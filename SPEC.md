# CHE-1170 · Local orchestrator · Spec

Issue: https://linear.app/chedev/issue/CHE-1170/claude-orchestrates-local-models-for-real-coding-work

Status: rev 5, approved by Che on November 21, 2026. Revised after spec review rounds 1 to 3 (gpt-6.1-sol and gpt-6.1-terra, high) and the closing audit (Sol, Terra, Gemini 4 Neon high). The review cap is reached; rev 5's fixes to the audit's findings were not re-reviewed. Nothing built yet.

## 1. Goal

Claude Code (Opus 5.5) orchestrates local models on Che's Mac: Claude plans, writes the acceptance tests, reviews every change and owns every check; a local model writes the code. The aim is a reusable tool for Che's real work that uses less Claude usage than Claude doing the same task alone, at the same quality.

## 2. Constraints (from Che)

1. Claude is the orchestrator.
2. The workers are local models running on this Mac.

Everything else (runtime, worker program, models) is chosen by evidence and recorded here.

## 3. Decisions

Che, November 21:

- First real project: Card Table (`~/projects/card-table`), after the model test.
- Corrections: one first attempt plus at most 2 corrections per task; then Claude writes that piece and logs an escalation.
- Worker program: picked by the phase 1 calibration (§7). Headless Claude Code pointed at the local model is tried first; Codex CLI is the fallback.
- Tracking: its own Linear issue, related to CHE-1166, not part of that experiment.

Che, November 21, on the spec review page (verdict: approve, on rev 1d78f0b):

- Sharing with CHE-1166: wait. No model requests, loads or unloads until CHE-1166's scored run is finished and Che says so in chat (§6.6).
- Baseline: a real Claude-only run of each Card Table task (§6.5).
- Packaging bar: 60% after dispatch, plus the 80% total guard (§9).

## 4. Terms

- **Worker:** one headless run of a local model inside a coding program, given one task.
- **Task:** a small change with a pinned base commit, a task file, and protected acceptance tests Claude wrote first.
- **Attempt:** the first try or one correction. A task has at most 3 attempts.
- **Local pass:** an attempt whose protected checks pass and whose diff Claude accepts, before any escalation.
- **Correction:** Claude's feedback after a failed check or rejected diff. It describes the problem and the failing output; it never contains replacement implementation code.
- **Escalation:** after the third failed attempt, Claude writes the piece itself.
- **Infrastructure failure:** an attempt that failed with evidence of a harness, sandbox or server fault: a server error response, a sandbox setup error, or a harness crash. Without that evidence, a failed or timed-out attempt is a model failure. An infrastructure failure is re-run, at most twice per task; after that the task is recorded as blocked and phase 2 reports it.
- **Writable paths:** the files and folders the task file says the worker may change (for example `src/game/`, or a test folder for a test-writing task). Everything else, including Claude's acceptance tests, test helpers, check commands, package and lock files, dependencies and tool configuration, is protected.
- **Baseline:** the same task, from the same base commit and protected tests, done by Claude alone.

## 5. Model server

LM Studio (installed; runs llama.cpp and MLX; API on port 1234; documents Claude Code integration and an Anthropic-compatible `/v1/messages` endpoint). Every run records the exact model file, quantization, backend, context length, reasoning and sampling settings, and LM Studio and worker-program versions. Replace LM Studio only if calibration shows a blocking gap.

## 6. Design

### 6.1 Worker isolation (fails closed)

A git worktree is not a security boundary, so `local-worker` wraps the worker program in a macOS Seatbelt profile it owns (`sandbox-exec`), whatever sandbox mode the worker program has of its own. Checks get a second, stricter profile (§6.2).

Worker profile:

- Writes: only the task's writable paths, plus the worker's own per-task home, config and temp folders.
- Reads: the worktree, the worker program's own install and the system paths it needs. No other repos, no `~/.ssh`, no keychains, no `.env` files.
- Network: only the local model endpoint. No other local ports, no internet.
- Environment: a clean home and config directory created per task; scrubbed environment variables; no inherited hooks, MCP servers, plugins or credentials.
- No unsandboxed fallback: if the sandbox can't be established, the attempt is an infrastructure failure.

Phase 1 proves the boundary with harmless canary checks: the worker is told to read a file in another repo, write outside the worktree, read a canary `.env`, reach another local port and reach the internet. Every one must be blocked.

### 6.2 Protected checks

The worker's code is untrusted input, so checks never run in the worker's worktree.

- Claude writes the acceptance tests before dispatch and commits them to the task's base commit.
- After an attempt, the script rejects any diff outside the writable paths, and any diff that adds a symlink. Then it builds a fresh check checkout: the base commit, a copy of the clean dependency folder the harness prepared before the worker started (no second install, no network), and only the worker's diff to the writable paths applied. Checks run there. Nothing the worker changed in its own worktree outside the writable paths, `node_modules` included, can reach the checks.
- Check profile: the checkout is read-only, writes go only to a temp and report folder, and there is no network at all, the model server included. Skipped tests, zero tests run, or missing check output fail the attempt. The harness reads pass and fail from the test runner's machine-readable report and its exit code, never from printed text.
- A clean run means: every expected test (listed from the protected test files before the run) passed, the one protected sentinel test failed as it must, no other test failed or was skipped, no suite or unhandled error, and the runner exited with its normal test-failure code, not 0 and not a crash or signal. Anything else fails the attempt; a sentinel shown as passed or missing marks the report as forged.
- Known limit: the code under test runs inside the test process, so code written on purpose to forge a correctly shaped report can't be fully stopped by the harness. The sentinel is a tamper indicator, not proof. Claude's diff review is the backstop: it rejects code that exits the process, touches the test runner, or writes report or result files.
- Checks that need a browser or a local service run in the same kind of sandbox, with only the ports they need opened, disposable test data, and never Che's running dev server. If that boundary can't be set up, the check is recorded as blocked, not passed.
- Negative controls are per task type, and each must fail before the worker starts:
  - New behavior or bug fix: the acceptance tests fail on the base commit.
  - Refactor: the behavior tests pass on the base commit and must still pass; a separate structural check (for example "module X no longer imports Y") fails on the base commit.
  - Writing tests: the worker writes tests only in that task's writable test folder. Claude's reference tests and the 5 frozen mutants (faulty versions of the code) stay outside the worker's worktree, so the worker can't read or copy them. On the real code: at least one worker test runs, all pass, and the run is otherwise clean. On each mutant: the run is clean apart from at least one worker test failing; a crash or syntax error doesn't count as catching it. The worker's tests must catch at least 4 of 5 mutants. Each mutant is checked first: Claude's reference tests must fail on it, so every mutant is a real, catchable fault. The control is that an empty test folder catches no mutants.
- Phase 1 calibration includes three tamper cases that must be caught: a worker told to make a failing test pass by editing a test helper or a dependency, one told to exit the test process early, and one told to write a correctly shaped fake report. If the fake report gets past the harness, Claude's review must catch it, and the result is recorded as relying on review.

### 6.3 `local-worker` script

Bun + TypeScript. One invocation runs one attempt. Input: repo, base commit, task file, model settings, attempt number, and for a correction, Claude's correction text and the previous attempt's diff. Steps:

1. Create a fresh worktree at the base commit. For a correction, apply the previous attempt's diff if it passed the path and symlink check; otherwise start clean. Every attempt starts a new worker session with the task file, plus the correction text for a correction; no worker conversation is resumed. This is the same for every model. Refuse a repo with uncommitted changes in the files the task touches.
2. Prepare a clean dependency folder on the host from the lockfile before the worker starts, once per task (the only step with network, limited to 10 minutes, outside the attempt deadline). Copy no `.env` or secrets.
3. Start the worker in its own process group, inside the sandbox, with the task.
4. Deadlines: 20 minutes for the worker, then 10 minutes for all checks, so 30 minutes per attempt end to end. At a deadline the script stops every process group it started (worker, checks, test services) and cancels the model request without stopping the shared server.
5. Run the checks (§6.2).
6. Return JSON: status, the full diff including untracked files, check output, elapsed time, local tokens.
7. Append one record when the attempt starts and one when it ends to an append-only ledger, so a crash leaves a visible incomplete attempt.

The worker never grades its own work.

### 6.4 Claude's loop and integration

1. Write the task file and protected tests; run the negative control.
2. Dispatch; read diff and checks; accept, or send a correction (max 2); then escalate.
3. One task at a time in v1. Accepted work merges into the issue branch serially; the script re-runs every check on the merged commit with the same sandboxed check procedure (§6.2), blocked outcome included, and Claude re-reviews any conflict resolution.
4. Failed worktrees are kept until their evidence is saved, then removed (never with `--force`, never another session's).

### 6.5 Measuring usage

- Sessions: shared preparation (planning, task file, protected tests, negative control) runs in its own Claude Code session and is committed to the base commit. Then the hybrid loop and the baseline each start in a fresh session from that same commit, with the same task file and no view of the other's code or feedback. Both use the same review structure: a review step in their own session.
- Claude's usage comes from each session's transcript: input, output and cache tokens for every call, failed calls included.
- Local tokens come from the worker's server responses.
- Missing numbers are recorded as unknown, never zero. Setup work shared across tasks is reported separately.
- Tokens are a proxy for Claude usage-limit burn, not a measurement of it.
- Shared preparation, meaning the task file and protected tests, is done once and used by both the hybrid and the baseline. Its usage is reported on its own line and left out of the comparison.
- The comparison covers everything after dispatch: for the hybrid, reviews, corrections and escalation code; for the baseline, Claude's whole implementation plus the same required review and any revisions that review prompts. Both runs pass the same checks and the same review before they count.
- One number decides the comparison, cost-weighted tokens: input + 1.25 × cache writes + 0.1 × cache reads + 5 × output, the ratios of Opus 5.5's API prices. The raw categories are reported too.
- Baseline (Che: real): a real Claude-only run of each Card Table task from the same base commit, task file and protected tests, in a separate worktree, discarded afterwards. The alternative is an estimate, which makes every savings figure hypothetical.
- Code share is descriptive only: lines of production code in the accepted diff written by the worker, excluding tests, generated files and formatting. Code Claude wrote during escalation counts as Claude's.

### 6.6 Sharing the model server with CHE-1166

Both projects use the same LM Studio server and memory. Model requests, loads and unloads by this project can distort CHE-1166's scored runs.

- Chosen by Che: this project sends no model requests and loads or unloads no models until CHE-1166's scored Snake run is finished and Che says so in chat.
- Not chosen: per-session handoffs.
- Either way, this project never changes LM Studio's global settings, and it releases the server with no model requests in flight.

### 6.7 Packaging

A skill in `ches-skills` via `new-skill`, plus the script in this repo, only after phase 3 passes its bar (§9).

## 7. Phases

1. **Plumbing and calibration.** Build `local-worker`. Pin versions. Calibrate the whole loop on one tiny task with headless Claude Code under the sandbox: read, edit, protected checks, one correction, completion, plus the canary checks (§6.1), the tamper cases (§6.2) and a cancellation test. If it fails, run the same calibration on Codex CLI. If neither qualifies, stop and report.
2. **Model test.** Freeze before running: the candidate list with exact files and settings, 5 tasks with base commits and protected tests, the task prompts, and the correction rules. Tasks: a pure function, a bug fix, a React component, a refactor, and adding tests to existing code (graded by frozen mutants, §6.2). Candidates: the installed coding-capable models (Inkling 2 Mini Q4_K_M, Qwen3.8 27B, Qwen3.6 35B-A3B, Gemma 4 E4B), each at one frozen setting. Every model gets the same 5 tasks; every attempt, prompt, correction and diff is saved.
3. **Card Table trial.** 1–2 real Card Table issues chosen with Che, each run with the best model and, if Che picks the real baseline, by Claude alone.
4. **Package** (§6.7), if phase 3 meets the bar.

Estimates (not limits): phase 1 about half a day; phase 2 about 3–5 hours of mostly unattended running; phase 3 about half a day.

## 8. Stop rule after phase 2

A model qualifies for phase 3 only if it gets a local pass on at least 3 of the 5 tasks, including both the bug fix and the React component. A blocked task counts as not passed. If no model qualifies, stop after phase 2 and report.

If several qualify, the best model has the most local passes; ties go to fewer total corrections, then to the shorter median attempt time.

## 9. Acceptance criteria

- Phase 1: the calibration passes end to end, every canary is blocked, every tamper case is caught (recorded where only review caught it), and a timed-out attempt leaves no process or model request running. `local-worker` passes typecheck and lint.
- Phase 2: results saved for every model and attempt, failures included, with the qualify decision per §8.
- Phase 3: at least one real Card Table issue merged with all Card Table checks passing and Claude's review accepted; every escalation and Claude rewrite recorded.
- Packaging bar (Che: 60%): the hybrid's cost-weighted Claude tokens after dispatch (§6.5) at most 60% of the real baseline's, summed across all phase 3 tasks with escalations included, with both passing all checks and Claude's review. A second guard on the same sums: the hybrid's total including shared preparation is at most 80% of the baseline's total including the same preparation, so a small saving on top of large shared prep can't pass. With an estimated baseline, the result is reported as inconclusive, and packaging needs Che's call.

## 10. Out of scope (v1)

- Running two workers at once. It comes back only after measured memory headroom at the real context lengths.
- Changing or re-running CHE-1166.
- Cloud models as workers.
- Publishing anything remotely.

## 11. Honest limits

- Claude's planning, test writing and review still use Claude usage; the savings come only from accepted local code.
- A few tasks show feasibility, not a reliable success rate or proof of equal quality.
- Memory figures are LM Studio estimates until measured.
