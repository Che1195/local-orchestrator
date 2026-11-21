// T8: headless Claude Code as the worker program, pointed at a local Anthropic-compatible model server
// and run inside the Worker Seatbelt profile. Seatbelt is the boundary, so permissions are bypassed inside.

import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultToolPaths, workerProfile } from '../sandbox';
import { makeTaskHome, scrubbedEnv } from '../env';
import { supervise } from '../supervise';

export const CODE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'] as const;
// Inkling calls Bash even when told not to run anything. LM Studio constrains tool calls to the
// listed tools, and an unlisted name crashes its decoder (500 "empty grammar stack"), so it is listed.
// The Worker Seatbelt profile is the boundary: no network, writes only to the writable paths.
export const ARTIFACT_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'] as const;

export interface LocalModel {
  /** Model id the server knows, for example inkling2-mini-q4. */
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** http://127.0.0.1:<port> */
  baseUrl: string;
  /** The server's context window; Claude Code compacts against it. */
  contextWindow: number;
  maxOutputTokens: number;
}

export interface WorkerRun {
  worktree: string;
  /** Absolute paths inside the worktree the worker may write. */
  writablePaths: string[];
  /** Folder for this attempt's task home, profile and logs. */
  attemptDir: string;
  prompt: string;
  tools: readonly string[];
  timeoutMs: number | null;
  readOnlyPaths?: string[];
}

export type WorkerStatus = 'finished' | 'model-fail' | 'infra-fail' | 'blocked';

export interface WorkerResult {
  status: WorkerStatus;
  reason: string;
  sessionId: string;
  exitCode: number | null;
  timedOut: boolean;
  outputAtDeadline: boolean;
  survivors: number[];
  elapsedMs: number;
  /** Tools the session reported at start: proof of what existed. */
  toolsSeen: string[];
  resultText: string;
  numTurns: number | null;
  /** The worker program's own token counts (local model; not cost-weighted). */
  localUsage: { input: number; output: number } | null;
  streamLog: string;
  stderrLog: string;
  configDir: string;
}

const INFRA = /API Error|ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|Connection error|\b5\d\d\b|overloaded|Unable to connect/i;

export function claudeCommand(claudeBin: string, m: LocalModel, tools: readonly string[], sessionId: string): string[] {
  return [claudeBin, '-p', '--model', m.model, '--effort', m.effort, '--session-id', sessionId, '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--setting-sources', '', '--permission-mode', 'bypassPermissions', '--autocompact', String(m.contextWindow), '--tools', tools.join(',')];
}

export function localEnv(m: LocalModel, tmp: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: m.baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'local-model',
    // Every model slot points at the local model, so no side request reaches another model.
    ANTHROPIC_DEFAULT_HAIKU_MODEL: m.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: m.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m.model,
    CLAUDE_CODE_SUBAGENT_MODEL: m.model,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(m.maxOutputTokens),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(m.contextWindow),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_TMPDIR: tmp
  };
}

interface StreamLine {
  type?: string;
  subtype?: string;
  tools?: string[];
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

export function parseStream(stdout: string): { toolsSeen: string[]; result: StreamLine | null; last: StreamLine | null } {
  let toolsSeen: string[] = [];
  let result: StreamLine | null = null;
  let last: StreamLine | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let j: StreamLine;
    try { j = JSON.parse(line) as StreamLine; } catch { continue; }
    if (j.type === 'system' && j.subtype === 'init' && Array.isArray(j.tools)) toolsSeen = j.tools;
    if (j.type === 'result') result = j;
    last = j;
  }
  return { toolsSeen, result, last };
}

export async function runClaudeWorker(m: LocalModel, w: WorkerRun): Promise<WorkerResult> {
  await mkdir(w.attemptDir, { recursive: true });
  const attemptDir = await realpath(w.attemptDir);
  const home = await makeTaskHome(join(attemptDir, 'task'));
  const toolPaths = defaultToolPaths();
  const bunBin = join(toolPaths.find(p => p.endsWith('.bun')) ?? '', 'bin');
  const claudePath = Bun.which('claude');
  if (!claudePath) throw new Error('claude is not on PATH');
  const claudeBin = await realpath(claudePath);
  const port = Number(new URL(m.baseUrl).port);
  const profile = workerProfile({ worktree: w.worktree, writablePaths: w.writablePaths, taskHome: home.home, toolPaths, readOnlyPaths: w.readOnlyPaths, modelPort: port });
  const profilePath = join(attemptDir, 'worker.sb');
  await writeFile(profilePath, profile);
  const sessionId = crypto.randomUUID();
  const env = scrubbedEnv(home, [bunBin], localEnv(m, home.tmp));
  const r = await supervise(['/usr/bin/sandbox-exec', '-f', profilePath, ...claudeCommand(claudeBin, m, w.tools, sessionId)], { cwd: w.worktree, env, timeoutMs: w.timeoutMs, stdin: w.prompt });
  const streamLog = join(attemptDir, 'stream.jsonl');
  const stderrLog = join(attemptDir, 'stderr.log');
  await writeFile(streamLog, r.stdout);
  await writeFile(stderrLog, r.stderr);
  const { toolsSeen, result, last } = parseStream(r.stdout);

  let status: WorkerStatus;
  let reason: string;
  if (r.survivors.length > 0) { status = 'blocked'; reason = `processes outlived the attempt: ${r.survivors.join(',')}`; }
  // Still retrying server errors when time ran out: the server, not the model, failed.
  else if (r.timedOut && last?.type === 'system' && last.subtype === 'api_retry') { status = 'infra-fail'; reason = 'deadline reached while retrying server errors'; }
  else if (r.timedOut) { status = 'model-fail'; reason = `deadline reached${r.outputAtDeadline ? ' while output was still arriving' : ''}`; }
  else if (result && !result.is_error && r.exitCode === 0) { status = 'finished'; reason = 'worker finished'; }
  else {
    const text = `${result?.result ?? ''}\n${r.stderr}`;
    status = INFRA.test(text) ? 'infra-fail' : 'model-fail';
    reason = (result?.result ?? r.stderr).trim().slice(0, 500) || `exit ${r.exitCode}`;
  }
  const u = result?.usage;
  return {
    status, reason, sessionId, exitCode: r.exitCode, timedOut: r.timedOut, outputAtDeadline: r.outputAtDeadline, survivors: r.survivors,
    elapsedMs: r.elapsedMs, toolsSeen, resultText: result?.result ?? '', numTurns: result?.num_turns ?? null,
    localUsage: u ? { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens ?? 0 } : null,
    streamLog, stderrLog, configDir: home.claudeConfig
  };
}
