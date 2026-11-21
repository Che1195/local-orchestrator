// T2: a fake model server that speaks the Anthropic Messages API and plays back scripted replies.
// Scripted workers can edit files, fail, tamper or hang on purpose, so the harness can be tested
// without a real model server.

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown>; id?: string };

export type ScriptStep =
  | { kind: 'reply'; content: ContentBlock[]; stopReason?: 'end_turn' | 'tool_use' | 'max_tokens'; usage?: { input_tokens: number; output_tokens: number } }
  | { kind: 'error'; status: number; message: string }
  | { kind: 'hang' }
  | { kind: 'slow'; text: string; chunkDelayMs: number };

export interface RecordedRequest {
  index: number;
  body: unknown;
  stream: boolean;
  step: ScriptStep['kind'] | 'exhausted';
  completed: boolean;
  disconnected: boolean;
}

export interface FakeModelServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  stop(): void;
}

const MODEL_ID = 'fake-local-model';

function messageId(index: number): string {
  return `msg_fake_${index}`;
}

function withIds(content: ContentBlock[], index: number): ContentBlock[] {
  return content.map((block, i) => (block.type === 'tool_use' ? { ...block, id: block.id ?? `toolu_fake_${index}_${i}` } : block));
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamEvents(index: number, content: ContentBlock[], stopReason: string, usage: { input_tokens: number; output_tokens: number }): string[] {
  const events = [
    sse('message_start', {
      type: 'message_start',
      message: { id: messageId(index), type: 'message', role: 'assistant', model: MODEL_ID, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } }
    })
  ];
  content.forEach((block, i) => {
    if (block.type === 'text') {
      events.push(sse('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }));
      events.push(sse('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } }));
    } else {
      events.push(sse('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }));
      events.push(sse('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }));
    }
    events.push(sse('content_block_stop', { type: 'content_block_stop', index: i }));
  });
  events.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }));
  events.push(sse('message_stop', { type: 'message_stop' }));
  return events;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function startFakeModel(script: ScriptStep[]): FakeModelServer {
  const requests: RecordedRequest[] = [];
  let next = 0;

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === 'GET' && path === '/v1/models') {
        return Response.json({ data: [{ id: MODEL_ID, type: 'model', display_name: 'Fake local model' }], has_more: false });
      }
      if (req.method !== 'POST' || path !== '/v1/messages') {
        return Response.json({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }, { status: 404 });
      }

      const body: unknown = await req.json();
      const stream = typeof body === 'object' && body !== null && (body as { stream?: unknown }).stream === true;
      const index = requests.length;
      const step = script[next];
      next += 1;
      const record: RecordedRequest = { index, body, stream, step: step ? step.kind : 'exhausted', completed: false, disconnected: false };
      requests.push(record);
      req.signal.addEventListener('abort', () => {
        if (!record.completed) record.disconnected = true;
      });

      if (!step) {
        record.completed = true;
        return Response.json({ type: 'error', error: { type: 'api_error', message: 'fake model script exhausted' } }, { status: 500 });
      }
      if (step.kind === 'error') {
        record.completed = true;
        return Response.json({ type: 'error', error: { type: 'api_error', message: step.message } }, { status: step.status });
      }
      if (step.kind === 'hang') {
        // Never answer; the client gives up or is killed, which the abort listener records.
        await new Promise<void>(resolve => req.signal.addEventListener('abort', () => resolve()));
        return new Response(null, { status: 499 });
      }

      const content: ContentBlock[] = step.kind === 'slow' ? [{ type: 'text', text: step.text }] : withIds(step.content, index);
      const stopReason = step.kind === 'reply' ? step.stopReason ?? (content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn') : 'end_turn';
      const usage = step.kind === 'reply' && step.usage ? step.usage : { input_tokens: 10, output_tokens: 5 };

      if (!stream) {
        record.completed = true;
        return Response.json({ id: messageId(index), type: 'message', role: 'assistant', model: MODEL_ID, content, stop_reason: stopReason, stop_sequence: null, usage });
      }

      const encoder = new TextEncoder();
      const events = streamEvents(index, content, stopReason, usage);
      const delayMs = step.kind === 'slow' ? step.chunkDelayMs : 0;
      const body$ = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const event of events) {
            if (req.signal.aborted) return;
            controller.enqueue(encoder.encode(event));
            if (delayMs > 0) await sleep(delayMs);
          }
          record.completed = true;
          controller.close();
        }
      });
      return new Response(body$, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
    }
  });

  const port = server.port ?? 0;
  return { url: `http://127.0.0.1:${port}`, port, requests, stop: () => server.stop(true) };
}
