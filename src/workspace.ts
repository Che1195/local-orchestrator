// T5: worktrees, replayable diffs, validation, clean dependencies and cleanup.

import { lstat, mkdir, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { git, must, run } from './git';

export const HARNESS_DEPS = 'node_modules';

function insideAny(path: string, roots: string[]): boolean {
  return roots.some(root => path === root || path.startsWith(root.replace(/\/$/, '') + '/'));
}

/** Refuse a repo with uncommitted changes in files the task touches. */
export async function assertClean(repo: string, paths: string[]): Promise<void> {
  const out = await git(repo, 'status', '--porcelain', '--', ...paths);
  if (out.trim() !== '') throw new Error(`repo has uncommitted changes in task paths:\n${out}`);
}

/**
 * Prepare the clean dependency folder once per task: a throwaway export of the base commit, a frozen install
 * with scripts off, then a check that no symlink in node_modules points outside it. Returns null when the
 * base commit has no package.json (artifact tasks).
 */
export async function prepareDeps(repo: string, baseCommit: string, dest: string, timeoutMs = 10 * 60_000): Promise<string | null> {
  const ls = await git(repo, 'ls-tree', '--name-only', baseCommit);
  if (!ls.split('\n').includes('package.json')) return null;
  await mkdir(dest, { recursive: true });
  const archive = Bun.spawn(['git', 'archive', baseCommit], { cwd: repo, stdout: 'pipe' });
  await must(['tar', '-x', '-C', dest], { stdin: new Uint8Array(await new Response(archive.stdout).arrayBuffer()) });
  const install = Bun.spawn(['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], { cwd: dest, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => install.kill('SIGKILL'), timeoutMs);
  const err = await new Response(install.stderr).text();
  const code = await install.exited;
  clearTimeout(timer);
  if (code !== 0) throw new Error(`dependency install failed: ${err.trim()}`);
  const deps = join(dest, HARNESS_DEPS);
  if (existsSync(deps)) await assertNoEscapingLinks(deps);
  return deps;
}

async function assertNoEscapingLinks(root: string): Promise<void> {
  const top = await realpath(root);
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = resolve(dirname(p), await readlink(p));
        if (!insideAny(target, [top, root])) throw new Error(`dependency symlink ${relative(root, p)} points outside node_modules: ${target}`);
      } else if (entry.isDirectory()) await walk(p);
    }
  };
  await walk(root);
}

/** A fresh worktree at the base commit, with an optional clone of the clean dependencies and a previous patch. */
export async function createWorktree(repo: string, baseCommit: string, dir: string, opts: { deps?: string | null; patch?: string } = {}): Promise<string> {
  await git(repo, 'worktree', 'add', '--detach', dir, baseCommit);
  if (opts.deps) await must(['cp', '-c', '-R', opts.deps, join(dir, HARNESS_DEPS)]);
  if (opts.patch && opts.patch.trim() !== '') await must(['git', 'apply', '--binary', '--whitespace=nowarn', '-'], { cwd: dir, stdin: opts.patch });
  return dir;
}

export interface Capture {
  changed: string[];
  violations: string[];
  patch: string;
}

/** List every change (tracked, staged, untracked, ignored), validate it, and build a replayable patch of the writable paths. */
export async function capture(worktree: string, baseCommit: string, writablePaths: string[]): Promise<Capture> {
  const status = await git(worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored');
  const changed = new Set<string>();
  const entries = status.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? '';
    const code = entry.slice(0, 2);
    const path = entry.slice(3).replace(/\/$/, '');
    if (code.startsWith('R') || code.startsWith('C')) i++; // the next field is the rename source
    if (path === HARNESS_DEPS || path.startsWith(HARNESS_DEPS + '/')) continue;
    changed.add(path);
  }
  const violations: string[] = [];
  for (const path of changed) if (!insideAny(path, writablePaths)) violations.push(`changed outside writable paths: ${path}`);

  let patch = '';
  const writableExisting = writablePaths.filter(p => existsSync(join(worktree, p)) || [...changed].some(c => insideAny(c, [p])));
  if (writableExisting.length > 0) {
    await git(worktree, 'add', '-A', '-f', '--', ...writableExisting);
    const raw = await git(worktree, 'diff', '--cached', '--raw', baseCommit, '--', ...writableExisting);
    for (const line of raw.split('\n').filter(Boolean)) {
      const [modes, path] = line.split('\t');
      if (modes && /\b120000\b/.test(modes)) violations.push(`symlink not allowed: ${path}`);
    }
    patch = await git(worktree, 'diff', '--cached', '--binary', baseCommit, '--', ...writableExisting);
  }
  return { changed: [...changed].sort(), violations, patch };
}

/** Save evidence: the patch and a tar of every changed file (node_modules excluded). */
export async function saveEvidence(worktree: string, cap: Capture, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'attempt.patch'), cap.patch);
  await writeFile(join(dir, 'changed.json'), JSON.stringify({ changed: cap.changed, violations: cap.violations }, null, 2));
  const present: string[] = [];
  for (const p of cap.changed) {
    try { await lstat(join(worktree, p)); present.push(p); } catch { /* deleted */ }
  }
  if (present.length > 0) await must(['tar', '-c', '-f', join(dir, 'changed-files.tar'), '--', ...present], { cwd: worktree });
}

/** Reset both the index and the files of a tool-owned worktree, then remove it normally (never --force). */
export async function cleanup(repo: string, worktree: string, baseCommit: string): Promise<void> {
  if (!existsSync(worktree)) return;
  const list = await git(repo, 'worktree', 'list', '--porcelain');
  const real = await realpath(worktree);
  if (!list.split('\n').some(l => l === `worktree ${real}` || l === `worktree ${worktree}`)) throw new Error(`${worktree} is not a worktree of ${repo}`);
  await git(worktree, 'reset', '--hard', baseCommit);
  await git(worktree, 'clean', '-fdx');
  await git(repo, 'worktree', 'remove', worktree);
  if (existsSync(worktree)) await rm(worktree, { recursive: true });
}

export { run };
