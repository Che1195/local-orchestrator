// T8: the Claude Code worker against the fake model server, sandboxed for real.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeModel, type ScriptStep } from './support/fake-model';
import { ARTIFACT_TOOLS, runClaudeWorker, type LocalModel } from '../src/workers/claude-code';

let root = '';
let n = 0;
beforeAll(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'cw-'))); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function attempt(script: ScriptStep[], opts: { timeoutMs?: number; tools?: readonly string[] } = {}) {
  const fake = startFakeModel(script);
  const wt = join(root, `wt-${n}`);
  await mkdir(join(wt, 'src'), { recursive: true });
  const m: LocalModel = { model: 'fake-local-model', effort: 'high', baseUrl: fake.url, contextWindow: 131072, maxOutputTokens: 64000 };
  const r = await runClaudeWorker(m, { worktree: wt, writablePaths: [join(wt, 'src')], attemptDir: join(root, `attempt-${n++}`), prompt: 'Build src/snake.html', tools: opts.tools ?? ARTIFACT_TOOLS, timeoutMs: opts.timeoutMs ?? 60_000 });
  fake.stop();
  return { r, wt, fake };
}

test('scripted write then finish: the file lands and effort reaches the server', async () => {
  const wtPath = join(root, `wt-${n}`, 'src', 'snake.html');
  const { r, fake } = await attempt([
    { kind: 'reply', content: [{ type: 'tool_use', name: 'Write', input: { file_path: wtPath, content: '<canvas></canvas>' } }], stopReason: 'tool_use' },
    { kind: 'reply', content: [{ type: 'text', text: 'done' }] }
  ]);
  expect(r.status).toBe('finished');
  expect(await readFile(wtPath, 'utf8')).toBe('<canvas></canvas>');
  const body = fake.requests[0]?.body as { output_config?: { effort?: string }; model?: string };
  expect(body.output_config?.effort).toBe('high');
  expect(body.model).toBe('fake-local-model');
  expect(r.survivors).toEqual([]);
}, 90_000);

test('artifact sessions have exactly the listed tools and no web or agent tools', async () => {
  const { r, fake } = await attempt([{ kind: 'reply', content: [{ type: 'text', text: 'ok' }] }]);
  expect(r.toolsSeen.sort()).toEqual([...ARTIFACT_TOOLS].sort());
  const names = ((fake.requests[0]?.body as { tools?: { name: string }[] }).tools ?? []).map(t => t.name);
  for (const banned of ['WebFetch', 'WebSearch', 'Task', 'Agent']) expect(names).not.toContain(banned);
}, 90_000);

test('the shell inside the worker cannot reach the network or write outside src', async () => {
  const wtPath = join(root, `wt-${n}`);
  const { r } = await attempt([
    { kind: 'reply', content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo x > ${wtPath}/evil.txt; /usr/bin/curl -sf -m 3 https://example.com > ${wtPath}/src/net.txt; echo ok > ${wtPath}/src/fine.txt` } }], stopReason: 'tool_use' },
    { kind: 'reply', content: [{ type: 'text', text: 'done' }] }
  ]);
  expect(r.status).toBe('finished');
  expect(await Bun.file(join(wtPath, 'evil.txt')).exists()).toBe(false);
  expect(await Bun.file(join(wtPath, 'src', 'fine.txt')).exists()).toBe(true);
  expect(await Bun.file(join(wtPath, 'src', 'net.txt')).text()).toBe('');
}, 90_000);

test('a write outside the writable path is refused by the sandbox', async () => {
  const outside = join(root, `wt-${n}`, 'evil.txt');
  const { r } = await attempt([
    { kind: 'reply', content: [{ type: 'tool_use', name: 'Write', input: { file_path: outside, content: 'x' } }], stopReason: 'tool_use' },
    { kind: 'reply', content: [{ type: 'text', text: 'tried' }] }
  ]);
  expect(r.status).toBe('finished');
  expect(await Bun.file(outside).exists()).toBe(false);
}, 90_000);

test('a server error is infra-fail', async () => {
  const errors: ScriptStep[] = Array.from({ length: 30 }, () => ({ kind: 'error', status: 500, message: 'boom' }));
  const { r } = await attempt(errors, { timeoutMs: 8_000 });
  expect(r.status).toBe('infra-fail');
}, 60_000);

test('a hung model is killed at the deadline as model-fail', async () => {
  const { r } = await attempt([{ kind: 'hang' }], { timeoutMs: 5_000 });
  expect(r.timedOut).toBe(true);
  expect(r.status).toBe('model-fail');
  expect(r.survivors).toEqual([]);
}, 60_000);
