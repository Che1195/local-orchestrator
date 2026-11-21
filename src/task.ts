// T3: the task file format, validated with hand-written guards (no `any`).

export type TaskType = 'behavior' | 'bugfix' | 'refactor' | 'tests' | 'artifact';
export const TASK_TYPES: readonly TaskType[] = ['behavior', 'bugfix', 'refactor', 'tests', 'artifact'];

export interface Check {
  name: string;
  command: string[];
}

export interface Task {
  id: string;
  repo: string;
  baseCommit: string;
  taskType: TaskType;
  writablePaths: string[];
  instructions: string;
  checks: Check[];
  testReport?: string;
  testManifest?: string;
  sentinelTest?: string;
  structuralCheck?: Check;
  mutantsDir?: string;
  referenceTestsDir?: string;
  artifactFile?: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

function parseCheck(v: unknown, where: string, errors: string[]): Check | undefined {
  if (!isObject(v) || !isString(v.name) || !isStringArray(v.command) || v.command.length === 0) {
    errors.push(`${where} must be { name: string, command: non-empty string[] }`);
    return undefined;
  }
  return { name: v.name, command: v.command };
}

function isSafeRelativePath(p: string): boolean {
  return !p.startsWith('/') && !p.split('/').includes('..') && p !== '.' && p !== '';
}

const isAbsolute = (p: string) => p.startsWith('/');

export function parseTask(raw: unknown): Result<Task> {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ['task file must be a JSON object'] };

  for (const key of ['id', 'repo', 'baseCommit', 'instructions'] as const) {
    if (!isString(raw[key])) errors.push(`${key} must be a non-empty string`);
  }
  if (isString(raw.repo) && !isAbsolute(raw.repo)) errors.push('repo must be an absolute path');
  if (isString(raw.baseCommit) && !/^[0-9a-f]{7,40}$/.test(raw.baseCommit)) errors.push('baseCommit must be a git commit hash');

  const taskType = raw.taskType;
  if (!TASK_TYPES.includes(taskType as TaskType)) errors.push(`taskType must be one of ${TASK_TYPES.join(', ')}`);

  if (!isStringArray(raw.writablePaths) || raw.writablePaths.length === 0) {
    errors.push('writablePaths must be a non-empty array of paths');
  } else {
    for (const p of raw.writablePaths) if (!isSafeRelativePath(p)) errors.push(`writable path "${p}" must be relative and stay inside the repo`);
  }

  const checks: Check[] = [];
  if (!Array.isArray(raw.checks)) errors.push('checks must be an array');
  else raw.checks.forEach((c, i) => { const parsed = parseCheck(c, `checks[${i}]`, errors); if (parsed) checks.push(parsed); });

  const optionalStrings = ['testReport', 'testManifest', 'sentinelTest', 'mutantsDir', 'referenceTestsDir', 'artifactFile'] as const;
  for (const key of optionalStrings) {
    if (raw[key] !== undefined && !isString(raw[key])) errors.push(`${key} must be a non-empty string when present`);
  }
  // Grading inputs must live outside the repo, so the worker can't read or change them.
  for (const key of ['testManifest', 'mutantsDir', 'referenceTestsDir'] as const) {
    const v = raw[key];
    if (isString(v) && !isAbsolute(v)) errors.push(`${key} must be an absolute path outside the repo`);
    if (isString(v) && isString(raw.repo) && (v === raw.repo || v.startsWith(raw.repo + '/'))) errors.push(`${key} must be outside the repo`);
  }

  let structuralCheck: Check | undefined;
  if (raw.structuralCheck !== undefined) structuralCheck = parseCheck(raw.structuralCheck, 'structuralCheck', errors);

  const t = taskType as TaskType;
  if (t === 'artifact') {
    if (!isString(raw.artifactFile)) errors.push('artifact tasks need artifactFile');
    else if (isStringArray(raw.writablePaths) && !(raw.writablePaths.length === 1 && raw.writablePaths[0] === raw.artifactFile)) {
      errors.push('artifact tasks may write only their artifactFile');
    }
    if (checks.length > 0) errors.push('artifact tasks have no checks');
  } else if (TASK_TYPES.includes(t)) {
    if (checks.length === 0) errors.push(`${t} tasks need at least one check`);
    for (const key of ['testReport', 'testManifest', 'sentinelTest'] as const) if (!isString(raw[key])) errors.push(`${t} tasks need ${key}`);
    if (t === 'refactor' && !structuralCheck) errors.push('refactor tasks need structuralCheck');
    if (t === 'tests') for (const key of ['mutantsDir', 'referenceTestsDir'] as const) if (!isString(raw[key])) errors.push(`tests tasks need ${key}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  const task: Task = {
    id: raw.id as string, repo: raw.repo as string, baseCommit: raw.baseCommit as string, taskType: t,
    writablePaths: raw.writablePaths as string[], instructions: raw.instructions as string, checks
  };
  for (const key of optionalStrings) if (isString(raw[key])) task[key] = raw[key] as string;
  if (structuralCheck) task.structuralCheck = structuralCheck;
  return { ok: true, value: task };
}

export async function loadTask(path: string): Promise<Result<Task>> {
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
  } catch (error) {
    return { ok: false, errors: [`cannot read task file ${path}: ${String(error)}`] };
  }
  return parseTask(raw);
}
