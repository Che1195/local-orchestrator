// T4: Seatbelt profiles for the worker and the checks, run with `sandbox-exec`.
// Spec §6.1 and §6.2. If a needed limit can't be expressed, fail closed: never fall back to an unsandboxed run.

import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface WorkerProfileOptions {
  /** The attempt worktree; readable. */
  worktree: string;
  /** Absolute paths inside the worktree the worker may write. */
  writablePaths: string[];
  /** Per-task home, config and temp folder; readable and writable. */
  taskHome: string;
  /** Install folders the worker program needs to read and run (for example Claude Code's and Bun's). */
  toolPaths: string[];
  /** Read-only folders inside the worktree, such as the harness-placed node_modules. */
  readOnlyPaths?: string[];
  /** The local model server's port, the only network the worker gets. */
  modelPort?: number;
}

export interface CheckProfileOptions {
  checkout: string;
  /** Temp and report folder: the only place checks may write. */
  writeDir: string;
  toolPaths: string[];
  /** Loopback ports a service check may listen on and connect to. Empty for a plain check. */
  servicePorts?: number[];
}

/** Paths are written into the profile as string literals, so refuse anything that could break out of one. */
function lit(path: string): string {
  if (!path.startsWith('/') || /["\\\n\r]/.test(path)) throw new Error(`unsafe path for a sandbox profile: ${JSON.stringify(path)}`);
  return `"${path}"`;
}

function port(p: number): number {
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`bad port ${p}`);
  return p;
}

/** Seatbelt matches resolved paths, so every path goes through realpath. */
function real(path: string): string {
  return realpathSync(path);
}

const HOME = (() => real(homedir()))();
// Shared temp roots on macOS; worktrees and task homes live under explicit allows.
const TEMP_ROOTS = ['/private/tmp', '/private/var/folders'];

const SECRET_RULES = `
; Secrets come last so they override every read allowed above.
(deny file-read* (regex #"/\\.env(\\..*)?$") (regex #"\\.(pem|key|p12)$"))
(deny file-read* (subpath ${lit(join(HOME, '.ssh'))}) (subpath ${lit(join(HOME, 'Library/Keychains'))}))
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))`;

function readsAndWrites(readable: string[], writable: string[], readOnly: string[]): string {
  const sub = (paths: string[]) => paths.map(p => `(subpath ${lit(p)})`).join(' ');
  return `
(deny file-read* (subpath ${lit(HOME)}) ${TEMP_ROOTS.map(p => `(subpath ${lit(p)})`).join(' ')})
(allow file-read* ${sub(readable)})
(deny file-write*)
(allow file-write* ${sub(writable)} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))${readOnly.length ? `
(deny file-write* ${sub(readOnly)})` : ''}`;
}

export function workerProfile(o: WorkerProfileOptions): string {
  const worktree = real(o.worktree);
  const taskHome = real(o.taskHome);
  const writable = o.writablePaths.map(p => {
    if (!p.startsWith(worktree + '/') && p !== worktree) throw new Error(`writable path ${p} is outside the worktree`);
    return p;
  });
  const readOnly = (o.readOnlyPaths ?? []).map(real);
  const network = o.modelPort === undefined ? '(deny network*)' : `(deny network*)
(allow network-outbound (remote ip "localhost:${port(o.modelPort)}"))`;
  return `(version 1)
(allow default)
${readsAndWrites([worktree, taskHome, ...o.toolPaths.map(real)], [...writable, taskHome], readOnly)}
${network}
${SECRET_RULES}
`;
}

export function checkProfile(o: CheckProfileOptions): string {
  const checkout = real(o.checkout);
  const writeDir = real(o.writeDir);
  const ports = o.servicePorts ?? [];
  const network = ports.length === 0 ? '(deny network*)' : `(deny network*)
${ports.map(p => `(allow network-bind network-inbound (local ip "localhost:${port(p)}"))
(allow network-outbound (remote ip "localhost:${port(p)}"))`).join('\n')}`;
  return `(version 1)
(allow default)
${readsAndWrites([checkout, writeDir, ...o.toolPaths.map(real)], [writeDir], [])}
(deny file-write* (subpath ${lit(checkout)}))
${network}
${SECRET_RULES}
`;
}

export interface SandboxRun {
  exitCode: number | null;
  signal: string | number | null;
  stdout: string;
  stderr: string;
}

/** Run a command under a profile. A sandbox-exec setup failure surfaces as a nonzero exit with its stderr. */
export async function runSandboxed(profile: string, profilePath: string, command: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs?: number }): Promise<SandboxRun> {
  await writeFile(profilePath, profile);
  const proc = Bun.spawn(['/usr/bin/sandbox-exec', '-f', profilePath, ...command], { cwd: opts.cwd, env: opts.env, stdout: 'pipe', stderr: 'pipe' });
  const timer = opts.timeoutMs ? setTimeout(() => proc.kill('SIGKILL'), opts.timeoutMs) : undefined;
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (timer) clearTimeout(timer);
  return { exitCode: proc.exitCode, signal: proc.signalCode, stdout, stderr };
}

/** The install folders a worker needs: Claude Code's versions folder and Bun's, resolved from PATH. */
export function defaultToolPaths(): string[] {
  const paths: string[] = [];
  for (const bin of ['claude', 'bun']) {
    const found = Bun.which(bin);
    if (!found) continue;
    const resolved = real(found);
    // claude resolves to ~/.local/share/claude/versions/<v>; bun to ~/.bun/bin/bun. Allow the install folder two levels up.
    paths.push(real(join(resolved, '..', '..')));
  }
  return paths;
}
