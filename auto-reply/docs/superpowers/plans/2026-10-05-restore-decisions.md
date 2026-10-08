# Restore decisions implementation plan

> **For agentic workers:** Use superpowers:executing-plans, with test-driven-development and verification-before-completion.

**Goal:** Complete the administrator decision step of the approved D16 recovery sequence, retaining complete, immutable review results for later atomic local application and central acknowledgement.

**Architecture:** Reuse the complete assessment and authenticated account lock. Administrators record explicit per-subject rulings against exact evidence receipts. Corrections append a compare-and-swap revision; a final decision seals all latest rulings at the current complete basis. This decision authorizes quarantine preparation only: it never starts automatic replies, rewrites physical outcomes, clears SQLite provenance or releases the central pause.

**Spec:** Existing approved `docs/development-plan.zh-CN.md`, D16; `docs/ledger-recovery.zh-CN.md` recovery sequence.

**Tech stack:** TypeScript, Zod, PostgreSQL/PGlite, existing independent administrator CLI.

## Constraints and rulings

- Preserve original D00–D20 scope and deferred real client/provider tests. No live messages, deployments or approvals are needed for local development.
- Work in existing `codex/reliable-agent`; another author is changing learning modules. Do not alter their modules or commit shared changes.
- Keep Vitest default 5000 ms and maximum one worker. Preserve failures, not merely targeted successes.
- Ruling: Final decisions use `quarantine` for restored history and remain `canRelease=false`; verification of missing backup-after history, local atomic application and central acknowledgement remain subsequent D16 tasks. Wrong choice costs a further protocol extension, not authority to replay messages.
- Ruling: Corrections require the exact previous ruling ID. Never silently select the last timestamp or overwrite a human conclusion. Wrong choice costs an explicit retry after a competing administrator's edit.

## Review focus

- Concurrent corrections and stale previous IDs cannot silently win.
- All subjects, including central records absent from the backup and records beyond a display page, contribute to coverage and the final digest.
- Historical retries return the original receipt without asserting that a changed basis is current.
- Time-zone formatting and UUID case never change semantic binding; corrupt stored columns/receipts fail closed.
- Decisions and audit rows commit together; ordinary device credentials cannot create or mutate administrator rulings.

## Task 1: Explicit per-subject rulings

Files: new shared `restore-decision.ts`, migration `027-restore-decisions.sql`, new central `restore-decisions.ts`; reuse complete assessment and evidence receipt validation. Integrate new Administration methods and strict CLI commands.

- [x] Write integration tests for immutable rulings, full coverage, evidence binding, exact previous-ID correction, stale basis and historical retries. Run and retain RED for missing APIs.
- [x] Implement schemas, append-only storage, full current-basis coverage and strict admin routes. Run targeted GREEN.

## Task 2: Seal a complete decision

- [x] Write tests for incomplete/held coverage rejection, complete quarantine decision, exact idempotency, stale digest, sealed-ruling immutability, damage, authentication and atomic audit rollback.
- [x] Implement final decision creation/read with complete rulings digest and context/inventory binding. Keep all existing pause/send guards intact. Run targeted GREEN and existing recovery regressions.

## Task 3: Verification and durable handoff

- [x] Run services/node/web type checks and scoped lint. Run meaningful PostgreSQL concurrent correction/seal tests with original limits; inspect every result.
- [x] Perform fresh review and reproduce any material findings before fixing. Record exact evidence, update recovery CLI documentation/status, and preserve whole-goal limitations. Do not claim installation or physical testing from synthetic results.

## Execution record

- Initial RED: `.local/reports/restore-decisions-red.json`, 9 failures for missing methods/commands. First GREEN: 42 tests; extended coverage: 44 tests.
- Fresh independent review found P2: a corrupted sealed basis lookup column could conceal a frozen decision. `restore-decisions-review-red.json` reproduced it; GREEN verified the correction path. Added adjacent seal/ruling-column tests: `restore-decisions-columns-red.json` reproduced both failures; final scoped report `restore-decisions-final-focused.json` passes 46 tests in four files, including 13 decision tests. Full saved receipts are checked before selecting a frozen basis; every ruling basis/revision is validated before choosing current entries. No deferred minors.
- A test's UUID assignment initially failed TypeScript's inferred UUID template type; use a distinct normalized request object. Fresh `restore-decisions-{services,node,web}-final.log` all exit 0. `restore-decisions-lint.json`: nine files, zero errors/warnings.
- Disposable real PostgreSQL run `cb57671c-38b3-4d6b-b482-69489708713e`: 41 tests, passed and cleaned up. Two independent administrator pools waited on actual account locks; duplicate initial ruling saved once, two conflicting corrections produced one success/one conflict, duplicate final seal saved once. All original isolation, assertions and time limits preserved; migration 027 applied twice.
- Full run `.local/reports/restore-decisions-regression.json`: 116 files, 1170 passed, 21 pending after two 20000 ms bootstrap hook timeouts. Windows Kernel-Power events confirm standby at 04:33 and later hibernation/resume at 09:00 during this run; affected files separately passed all 21 tests (`restore-decisions-bootstrap-recheck.json`). No timeout or isolation change.
- Re-ran full regression with temporary `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` and cleared it in finally; no power-plan change. `restore-decisions-regression-awake.json`: 117 files, 1191 passed, 6 failed, zero skipped. Failures were in concurrently authored `learning-view-state.test.ts`, added during this session; its implementation changed at 09:14. Current separate recheck passes all six (`restore-decisions-learning-view-current.json`), but this does not retroactively pass the full report. Fresh `restore-decisions-{services,node,web}-current.log` all exit 0. Both full failures remain retained; no third full rerun chasing another author's ongoing edits.
- Next executable increment: `docs/superpowers/plans/2026-10-05-restore-application.md`. The full original scope remains required; no unfinished task is marked complete merely to close this increment.
- No commit, merge, package rebuild, installation, deployment, chat read, message send or real provider call. D00–D20 full goal remains active; local atomic application/central acknowledgement, complete backup-after history proof, joint backups, physical adapters/Jev accuracy and multiple daily-use PCs remain required.
