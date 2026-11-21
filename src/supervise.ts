// T6: run a command with a deadline and make sure every descendant is gone afterwards.
// Every attempt gets a unique token in an inherited environment variable, which survives new process
// groups, new sessions and reparenting. Cleanup signals the group and every process carrying the token.

import { spawn } from 'node:child_process';

export const TOKEN_VAR = 'LOCAL_ORCH_ATTEMPT';
const GRACE_MS = 5_000;

export interface Supervised {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Output arrived in the last 30 s before the deadline (spec: report whether it was still working). */
  outputAtDeadline: boolean;
  /** Pids still carrying the token after cleanup; non-empty means the attempt is blocked. */
  survivors: number[];
  elapsedMs: number;
  token: string;
}

/** Pids of this user's processes whose environment carries the token (the caller excluded). */
export async function findTokenPids(token: string): Promise<number[]> {
  const proc = Bun.spawn(['ps', '-wwE', '-o', 'pid=,command=', '-U', String(process.getuid?.() ?? '')], { stdout: 'pipe', stderr: 'ignore' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const needle = `${TOKEN_VAR}=${token}`;
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!m || !m[1] || !m[2]) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || pid === proc.pid) continue;
    if (m[2].split(/\s+/).includes(needle)) pids.push(pid);
  }
  return pids;
}

async function signalAll(groupPid: number | undefined, token: string, sig: NodeJS.Signals): Promise<void> {
  if (groupPid !== undefined) {
    try { process.kill(-groupPid, sig); } catch { /* group gone */ }
  }
  // Re-read the token right before signalling so a reused pid is never hit.
  for (const pid of await findTokenPids(token)) {
    try { process.kill(pid, sig); } catch { /* already gone */ }
  }
}

export async function supervise(command: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number | null; onStdout?: (chunk: string) => void; stdin?: string }): Promise<Supervised> {
  const token = crypto.randomUUID();
  const started = Date.now();
  const [bin, ...args] = command;
  if (!bin) throw new Error('empty command');
  const child = spawn(bin, args, { cwd: opts.cwd, env: { ...opts.env, [TOKEN_VAR]: token }, detached: true, stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  let stdout = '';
  let stderr = '';
  let lastOutput = started;
  child.stdout?.setEncoding('utf8').on('data', (c: string) => { stdout += c; lastOutput = Date.now(); opts.onStdout?.(c); });
  child.stderr?.setEncoding('utf8').on('data', (c: string) => { stderr += c; lastOutput = Date.now(); });

  let timedOut = false;
  let outputAtDeadline = false;
  // 'exit' is the child itself; 'close' also waits for every holder of its pipes, which a stray grandchild can keep open.
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  const closed = new Promise<void>(resolve => child.on('close', () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = opts.timeoutMs === null ? null : new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), opts.timeoutMs ?? 0); });
  const first = await (deadline ? Promise.race([exited, deadline]) : exited);
  if (first === 'deadline') {
    timedOut = true;
    outputAtDeadline = Date.now() - lastOutput < 30_000;
    await signalAll(child.pid, token, 'SIGTERM');
    await Promise.race([exited, Bun.sleep(GRACE_MS)]);
    await signalAll(child.pid, token, 'SIGKILL');
  }
  if (timer) clearTimeout(timer);
  const { code, signal } = await exited;

  // Whatever the outcome, nothing may outlive the attempt.
  let survivors = await findTokenPids(token);
  if (survivors.length > 0) {
    await signalAll(child.pid, token, 'SIGTERM');
    await Bun.sleep(1_000);
    await signalAll(child.pid, token, 'SIGKILL');
    await Bun.sleep(500);
    survivors = await findTokenPids(token);
  }
  await Promise.race([closed, Bun.sleep(2_000)]);
  return { exitCode: code, signal, stdout, stderr, timedOut, outputAtDeadline, survivors, elapsedMs: Date.now() - started, token };
}
