# CHE-1170 · Local orchestrator · Spec

Issue: https://linear.app/chedev/issue/CHE-1170/claude-orchestrates-local-models-for-real-coding-work

Status: draft rev 2 for Che's review, November 21, 2026. Revised after spec review round 1 (gpt-6.1-sol and gpt-6.1-terra, high). Nothing built yet.

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

Open for Che (on the review page): how this shares the model server with CHE-1166 (§6.6), whether savings are measured against a real Claude-only run (§6.5), and the savings bar for packaging (§9).

## 4. Terms

- **Worker:** one headless run of a local model inside a coding program, given one task.
- **Task:** a small change with a pinned base commit, a task file, and protected acceptance tests Claude wrote first.
- **Attempt:** the first try or one correction. A task has at most 3 attempts.
- **Local pass:** an attempt whose protected checks pass and whose diff Claude accepts, before any escalation.
- **Correction:** Claude's feedback after a failed check or rejected diff. It describes the problem and the failing output; it never contains replacement implementation code.
- **Escalation:** after the third failed attempt, Claude writes the piece itself.
- **Infrastructure failure:** an attempt that failed because of the harness, sandbox, server or timeout plumbing, not the model's code. Recorded separately; never counted as a model failure or pass.
- **Protected files:** the acceptance tests, check commands, package and lock files, and tool configuration for a task. The worker may not change them.
- **Baseline:** the same task, from the same base commit and protected tests, done by Claude alone.

## 5. Model server

LM Studio (installed; runs llama.cpp and MLX; API on port 1234; documents Claude Code integration and an Anthropic-compatible `/v1/messages` endpoint). Every run records the exact model file, quantization, backend, context length, reasoning and sampling settings, and LM Studio and worker-program versions. Replace LM Studio only if calibration shows a blocking gap.

## 6. Design

### 6.1 Worker isolation (fails closed)

A git worktree is not a security boundary, so the worker runs inside an OS-level sandbox (macOS Seatbelt, through the worker program's own sandbox mode):

- Writes: only the task's worktree, minus protected files.
- Reads: the worktree and the worker program's own install. No other repos, no `~/.ssh`, no keychains, no `.env` files.
- Network: only the local model endpoint. No other local ports, no internet.
- Environment: a clean home and config directory created per task; scrubbed environment variables; no inherited hooks, MCP servers, plugins or credentials.
- No unsandboxed fallback: if the sandbox can't be established, the attempt is an infrastructure failure.

Phase 1 proves the boundary with harmless canary checks: the worker is told to read a file in another repo, write outside the worktree, read a canary `.env`, reach another local port and reach the internet. Every one must be blocked.

### 6.2 Protected checks

- Claude writes the acceptance tests before dispatch and commits them to the task's base commit.
- A negative control runs first: the acceptance tests must fail on the base commit. A test that already passes doesn't count.
- After each attempt, the script verifies the hashes of every protected file and rejects any diff that touches one. Changed protected files fail the attempt.
- Checks run inside the same sandbox, with no credentials and no network. Skipped tests, zero tests run, or missing check output fail the attempt.
- Checks that need a browser, a service or the network are host checks; Claude runs them after the sandboxed checks pass, on the host's ports, never on Che's running dev server. A required check that can't run is recorded as blocked, not passed.

### 6.3 `local-worker` script

Bun + TypeScript. Input: repo, base commit, task file, model settings, attempt budget. Steps:

1. Create a worktree at the base commit. Refuse a repo with uncommitted changes in the files the task touches.
2. Prepare dependencies on the host from the lockfile before the worker starts (the only step with network). Copy no `.env` or secrets.
3. Start the worker in its own process group, inside the sandbox, with the task.
4. At the attempt budget (default 20 minutes), stop the process group and cancel its model request without stopping the shared server. A timeout is an infrastructure failure unless the model was still producing output, which is a model failure; the record says which.
5. Run the protected checks (§6.2).
6. Return JSON: status, the full diff including untracked files, check output, elapsed time, local tokens.
7. Append one record when the attempt starts and one when it ends to an append-only ledger, so a crash leaves a visible incomplete attempt.

The worker never grades its own work.

### 6.4 Claude's loop and integration

1. Write the task file and protected tests; run the negative control.
2. Dispatch; read diff and checks; accept, or send a correction (max 2); then escalate.
3. One task at a time in v1. Accepted work merges into the issue branch serially; the script re-runs every check on the merged commit, and Claude re-reviews any conflict resolution.
4. Failed worktrees are kept until their evidence is saved, then removed (never with `--force`, never another session's).

### 6.5 Measuring usage

- Each task's orchestration runs in its own Claude Code session. Claude's usage per task comes from that session's transcript: input, output and cache tokens for every call, failed calls included, covering planning, test writing, reviews, corrections and escalation code.
- Local tokens come from the worker's server responses.
- Missing numbers are recorded as unknown, never zero. Setup work shared across tasks is reported separately.
- Tokens are a proxy for Claude usage-limit burn, not a measurement of it.
- Baseline (open decision): suggested is a real Claude-only run of each Card Table task from the same base commit and protected tests, in a separate worktree, discarded afterwards. The alternative is an estimate, which makes every savings figure hypothetical.
- Code share is descriptive only: lines of production code in the accepted diff written by the worker, excluding tests, generated files and formatting. Code Claude wrote during escalation counts as Claude's.

### 6.6 Sharing the model server with CHE-1166

Both projects use the same LM Studio server and memory. Model requests, loads and unloads by this project can distort CHE-1166's scored runs.

- Suggested: this project sends no model requests and loads or unloads no models until CHE-1166's scored Snake run is finished and Che says so in chat.
- Alternative: Che hands the server over per session in chat, and CHE-1166 doesn't run while this project holds it.
- Either way, this project never changes LM Studio's global settings, and it releases the server with no model requests in flight.

### 6.7 Packaging

A skill in `ches-skills` via `new-skill`, plus the script in this repo, only after phase 3 passes its bar (§9).

## 7. Phases

1. **Plumbing and calibration.** Build `local-worker`. Pin versions. Calibrate the whole loop on one tiny task with headless Claude Code under the sandbox: read, edit, protected checks, one correction, completion, plus the canary checks (§6.1) and a cancellation test. If it fails, run the same calibration on Codex CLI. If neither qualifies, stop and report.
2. **Model test.** Freeze before running: the candidate list with exact files and settings, 5 tasks with base commits and protected tests, the task prompts, and the correction rules. Tasks: a pure function, a bug fix, a React component, a refactor, and adding tests to existing code (graded by Claude's protected tests of the same code, not the worker's own tests). Candidates: the installed coding-capable models (Inkling 2 Mini Q4_K_M, Qwen3.8 27B, Qwen3.6 35B-A3B, Gemma 4 E4B), each at one frozen setting. Every model gets the same 5 tasks; every attempt, prompt, correction and diff is saved.
3. **Card Table trial.** 1–2 real Card Table issues chosen with Che, each run with the best model and, if Che picks the real baseline, by Claude alone.
4. **Package** (§6.7), if phase 3 meets the bar.

Estimates (not limits): phase 1 about half a day; phase 2 about 3–5 hours of mostly unattended running; phase 3 about half a day.

## 8. Stop rule after phase 2

A model qualifies for phase 3 only if it gets a local pass on at least 3 of the 5 tasks, including both the bug fix and the React component, with infrastructure failures re-run, not counted. If no model qualifies, stop after phase 2 and report.

## 9. Acceptance criteria

- Phase 1: the calibration passes end to end, every canary is blocked, and a timed-out attempt leaves no process or model request running. `local-worker` passes typecheck and lint.
- Phase 2: results saved for every model and attempt, failures included, with the qualify decision per §8.
- Phase 3: at least one real Card Table issue merged with all Card Table checks passing and Claude's review accepted; every escalation and Claude rewrite recorded.
- Packaging bar (open decision): suggested is hybrid Claude tokens at most 60% of the real baseline's, at an equal check and review result. With an estimated baseline, the result is reported as inconclusive, and packaging needs Che's call.

## 10. Out of scope (v1)

- Running two workers at once. It comes back only after measured memory headroom at the real context lengths.
- Changing or re-running CHE-1166.
- Cloud models as workers.
- Publishing anything remotely.

## 11. Honest limits

- Claude's planning, test writing and review still use Claude usage; the savings come only from accepted local code.
- A few tasks show feasibility, not a reliable success rate or proof of equal quality.
- Memory figures are LM Studio estimates until measured.
