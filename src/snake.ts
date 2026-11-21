// T13: the Snake evaluation (spec §12), a port of CHE-1166's snake-human-review-v2 runner to this harness.
// Arms: claude (Opus 5.5 high alone), inkling (Inkling 2 Mini alone, prompted by this runner), hybrid
// (Opus plans and reviews, Inkling builds). Che plays the three games blind as A to C.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { git } from './git';
import { sessionUsage, type UsageResult } from './usage';
import { ARTIFACT_TOOLS, runClaudeWorker, type LocalModel } from './workers/claude-code';
import { runOpus } from './workers/opus';
import { BOUNDARY, IMPLEMENT, PLANNER, RETRY, REVIEW, render, verifyAgainst } from '../snake/prompts';

export const REPO = resolve(import.meta.dir, '..');
export const CHE1166 = join(homedir(), 'projects', 'hybrid-development-eval');
export const CODE_COMMIT = '522d0eb45d20a8517a4b56b089c93fd15daee121';
export const ACCEPTED = join(CHE1166, 'results', 'snake-20261121-02', 'manifest.json');
export const OUTPUT_ROOT = join(homedir(), 'projects', 'local-ai-output');
const STARTER = join(REPO, 'snake', 'starter');
const MAX_ATTEMPTS = 3;

export type Arm = 'claude' | 'inkling' | 'hybrid' | 'plus';
export const ARMS: Arm[] = ['claude', 'inkling', 'hybrid'];

export function labelOf(m: Pick<Manifest, 'labels'>, arm: Arm): string {
  const label = m.labels[arm];
  if (!label) throw new Error(`no ${arm} arm in this run`);
  return label;
}

export interface Paths { results: string; runs: string; output: string }
export const defaultPaths = (): Paths => ({ results: join(REPO, 'results'), runs: join(REPO, 'runs'), output: OUTPUT_ROOT });

export interface Manifest {
  protocol: 'claude-snake-v1' | 'claude-snake-plus-v1';
  runId: string;
  preparedAt: string;
  starterHash: string;
  taskHash: string;
  che1166: { codeCommit: string; acceptedRun: string; promptsVerified: true };
  harnessCommit: string;
  maxAttempts: number;
  claude: { model: string; effort: string };
  local: LocalModel & { quant: string };
  labels: Partial<Record<Arm, string>>;
  order: Arm[];
  limitations: string[];
}

export interface CallLog {
  id: string;
  role: string;
  model: string;
  sessionId: string;
  configDir: string;
  exitCode: number | null;
  status: string;
  elapsedMs: number;
  usage?: UsageResult;
}

export interface ArmResult {
  label: string;
  arm: Arm;
  startedAt: string;
  elapsedMs: number;
  outcome: 'running' | 'artifact_ready_for_user' | 'failed';
  calls: CallLog[];
  attempts: { round: number; scope: string[]; present: boolean; hash: string | null; bytes: number }[];
  kept: string | null;
  keptHash: string | null;
  review?: string;
  error?: string;
}

export const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/** CHE-1166's hashTree, same algorithm: sorted entries, path NUL bytes NUL, skipping build and VCS folders. */
export async function hashTree(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', '.git', 'dist', '.vite'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in hashed tree: ' + path);
      if (entry.isDirectory()) await visit(path);
      else { hash.update(relative(root, path) + '\0'); hash.update(await readFile(path)); hash.update('\0'); }
    }
  }
  await visit(root);
  return hash.digest('hex');
}

export function shuffle<T>(input: T[]): T[] {
  const a = [...input];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j] as T, a[i] as T]; }
  return a;
}

export function checkRunId(id: string): void { if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('bad run id'); }

/** The frozen inputs must match CHE-1166's accepted run, and its prompts must match ours word for word. */
export async function verifyInputs(): Promise<{ starterHash: string; taskHash: string }> {
  const accepted = JSON.parse(await readFile(ACCEPTED, 'utf8')) as { starterHash: string; taskHash: string; codeCommit: string };
  if (accepted.codeCommit !== CODE_COMMIT) throw new Error('accepted manifest names a different code commit');
  const starterHash = await hashTree(STARTER);
  const taskHash = sha(await readFile(join(STARTER, 'TASK.md')));
  if (starterHash !== accepted.starterHash) throw new Error('starter differs from CHE-1166');
  if (taskHash !== accepted.taskHash) throw new Error('TASK.md differs from CHE-1166');
  const source = await git(CHE1166, 'show', `${CODE_COMMIT}:src/snake.ts`);
  const missing = verifyAgainst(source);
  if (missing.length) throw new Error(`prompts differ from CHE-1166: ${missing.join(', ')}`);
  return { starterHash, taskHash };
}

export async function prepare(id: string, local: Manifest['local'], paths = defaultPaths()): Promise<Manifest> {
  checkRunId(id);
  const { starterHash, taskHash } = await verifyInputs();
  const priv = join(paths.results, id, 'private');
  if (existsSync(join(paths.results, id))) throw new Error('run already exists');
  await mkdir(priv, { recursive: true });
  const labelOrder = shuffle(ARMS);
  const labels: Partial<Record<Arm, string>> = Object.fromEntries(labelOrder.map((arm, i) => [arm, String.fromCharCode(65 + i)]));
  for (const label of ['A', 'B', 'C']) {
    const ws = join(paths.runs, id, label, 'workspace');
    await cp(STARTER, ws, { recursive: true, errorOnExist: true, force: false });
    await mkdir(join(ws, 'src'));
    await writeFile(join(ws, '.gitignore'), '');
    await git(ws, 'init', '-q', '-b', 'snake');
    await git(ws, 'add', '--all');
    await git(ws, '-c', 'user.name=Evaluation Fixture', '-c', 'user.email=eval@localhost', 'commit', '-q', '--no-gpg-sign', '-m', 'Frozen Snake contract');
  }
  const manifest: Manifest = {
    protocol: 'claude-snake-v1', runId: id, preparedAt: new Date().toISOString(), starterHash, taskHash,
    che1166: { codeCommit: CODE_COMMIT, acceptedRun: 'snake-20261121-02', promptsVerified: true },
    harnessCommit: (await git(REPO, 'rev-parse', 'HEAD')).trim(), maxAttempts: MAX_ATTEMPTS,
    claude: { model: 'claude-opus-5-5', effort: 'high' }, local, labels, order: shuffle(ARMS),
    limitations: [
      'No gameplay or automated functional checks: every game awaits Che\'s review.',
      'One small task; not proof that local models can replace Claude.',
      'Worker program differs from CHE-1166: headless Claude Code here, Codex CLI there. Same model file, context and effort setting.',
      'Inkling\'s per-response output is capped at the configured maxOutputTokens by Claude Code; Codex had no stated cap.',
      'Claude sessions run on Che\'s normal login with Che\'s instructions and memory hidden by Seatbelt; filesystem blinding is policy, not a container.'
    ]
  };
  await writeFile(join(priv, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export async function scopeViolations(ws: string): Promise<string[]> {
  const errors: string[] = [];
  const src = await lstat(join(ws, 'src')).catch(() => null);
  if (!src || !src.isDirectory() || src.isSymbolicLink()) return ['src must be an ordinary directory'];
  for (const file of ['AGENTS.md', 'TASK.md']) {
    const info = await lstat(join(ws, file)).catch(() => null);
    if (!info?.isFile()) { errors.push(file + ' must be an ordinary file'); continue; }
    if (sha(await readFile(join(ws, file))) !== sha(await readFile(join(STARTER, file)))) errors.push(file + ' changed');
  }
  if ((await readFile(join(ws, '.gitignore'), 'utf8').catch(() => null)) !== '') errors.push('.gitignore changed');
  for (const entry of await readdir(ws)) if (!['AGENTS.md', 'TASK.md', '.gitignore', '.git', 'src'].includes(entry)) errors.push('Unexpected root file ' + entry);
  for (const entry of await readdir(join(ws, 'src'), { withFileTypes: true })) if (entry.name !== 'snake.html' || !entry.isFile()) errors.push('Unexpected source entry ' + entry.name);
  return errors;
}

export const decisionSchema = {
  type: 'object', additionalProperties: false,
  properties: { decision: { type: 'string', enum: ['implement', 'revise', 'accept', 'blocked'] }, assignment: { type: 'string' }, rationale: { type: 'string' } },
  required: ['decision', 'assignment', 'rationale']
};
interface Decision { decision: 'implement' | 'revise' | 'accept' | 'blocked'; assignment: string; rationale: string }
export function readDecision(v: unknown): Decision {
  const d = v as Partial<Decision> | null;
  if (!d || !['implement', 'revise', 'accept', 'blocked'].includes(String(d.decision)) || typeof d.assignment !== 'string' || typeof d.rationale !== 'string') throw new Error('Invalid Claude decision');
  return d as Decision;
}

/** Seams for tests: the two session kinds. */
export interface Runners {
  opus: typeof runOpus;
  local: typeof runClaudeWorker;
  claudeConfigDir: string;
}
export const realRunners = (): Runners => ({ opus: runOpus, local: runClaudeWorker, claudeConfigDir: join(homedir(), '.claude') });

export async function runArm(m: Manifest, arm: Arm, paths: Paths, runners: Runners): Promise<ArmResult> {
  const label = labelOf(m, arm);
  const ws = join(paths.runs, m.runId, label, 'workspace');
  const dir = join(paths.results, m.runId, 'private', label);
  await mkdir(dir, { recursive: true });
  if ((await scopeViolations(ws)).length || (await readdir(join(ws, 'src'))).length) throw new Error(`workspace ${label} is not fresh`);
  const task = await readFile(join(ws, 'TASK.md'), 'utf8');
  const start = Date.now();
  const r: ArmResult = { label, arm, startedAt: new Date(start).toISOString(), elapsedMs: 0, outcome: 'running', calls: [], attempts: [], kept: null, keptHash: null };
  const save = async () => { r.elapsedMs = Date.now() - start; await writeFile(join(dir, 'result.json'), JSON.stringify(r, null, 2) + '\n'); };
  const hidden = [REPO, OUTPUT_ROOT, CHE1166, paths.results, paths.runs, paths.output];

  async function decide(role: string, prompt: string): Promise<Decision> {
    const before = await hashTree(join(ws, 'src'));
    const c = await runners.opus({ workspace: ws, hidden, canWrite: false, tools: ['Read', 'Glob', 'Grep'], prompt, profilePath: join(dir, `${role}.sb`), jsonSchema: decisionSchema, model: m.claude.model, effort: m.claude.effort });
    r.calls.push({ id: `${role}-${r.calls.length + 1}`, role, model: m.claude.model, sessionId: c.sessionId, configDir: runners.claudeConfigDir, exitCode: c.exitCode, status: c.isError ? 'error' : 'ok', elapsedMs: c.elapsedMs });
    await writeFile(join(dir, `${role}.json`), c.stdout);
    await save();
    if (before !== await hashTree(join(ws, 'src')) || (await scopeViolations(ws)).length) throw new Error('Read-only role changed frozen scope');
    if (c.exitCode !== 0 || c.isError) throw new Error(`Claude ${role} failed: ${c.resultText.slice(0, 300) || c.stderr.slice(0, 300)}`);
    return readDecision(c.structured);
  }

  try {
    let assignment = task;
    if (arm === 'hybrid') {
      const plan = await decide('plan', render(PLANNER, { boundary: BOUNDARY, task }));
      if (plan.decision !== 'implement') throw new Error('Planner did not assign implementation');
      assignment = plan.assignment;
    }
    for (let round = 1; round <= m.maxAttempts; round++) {
      const roundDir = join(dir, `round-${round}`);
      await mkdir(roundDir, { recursive: true });
      const prompt = render(IMPLEMENT, { boundary: BOUNDARY, task, assignment });
      console.log(`SNAKE_RUN ${label} attempt ${round}`);
      let exit: number | null;
      let stop: string;
      let ok: boolean;
      if (arm === 'claude') {
        const c = await runners.opus({ workspace: ws, hidden, canWrite: true, tools: ['Read', 'Write', 'Edit'], prompt, profilePath: join(roundDir, 'implement.sb'), model: m.claude.model, effort: m.claude.effort });
        await writeFile(join(roundDir, 'implement.json'), c.stdout);
        await writeFile(join(roundDir, 'implement.stderr'), c.stderr);
        r.calls.push({ id: `implement-${round}`, role: 'implement', model: m.claude.model, sessionId: c.sessionId, configDir: runners.claudeConfigDir, exitCode: c.exitCode, status: c.isError ? 'error' : 'ok', elapsedMs: c.elapsedMs });
        exit = c.exitCode; stop = c.stopReason ?? 'unknown'; ok = c.exitCode === 0 && !c.isError && c.survivors.length === 0;
      } else {
        const w = await runners.local(m.local, { worktree: ws, writablePaths: [join(ws, 'src')], attemptDir: roundDir, prompt, tools: ARTIFACT_TOOLS, timeoutMs: null });
        r.calls.push({ id: `implement-${round}`, role: 'implement', model: m.local.model, sessionId: w.sessionId, configDir: w.configDir, exitCode: w.exitCode, status: w.status, elapsedMs: w.elapsedMs });
        exit = w.exitCode; stop = w.status; ok = w.status === 'finished';
      }
      await save();
      const scope = await scopeViolations(ws);
      if (scope.length) {
        r.attempts.push({ round, scope, present: false, hash: null, bytes: 0 });
        throw new Error('Scope violation: ' + scope.join('; '));
      }
      const contents = await readFile(join(ws, 'src', 'snake.html')).catch(() => null);
      const present = contents !== null && contents.length > 0;
      r.attempts.push({ round, scope, present, hash: present ? sha(contents) : null, bytes: contents?.length ?? 0 });
      if (present) {
        const kept = join(roundDir, 'artifact.html');
        await writeFile(kept, contents, { flag: 'wx' });
        r.kept = kept; r.keptHash = sha(contents);
      }
      await save();
      if (ok && present) {
        if (arm !== 'hybrid') { r.outcome = 'artifact_ready_for_user'; break; }
        const review = await decide(`review-${round}`, render(REVIEW, { boundary: BOUNDARY, task }));
        r.review = review.rationale;
        if (review.decision === 'accept') { r.outcome = 'artifact_ready_for_user'; break; }
        if (review.decision === 'blocked') throw new Error('Claude review blocked: ' + review.rationale);
        assignment = review.assignment;
      } else {
        assignment = render(RETRY, { 'call.exitCode': String(exit), 'call.stopReason': stop, present: String(present) });
      }
    }
    if (r.outcome === 'running') r.outcome = 'failed';
  } catch (e) {
    r.outcome = 'failed';
    r.error = String(e);
  } finally {
    for (const c of r.calls) c.usage = await sessionUsage(c.configDir, c.sessionId);
    await save();
  }
  console.log(`SNAKE_END ${label} ${r.outcome}`);
  return r;
}

export async function loadManifest(id: string, paths: Paths): Promise<Manifest> {
  checkRunId(id);
  const m = JSON.parse(await readFile(join(paths.results, id, 'private', 'manifest.json'), 'utf8')) as Manifest;
  const { starterHash, taskHash } = await verifyInputs();
  if (m.starterHash !== starterHash || m.taskHash !== taskHash) throw new Error('frozen inputs changed');
  return m;
}

export async function run(id: string, paths = defaultPaths(), runners = realRunners(), only?: Arm[]): Promise<ArmResult[]> {
  const m = await loadManifest(id, paths);
  const out: ArmResult[] = [];
  for (const arm of m.order) {
    if (arm === 'plus') continue;
    if (only && !only.includes(arm)) continue;
    if (existsSync(join(paths.results, id, 'private', labelOf(m, arm), 'result.json'))) throw new Error(`arm ${labelOf(m, arm)} already ran; never overwrite`);
    out.push(await runArm(m, arm, paths, runners));
  }
  return out;
}

/** Copy the games to the output folder as A–C with an index that shows only labels. */
export async function publish(id: string, paths = defaultPaths()): Promise<string> {
  await loadManifest(id, paths);
  const out = join(paths.output, id);
  await mkdir(paths.output, { recursive: true });
  await mkdir(out, { recursive: false });
  const rows: string[] = [];
  for (const label of ['A', 'B', 'C']) {
    const raw = await readFile(join(paths.results, id, 'private', label, 'result.json'), 'utf8').catch(() => null);
    const r = raw ? (JSON.parse(raw) as ArmResult) : null;
    if (r?.kept && r.keptHash) {
      const bytes = await readFile(r.kept);
      if (sha(bytes) !== r.keptHash) throw new Error(`kept file for ${label} changed`);
      await writeFile(join(out, `${label}.html`), bytes, { flag: 'wx' });
      rows.push(`<li>Game ${label}: <a href="${label}.html">Open game</a></li>`);
    } else rows.push(`<li>Game ${label}: no playable game</li>`);
  }
  const index = join(out, 'index.html');
  await writeFile(index, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Snake: Claude round</title><body style="font:16px/1.5 system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem"><h1>Snake: Claude round</h1><p>Three games built from the same contract as the GPT round. Play each one and rate it by letter. The labels are random.</p><ol>${rows.join('\n')}</ol></body></html>\n`, { flag: 'wx' });
  return index;
}

if (import.meta.main) {
  const [mode, id, ...rest] = process.argv.slice(2);
  if (!mode || !id) throw new Error('usage: bun src/snake.ts prepare|run|publish <run id> [arms]');
  if (mode === 'prepare') {
    const local = JSON.parse(rest[0] ?? '{}') as Manifest['local'];
    if (!local.model || !local.baseUrl) throw new Error('prepare needs the local model JSON');
    console.log(JSON.stringify(await prepare(id, local), null, 2));
  } else if (mode === 'run') {
    const only = rest[0] ? (rest[0].split(',') as Arm[]) : undefined;
    const results = await run(id, defaultPaths(), realRunners(), only);
    console.log(JSON.stringify(results.map(r => ({ label: r.label, outcome: r.outcome, attempts: r.attempts.length })), null, 2));
  } else if (mode === 'publish') console.log(await publish(id));
  else if (mode === 'publish-combined') {
    // publish-combined <name> <runId>:<arm,arm> [<runId>:<arm,arm> ...]
    const sources = rest.map(s => { const [runId, arms] = s.split(':'); return { runId: runId ?? '', arms: (arms ?? '').split(',') as Arm[] }; });
    console.log(await publishCombined(id, sources));
  }
  else throw new Error('unknown mode');
}

/**
 * One blind page across several runs: every kept game from the named arms, shuffled and labelled A, B, C, ...
 * The label-to-run mapping is saved privately; the index shows only labels.
 */
export async function publishCombined(name: string, sources: { runId: string; arms: Arm[] }[], paths = defaultPaths()): Promise<string> {
  checkRunId(name);
  const games: { runId: string; arm: Arm; kept: string; hash: string }[] = [];
  for (const s of sources) {
    const m = await loadManifest(s.runId, paths);
    for (const arm of s.arms) {
      const raw = await readFile(join(paths.results, s.runId, 'private', labelOf(m, arm), 'result.json'), 'utf8');
      const r = JSON.parse(raw) as ArmResult;
      if (!r.kept || !r.keptHash) { games.push({ runId: s.runId, arm, kept: '', hash: '' }); continue; }
      if (sha(await readFile(r.kept)) !== r.keptHash) throw new Error(`kept file for ${s.runId}/${arm} changed`);
      games.push({ runId: s.runId, arm, kept: r.kept, hash: r.keptHash });
    }
  }
  const out = join(paths.output, name);
  const priv = join(paths.results, name, 'private');
  await mkdir(paths.output, { recursive: true });
  await mkdir(out, { recursive: false });
  await mkdir(priv, { recursive: true });
  const order = shuffle(games);
  const mapping: Record<string, { runId: string; arm: Arm; hash: string }> = {};
  const rows: string[] = [];
  for (const [i, g] of order.entries()) {
    const label = String.fromCharCode(65 + i);
    mapping[label] = { runId: g.runId, arm: g.arm, hash: g.hash };
    if (g.kept) {
      await writeFile(join(out, `${label}.html`), await readFile(g.kept), { flag: 'wx' });
      rows.push(`<li>Game ${label}: <a href="${label}.html">Open game</a></li>`);
    } else rows.push(`<li>Game ${label}: no playable game</li>`);
  }
  await writeFile(join(priv, 'mapping.json'), JSON.stringify({ createdAt: new Date().toISOString(), mapping }, null, 2) + '\n', { flag: 'wx' });
  const index = join(out, 'index.html');
  await writeFile(index, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Snake: Claude round</title><body style="font:16px/1.5 system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem"><h1>Snake: Claude round</h1><p>${order.length} games built from the same contract as the GPT round. Play each one and rate it by letter. The labels are random.</p><ol>${rows.join('\n')}</ol></body></html>\n`, { flag: 'wx' });
  return index;
}
