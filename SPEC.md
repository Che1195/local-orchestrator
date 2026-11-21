# CHE-1170 · Local orchestrator · Spec

Issue: https://linear.app/chedev/issue/CHE-1170/claude-orchestrates-local-models-for-real-coding-work

Status: draft for Che's review, November 21, 2026. Nothing built yet.

## Goal

Claude Code (Opus 5.5) orchestrates local models on Che's Mac: Claude plans, writes the tests, reviews every change and owns every check; a local model writes the code. The aim is a reusable tool for Che's real work that moves code-writing off Claude usage without lowering quality.

## Constraints (from Che)

1. Claude is the orchestrator.
2. The workers are local models running on this Mac.

Everything else (runtime, worker program, models) is chosen by evidence, recorded here.

## Decisions (Che, November 21)

- First real project: Card Table (`~/projects/card-table`), after the model test.
- Corrections: the local model gets at most 2 corrections per task; then Claude writes that piece and logs an escalation.
- Worker program: picked after testing. Try headless Claude Code pointed at the local model first; fall back to Codex CLI if the local server's Claude-style API (`/v1/messages`) doesn't work. Record the result here.
- Tracking: its own Linear issue, linked to CHE-1166 as related. Not part of the CHE-1166 experiment.

## Terms

- **Worker:** one headless run of a local model inside a coding program, given one task.
- **Task:** a small change (a few files) with tests Claude wrote first; pass means the script's checks pass and Claude accepts the diff.
- **Correction:** Claude sends the worker specific feedback after a failed check or rejected diff.
- **Escalation:** after 2 failed corrections, Claude writes the piece itself.
- **Worktree:** a separate git checkout on its own branch, one per task.

## Design

1. **Model server:** LM Studio (already installed; runs llama.cpp and MLX; API on port 1234). Replace only if testing shows a blocking gap.
2. **`local-worker` script** (Bun + TypeScript). Input: repo, task file, model, time limit. It:
   - creates a worktree and branch for the task;
   - runs the worker with the task and a tool allowlist (file edits and the repo's own commands; no network, no other repos);
   - stops the worker at the time limit;
   - runs the repo's typecheck, lint and tests itself;
   - returns the diff, check results, elapsed time and token counts as JSON.
   The worker never grades its own work; only the script's checks and Claude's review count.
3. **Claude's loop:** write tests → send task → read diff and checks → accept, or correct (max 2) → escalate. Accepted work merges into the issue branch.
4. **Parallelism:** at most 2 tasks at once, as two slots on one model, or a mid-size plus a small model, within 64 GB. Each task in its own worktree.
5. **Packaging:** a skill in `ches-skills` via `new-skill`, plus the script in this repo.
6. **Ledger:** one JSONL line per task: model, attempts, pass/escalate, elapsed time, local tokens, Claude tokens (reported or estimated, labelled which).

## Phases

1. **Plumbing (≈1 hour).** Confirm LM Studio's `/v1/messages` with a loaded model (test only when CHE-1166 isn't using it). Decide worker program. Build `local-worker`.
2. **Model test (≈1–2 hours).** 5 small frozen tasks in a sandbox repo (pure function, bug fix, React component, refactor, test-writing). Run each installed coding-capable model: Inkling 2 Mini, Qwen3.8 27B, Qwen3.6 35B-A3B, Gemma 4 E4B, and others as fit. Keep the best one or two.
3. **Card Table trial.** Use it on 1–2 real Card Table issues chosen with Che. Report share of code written locally, corrections, escalations and Claude usage versus a Claude-only estimate.
4. **Package** as a skill once phase 3 shows it helps.

## Acceptance criteria

- `local-worker` runs one task end to end and returns diff + checks + metrics as JSON; typecheck and lint pass on the script.
- Model test results saved for every model tried, including failures.
- Card Table trial: at least one real issue completed with the local model writing most of the accepted code, and all of Card Table's checks passing.
- Every escalation and every Claude rewrite is recorded, never hidden.

## Stop rule

If no installed model passes at least 3 of the 5 phase-2 tasks within 2 corrections each, stop after phase 2 and report. Don't build further.

## Out of scope

- Changing or re-running the CHE-1166 experiment.
- Cloud models as workers.
- Any change to LM Studio's global settings that would affect CHE-1166 while it runs.
- Publishing anything remotely.

## Honest limits

- Claude's planning, test-writing and review still use Claude usage; savings come only from accepted local code.
- Small task counts show feasibility, not a reliable success rate.
- Memory figures are LM Studio estimates until measured.
