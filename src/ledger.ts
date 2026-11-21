// T3: attempt states and the append-only ledger.
// The script never decides a local pass by itself: `checks-passed` plus Claude's recorded acceptance does.

import { appendFile, readFile } from 'node:fs/promises';

export const MAX_ATTEMPTS = 3;
export const MAX_INFRA_RERUNS = 2;

export type EndStatus = 'checks-passed' | 'artifact-ready' | 'model-fail' | 'infra-fail' | 'blocked' | 'forged';
const END_STATUSES: readonly EndStatus[] = ['checks-passed', 'artifact-ready', 'model-fail', 'infra-fail', 'blocked', 'forged'];

export type LocalTokens = { prompt: number; completion: number } | 'unknown';

export type LedgerRecord =
  | { type: 'start'; taskId: string; attempt: number; configHash: string; at: string }
  | { type: 'end'; taskId: string; attempt: number; configHash: string; status: EndStatus; reasons: string[]; elapsedMs: number; localTokens: LocalTokens; at: string }
  | { type: 'review'; taskId: string; attempt: number; decision: 'accept' | 'reject'; reason: string; at: string }
  | { type: 'escalate'; taskId: string; reason: string; at: string };

export type AttemptView = {
  attempt: number;
  runs: { status: EndStatus | 'incomplete'; reasons: string[] }[];
  final: EndStatus | 'incomplete' | undefined;
  review?: 'accept' | 'reject';
};

export type TaskState =
  | 'not-started'
  | 'incomplete'
  | 'awaiting-review'
  | 'needs-rerun'
  | 'needs-correction'
  | 'awaiting-escalation'
  | 'local-pass'
  | 'artifact-accepted'
  | 'escalated'
  | 'blocked';

export interface TaskView {
  taskId: string;
  attempts: AttemptView[];
  infraFailures: number;
  state: TaskState;
}

const now = () => new Date().toISOString();

function isRecord(v: unknown): v is LedgerRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.taskId !== 'string' || typeof r.at !== 'string') return false;
  switch (r.type) {
    case 'start': return typeof r.attempt === 'number' && typeof r.configHash === 'string';
    case 'end': return typeof r.attempt === 'number' && END_STATUSES.includes(r.status as EndStatus) && Array.isArray(r.reasons);
    case 'review': return typeof r.attempt === 'number' && (r.decision === 'accept' || r.decision === 'reject');
    case 'escalate': return typeof r.reason === 'string';
    default: return false;
  }
}

export async function readLedger(path: string): Promise<LedgerRecord[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter(line => line.trim() !== '').map((line, i) => {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) throw new Error(`ledger line ${i + 1} is not a valid record`);
    return parsed;
  });
}

export function viewTask(records: LedgerRecord[], taskId: string): TaskView {
  const mine = records.filter(r => r.taskId === taskId);
  const attempts = new Map<number, AttemptView>();
  const get = (n: number) => {
    let a = attempts.get(n);
    if (!a) { a = { attempt: n, runs: [], final: undefined }; attempts.set(n, a); }
    return a;
  };
  let escalated = false;
  for (const r of mine) {
    if (r.type === 'start') get(r.attempt).runs.push({ status: 'incomplete', reasons: [] });
    else if (r.type === 'end') {
      const a = get(r.attempt);
      const open = [...a.runs].reverse().find(run => run.status === 'incomplete');
      if (open) { open.status = r.status; open.reasons = r.reasons; }
      else a.runs.push({ status: r.status, reasons: r.reasons });
    } else if (r.type === 'review') get(r.attempt).review = r.decision;
    else escalated = true;
  }
  const list = [...attempts.values()].sort((x, y) => x.attempt - y.attempt);
  for (const a of list) a.final = a.runs.at(-1)?.status;
  const infraFailures = list.flatMap(a => a.runs).filter(run => run.status === 'infra-fail').length;
  return { taskId, attempts: list, infraFailures, state: deriveState(list, infraFailures, escalated) };
}

function deriveState(attempts: AttemptView[], infraFailures: number, escalated: boolean): TaskState {
  if (escalated) return 'escalated';
  const last = attempts.at(-1);
  if (!last) return 'not-started';
  // Started with no end record: still running, or crashed. The ledger alone can't tell which.
  if (last.final === 'incomplete') return 'incomplete';
  if (last.final === 'blocked' || infraFailures > MAX_INFRA_RERUNS) return 'blocked';
  if (last.final === 'checks-passed' || last.final === 'artifact-ready') {
    if (last.review === 'accept') return last.final === 'checks-passed' ? 'local-pass' : 'artifact-accepted';
    if (last.review === undefined) return 'awaiting-review';
  }
  if (last.final === 'infra-fail') return 'needs-rerun';
  // A model failure, a forged report, or a rejected diff uses up the attempt.
  return countedAttempts(attempts) >= MAX_ATTEMPTS ? 'awaiting-escalation' : 'needs-correction';
}

/** Attempts that ended in something other than an infrastructure failure. */
export function countedAttempts(attempts: AttemptView[]): number {
  return attempts.filter(a => a.final !== undefined && a.final !== 'infra-fail' && a.final !== 'incomplete').length;
}

export class Ledger {
  constructor(readonly path: string) {}

  private async append(record: LedgerRecord) {
    await appendFile(this.path, JSON.stringify(record) + '\n', { flag: 'a' });
  }

  async view(taskId: string): Promise<TaskView> {
    return viewTask(await readLedger(this.path), taskId);
  }

  async start(taskId: string, attempt: number, configHash: string) {
    const view = await this.view(taskId);
    if (['local-pass', 'artifact-accepted', 'escalated', 'blocked'].includes(view.state)) throw new Error(`task ${taskId} is ${view.state}; no more attempts`);
    if (view.state === 'awaiting-review') throw new Error(`task ${taskId} attempt needs Claude's review first`);
    if (view.state === 'awaiting-escalation') throw new Error(`task ${taskId} used ${MAX_ATTEMPTS} attempts; escalate`);
    if (attempt < 1 || attempt > MAX_ATTEMPTS) throw new Error(`attempt must be 1 to ${MAX_ATTEMPTS}`);
    await this.append({ type: 'start', taskId, attempt, configHash, at: now() });
  }

  async end(taskId: string, attempt: number, configHash: string, status: EndStatus, reasons: string[], elapsedMs: number, localTokens: LocalTokens) {
    await this.append({ type: 'end', taskId, attempt, configHash, status, reasons, elapsedMs, localTokens, at: now() });
  }

  async review(taskId: string, attempt: number, decision: 'accept' | 'reject', reason: string) {
    const view = await this.view(taskId);
    const a = view.attempts.find(x => x.attempt === attempt);
    if (!a || (a.final !== 'checks-passed' && a.final !== 'artifact-ready')) throw new Error(`attempt ${attempt} of ${taskId} has nothing to review`);
    if (a.review) throw new Error(`attempt ${attempt} of ${taskId} is already reviewed`);
    await this.append({ type: 'review', taskId, attempt, decision, reason, at: now() });
  }

  async escalate(taskId: string, reason: string) {
    const view = await this.view(taskId);
    if (view.state !== 'awaiting-escalation') throw new Error(`task ${taskId} is ${view.state}; escalation needs ${MAX_ATTEMPTS} failed attempts`);
    await this.append({ type: 'escalate', taskId, reason, at: now() });
  }
}
