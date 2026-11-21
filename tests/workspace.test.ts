// T5: worktrees, diffs, validation, clean deps and cleanup, on a throwaway fixture repo.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git';
import { assertClean, capture, cleanup, createWorktree, saveEvidence } from '../src/workspace';

let root = '';
let repo = '';
let base = '';
let n = 0;
const wt = () => join(root, `wt-${n++}`);

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ws-')));
  repo = join(root, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 't@t');
  await git(repo, 'config', 'user.name', 't');
  await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(repo, 'src', 'gone.ts'), 'export {};\n');
  await writeFile(join(repo, 'readme.md'), 'hi\n');
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n*.log\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'base');
  base = (await git(repo, 'rev-parse', 'HEAD')).trim();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test('clean repo passes; dirty task path is refused', async () => {
  await assertClean(repo, ['src']);
  await writeFile(join(repo, 'src', 'a.ts'), 'dirty\n');
  await expect(assertClean(repo, ['src'])).rejects.toThrow('uncommitted');
  await git(repo, 'checkout', '--', 'src/a.ts');
});

test('captures modified, added, deleted, ignored and untracked files, and replays them', async () => {
  const deps = join(root, 'deps');
  await mkdir(join(deps, 'pkg'), { recursive: true });
  await writeFile(join(deps, 'pkg', 'index.js'), 'clean');
  const w = await createWorktree(repo, base, wt(), { deps });
  await writeFile(join(w, 'src', 'a.ts'), 'export const a = 2;\n');
  await rm(join(w, 'src', 'gone.ts'));
  await mkdir(join(w, 'src', 'deep'), { recursive: true });
  await writeFile(join(w, 'src', 'deep', 'new.ts'), 'export const b = 1;\n');
  await writeFile(join(w, 'src', 'debug.log'), 'ignored but in a writable path\n');
  await writeFile(join(w, 'node_modules', 'pkg', 'index.js'), 'TAMPERED');

  const cap = await capture(w, base, ['src']);
  expect(cap.violations).toEqual([]);
  expect(cap.changed).toEqual(['src/a.ts', 'src/debug.log', 'src/deep/new.ts', 'src/gone.ts']);
  expect(cap.patch).not.toContain('TAMPERED');

  const ev = join(root, 'evidence');
  await saveEvidence(w, cap, ev);
  expect(existsSync(join(ev, 'attempt.patch'))).toBe(true);
  expect(existsSync(join(ev, 'changed-files.tar'))).toBe(true);

  // The check checkout: fresh worktree, clean deps, the patch replayed.
  const check = await createWorktree(repo, base, wt(), { deps, patch: cap.patch });
  expect(await readFile(join(check, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
  expect(await readFile(join(check, 'src', 'deep', 'new.ts'), 'utf8')).toBe('export const b = 1;\n');
  expect(existsSync(join(check, 'src', 'gone.ts'))).toBe(false);
  expect(existsSync(join(check, 'src', 'debug.log'))).toBe(true);
  expect(await readFile(join(check, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('clean');

  await cleanup(repo, w, base);
  await cleanup(repo, check, base);
  expect(existsSync(w)).toBe(false);
  expect(existsSync(check)).toBe(false);
});

test('flags changes outside the writable paths, including ignored files', async () => {
  const w = await createWorktree(repo, base, wt());
  await writeFile(join(w, 'readme.md'), 'changed\n');
  await writeFile(join(w, 'notes.log'), 'ignored outside\n');
  const cap = await capture(w, base, ['src']);
  expect(cap.violations).toContain('changed outside writable paths: readme.md');
  expect(cap.violations).toContain('changed outside writable paths: notes.log');
  expect(cap.patch).toBe('');
  await cleanup(repo, w, base);
});

test('rejects a symlink inside a writable path', async () => {
  const w = await createWorktree(repo, base, wt());
  await symlink('/etc/passwd', join(w, 'src', 'link.ts'));
  const cap = await capture(w, base, ['src']);
  expect(cap.violations).toContain('symlink not allowed: src/link.ts');
  await cleanup(repo, w, base);
});

test('cleanup refuses a folder that is not a worktree of the repo', async () => {
  const stray = join(root, 'stray');
  await mkdir(stray);
  await expect(cleanup(repo, stray, base)).rejects.toThrow('not a worktree');
});
