// T12: usage from Claude Code transcripts (schema seen in 2.1.329).
// Main transcript: <config>/projects/<slug>/<session>.jsonl. Subagents: <config>/projects/<slug>/<session>/subagents/*.jsonl.
// Streaming writes several records per API message with the same message.id; each response counts once, using its last record.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Usage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  calls: number;
  /** input + 1.25 × cache writes + 0.1 × cache reads + 5 × output */
  weighted: number;
  models: string[];
  files: string[];
}

export type UsageResult = { known: true; usage: Usage } | { known: false; reason: string; files: string[] };

interface RawUsage { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number }
interface Record_ { type?: string; message?: { id?: string; model?: string; usage?: RawUsage } }

export const weigh = (u: { input: number; cacheWrite: number; cacheRead: number; output: number }): number =>
  u.input + 1.25 * u.cacheWrite + 0.1 * u.cacheRead + 5 * u.output;

export async function sessionFiles(configDir: string, sessionId: string): Promise<string[]> {
  const projects = join(configDir, 'projects');
  if (!existsSync(projects)) return [];
  const files: string[] = [];
  for (const slug of await readdir(projects)) {
    const main = join(projects, slug, `${sessionId}.jsonl`);
    if (existsSync(main)) files.push(main);
    const subs = join(projects, slug, sessionId, 'subagents');
    if (existsSync(subs)) for (const f of await readdir(subs)) if (f.endsWith('.jsonl')) files.push(join(subs, f));
  }
  return files;
}

export function usageFromLines(lines: string[]): { byId: Map<string, { model: string; usage: RawUsage | undefined }>; missing: number } {
  const byId = new Map<string, { model: string; usage: RawUsage | undefined }>();
  let missing = 0;
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let r: Record_;
    try { r = JSON.parse(line) as Record_; } catch { continue; }
    if (r.type !== 'assistant' || !r.message) continue;
    const id = r.message.id;
    if (!id) { missing++; continue; }
    // A synthetic message (for example an interrupted turn) carries model "<synthetic>" and no real usage; skip it.
    if (r.message.model === '<synthetic>') continue;
    byId.set(id, { model: r.message.model ?? 'unknown', usage: r.message.usage });
  }
  return { byId, missing };
}

export async function sessionUsage(configDir: string, sessionId: string): Promise<UsageResult> {
  const files = await sessionFiles(configDir, sessionId);
  if (files.length === 0) return { known: false, reason: `no transcript for session ${sessionId} under ${configDir}`, files };
  const lines: string[] = [];
  for (const f of files) lines.push(...(await readFile(f, 'utf8')).split('\n'));
  const { byId, missing } = usageFromLines(lines);
  if (missing > 0) return { known: false, reason: `${missing} assistant records without a message id`, files };
  const u = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const models = new Set<string>();
  for (const [id, { model, usage }] of byId) {
    if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return { known: false, reason: `message ${id} has no usage`, files };
    u.input += usage.input_tokens;
    u.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    u.cacheRead += usage.cache_read_input_tokens ?? 0;
    u.output += usage.output_tokens;
    models.add(model);
  }
  return { known: true, usage: { ...u, calls: byId.size, weighted: weigh(u), models: [...models].sort(), files } };
}

/** Sum several sessions; any unknown makes the total unknown. */
export function sumUsage(results: UsageResult[]): UsageResult {
  const files = results.flatMap(r => (r.known ? r.usage.files : r.files));
  const bad = results.find(r => !r.known);
  if (bad && !bad.known) return { known: false, reason: bad.reason, files };
  const u = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, calls: 0 };
  const models = new Set<string>();
  for (const r of results) if (r.known) {
    u.input += r.usage.input; u.cacheWrite += r.usage.cacheWrite; u.cacheRead += r.usage.cacheRead; u.output += r.usage.output; u.calls += r.usage.calls;
    r.usage.models.forEach(m => models.add(m));
  }
  return { known: true, usage: { ...u, weighted: weigh(u), models: [...models].sort(), files } };
}
