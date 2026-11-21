// T12: usage counting on transcript-shaped fixtures (schema from Claude Code 2.1.329).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionUsage, sumUsage, weigh } from '../src/usage';

let cfg = '';
const rec = (id: string | undefined, usage?: Record<string, number>, model = 'claude-opus-5-5') => JSON.stringify({ type: 'assistant', message: { id, model, usage } });

beforeAll(async () => {
  cfg = await mkdtemp(join(tmpdir(), 'usage-'));
  const slug = join(cfg, 'projects', '-tmp-ws');
  await mkdir(join(slug, 'good', 'subagents'), { recursive: true });
  await writeFile(join(slug, 'good.jsonl'), [
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    rec('m1', { input_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 5 }),
    rec('m1', { input_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 50 }),
    rec('m2', { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: 20 }),
    rec('synthetic', undefined, '<synthetic>')
  ].join('\n'));
  await writeFile(join(slug, 'good', 'subagents', 'agent-x.jsonl'), rec('s1', { input_tokens: 10, output_tokens: 10 }, 'claude-haiku-5-5'));
  await writeFile(join(slug, 'bad.jsonl'), [rec('m1', { input_tokens: 1, output_tokens: 1 }), rec('m2')].join('\n'));
});
afterAll(async () => { await rm(cfg, { recursive: true, force: true }); });

test('repeated message ids count once, using the last record; subagents are included', async () => {
  const r = await sessionUsage(cfg, 'good');
  if (!r.known) throw new Error(r.reason);
  expect(r.usage).toMatchObject({ input: 13, cacheWrite: 100, cacheRead: 1000, output: 80, calls: 3 });
  expect(r.usage.weighted).toBe(13 + 125 + 100 + 400);
  expect(r.usage.models).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']);
});

test('a missing usage field makes the session unknown, and unknown spreads to totals', async () => {
  const bad = await sessionUsage(cfg, 'bad');
  expect(bad.known).toBe(false);
  const good = await sessionUsage(cfg, 'good');
  expect(sumUsage([good, bad]).known).toBe(false);
  expect((await sessionUsage(cfg, 'nope')).known).toBe(false);
});

test('weights', () => {
  expect(weigh({ input: 1, cacheWrite: 4, cacheRead: 10, output: 1 })).toBe(1 + 5 + 1 + 5);
});
