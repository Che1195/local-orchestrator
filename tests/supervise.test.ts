// T6: deadlines and cleanup of the whole process tree, including reparented and new-session descendants.
import { expect, test } from 'bun:test';
import { findTokenPids, supervise } from '../src/supervise';

const env = { PATH: '/usr/bin:/bin' };

test('a normal command finishes and leaves nothing behind', async () => {
  const r = await supervise(['/bin/sh', '-c', 'echo hi'], { cwd: '/tmp', env, timeoutMs: 10_000 });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe('hi\n');
  expect(r.timedOut).toBe(false);
  expect(r.survivors).toEqual([]);
});

test('a hung child and its grandchildren in a new group are killed at the deadline', async () => {
  const script = 'sleep 300 & (set -m; sleep 301 &) ; echo started; sleep 302';
  const r = await supervise(['/bin/sh', '-c', script], { cwd: '/tmp', env, timeoutMs: 1_000 });
  expect(r.timedOut).toBe(true);
  expect(r.outputAtDeadline).toBe(true);
  expect(r.survivors).toEqual([]);
  expect(await findTokenPids(r.token)).toEqual([]);
}, 20_000);

test('a reparented descendant in a new session is still found and killed after the child exits', async () => {
  // perl setsid() puts the grandchild in a new session; the parent exits at once, so it is reparented to launchd.
  const script = `perl -e 'if (fork() == 0) { require POSIX; POSIX::setsid(); exec("sleep", "303") } exit 0'`;
  const r = await supervise(['/bin/sh', '-c', script], { cwd: '/tmp', env, timeoutMs: 10_000 });
  expect(r.timedOut).toBe(false);
  expect(r.survivors).toEqual([]);
  expect(await findTokenPids(r.token)).toEqual([]);
}, 20_000);

test('no deadline means it runs to completion', async () => {
  const r = await supervise(['/bin/sh', '-c', 'sleep 1; echo done'], { cwd: '/tmp', env, timeoutMs: null });
  expect(r.stdout).toBe('done\n');
  expect(r.timedOut).toBe(false);
});
