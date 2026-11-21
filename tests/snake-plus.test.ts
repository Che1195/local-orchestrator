// The best-possible arm with stubbed sessions and a stubbed browser: four builds, three fix lists, then a pick.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePlus, runPlus } from '../src/snake-plus';
import type { Paths, Runners } from '../src/snake';
import type { PlayReport } from '../src/play';
import type { OpusCall, OpusResult } from '../src/workers/opus';

let root = '';
beforeAll(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'plus-'))); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test('four builds, three fix lists with evidence, and the picked version is the one kept', async () => {
  const p: Paths = { results: join(root, 'results'), runs: join(root, 'runs'), output: join(root, 'out') };
  await preparePlus('plus-1', { model: 'fake', effort: 'high', baseUrl: 'http://127.0.0.1:1', contextWindow: 131072, maxOutputTokens: 64000, quant: 'Q4_K_M' }, p);
  const prompts: string[] = [];
  const readable: string[][] = [];
  const decisions: object[] = [
    { decision: 'implement', assignment: 'SPEC', rationale: 'r' },
    { decision: 'revise', assignment: 'FIX-1', rationale: 'r' },
    { decision: 'accept', assignment: 'FIX-2', rationale: 'r' },
    { decision: 'revise', assignment: 'FIX-3', rationale: 'r' },
    { choice: 'v2', rationale: 'v3 and v4 regressed' }
  ];
  let build = 0;
  const runners: Runners = {
    claudeConfigDir: join(root, 'none'),
    opus: async (c: OpusCall): Promise<OpusResult> => {
      readable.push(c.readable ?? []);
      return { sessionId: crypto.randomUUID(), exitCode: 0, isError: false, resultText: '', structured: decisions.shift() ?? null, stopReason: 'end_turn', elapsedMs: 1, stdout: '{}', stderr: '', survivors: [] };
    },
    local: async (_m, w) => {
      prompts.push(w.prompt);
      await writeFile(join(w.worktree, 'src', 'snake.html'), `<p>build ${++build}</p>`);
      return { status: 'finished', reason: '', sessionId: crypto.randomUUID(), exitCode: 0, timedOut: false, outputAtDeadline: false, survivors: [], elapsedMs: 1, toolsSeen: [], resultText: '', numTurns: 1, localUsage: null, streamLog: '', stderrLog: '', configDir: join(root, 'none') };
    }
  };
  const played: string[] = [];
  const play = async (file: string, out: string): Promise<PlayReport> => {
    played.push(await readFile(file, 'utf8'));
    await mkdir(out, { recursive: true });
    return { file, loaded: true, errors: [], blockedRequests: [], buttons: [], canvas: null, steps: [], boardChangedAfterStart: true, boardChangedWhilePaused: false, mobile: null };
  };
  const r = await runPlus('plus-1', p, runners, play);
  expect(r.outcome).toBe('artifact_ready_for_user');
  expect(prompts.length).toBe(4);
  expect(prompts[0]).toContain('ASSIGNMENT\nSPEC');
  expect(prompts[1]).toContain('ASSIGNMENT\nFIX-1');
  expect(prompts[2]).toContain('ASSIGNMENT\nFIX-2');
  expect(prompts[3]).toContain('ASSIGNMENT\nFIX-3');
  expect(played).toEqual(['<p>build 1</p>', '<p>build 2</p>', '<p>build 3</p>', '<p>build 4</p>']);
  expect(readable[1]?.[0]).toEndWith('/evidence/v1');
  expect(readable[4]?.[0]).toEndWith('/evidence');
  expect(await readFile(r.kept ?? '', 'utf8')).toBe('<p>build 2</p>');
});
