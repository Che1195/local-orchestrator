// Snake evaluation: a standalone headless Claude session on Che's normal login, inside a Seatbelt profile
// that hides Che's instructions and memory, the other arms, the private results and CHE-1166's repo.

import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { supervise } from '../supervise';

export interface OpusCall {
  workspace: string;
  /** Folders and files the session must not read (other arms, results, mapping, CHE-1166, output). */
  hidden: string[];
  /** Write access to <workspace>/src; false for planner and reviewer sessions. */
  canWrite: boolean;
  tools: string[];
  prompt: string;
  profilePath: string;
  jsonSchema?: object;
  /** Extra folders the session may read (passed as --add-dir too), such as browser evidence. */
  readable?: string[];
  model?: string;
  effort?: string;
}

export interface OpusResult {
  sessionId: string;
  exitCode: number | null;
  isError: boolean;
  resultText: string;
  structured: unknown;
  stopReason: string | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  survivors: number[];
}

const lit = (p: string): string => {
  if (!p.startsWith('/') || /["\\\n\r]/.test(p)) throw new Error(`unsafe path ${p}`);
  return `"${p}"`;
};
const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

export function opusProfile(workspace: string, hidden: string[], canWrite: boolean, readable: string[] = []): string {
  const home = real(homedir());
  const ws = real(workspace);
  const projects = join(home, 'projects');
  return `(version 1)
(allow default)
; Hide Che's own instructions, memory, skills and rules, and any CLAUDE.md or AGENTS.md outside the workspace.
(deny file-read* (literal ${lit(join(home, '.claude', 'CLAUDE.md'))}) (subpath ${lit(join(home, '.claude', 'skills'))}) (subpath ${lit(join(home, '.claude', 'rules'))}) (subpath ${lit(join(home, '.claude', 'agents'))}) (subpath ${lit(join(home, '.claude', 'plugins'))}) (subpath ${lit(join(home, '.agents'))}) (subpath ${lit(join(home, '.codex'))}))
(deny file-read* (regex #"/\\.claude/projects/[^/]+/memory(/|$)") (regex #"/(CLAUDE|CLAUDE\\.local|AGENTS)\\.md$"))
; Hide the other arms, results, mapping, output and CHE-1166's repo: contents and listings, not metadata,
; so Claude Code can still resolve the workspace's parent folders.
(deny file-read-data ${hidden.map(p => `(subpath ${lit(real(p))})`).join(' ')})
(allow file-read* file-read-data (subpath ${lit(ws)})${readable.map(p => ` (subpath ${lit(real(p))})`).join('')})
; No writes anywhere under ~/projects except this arm's src folder (and none at all for read-only roles).
(deny file-write* (subpath ${lit(projects)}))${canWrite ? `
(allow file-write* (subpath ${lit(join(ws, 'src'))}))` : ''}
`;
}

/** Only what a login session needs; nothing from this harness's own Claude Code environment. */
export function opusEnv(): Record<string, string> {
  const env: Record<string, string> = { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export function opusCommand(claudeBin: string, c: OpusCall, sessionId: string): string[] {
  const cmd = [claudeBin, '-p', '--model', c.model ?? 'claude-opus-5-5', '--effort', c.effort ?? 'high', '--session-id', sessionId,
    '--tools', c.tools.join(','), '--permission-mode', c.canWrite ? 'acceptEdits' : 'default', '--strict-mcp-config', '--setting-sources', '',
    '--disable-slash-commands', '--output-format', 'json'];
  if (c.jsonSchema) cmd.push('--json-schema', JSON.stringify(c.jsonSchema));
  for (const dir of c.readable ?? []) cmd.push('--add-dir', dir);
  return cmd;
}

interface JsonResult { is_error?: boolean; result?: string; structured_output?: unknown; stop_reason?: string; session_id?: string }

export async function runOpus(c: OpusCall): Promise<OpusResult> {
  const found = Bun.which('claude');
  if (!found) throw new Error('claude is not on PATH');
  await writeFile(c.profilePath, opusProfile(c.workspace, c.hidden, c.canWrite, c.readable));
  const sessionId = crypto.randomUUID();
  const r = await supervise(['/usr/bin/sandbox-exec', '-f', c.profilePath, ...opusCommand(real(found), c, sessionId)], { cwd: c.workspace, env: opusEnv(), timeoutMs: null, stdin: c.prompt });
  let j: JsonResult = {};
  try { j = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as JsonResult; } catch { /* left empty */ }
  return {
    sessionId, exitCode: r.exitCode, isError: j.is_error !== false, resultText: j.result ?? '', structured: j.structured_output ?? null,
    stopReason: j.stop_reason ?? null, elapsedMs: r.elapsedMs, stdout: r.stdout, stderr: r.stderr, survivors: r.survivors
  };
}
