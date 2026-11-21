// T4: the scrubbed environment every sandboxed process gets. Nothing is inherited except an allowlist.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const INHERITED = ['LANG', 'LC_ALL', 'TERM'] as const;

export interface TaskHome {
  home: string;
  tmp: string;
  claudeConfig: string;
}

export async function makeTaskHome(root: string): Promise<TaskHome> {
  const home = join(root, 'home');
  const tmp = join(home, 'tmp');
  const claudeConfig = join(home, '.claude');
  for (const dir of [home, tmp, claudeConfig]) await mkdir(dir, { recursive: true });
  return { home, tmp, claudeConfig };
}

/**
 * Build a clean environment: fresh HOME, TMPDIR and CLAUDE_CONFIG_DIR, a PATH of system folders plus the
 * given tool bins, a few harmless inherited locale variables, and any explicit extras. No tokens, keys or
 * other variables from the caller's shell leak through.
 */
export function scrubbedEnv(taskHome: TaskHome, toolBins: string[], extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    HOME: taskHome.home,
    TMPDIR: taskHome.tmp,
    CLAUDE_CONFIG_DIR: taskHome.claudeConfig,
    PATH: [...toolBins, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
  };
  for (const key of INHERITED) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}
