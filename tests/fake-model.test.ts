import { afterEach, expect, test } from 'bun:test';
import { startFakeModel, type FakeModelServer } from './support/fake-model';

let server: FakeModelServer | undefined;
afterEach(() => server?.stop());

const post = (body: unknown, signal?: AbortSignal) =>
  fetch(`${server!.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });

async function waitFor(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await Bun.sleep(20);
  }
}

test('lists its model', async () => {
  server = startFakeModel([]);
  const res = await fetch(`${server.url}/v1/models`);
  const json = (await res.json()) as { data: { id: string }[] };
  expect(json.data[0]?.id).toBe('fake-local-model');
});

test('plays a scripted text reply without streaming', async () => {
  server = startFakeModel([{ kind: 'reply', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 7, output_tokens: 3 } }]);
  const res = await post({ model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  const json = (await res.json()) as { content: { type: string; text: string }[]; stop_reason: string; usage: { output_tokens: number } };
  expect(json.content[0]).toEqual({ type: 'text', text: 'hello' });
  expect(json.stop_reason).toBe('end_turn');
  expect(json.usage.output_tokens).toBe(3);
  expect(server.requests[0]).toMatchObject({ index: 0, stream: false, step: 'reply', completed: true, disconnected: false });
});

test('streams a scripted tool call as Anthropic SSE events', async () => {
  server = startFakeModel([{ kind: 'reply', content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'src/a.ts', content: 'x' } }] }]);
  const res = await post({ model: 'x', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'go' }] });
  const text = await res.text();
  const events = [...text.matchAll(/^event: (\S+)$/gm)].map(m => m[1]);
  expect(events).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  expect(text).toContain('"name":"Write"');
  expect(text).toContain('"stop_reason":"tool_use"');
  expect(text).toContain(JSON.stringify(JSON.stringify({ file_path: 'src/a.ts', content: 'x' })));
  expect(server.requests[0]?.completed).toBe(true);
});

test('returns scripted errors and reports an exhausted script', async () => {
  server = startFakeModel([{ kind: 'error', status: 503, message: 'overloaded' }]);
  const first = await post({ messages: [] });
  expect(first.status).toBe(503);
  const second = await post({ messages: [] });
  expect(second.status).toBe(500);
  expect(server.requests.map(r => r.step)).toEqual(['error', 'exhausted']);
});

test('a hang is recorded as a disconnect when the client aborts', async () => {
  server = startFakeModel([{ kind: 'hang' }]);
  const controller = new AbortController();
  const pending = post({ messages: [] }, controller.signal).catch(() => 'aborted');
  await waitFor(() => server!.requests.length === 1);
  controller.abort();
  expect(await pending).toBe('aborted');
  await waitFor(() => server!.requests[0]?.disconnected === true);
  expect(server.requests[0]?.completed).toBe(false);
});

test('a killed client process mid-stream is recorded as a disconnect', async () => {
  server = startFakeModel([{ kind: 'slow', text: 'a long answer', chunkDelayMs: 400 }]);
  const curl = Bun.spawn(['curl', '-sN', '-X', 'POST', `${server.url}/v1/messages`, '-H', 'content-type: application/json', '-d', JSON.stringify({ stream: true, messages: [] })], { stdout: 'ignore', stderr: 'ignore' });
  await waitFor(() => server!.requests.length === 1);
  await Bun.sleep(150);
  curl.kill('SIGKILL');
  await curl.exited;
  await waitFor(() => server!.requests[0]?.disconnected === true);
  expect(server.requests[0]?.completed).toBe(false);
});
