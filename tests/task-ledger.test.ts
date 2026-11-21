import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTask, parseTask } from '../src/task';
import { Ledger, readLedger } from '../src/ledger';

const behavior = {
  id: 't1', repo: '/tmp/repo', baseCommit: 'abc1234', taskType: 'behavior', writablePaths: ['src/game'],
  instructions: 'Add scoring.', checks: [{ name: 'test', command: ['bun', 'test'] }],
  testReport: 'report.xml', testManifest: '/tmp/grading/t1.manifest.json', sentinelTest: 'sentinel > must fail'
};

test('accepts a valid behavior task', () => {
  const r = parseTask(behavior);
  expect(r.ok).toBe(true);
});

test('refuses bad task files with reasons', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ ...behavior, taskType: 'magic' }, 'taskType must be one of'],
    [{ ...behavior, writablePaths: ['../other'] }, 'stay inside the repo'],
    [{ ...behavior, writablePaths: ['/etc'] }, 'must be relative'],
    [{ ...behavior, repo: 'relative/repo' }, 'repo must be an absolute path'],
    [{ ...behavior, baseCommit: 'main' }, 'baseCommit must be a git commit hash'],
    [{ ...behavior, checks: [] }, 'need at least one check'],
    [{ ...behavior, testManifest: '/tmp/repo/manifest.json' }, 'testManifest must be outside the repo'],
    [{ ...behavior, sentinelTest: undefined }, 'need sentinelTest'],
    [{ ...behavior, taskType: 'refactor' }, 'refactor tasks need structuralCheck'],
    [{ ...behavior, taskType: 'tests' }, 'tests tasks need mutantsDir'],
    [{ ...behavior, taskType: 'artifact', checks: [], artifactFile: 'src/snake.html', writablePaths: ['src'] }, 'may write only their artifactFile']
  ];
  for (const [input, message] of cases) {
    const r = parseTask(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('; ')).toContain(message);
  }
});

test('accepts an artifact task that writes only its file', () => {
  const r = parseTask({ id: 'snake-a', repo: '/tmp/ws', baseCommit: 'abc1234', taskType: 'artifact', writablePaths: ['src/snake.html'], artifactFile: 'src/snake.html', instructions: 'Build Snake.', checks: [] });
  expect(r.ok).toBe(true);
});

let dir = '';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ledger-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test('loadTask reports an unreadable file', async () => {
  const r = await loadTask(join(dir, 'missing.json'));
  expect(r.ok).toBe(false);
  await writeFile(join(dir, 'task.json'), JSON.stringify(behavior));
  expect((await loadTask(join(dir, 'task.json'))).ok).toBe(true);
});

test('checks-passed alone is never a local pass; Claude must accept', async () => {
  const l = new Ledger(join(dir, 'ledger.jsonl'));
  await l.start('t1', 1, 'cfg');
  await l.end('t1', 1, 'cfg', 'checks-passed', [], 1000, { prompt: 10, completion: 5 });
  expect((await l.view('t1')).state).toBe('awaiting-review');
  await expect(l.start('t1', 2, 'cfg')).rejects.toThrow('needs Claude');
  await l.review('t1', 1, 'accept', 'clean diff');
  expect((await l.view('t1')).state).toBe('local-pass');
  await expect(l.review('t1', 1, 'accept', 'again')).rejects.toThrow('already reviewed');
});

test('a rejection leads to a correction, and three failures lead to escalation', async () => {
  const l = new Ledger(join(dir, 'ledger.jsonl'));
  await l.start('t1', 1, 'cfg');
  await l.end('t1', 1, 'cfg', 'checks-passed', [], 1, 'unknown');
  await l.review('t1', 1, 'reject', 'writes a report file');
  expect((await l.view('t1')).state).toBe('needs-correction');
  await expect(l.escalate('t1', 'too early')).rejects.toThrow('escalation needs 3');
  await l.start('t1', 2, 'cfg');
  await l.end('t1', 2, 'cfg', 'model-fail', ['2 tests red'], 1, 'unknown');
  await l.start('t1', 3, 'cfg');
  await l.end('t1', 3, 'cfg', 'forged', ['sentinel passed'], 1, 'unknown');
  expect((await l.view('t1')).state).toBe('awaiting-escalation');
  await expect(l.start('t1', 3, 'cfg')).rejects.toThrow('escalate');
  await l.escalate('t1', 'Claude wrote the scoring module');
  expect((await l.view('t1')).state).toBe('escalated');
});

test('infra failures re-run without using attempts, then block after two re-runs', async () => {
  const l = new Ledger(join(dir, 'ledger.jsonl'));
  for (let i = 0; i < 2; i++) {
    await l.start('t1', 1, 'cfg');
    await l.end('t1', 1, 'cfg', 'infra-fail', ['server 503'], 1, 'unknown');
    expect((await l.view('t1')).state).toBe('needs-rerun');
  }
  await l.start('t1', 1, 'cfg');
  await l.end('t1', 1, 'cfg', 'infra-fail', ['server 503'], 1, 'unknown');
  const v = await l.view('t1');
  expect(v.infraFailures).toBe(3);
  expect(v.state).toBe('blocked');
});

test('a start with no end reads back as incomplete', async () => {
  const l = new Ledger(join(dir, 'ledger.jsonl'));
  await l.start('t1', 1, 'cfg');
  const v = await l.view('t1');
  expect(v.state).toBe('incomplete');
  expect(v.attempts[0]?.final).toBe('incomplete');
});

test('the ledger file is append-only JSONL and rejects corrupt lines', async () => {
  const path = join(dir, 'ledger.jsonl');
  const l = new Ledger(path);
  await l.start('t1', 1, 'cfg');
  await l.end('t1', 1, 'cfg', 'artifact-ready', [], 1, 'unknown');
  expect((await readLedger(path)).map(r => r.type)).toEqual(['start', 'end']);
  await writeFile(path, '{"type":"bogus"}\n', { flag: 'a' });
  await expect(readLedger(path)).rejects.toThrow('line 3');
});
