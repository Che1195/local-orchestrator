// T4 canaries: every one runs for real under sandbox-exec. Each forbidden action must fail; allowed ones must work.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkProfile, defaultToolPaths, runSandboxed, workerProfile } from '../src/sandbox';
import { makeTaskHome, scrubbedEnv, type TaskHome } from '../src/env';

let root = '';
let work = '';
let other = '';
let checkout = '';
let checkTmp = '';
let taskHome: TaskHome;
let modelServer: ReturnType<typeof Bun.serve>;
let otherServer: ReturnType<typeof Bun.serve>;
const thisRepo = resolve(import.meta.dir, '..');
const toolPaths = defaultToolPaths();
const bunBin = join(toolPaths.find(p => p.endsWith('.bun')) ?? '', 'bin');

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sbx-')));
  work = join(root, 'work');
  other = join(root, 'other');
  checkout = join(root, 'checkout');
  checkTmp = join(root, 'check-tmp');
  for (const d of [join(work, 'src'), join(work, 'node_modules'), other, join(checkout, 'src'), checkTmp]) await mkdir(d, { recursive: true });
  await writeFile(join(work, 'readme.txt'), 'ok');
  await writeFile(join(work, '.env'), 'SECRET=1');
  await writeFile(join(work, 'src', '.env.local'), 'SECRET=2');
  await writeFile(join(work, 'server.pem'), 'secret');
  await writeFile(join(other, 'secret.txt'), 'other');
  await symlink(join(other, 'secret.txt'), join(work, 'link-out'));
  await symlink(join(work, '.env'), join(work, 'link-to-env'));
  await writeFile(join(checkout, 'src', 'a.ts'), 'export {}');
  taskHome = await makeTaskHome(join(root, 'task'));
  modelServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('model') });
  otherServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('other') });
});

afterAll(async () => {
  modelServer.stop(true);
  otherServer.stop(true);
  await rm(root, { recursive: true, force: true });
});

const worker = () => workerProfile({ worktree: work, writablePaths: [join(work, 'src')], taskHome: taskHome.home, toolPaths, readOnlyPaths: [join(work, 'node_modules')], modelPort: modelServer.port });
const check = (servicePorts: number[] = []) => checkProfile({ checkout, writeDir: checkTmp, toolPaths, servicePorts });

async function allowed(profile: string, script: string): Promise<boolean> {
  const r = await runSandboxed(profile, join(root, `profile-${crypto.randomUUID()}.sb`), ['/bin/sh', '-c', script], { cwd: work, env: scrubbedEnv(taskHome, [bunBin]), timeoutMs: 15000 });
  return r.exitCode === 0;
}

const curl = (url: string) => `/usr/bin/curl -sf -m 3 ${url} >/dev/null`;

describe('worker profile', () => {
  test('allows what the worker needs', async () => {
    expect(await allowed(worker(), `cat ${work}/readme.txt`)).toBe(true);
    expect(await allowed(worker(), `echo x > ${work}/src/new.ts`)).toBe(true);
    expect(await allowed(worker(), `echo x > ${taskHome.tmp}/scratch`)).toBe(true);
    expect(await allowed(worker(), curl(`http://127.0.0.1:${modelServer.port}/`))).toBe(true);
    expect(await allowed(worker(), 'bun --version')).toBe(true);
  });

  const canaries: [string, () => string][] = [
    ['read a file in another repo', () => `cat ${thisRepo}/package.json`],
    ['read a file in another folder', () => `cat ${other}/secret.txt`],
    ['write outside the writable paths', () => `echo x > ${work}/readme.txt`],
    ['write the harness-placed node_modules', () => `echo x > ${work}/node_modules/evil.js`],
    ['read .env inside the worktree', () => `cat ${work}/.env`],
    ['read .env.local inside a writable path', () => `cat ${work}/src/.env.local`],
    ['read a .pem file', () => `cat ${work}/server.pem`],
    ['read a symlink pointing outside', () => `cat ${work}/link-out`],
    ['read a symlink pointing at .env', () => `cat ${work}/link-to-env`],
    ['connect to another local port', () => curl(`http://127.0.0.1:${otherServer.port}/`)],
    ['connect to the internet', () => curl('https://example.com/')]
  ];
  for (const [name, script] of canaries) {
    test(`blocks: ${name}`, async () => {
      expect(await allowed(worker(), script())).toBe(false);
    });
  }

  test('the scrubbed environment leaks no caller variables', async () => {
    process.env.CANARY_TOKEN = 'leak-me';
    const r = await runSandboxed(worker(), join(root, 'env.sb'), ['/usr/bin/env'], { cwd: work, env: scrubbedEnv(taskHome, [bunBin]) });
    delete process.env.CANARY_TOKEN;
    expect(r.stdout).not.toContain('leak-me');
    expect(r.stdout).toContain(`HOME=${taskHome.home}`);
    expect(r.stdout).toContain(`CLAUDE_CONFIG_DIR=${taskHome.claudeConfig}`);
  });
});

describe('check profile', () => {
  test('reads the checkout and writes only its temp folder', async () => {
    expect(await allowed(check(), `cat ${checkout}/src/a.ts && echo r > ${checkTmp}/report.xml`)).toBe(true);
    expect(await allowed(check(), `echo x > ${checkout}/src/a.ts`)).toBe(false);
    expect(await allowed(check(), `cat ${work}/readme.txt`)).toBe(false);
  });

  test('has no network, the model server included', async () => {
    expect(await allowed(check(), curl(`http://127.0.0.1:${modelServer.port}/`))).toBe(false);
    expect(await allowed(check(), curl('https://example.com/'))).toBe(false);
  });

  test('a service check may use only its declared port', async () => {
    const declared = modelServer.port ?? 0;
    expect(await allowed(check([declared]), curl(`http://127.0.0.1:${declared}/`))).toBe(true);
    expect(await allowed(check([declared]), curl(`http://127.0.0.1:${otherServer.port}/`))).toBe(false);
  });
});

test('refuses paths that could break out of a profile string', () => {
  expect(() => workerProfile({ worktree: work, writablePaths: [`${work}/src"`], taskHome: taskHome.home, toolPaths: [] })).toThrow();
  expect(() => workerProfile({ worktree: work, writablePaths: ['/etc'], taskHome: taskHome.home, toolPaths: [] })).toThrow('outside the worktree');
});
