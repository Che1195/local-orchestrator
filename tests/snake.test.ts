// T13: the Snake runner end to end with stubbed sessions, plus the Opus blinding profile under real Seatbelt.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, publish, REPO, run, type Arm, type Manifest, type Paths, type Runners } from '../src/snake';
import type { WorkerResult } from '../src/workers/claude-code';
import { opusProfile, type OpusCall, type OpusResult } from '../src/workers/opus';

let root = '';
let paths: Paths;
let k = 0;
const local: Manifest['local'] = { model: 'fake-local-model', effort: 'high', baseUrl: 'http://127.0.0.1:1', contextWindow: 131072, maxOutputTokens: 64000, quant: 'Q4_K_M' };
beforeAll(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'snake-'))); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const fresh = async (): Promise<{ id: string; m: Manifest; p: Paths }> => {
  const base = join(root, `p${k++}`);
  paths = { results: join(base, 'results'), runs: join(base, 'runs'), output: join(base, 'out') };
  const id = `test-${k}`;
  return { id, m: await prepare(id, local, paths), p: paths };
};

type LocalStep = { write?: string; status?: WorkerResult['status']; extra?: string };
function stubs(localSteps: LocalStep[], opusSteps: ({ write?: string; decision?: object; fail?: boolean })[], seen: { localPrompts: string[]; reviewedFiles: string[] }): Runners {
  return {
    claudeConfigDir: join(root, 'no-config'),
    local: async (_m, w) => {
      const s = localSteps.shift() ?? {};
      seen.localPrompts.push(w.prompt);
      if (s.write !== undefined) await writeFile(join(w.worktree, 'src', 'snake.html'), s.write);
      if (s.extra) await writeFile(join(w.worktree, s.extra), 'x');
      return { status: s.status ?? 'finished', reason: '', sessionId: crypto.randomUUID(), exitCode: s.status && s.status !== 'finished' ? 1 : 0, timedOut: false, outputAtDeadline: false, survivors: [], elapsedMs: 5, toolsSeen: [], resultText: '', numTurns: 1, localUsage: null, streamLog: '', stderrLog: '', configDir: join(root, 'no-config') };
    },
    opus: async (c: OpusCall): Promise<OpusResult> => {
      const s = opusSteps.shift() ?? {};
      if (!c.canWrite && existsSync(join(c.workspace, 'src', 'snake.html'))) seen.reviewedFiles.push(await readFile(join(c.workspace, 'src', 'snake.html'), 'utf8'));
      if (s.write !== undefined && c.canWrite) await writeFile(join(c.workspace, 'src', 'snake.html'), s.write);
      return { sessionId: crypto.randomUUID(), exitCode: s.fail ? 1 : 0, isError: !!s.fail, resultText: '', structured: s.decision ?? null, stopReason: 'end_turn', elapsedMs: 5, stdout: '{}', stderr: '', survivors: [] };
    }
  };
}

const result = async (p: Paths, id: string, m: Manifest, arm: Arm) => JSON.parse(await readFile(join(p.results, id, 'private', m.labels[arm], 'result.json'), 'utf8')) as { outcome: string; attempts: unknown[]; error?: string; kept: string | null };

test('full dry run: three labelled games, a blind index, and Inkling\'s file is what the review reads', async () => {
  const { id, m, p } = await fresh();
  const seen = { localPrompts: [] as string[], reviewedFiles: [] as string[] };
  // Arms run in manifest order; give each kind its own queue.
  const r = stubs(
    [{ write: '<p>inkling solo</p>' }, { write: '<p>hybrid v1</p>' }, { write: '<p>hybrid v2</p>' }],
    [{ write: '<p>claude</p>' }, { decision: { decision: 'implement', assignment: 'Build it', rationale: 'r' } }, { decision: { decision: 'revise', assignment: 'Fix pause', rationale: 'r' } }, { decision: { decision: 'accept', assignment: '', rationale: 'ok' } }],
    seen
  );
  // Order the local and opus queues independently of arm order by running arms one at a time.
  await run(id, p, r, ['claude']);
  await run(id, p, r, ['inkling']);
  await run(id, p, r, ['hybrid']);
  for (const arm of ['claude', 'inkling', 'hybrid'] as Arm[]) expect((await result(p, id, m, arm)).outcome).toBe('artifact_ready_for_user');
  expect(seen.reviewedFiles).toEqual(['<p>hybrid v1</p>', '<p>hybrid v2</p>']);
  expect(seen.localPrompts[2]).toContain('ASSIGNMENT\nFix pause');
  const index = await publish(id, p);
  const html = await readFile(index, 'utf8');
  for (const word of ['second', 'attempt', 'failed', 'Opus', 'Inkling', 'Claude only', 'hybrid', 'token']) expect(html.toLowerCase()).not.toContain(word.toLowerCase());
  expect(await readFile(join(p.output, id, `${m.labels.hybrid}.html`), 'utf8')).toBe('<p>hybrid v2</p>');
  expect(existsSync(join(p.results, id, 'private', 'manifest.json'))).toBe(true);
});

test('a call that fails after writing a file is retried with the retry text, keeping the file', async () => {
  const { id, m, p } = await fresh();
  const seen = { localPrompts: [] as string[], reviewedFiles: [] as string[] };
  await run(id, p, stubs([{ write: '<p>v1</p>', status: 'model-fail' }, { write: '<p>v2</p>' }], [], seen), ['inkling']);
  const r = await result(p, id, m, 'inkling');
  expect(r.outcome).toBe('artifact_ready_for_user');
  expect(r.attempts.length).toBe(2);
  expect(seen.localPrompts[1]).toContain('Finish the unchanged task in the actual file. Prior call exit=1, stop=model-fail, nonempty file=true.');
});

test('a scope violation stops the arm; a final empty file still publishes the earlier kept copy', async () => {
  const { id, m, p } = await fresh();
  const seen = { localPrompts: [] as string[], reviewedFiles: [] as string[] };
  await run(id, p, stubs([{ write: '<p>v1</p>', extra: 'notes.txt' }], [], seen), ['inkling']);
  const bad = await result(p, id, m, 'inkling');
  expect(bad.outcome).toBe('failed');
  expect(bad.error).toContain('Scope violation');
  await run(id, p, stubs([], [{ write: '<p>v1</p>', fail: true }, { write: '', fail: true }, { write: '', fail: true }], seen), ['claude']);
  const c = await result(p, id, m, 'claude');
  expect(c.outcome).toBe('failed');
  await run(id, p, stubs([{ write: '<p>h</p>' }], [{ decision: { decision: 'implement', assignment: 'a', rationale: 'r' } }, { decision: { decision: 'accept', assignment: '', rationale: 'r' } }], seen), ['hybrid']);
  await publish(id, p);
  expect(await readFile(join(p.output, id, `${m.labels.claude}.html`), 'utf8')).toBe('<p>v1</p>');
  expect(existsSync(join(p.output, id, `${m.labels.inkling}.html`))).toBe(false);
});

test('a changed task file is refused', async () => {
  const { id, m, p } = await fresh();
  await writeFile(join(p.runs, id, m.labels.claude, 'workspace', 'TASK.md'), 'changed');
  const seen = { localPrompts: [] as string[], reviewedFiles: [] as string[] };
  await expect(run(id, p, stubs([], [], seen), ['claude'])).rejects.toThrow('not fresh');
});

test('an arm never runs twice', async () => {
  const { id, p } = await fresh();
  const seen = { localPrompts: [] as string[], reviewedFiles: [] as string[] };
  await run(id, p, stubs([{ write: 'x' }], [], seen), ['inkling']);
  await expect(run(id, p, stubs([{ write: 'x' }], [], seen), ['inkling'])).rejects.toThrow('already ran');
});

test('the Opus profile hides other arms, the mapping and Che\'s CLAUDE.md, and limits writes to src', async () => {
  const base = join(REPO, 'runs', `blind-${crypto.randomUUID()}`);
  const ws = join(base, 'A', 'workspace');
  const other = join(base, 'B', 'workspace');
  const results = join(base, 'results');
  await mkdir(join(ws, 'src'), { recursive: true });
  await mkdir(other, { recursive: true });
  await mkdir(results, { recursive: true });
  await writeFile(join(ws, 'TASK.md'), 'task');
  await writeFile(join(other, 'secret.html'), 'other arm');
  await writeFile(join(results, 'manifest.json'), 'mapping');
  const profile = join(base, 'p.sb');
  const can = async (canWrite: boolean, script: string) => {
    await writeFile(profile, opusProfile(ws, [base, results], canWrite));
    const p = Bun.spawn(['/usr/bin/sandbox-exec', '-f', profile, '/bin/sh', '-c', script], { cwd: ws, stdout: 'ignore', stderr: 'ignore' });
    return (await p.exited) === 0;
  };
  try {
    expect(await can(true, `cat ${ws}/TASK.md`)).toBe(true);
    expect(await can(true, `echo x > ${ws}/src/snake.html`)).toBe(true);
    expect(await can(true, `cat ${other}/secret.html`)).toBe(false);
    expect(await can(true, `cat ${results}/manifest.json`)).toBe(false);
    expect(await can(true, `cat ${join(homedir(), '.claude', 'CLAUDE.md')}`)).toBe(false);
    expect(await can(true, `echo x > ${ws}/TASK.md`)).toBe(false);
    expect(await can(false, `echo x > ${ws}/src/snake.html`)).toBe(false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
