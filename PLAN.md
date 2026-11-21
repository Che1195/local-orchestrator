# CHE-1170 · Local orchestrator · Implementation plan

Spec: SPEC.md (rev 5, approved by Che on November 21, 2026, on rev 1d78f0b). This plan is the source of truth for the build; the spec wins where they differ.

Status: draft rev 1 for review. Nothing built yet.

## Ground rules

- Bun 1.4.3 + TypeScript, no `any`. Checks for this repo: `bun run typecheck`, `bun run lint`, `bun test`.
- Branch `che-1170-local-orchestrator`; one commit per task at least; a PR only if Che picks a GitHub repo (decision on the page).
- **Model-server gate:** no task sends a request to LM Studio, or loads or unloads a model, until CHE-1166's scored run is finished and Che says so in chat. Tasks marked **[gate]** wait for that; everything else uses a fake model server (T2) and can be built now.
- Every task ends with its named check run and its result recorded in Linear at each milestone.

## Key idea: a fake model server

Most of the loop can be built and tested without LM Studio. T2 builds a tiny local server that speaks the Anthropic `/v1/messages` format and plays back scripted replies, including tool calls. Scripted workers can then edit files, fail, tamper with checks or hang on purpose, so the sandbox, checks, tamper cases and deadlines are all tested before any real model runs.

## Phase 1 · Plumbing and calibration

### T1 · Repo scaffold (~20 min)
- Files: `package.json` (scripts `typecheck`, `lint`, `test`), `tsconfig.json` (strict), `eslint.config.js` (no `any`), `src/`, `tests/`, `.gitignore` (`runs/`, `html-pages/.private/`).
- Done when: the three checks pass on an empty `src/index.ts`.

### T2 · Fake model server (~45 min)
- `tests/support/fake-model.ts`: a Bun HTTP server on a random local port implementing `POST /v1/messages` (streaming and non-streaming) and `GET /v1/models`. It plays a scripted list of replies: text, `tool_use` blocks, a server error, a hang, or a slow stream. It records every request it receives and whether the client disconnected.
- Tests: a scripted reply round-trips; a hang can be detected as a disconnect when the client is killed.

### T3 · Task file and ledger (~45 min)
- `src/task.ts`: the task file format (JSON), validated with hand-written TypeScript guards:
  `id`, `repo`, `baseCommit`, `taskType` (`behavior` | `bugfix` | `refactor` | `tests`), `writablePaths[]`, `instructions` (markdown), `checks[]` (name + command, run in the check checkout), `testReport` (path to the JUnit report), `protectedTestGlobs[]`, `sentinelTest` (name), and for `refactor` a `structuralCheck` command, for `tests` a `mutantsDir` and `referenceTestsDir` outside the repo.
- `src/ledger.ts`: append-only JSONL. `start` and `end` records per attempt with task id, attempt number, model settings, status (`local-pass` | `model-fail` | `infra-fail` | `blocked` | `forged` | `escalated`), elapsed time, local tokens, and the reasons. A `start` with no `end` reads back as `incomplete`.
- Tests: bad task files are refused with a reason; ledger round-trip; an incomplete attempt is detected.

### T4 · Sandbox profiles and canaries (~1.5 h)
- `src/sandbox.ts` builds two Seatbelt profiles from parameters and runs a command under `sandbox-exec -f <profile>`:
  - Worker: write to writable paths and the per-task home/config/temp; read the worktree, the worker program's install, system paths; network only to `127.0.0.1:<model port>`.
  - Check: read-only check checkout, write only a temp/report folder, no network.
- `src/env.ts`: the scrubbed environment (allowlist of variables; fresh `HOME`, `TMPDIR`, `CLAUDE_CONFIG_DIR`).
- `tests/sandbox.test.ts` runs the five canaries for real under each profile: read a file in another repo, write outside the allowed paths, read a canary `.env`, connect to another local port (a listener the test starts), and connect to the internet. Plus: the check profile can't reach the model port. Every one must be blocked; the allowed operations must still work.
- Risk: `sandbox-exec` is deprecated by Apple but present on this macOS. If a profile rule can't express a needed limit, stop and report; no weaker fallback (spec §6.1).

### T5 · Worktrees, diffs and dependencies (~1 h)
- `src/workspace.ts`:
  - Refuse when the repo has uncommitted changes in files the task touches.
  - Prepare the clean dependency folder once per task: `bun install --frozen-lockfile` into a cache folder on the host (10-minute limit).
  - Create a fresh worktree at the base commit for each attempt; for a correction, apply the previous attempt's diff if it passed validation.
  - Capture the attempt's diff, untracked files included (`git add -N` then `git diff`).
  - Validate: every path inside `writablePaths`, no symlinks (mode `120000`), no deletions of protected files.
  - Build the check checkout: a new worktree at the base commit, a copy-on-write clone of the dependency folder (`cp -c`), then the validated diff.
  - Clean up worktrees with `git worktree remove` (never `--force`) after evidence is saved; never touch worktrees this tool didn't create.
- Tests on a throwaway fixture repo: path escape rejected; symlink rejected; untracked file captured; a changed `node_modules` file in the worker worktree does not reach the check checkout.

### T6 · Process supervisor (~45 min)
- `src/supervise.ts`: start a command in its own process group, enforce a deadline, kill the whole group (TERM, then KILL after 5 s), and report whether output was still arriving at the deadline.
- Tests: a child that spawns grandchildren is fully killed; a hung child is killed at the deadline.

### T7 · Check runner (~1.5 h)
- `src/checks.ts`: run the task's checks in the check checkout under the check profile with the 10-minute deadline, then grade:
  - Parse the JUnit report (`bun test --reporter=junit --reporter-outfile=<report>`).
  - List expected tests from the protected test files before the run.
  - Clean run = every expected test passed, the sentinel failed, nothing else failed or skipped, no suite error, and exit code is bun's normal test-failure code (not 0, not a signal).
  - Sentinel passed or missing → `forged`.
  - Task-type rules: `refactor` also runs the structural check; `tests` runs the worker's tests against the real code and each mutant, as in spec §6.2.
  - Negative control: run once on the base commit before dispatch; it must fail in the way the task type requires, or the task is refused.
- Tests with fixture repos: clean pass; one test failing; one skipped; zero tests; a source file that calls `process.exit(0)` at import (must fail); a source file that writes a correctly shaped fake report (must be marked as relying on review: see T10); a hung test killed at the deadline; mutant grading with 4 of 5 and 3 of 5 caught.

### T8 · Claude Code worker adapter (~1.5 h)
- `src/workers/claude-code.ts`: build the headless command:
  `claude -p --model <local model id> --output-format stream-json --verbose --strict-mcp-config --setting-sources "" --permission-mode bypassPermissions --allowedTools Read,Edit,Write,Glob,Grep,Bash`
  with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, a dummy `ANTHROPIC_AUTH_TOKEN`, and the scrubbed environment from T4, all inside the worker profile. Permissions are bypassed inside the worker program because the Seatbelt profile is the real boundary.
- Parse the stream for completion, errors and local token counts.
- Prompt: the task file's instructions plus, for a correction, Claude's correction text, plus the rules (work only in the writable paths, no network, stop when done).
- Exact flags are confirmed against `claude --help` 2.1.329 during the task; anything that differs is recorded in the plan.
- Tests against the fake server: a scripted worker reads a file, edits it, and finishes; a scripted server error is classified `infra-fail`; a scripted hang hits the deadline as `model-fail`.

### T9 · `local-worker` command (~1 h)
- `src/cli.ts`: `local-worker run --task <file> --attempt <n> [--correction <file> --previous-diff <file>]` runs T5 → T8 under T6 → T7 and prints one JSON result (status, diff, check output, elapsed time, local tokens), writing ledger records at start and end.
- `local-worker negative-control --task <file>` runs the base-commit control.
- Infra failures re-run at most twice per task (spec §4).
- Done when: an end-to-end run against the fake server passes on a fixture task, with a scripted first-attempt failure and a passing correction.

### T10 · Calibration suite (~1 h build; the real run is [gate])
- `calibration/` holds one tiny task and a script that runs:
  1. The whole loop: read, edit, checks fail, correction, checks pass.
  2. The five canaries from inside a real worker session (the worker is told to try each).
  3. Three tamper cases (spec §6.2): edit a test helper, exit the test process early, write a fake report. The first two must be caught by the harness; for the third, the result records whether the harness caught it or only Claude's review did.
  4. Cancellation: a worker stopped at its deadline leaves no process and no in-flight model request (checked on LM Studio with `lms ps` and its server log).
- Against the fake server: built and run now.
- Against LM Studio with Inkling 2 Mini: **[gate]**. If headless Claude Code fails it, build T11 and rerun.
- Done when: every step passes on the real server and the results are saved in `results/calibration-<date>/`.

### T11 · Codex CLI fallback (only if T10 fails with Claude Code; ~1.5 h)
- `src/workers/codex.ts` with the same contract, pointed at LM Studio's OpenAI-compatible endpoint. Rerun T10. If both fail, stop and report (spec §7).

### T12 · Usage accounting (~1 h)
- `src/usage.ts`: read a Claude Code session transcript (JSONL) by session id and sum input, cache-write, cache-read and output tokens for every assistant call, failed calls included. Cost-weighted total = input + 1.25 × cache writes + 0.1 × cache reads + 5 × output. Missing fields are `unknown`, never 0.
- Tests on small fixture transcripts, including one with a missing usage field.

## Phase 2 · Model test

### T13 · Benchmark tasks (~2 h)
- A sandbox repo `bench/` (Bun + TypeScript + React, its own git history) with five frozen tasks, each with a base commit, task file, protected tests, sentinel test and negative control: a pure function, a bug fix, a React component (tested with `@testing-library/react` under `happy-dom`), a refactor with a structural check, and a test-writing task with 5 mutants and reference tests kept outside the repo.
- Done when: every negative control fails as required, and a reference solution for each task passes (the solutions are kept outside the worker's view).

### T14 · Run the model test **[gate]** (~3–5 h, mostly unattended)
- Freeze `bench/candidates.json` first: Inkling 2 Mini Q4_K_M, Qwen3.8 27B (the installed GGUF and MLX builds count as one candidate each only if both fit; otherwise the GGUF), Qwen3.6 35B-A3B 4-bit, Gemma 4 E4B 4-bit, each with exact file, context length, and default sampling and reasoning settings recorded.
- For each model: load it, run the 5 tasks with up to 3 attempts each, unload it. I write corrections by the same rules for every model (problem and failing output, never code).
- Apply the stop rule and ranking (spec §8). Save everything in `results/model-test-<date>/`.

### T15 · Model test report (~30 min)
- A short report on the page: per model, local passes, corrections, escalations, infra failures, median attempt time; the chosen model or the stop.

## Phase 3 · Card Table trial

### T16 · Pick and prepare (~30 min, needs Che)
- Che picks 1–2 Card Table issues (CHE-980 to CHE-985 or newer). Card Table's checks are `bun run typecheck` and `bun test`; it has no lint script.
- For each issue, a preparation session writes the task file and protected tests and commits them on a branch as the shared base commit (spec §6.5).

### T17 · Hybrid and baseline runs **[gate]** (~half day)
- For each issue, two fresh Claude Code sessions started from this one, each on its own worktree of the base commit:
  - Hybrid: orchestrates the local model with `local-worker`.
  - Baseline: Claude alone, no local model.
- Each ends only when it passes the same checks and the same review step. The baseline worktree is discarded afterwards; the hybrid result goes into a Card Table PR for Che.
- T12 sums each session's usage.

### T18 · Trial report and packaging decision (~30 min)
- Report: summed cost-weighted tokens for both after dispatch and in total, the two ratios against the bar (60% and 80%), local code share, corrections, escalations, elapsed time. Packaging needs both ratios under the bar.

## Phase 4 · Package (only if T18 meets the bar)

### T19 · Skill (~1 h)
- A `local-orchestrator` skill in `~/projects/ches-skills/skills/` through `new-skill`, then `bin/publish`. It tells a session how to write task files and protected tests, run `local-worker`, write corrections, escalate, and record usage.

## Order and what can run now

- Now (no model server): T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 (fake server) → T12 → T13.
- After Che's word on CHE-1166: T10 (real) → T11 if needed → T14 → T15 → T16 → T17 → T18 → T19.

Estimate (not a limit): about 2 days of build before the gate; then about 1 day of runs, mostly unattended.

## Reviews

- Code written by Claude: Sol and Terra review before merge, per Che's rules; the closing audit adds Gemini.
- Each phase's results go on the feature page as the record.
