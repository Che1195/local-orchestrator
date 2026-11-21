// The "best possible" hybrid arm, added at Che's request on 2026-11-21. It is not part of CHE-1166's protocol.
// Claude plans; Inkling builds; the harness plays each build in sandboxed headless Chromium; Claude reviews the
// code with that evidence and always sends a fix list. Four builds in all, then Claude picks the best version.

import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './git';
import { playEvidence } from './play';
import { BOUNDARY, IMPLEMENT, RETRY, render } from '../snake/prompts';
import { CHE1166, OUTPUT_ROOT, REPO, checkRunId, decisionSchema, defaultPaths, hashTree, readDecision, realRunners, scopeViolations, sha, verifyInputs, type ArmResult, type Manifest, type Paths, type Runners } from './snake';
import { sessionUsage } from './usage';
import { ARTIFACT_TOOLS } from './workers/claude-code';

export const BUILDS = 4;
const STARTER = join(REPO, 'snake', 'starter');

export const PLUS_PLANNER = `You are the orchestrator. A smaller local model (the worker) will build this game in src/snake.html over ${BUILDS} builds. After each build you will see screenshots and a report from a scripted headless browser run, and you will send the worker a fix list. Give the first assignment: a clear, complete, well-organized specification of what to build, written so a smaller model can follow it step by step. Do not write the code. Use decision implement, with the specification as the assignment.`;

export function plusReview(build: number, evidenceDir: string): string {
  return `You are the orchestrator improving the worker's Snake game toward the best possible version of TASK.md. This is build ${build} of ${BUILDS}.
Read TASK.md, src/snake.html, and the browser evidence for this build in ${evidenceDir}: report.json and every screenshot (open each PNG with Read). The scripted run: load the page, press Start, ArrowUp, ArrowLeft, Pause and wait 1.2 s, Resume, 8 s with no input (expect a wall hit and game over), Restart, plus a phone-size screenshot. The script can't judge feel or every rule, so also read the code carefully.
Write the most valuable fix list for the next build: broken behavior first, then contract gaps, then visual polish and feel. Be concrete and scoped to src/snake.html; the worker edits its existing file. No replacement code. Always use decision revise with the fix list as the assignment, even if the game is already good: there is always something to improve. Builds left after this review: ${BUILDS - build}.`;
}

export function plusSelect(evidenceRoot: string, versions: string[]): string {
  return `You are the orchestrator. The worker made ${versions.length} builds of the Snake game. Each one is in ${evidenceRoot}/<version>/ with snake.html, report.json and screenshots. Versions: ${versions.join(', ')}.
Read TASK.md, then each version's code, report and screenshots. Choose the one version Che should play: the best overall against TASK.md, with correctness first, then completeness, then look and feel. A later build is not automatically better; pick a regression-free version.`;
}

export const selectSchema = (versions: string[]) => ({
  type: 'object', additionalProperties: false,
  properties: { choice: { type: 'string', enum: versions }, rationale: { type: 'string' } },
  required: ['choice', 'rationale']
});

export async function preparePlus(id: string, local: Manifest['local'], paths = defaultPaths()): Promise<Manifest> {
  checkRunId(id);
  const { starterHash, taskHash } = await verifyInputs();
  if (existsSync(join(paths.results, id))) throw new Error('run already exists');
  const priv = join(paths.results, id, 'private');
  await mkdir(priv, { recursive: true });
  const ws = join(paths.runs, id, 'A', 'workspace');
  await cp(STARTER, ws, { recursive: true, errorOnExist: true, force: false });
  await mkdir(join(ws, 'src'));
  await writeFile(join(ws, '.gitignore'), '');
  await git(ws, 'init', '-q', '-b', 'snake');
  await git(ws, 'add', '--all');
  await git(ws, '-c', 'user.name=Evaluation Fixture', '-c', 'user.email=eval@localhost', 'commit', '-q', '--no-gpg-sign', '-m', 'Frozen Snake contract');
  const m: Manifest = {
    protocol: 'claude-snake-plus-v1', runId: id, preparedAt: new Date().toISOString(), starterHash, taskHash,
    che1166: { codeCommit: '522d0eb45d20a8517a4b56b089c93fd15daee121', acceptedRun: 'snake-20261121-02', promptsVerified: true },
    harnessCommit: (await git(REPO, 'rev-parse', 'HEAD')).trim(), maxAttempts: BUILDS,
    claude: { model: 'claude-opus-5-5', effort: 'high' }, local, labels: { plus: 'A' }, order: ['plus'],
    limitations: [
      'Not CHE-1166\'s protocol: Claude reviews with headless browser evidence and always revises; four builds, then Claude picks the best.',
      'The browser script is generic: it presses Start, two turns, Pause/Resume, idles to a wall and restarts. It cannot judge feel.',
      'Worker prompts use CHE-1166\'s boundary and implementation template; planner, review and selection prompts are new (src/snake-plus.ts).'
    ]
  };
  await writeFile(join(priv, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  return m;
}

export async function runPlus(id: string, paths: Paths = defaultPaths(), runners: Runners = realRunners(), play = playEvidence): Promise<ArmResult> {
  checkRunId(id);
  const m = JSON.parse(await readFile(join(paths.results, id, 'private', 'manifest.json'), 'utf8')) as Manifest;
  if (m.protocol !== 'claude-snake-plus-v1') throw new Error('not a best-possible run');
  const dir = join(paths.results, id, 'private', 'A');
  if (existsSync(join(dir, 'result.json'))) throw new Error('already ran; never overwrite');
  await mkdir(dir, { recursive: true });
  const ws = join(paths.runs, id, 'A', 'workspace');
  const evidenceRoot = join(paths.runs, id, 'A', 'evidence');
  await mkdir(evidenceRoot, { recursive: true });
  if ((await scopeViolations(ws)).length || (await readdir(join(ws, 'src'))).length) throw new Error('workspace is not fresh');
  const task = await readFile(join(ws, 'TASK.md'), 'utf8');
  const start = Date.now();
  const r: ArmResult = { label: 'A', arm: 'plus', startedAt: new Date(start).toISOString(), elapsedMs: 0, outcome: 'running', calls: [], attempts: [], kept: null, keptHash: null, harnessCommit: (await git(REPO, 'rev-parse', 'HEAD')).trim() };
  const save = async () => { r.elapsedMs = Date.now() - start; await writeFile(join(dir, 'result.json'), JSON.stringify(r, null, 2) + '\n'); };
  const hidden = [REPO, OUTPUT_ROOT, CHE1166, paths.results, paths.runs, paths.output];
  const versions: { name: string; kept: string; hash: string }[] = [];

  async function ask(role: string, prompt: string, schema: object, readable: string[]): Promise<unknown> {
    const before = await hashTree(join(ws, 'src'));
    const c = await runners.opus({ workspace: ws, hidden, canWrite: false, tools: ['Read', 'Glob', 'Grep'], prompt, profilePath: join(dir, `${role}.sb`), jsonSchema: schema, readable, model: m.claude.model, effort: m.claude.effort });
    r.calls.push({ id: `${role}-${r.calls.length + 1}`, role, model: m.claude.model, sessionId: c.sessionId, configDir: runners.claudeConfigDir, exitCode: c.exitCode, status: c.isError ? 'error' : 'ok', elapsedMs: c.elapsedMs });
    await writeFile(join(dir, `${role}.json`), c.stdout);
    await save();
    if (before !== await hashTree(join(ws, 'src')) || (await scopeViolations(ws)).length) throw new Error('Read-only role changed frozen scope');
    if (c.exitCode !== 0 || c.isError) throw new Error(`Claude ${role} failed: ${c.resultText.slice(0, 300) || c.stderr.slice(0, 300)}`);
    return c.structured;
  }

  try {
    const plan = readDecision(await ask('plan', `${PLUS_PLANNER} ${BOUNDARY}\nPRODUCT CONTRACT\n${task}`, decisionSchema, []));
    if (plan.decision !== 'implement') throw new Error('Planner did not assign implementation');
    let assignment = plan.assignment;
    for (let build = 1; build <= BUILDS; build++) {
      const roundDir = join(dir, `round-${build}`);
      await mkdir(roundDir, { recursive: true });
      console.log(`SNAKE_RUN A build ${build}`);
      const w = await runners.local(m.local, { worktree: ws, writablePaths: [join(ws, 'src')], attemptDir: roundDir, prompt: render(IMPLEMENT, { boundary: BOUNDARY, task, assignment }), tools: ARTIFACT_TOOLS, timeoutMs: null });
      r.calls.push({ id: `implement-${build}`, role: 'implement', model: m.local.model, sessionId: w.sessionId, configDir: w.configDir, exitCode: w.exitCode, status: w.status, elapsedMs: w.elapsedMs });
      const scope = await scopeViolations(ws);
      if (scope.length) { r.attempts.push({ round: build, scope, present: false, hash: null, bytes: 0 }); throw new Error('Scope violation: ' + scope.join('; ')); }
      const contents = await readFile(join(ws, 'src', 'snake.html')).catch(() => null);
      const present = contents !== null && contents.length > 0;
      r.attempts.push({ round: build, scope, present, hash: present ? sha(contents) : null, bytes: contents?.length ?? 0 });
      await save();
      const ok = w.status === 'finished' && present;
      let evidence = '';
      if (present) {
        const kept = join(roundDir, 'artifact.html');
        await writeFile(kept, contents, { flag: 'wx' });
        const name = `v${build}`;
        evidence = join(evidenceRoot, name);
        await mkdir(evidence);
        await writeFile(join(evidence, 'snake.html'), contents);
        await play(join(evidence, 'snake.html'), evidence);
        versions.push({ name, kept, hash: sha(contents) });
      }
      if (build === BUILDS) break;
      if (ok) {
        const review = readDecision(await ask(`review-${build}`, `${plusReview(build, evidence)} ${BOUNDARY}\nPRODUCT CONTRACT\n${task}`, decisionSchema, [evidence]));
        r.review = review.rationale;
        if (review.decision === 'blocked') throw new Error('Claude review blocked: ' + review.rationale);
        assignment = review.assignment.trim() || assignment;
      } else {
        assignment = render(RETRY, { 'call.exitCode': String(w.exitCode), 'call.stopReason': w.status, present: String(present) });
      }
    }
    if (versions.length === 0) throw new Error('no build produced a file');
    const names = versions.map(v => v.name);
    const pick = (await ask('select', `${plusSelect(evidenceRoot, names)} ${BOUNDARY}\nPRODUCT CONTRACT\n${task}`, selectSchema(names), [evidenceRoot])) as { choice?: string; rationale?: string } | null;
    const chosen = versions.find(v => v.name === pick?.choice);
    if (!chosen) throw new Error('selection did not name a version');
    r.kept = chosen.kept;
    r.keptHash = chosen.hash;
    r.review = `chose ${chosen.name}: ${pick?.rationale ?? ''}`;
    r.outcome = 'artifact_ready_for_user';
  } catch (e) {
    r.outcome = 'failed';
    r.error = String(e);
    const last = versions[versions.length - 1];
    if (last) { r.kept = last.kept; r.keptHash = last.hash; }
  } finally {
    for (const c of r.calls) c.usage = await sessionUsage(c.configDir, c.sessionId);
    await save();
  }
  console.log(`SNAKE_END A ${r.outcome}`);
  return r;
}

if (import.meta.main) {
  const [mode, id, json] = process.argv.slice(2);
  if (!mode || !id) throw new Error('usage: bun src/snake-plus.ts prepare|run <run id> [local model JSON]');
  if (mode === 'prepare') console.log(JSON.stringify(await preparePlus(id, JSON.parse(json ?? '{}') as Manifest['local']), null, 2));
  else if (mode === 'run') { const r = await runPlus(id); console.log(JSON.stringify({ outcome: r.outcome, builds: r.attempts.length, review: r.review?.slice(0, 200) })); }
  else throw new Error('unknown mode');
}
