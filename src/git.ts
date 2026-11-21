// Small git and shell helpers shared by the workspace and checks.

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string>; stdin?: string | Uint8Array } = {}): Promise<Run> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ?? (process.env as Record<string, string>),
    stdin: opts.stdin === undefined ? 'ignore' : new Blob([opts.stdin]),
    stdout: 'pipe',
    stderr: 'pipe'
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

export async function must(cmd: string[], opts: Parameters<typeof run>[1] = {}): Promise<string> {
  const r = await run(cmd, opts);
  if (r.code !== 0) throw new Error(`${cmd.join(' ')} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

export const git = (cwd: string, ...args: string[]) => must(['git', ...args], { cwd });
