# CHE-1170 · Local orchestrator · Implementation plan

Spec: SPEC.md rev 6 (rev 5 approved by Che on November 21, 2026; rev 6 adds the Snake evaluation and awaits his re-approval). The spec wins where they differ.

Status: draft rev 2, revised after plan review round 1 (gpt-6.1-sol and gpt-6.1-terra, high) and Che's Snake request. Nothing built yet.

## Ground rules

- Bun 1.4.3 + TypeScript, no `any`. Checks for this repo: `bun run typecheck`, `bun run lint`, `bun test`.
- Branch `che-1170-local-orchestrator`. The repo is local; a PR needs a GitHub repo (decision on the page).
- **Model-server gate: lifted** by Che in chat on November 21 (CHE-1166 is done). Tasks marked **[gate]** use the real LM Studio server and may run once their build steps are done; tests still use the fake model server (T2).
- Every task ends with its named check run; results go to Linear at each milestone.

## Key idea: a fake model server

T2 builds a tiny local server that speaks the Anthropic `/v1/messages` format and plays back scripted replies, tool calls included. Scripted workers edit files, fail, tamper or hang on purpose, so the sandbox, checks, tamper cases and deadlines are tested before any real model runs.

## Run configuration

One immutable JSON file per run, `runs/<run id>/config.json`, written before the first attempt and hashed into every ledger record: model id and exact file path, quantization, backend, context length, reasoning effort, sampling settings (LM Studio defaults, read back and recorded), endpoint URL and port, LM Studio version, worker program and version, Claude model and effort. The worker adapter takes all of it from this file; nothing comes from ambient settings. Models are loaded per run with `lms load <model> --context-length <n>` and unloaded with `lms unload` [gate]; LM Studio's global settings are never changed.

## Phase 1 · Plumbing and calibration

### T1 · Repo scaffold (~20 min)
- `package.json` (scripts `typecheck`, `lint`, `test`), strict `tsconfig.json`, `eslint.config.js` (no `any`), `src/`, `tests/`, `.gitignore` (`runs/`, `results/`, `html-pages/.private/`).
- Done when: the three checks pass on an empty `src/index.ts`.

### T2 · Fake model server (~45 min)
- `tests/support/fake-model.ts`: a Bun server on a random local port with `POST /v1/messages` (streaming and not) and `GET /v1/models`, playing scripted replies: text, `tool_use`, a server error, a hang, a slow stream. It logs every request and whether the client disconnected mid-request.
- Tests: scripted replies round-trip; a killed client shows as a disconnect.

### T3 · Task file, run states and ledger (~1 h)
- `src/task.ts`: the task file (JSON) with hand-written guards: `id`, `repo`, `baseCommit`, `taskType` (`behavior` | `bugfix` | `refactor` | `tests` | `artifact`), `writablePaths[]`, `instructions`, `checks[]` (name + command), `testReport` (JUnit path), `testManifest` (path outside the repo, T7), `sentinelTest` (name), and per type: `structuralCheck` for `refactor`; `mutantsDir` and `referenceTestsDir` outside the repo for `tests`; `artifactFile` for `artifact` (the Snake games, no checks). `artifact` tasks skip dependency preparation, the negative control and all checks; corrections start from the previous attempt's file (T13).
- Attempt states. `local-worker` never decides a local pass by itself:
  - The script ends an attempt as `checks-passed`, `model-fail`, `infra-fail`, `blocked` or `forged` (for `artifact` tasks: `artifact-present` or `model-fail`).
  - Claude then records a review with `local-worker review --task <id> --attempt <n> --accept|--reject --reason <text>`.
  - Derived: `local-pass` = `checks-passed` + accepted. A rejection or failure leads to a correction while attempts remain; after the third failed attempt Claude writes the piece and records `escalated` with `local-worker escalate`.
  - An `infra-fail` re-run doesn't use up an attempt; at most 2 re-runs per task, then `blocked`.
- `src/ledger.ts`: append-only JSONL with `start`, `end`, `review` and `escalate` records, each carrying the run configuration hash. A `start` with no `end` reads back as `incomplete`.
- Tests: bad task files refused with a reason; every state transition, including that `checks-passed` alone never counts as `local-pass`; incomplete attempts detected.

### T4 · Sandbox profiles and canaries (~2 h)
- `src/sandbox.ts` builds three Seatbelt profiles and runs commands under `sandbox-exec -f <profile>`:
  - **Worker:** write the writable paths plus the per-task home, config and temp folders; read the worktree, the worker program's install and system paths; network only to `127.0.0.1:<model port>`. Secret rules come last and override reads: deny reading any file named `.env` or `.env.*`, `*.pem`, `*.key`, and anything under `~/.ssh`, `~/Library/Keychains` and other repos. Seatbelt matches resolved paths, so a symlink to a secret is denied too; T4's tests prove it.
  - **Check:** read-only check checkout and the dependency copy, write only a temp and report folder, no network.
  - **Service check:** as Check, plus listening and connecting on the specific loopback ports the task declares, for browser or service checks. If the profile can't be set up, the check is `blocked`.
- `src/env.ts`: the scrubbed environment (allowlisted variables; fresh `HOME`, `TMPDIR`, `CLAUDE_CONFIG_DIR`).
- `tests/sandbox.test.ts` runs every canary for real under each profile: read a file in another repo; write outside the allowed paths; read a `.env` placed **inside** the worktree; read a symlink in the worktree that points at a secret; connect to another local port (a listener the test starts); connect to the internet; and, under Check, connect to the model port. All must be blocked, and the allowed operations must still work.
- If a needed limit can't be expressed in Seatbelt, stop and report; no weaker fallback (spec §6.1).

### T5 · Worktrees, diffs and dependencies (~1.5 h)
- `src/workspace.ts`:
  - Refuse when the repo has uncommitted changes in files the task touches.
  - **Dependencies, once per task:** a throwaway clone at the base commit in a temp folder, `bun install --frozen-lockfile --ignore-scripts` there (10-minute limit), then verify that no symlink in `node_modules` points outside the dependency folder or at the repo. Save the folder as the clean dependency copy.
  - **Attempt worktree:** a fresh worktree at the base commit; for a correction, apply the previous attempt's validated diff.
  - **Capture:** list every change with `git status --porcelain=v2 --untracked-files=all --ignored` (tracked, staged, untracked and ignored) and save a tar of every changed file as evidence. The replayable patch is made by `git add -A -f -- <writable paths>` in the tool-owned worktree, then `git diff --cached --binary <base commit>`, so new, staged and ignored files in writable paths are all in it.
  - **Validate:** every changed path inside `writablePaths`; no symlinks (mode `120000`); no protected file touched. Ignored files outside the writable paths are evidence of an attempted escape and fail the attempt.
  - **Check checkout:** a new worktree at the base commit, a copy-on-write clone of the clean dependency copy (`cp -c`), then the validated diff.
  - **Cleanup:** after evidence is saved, `git checkout -- . && git clean -fdx` inside tool-owned worktrees, then `git worktree remove` (never `--force`). Worktrees this tool didn't create are never touched.
- Tests on a throwaway fixture repo, including Card Table's layout copied as a fixture: path escape rejected; symlink rejected; untracked and ignored files captured; a new file in a writable path reaches both the correction worktree and the check checkout with exact contents; a tampered `node_modules` file in the worker worktree doesn't reach the check checkout; cleanup leaves no worktree behind.

### T6 · Process supervisor and cancellation (~1 h)
- `src/supervise.ts`: start a command in a new process group and record every descendant's pid as it appears (polling `ps -o pid,pgid,ppid`); at the deadline send TERM, then KILL after 5 s, to the group and to any recorded descendant that moved to another group. Report whether output was still arriving at the deadline.
- Deadlines (spec §6.3): 20 minutes for the worker; 10 minutes for all check runs of an attempt together, mutant runs included. Snake (`artifact`) tasks have no deadline (spec §12.2).
- Cancellation evidence: the worker's HTTP connection closing is the cancel signal. Proof that the server stopped generating comes from the server: the fake server's disconnect log now, and LM Studio's request log at verbosity 3 (`lms log stream`) [gate], which must show the request ending within 10 s of the kill. No evidence means the calibration step is `blocked`.
- Tests: a child that spawns grandchildren in a new group is fully killed; a hung child is killed at the deadline; the fake server records the disconnect.

### T7 · Check runner (~2 h)
- **Sentinel placement:** the sentinel test file is never committed to the target repo. The harness copies it into each check checkout from outside the repo just before a run, so the repo's own `bun test` never sees it.
- **Test manifest:** during task preparation (trusted, before dispatch), run the protected tests on Claude's reference solution with the JUnit reporter and save every test's identity (file path + full `describe > test` name) to `testManifest`, outside the repo. Supported forms: `test`/`it` inside `describe`, no tests generated at runtime from data. The grader never discovers tests from candidate code.
- `src/checks.ts` runs the task's checks in the check checkout under the Check profile and grades by run kind:
  - **Acceptance run** (behavior, bugfix, refactor): clean = every manifest test passed, the sentinel (in its own protected file) failed, nothing else failed or skipped, no suite error, exit code is bun's normal test-failure code (not 0, not a signal). Refactor also needs its structural check to pass.
  - **Tests task, real code:** at least one worker test runs, every worker test passes, no worker test is skipped or marked todo, the sentinel fails, no suite error, and the exit code is bun's normal test-failure code.
  - **Tests task, each mutant:** same report rules (no skips, no suite error, normal test-failure exit, sentinel fails), and at least one worker test fails; the sentinel never counts as catching a mutant. Pass = at least 4 of 5 mutants caught.
  - **Reference validation (preparation):** Claude's reference tests fail on every mutant; an empty worker test folder catches none.
  - Sentinel passed or missing → `forged`.
  - **Negative control:** run once on the base commit before dispatch; it must fail as the task type requires (spec §6.2), or the task is refused.
- Tests with fixture repos: clean pass; one failing; one skipped; zero tests; a source file calling `process.exit(0)` at import; a source file writing a correctly shaped fake report (expected: passes the harness, which is why Claude's review exists; recorded so); a hung test killed at the deadline; mutant grading at 4 of 5 and 3 of 5; a worker test file with a skipped test fails the tests task.

### T8 · Claude Code worker adapter (~1.5 h)
- `src/workers/claude-code.ts` builds the headless command from the run configuration:
  `claude -p --model <local model id> --output-format stream-json --verbose --strict-mcp-config --setting-sources "" --permission-mode bypassPermissions --tools <list>`
  with `ANTHROPIC_BASE_URL`, a dummy `ANTHROPIC_AUTH_TOKEN`, and the scrubbed environment, inside the Worker profile. `--tools` sets which tools exist at all (`--allowedTools` only pre-approves, so it is not used). Code tasks: `Read,Edit,Write,Glob,Grep,Bash`. `artifact` tasks: `Read,Edit,Write` only. Permissions are bypassed inside the worker program because Seatbelt is the boundary.
- A fake-server test asks the artifact worker to run a shell command and to fetch a URL; both tools must be absent from the session's tool list. The Codex fallback (T11) gets the same test.
- Each flag is checked against `claude --help` (2.1.329) while building; differences are recorded here.
- Parse the stream for completion, errors and local token counts. Prompt = task instructions + correction text (if any) + the boundary rules.
- Tests against the fake server: scripted read → edit → finish; scripted server error → `infra-fail`; scripted hang → deadline → `model-fail`.

### T9 · `local-worker` command (~1 h)
- `src/cli.ts`:
  - `run --config <file> --task <file> --attempt <n> [--correction <file> --previous-diff <file>]`
  - `negative-control --task <file>`
  - `review` and `escalate` (T3)
  - Prints one JSON result per call and writes ledger records.
- Done when: an end-to-end run on the fake server passes on a fixture task: scripted first-attempt failure, Claude's rejection recorded, correction, `checks-passed`, acceptance recorded, `local-pass` derived.

### T10 · Calibration suite (~1 h build; real run [gate])
- `calibration/` holds one tiny task and a script that runs:
  1. The whole loop: read, edit, checks fail, correction, checks pass, review accepted.
  2. Every canary from T4, attempted by a real worker session told to try each.
  3. Four tamper cases: edit a test helper, edit a file in `node_modules`, exit the test process early, write a correctly shaped fake report. The first three must be caught by the harness; for the fake report, the result records whether the harness or only Claude's review caught it.
  4. Cancellation with server evidence (T6).
- Against the fake server: built and run now.
- Against LM Studio with Inkling 2 Mini: [gate]. If headless Claude Code fails it, do T11 and rerun.
- Done when: every step passes on the real server; results saved in `results/calibration-<date>/`.

### T11 · Codex CLI fallback (only if T10 fails with Claude Code; ~1.5 h)
- `src/workers/codex.ts`, same contract, pointed at LM Studio's OpenAI-compatible endpoint. Rerun T10. If both fail, stop and report.

### T12 · Usage accounting (~1.5 h)
- First capture real transcripts from Claude Code 2.1.329 (a short headless session, and one interrupted mid-response) as fixtures, and record the schema found.
- `src/usage.ts`: read a session transcript by session id; group assistant records by API message id and count each response once, using the final record's usage (streamed placeholder counts are ignored); include failed and interrupted calls when their usage is recorded. Cost-weighted total = input + 1.25 × cache writes + 0.1 × cache reads + 5 × output.
- Any call with unrecoverable usage makes the session total `unknown`; an `unknown` on either side makes a packaging ratio `inconclusive`.
- Tests on the captured fixtures: repeated message ids counted once; a missing usage field propagates as `unknown`.

## Phase 1b · Snake evaluation (spec §12)

### T13 · Snake task and runner (~1.5 h)
- `snake/starter/TASK.md` and `snake/starter/AGENTS.md`: copied word for word from CHE-1166's `snake-starter/`; `snake/prompts.ts`: CHE-1166's boundary, planner, review and retry text, copied from its `src/snake.ts`. The runner refuses to start if any hash differs from CHE-1166's files, pinned to its accepted run `snake-20261121-02`.
- `src/snake.ts`, a port of CHE-1166's `snake-human-review-v2` runner to this harness:
  - `prepare <run id>`: for each arm, a workspace that is a fresh git repo with one commit holding only `TASK.md`, `AGENTS.md` and an empty `src/` (the base commit); a random arm order; random labels A to C; a manifest with hashes, run configuration and limitations. The manifest, logs and mapping live under `results/<run id>/private/`.
  - `run <run id>`, one arm at a time in the manifest's order:
    - Claude only: a new standalone headless session `claude -p --model claude-opus-5-5 --effort high --session-id <uuid> --tools Read,Write,Edit --permission-mode acceptEdits --strict-mcp-config --setting-sources ""` in the workspace, given CHE-1166's boundary text and the task. `acceptEdits` lets it save the file; `--tools` keeps the shell and web tools out. Before the scored run, an unscored smoke session in a scratch folder must write a file with these exact flags.
    - Inkling only: `local-worker run` with an `artifact` task in the workspace, same boundary text and task.
    - Both solo arms use CHE-1166's rule (spec §12.2): success = normal exit and a non-empty file; otherwise retry with its retry text, keeping the existing file.
    - Hybrid: a new standalone Claude session (same settings, read-only tools) writes one assignment without code, using CHE-1166's planner prompt; Inkling builds; a new Claude review session reads the file and answers accept, revise with a scoped correction, or blocked, in CHE-1166's decision shape and review prompt; up to 3 attempts.
    - After every attempt: scope check (only `src/snake.html` changed), file present and non-empty, hash and size saved. A correction or retry continues in the same workspace from the previous attempt's file, as in CHE-1166.
  - Every Claude session id and every Inkling request is logged for T12. Elapsed time is measured per arm, with no cutoff.
  - `publish <run id>`: copy the three games to `~/projects/local-ai-output/<run id>/` as `A.html` to `C.html` with an index page that shows only each label and a game link, or "no playable game". No timings, attempts, outcomes or usage appear there (CHE-1166's index showed timings; this one doesn't, to keep the review blind). Everything else stays in `results/<run id>/private/` until Che submits.
- Tests on the fake server: a full dry run through the real runner with scripted Inkling and stubbed Claude sessions produces three labelled files and a private manifest and ledger; a hybrid revision keeps and edits the previous file; a call that exits non-zero after writing a file is retried; a scope violation stops that arm; a changed task file is refused; the index contains no timing or outcome text.

### T14 · Run the Snake evaluation [gate] (~1 h, mostly unattended)
- Load Inkling 2 Mini at 131,072 context (run configuration), run the three arms, unload.
- Done when: three games are ready (or recorded as failed) in the output folder and every arm's stats are saved.

### T15 · Che's review page and report (~1 h, then Che's play time)
- An html-pages choice page: per game A to C, works (fully, partly, not at all), score 1 to 5, and notes; then a ranking of all six Snakes, listing Claude's three by label and GPT's three by CHE-1166's labels. Nothing about Claude's three beyond label and link appears before submission; a game with no file is shown as "no playable game" and ranked last.
- After Che submits: reveal the mapping and publish the report with all six side by side: Che's ratings and ranking; elapsed time, attempts, outcome, frontier tokens (raw and cost-weighted for Claude; as CHE-1166 recorded them for GPT), Inkling tokens, and the hybrid review notes. CHE-1166's files are read only.

## Phase 2 · Model test

### T16 · Benchmark tasks (~2 h)
- A sandbox repo `bench/` (Bun + TypeScript + React) with five frozen tasks, each with base commit, task file, protected tests, sentinel, test manifest and negative control: a pure function, a bug fix, a React component (`@testing-library/react` under `happy-dom`), a refactor with a structural check, and a test-writing task with 5 mutants and reference tests outside the repo.
- Also frozen before T17: `bench/prompts/` (the exact worker prompt template) and `bench/corrections.md` (the correction rules: problem and failing output only, never code; same for every model).
- Done when: every negative control fails as required and a reference solution for each task passes.

### T17 · Run the model test [gate] (~3–5 h, mostly unattended)
- Freeze `bench/candidates.json` with exactly the spec's four candidates and one setting each: Inkling 2 Mini Q4_K_M; Qwen3.8 27B (the unsloth GGUF build); Qwen3.6 35B-A3B 4-bit (MLX); Gemma 4 E4B 4-bit (MLX).
- Per model: a run configuration, load, 5 tasks with up to 3 attempts and Claude's reviews, unload.
- Apply the stop rule and ranking (spec §8). Save everything in `results/model-test-<date>/`.

### T18 · Model test report (~30 min)
- On the page: per model, local passes, corrections, escalations, infra failures, median attempt time; the chosen model or the stop.

## Phase 3 · Card Table trial

### T19 · Pick and prepare (~30 min, needs Che)
- Che picks 1–2 Card Table issues. Card Table's checks: `bun run typecheck` and `bun test` (it has no lint script).
- Per issue, a standalone preparation session (`claude -p`, Opus 5.5) writes the task file, protected tests and manifest, and commits the task file and protected tests on a branch as the shared base commit. The sentinel and manifest stay outside Card Table (T7). Its session id is saved.

### T20 · Hybrid and baseline runs [gate] (~half day)
- Per issue, two new standalone Claude Code sessions (not forks; Opus 5.5 at the same effort; session ids saved), each on its own worktree of the base commit, each given only the task file and base commit, with no access to the other's worktree or results folder:
  - Hybrid: orchestrates the local model with `local-worker`.
  - Baseline: Claude alone.
- Each finishes only when it passes the same checks and the same review step. The baseline worktree is removed after evidence is saved.

### T21 · Integrate and merge (~1 h, needs Che)
- Merge the hybrid result into the issue branch serially, re-run every check on the merged commit with the Check profile (blocked outcome included), then run Card Table's own `bun run typecheck` and `bun test` on that exact commit with no sentinel added; both must pass. Re-review any conflict resolution.
- Open a draft PR in Card Table; merge only with Che's yes, per his PR rules.

### T22 · Trial report and packaging decision (~30 min)
- Summed cost-weighted tokens for both arms after dispatch and in total, the two ratios against the bars (60% and 80%), local code share, corrections, escalations, elapsed time. Packaging needs phase 3's acceptance criteria met (an issue merged) **and** both ratios under the bar; `inconclusive` blocks packaging until Che decides.

## Phase 4 · Package (only if T22 passes)

### T23 · Skill (~1 h)
- A `local-orchestrator` skill in `~/projects/ches-skills/skills/` through `new-skill`, then `bin/publish`.

## Order

- Now, no model server: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 (fake server) → T12 → T13 → T16.
- After Che's word on CHE-1166: T10 (real) → T11 if needed → T14 → T15 → T17 → T18 → T19 → T20 → T21 → T22 → T23.

Estimate (not a limit): about 2.5 days of build before the gate; after it, Claude's three Snakes are ready for Che to play within about 2 hours.

## Reviews

- Code written by Claude: Sol and Terra review before merge; the closing audit adds Gemini.
- Each phase's results go on the feature page as the record.
