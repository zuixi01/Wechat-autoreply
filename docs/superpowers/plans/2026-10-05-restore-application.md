# Restore application and acknowledgement implementation plan

> **For agentic workers:** Use superpowers:executing-plans, test-driven-development and verification-before-completion. Continue the already authorized D16 sequence without another approval round.

**Goal:** Atomically quarantine restored local history, acknowledge that exact application centrally, and complete recovery fences while preserving human ownership and independently unresolved executions.

**Architecture:** Consume migration 027's immutable decision, recompute the current complete basis in authenticated target requests, then apply only the exact uploaded local source set in one SQLite transaction. Append local application and central acknowledgement journals. Historical provenance remains immutable. Finishing a recovery does not start automatic replies; account resume and all existing execution/reconciliation guards still apply.

**Spec:** Approved `docs/development-plan.zh-CN.md`, D16; current `docs/ledger-recovery.zh-CN.md`; preceding `2026-10-05-restore-decisions.md` supplies exact decision contracts.

**Tech stack:** Existing TypeScript/Zod, SQLite ledger, PostgreSQL account authority, private target HTTP and main-process IPC.

## Constraints

- No real chat probing, chat reads/messages or provider calls while the user defers physical testing.
- Use current `codex/reliable-agent`, preserve another author's learning changes, and do not commit shared files.
- Do not overwrite unknown/confirmed/not_sent physical history or grant replay rights from quarantine decisions.
- Keep default five-second test deadlines, original PostgreSQL limits and complete data coverage. No truncating history to a displayed page.
- Never remove or weaken provenance tables/pointers to clear a fence. A marker alone, writable sidecar or renderer claim cannot authorize recovery.
- Existing administrator decisions are metadata review, not complete proof of backup-after history. If required independent history/device facts or unresolved-permit acknowledgements are absent, final activation must remain blocked.

## Review focus

- Crash/response loss between local commit, central acknowledgement and local acknowledgement persistence: retry exactly, never reprocess old messages.
- Multiple restores of the same profile: latest provenance must be covered, old receipts cannot clear new fences.
- New central settlement/lease/device revocation after sealing invalidates stale application requests.
- Multi-account or conversation identity differences must never consume another employee's messages or change another account's human ownership.
- Runtime, direct sender and administrator resume must agree on the completed fence; completing recovery must not bypass unresolved reconciliation/request seals.

## Task 1: Authenticated target decision retrieval

Files: new `server/src/execution/restore-application-authority.ts`; extend private restoration routes/contracts and `AgentRegistration`.

- [x] Write target tests: independent admin-only writes, only the exact unrevoked target can fetch a matching context/decision; wrong account, restoreId, upload, scope, stale basis and damaged decision are rejected. Expected RED: missing application authority APIs.
- [x] Add strict request/result schemas and `RestoreApplicationAuthority.decision(credential,input)`. Authenticate under `AccountAuthority.withLockedAccount(...,true)`, bind exact current target and complete metadata basis. Keep account paused, with no active lease/live issuance. Return immutable decision plus source manifest references only; no customer body or provider secrets. Expected GREEN: target tests and previous administrator recovery tests.

## Task 2: Local atomic quarantine application

Files: new `src/core/persistence/restore-application-journal.ts`, ledger methods/schema, backup compatibility, integration tests with real SQLite.

- [x] Test missing provenance, corrupted source, changed source basis, wrong device scope, gap/identity facts insufficient for activation and audit/storage failure. Expected RED: absent `Ledger.applyRestoreDecision(scope,decision,now)` API.
- [x] In one SQLite transaction, validate the current restored provenance and exact uploaded pre-application inventory digest. Bind every local message/execution to its stable identity and original content/state hashes. Append an immutable application receipt; quarantine existing inbound history and keep covered conversations human-owned. Preserve terminal/unknown execution records and their original receipts. Do not clear restoration fences before exact central acknowledgement. An idempotent retry verifies the saved receipt and returns the same application.
- [x] Test source messages outside this account remain unchanged, outbound history is not consumed, zero-local-message execution sessions remain covered, unknown history still blocks independent send admission, transaction failure rolls back all state, and restart reuses the exact committed receipt. Expected GREEN: meaningful SQLite/ledger/recovery suites, with current schema compatibility explicitly preserved.

## Task 3: Central exact acknowledgement and guarded completion

2026-10-07 coverage follow-up: [account-wide completion audit](2026-10-07-restore-completion-audit.md) now authenticates, locks and checks every restoration case against its latest approval and complete original declaration/source/resolution. Actual 51/52-case lock-wait coverage, final-clock expiry, original corruption and strict read-only CLI boundaries are verified. The immutable final admission and guard changes below remain open.

2026-10-07 partial implementation: [durable completion declaration](2026-10-07-restore-completion-declaration.md) adds immutable authenticated target request/receipt, audit rollback, independent-pool duplicate confirmation, revoked account-lock waiter rejection and durable host retry. The receipt explicitly does not grant admission; all-case final authority and guard replacement below remain unchecked.

Files: next unused central migration, application authority, administrator restore-state guard, restore-review state helper, target contracts.

- [ ] Test acknowledgement mutation/cross-scope rejection, duplicate acknowledgement across independent pools, audit rollback and stale basis after a late settlement. Expected RED: missing acknowledgement method/tables.
- [ ] Append-only acknowledgement binds tenant/account/case/upload/target/restoreId/context/decision hash/source inventory/application receipt. Authenticate and account-lock the target; revalidate current exact decision and required independent facts before accepting completion. Preserve separate unresolved execution/request-seal blockers; never settle old unknown based on quarantine alone.
- [ ] Replace preparation-only restore pause guard with a migration-owned guard that requires exact completed review acknowledgement for every relevant open restoration. Do not grant ordinary roles update/delete authority. `Administration.resume`, lease admission and local runtime/sender must continue to reject pending or damaged restoration state.
- [ ] Real PostgreSQL tests must prove same-account issuance waits behind completion, revoked waiters fail, one exact acknowledgement/audit persists, and another pending case prevents resume. Expected GREEN: original concurrent suite plus retained new assertions.

## Task 4: Main-process restart-safe orchestration

Files: existing restoration service/runtime, private IPC and employee restoration UI; tests with synthetic HTTP and ledger.

- [x] Test failure/cancel after local commit, lost acknowledgement response, restart before local receipt persistence, two simultaneous button clicks and settings/account change mid-flight. Expected RED: absent orchestrator flow.
- [ ] Main process discovers its own restore context/scope, reads current decision and source binding, verifies quiescence, atomically applies locally, and submits exactly the durable receipt. Persist the authenticated central acknowledgement before changing local fence state. Preserve stopped runtime/human ownership; do not auto-acquire a lease or start replying.
- [x] UI only sends strict empty requests; it cannot supply file paths, scope, arbitrary decision IDs or release flags. Show completion accurately and leave employee review/explicit start separate. Expected GREEN: private IPC/HTTP/SQLite restart tests and own synthetic desktop renderer smoke. Do not touch actual WeChat/WeCom.

## Task 5: Complete verification and handoff

- [x] Scoped RED/GREEN, current services/node/web checks, scoped lint and required PostgreSQL checks. Run full regression sequentially; keep failed runs and do not broaden timeouts.
- [x] Fresh independent scoped review, reproduce/fix material findings with covering tests; document exact source/build/test limits and CLI/employee steps.
- [x] Keep D16 joint settings/knowledge/learning/central backups, large-scale recovery tests and production rollout as explicit remaining work. Prioritize production WeChat/WeCom adapters and Jev business evaluation once the user permits physical testing; do not call metadata scaffolding a working live sender.

## Execution ledger — 2026-10-05

- 2026-10-07 [ordered observation](2026-10-07-restore-ordered-observation.md): authenticated public-key preparation, source-only historical reread quarantine and signed contiguous post-boundary messages now share the SQLite collection transaction. Task 3 final completion/guards and Task 4 final acknowledgment/employee completion remain open; production ordered-source verification and long-term authorization renewal remain pending.

- 2026-10-07 [independent resolution reapplication](2026-10-07-restore-resolution-reapplication.md): authenticated target delivery of complete original reconciliation/request-seal evidence and append-only restored-host execution journal are connected. Every old execution remains intact. Task 3's final central completion/guards and Task 4's source reread/final acknowledgment/employee completion remain open.

- 2026-10-07 target follow-up: [recovery target retrieval and host preparation](2026-10-07-restore-recovery-target.md) now connects the independent authorization to the exact credential-bound target and quiescent SQLite application. Task 3 completion/guard and Task 4 final local-resolution/reread/acknowledgment orchestration remain open; no automatic start or fence release.

- 2026-10-07 recovery boundary increment: [maintenance authorization and durable local boundary](2026-10-07-restore-recovery-authorization.md) now bind all original reconciliations/applications and source history. SQLite application retains all provenance fences and original unknown outcomes. Tasks 3/4 remain unchecked until authenticated target retrieval, independent local resolution reapplication, historical reread classification, central completion and admission guards are connected. No physical or full-goal completion claim.

- 2026-10-07 prerequisite update: independent signed full history, immutable authenticated history records, independent maintenance registration/revocation, and [full execution outcome maintenance review](2026-10-07-restore-execution-review.md) are implemented. Latest ordinary full suite 163 files / 1663 passed and final actual PostgreSQL seven files / 70 passed; failed runs retained. These supply prerequisites only: Task 3 final approval/new boundary/guard completion and Task 4 local final fence orchestration remain unchecked. Unknown permits still require separate independently applied reconciliation, and production platform/business/multiple-PC/release acceptance remains open.

- Task 1: complete. Target preparation RED in `restore-application-target-red-verified.json`; five recovery files/53 checks GREEN in `restore-application-target-extended.json`. Actual PostgreSQL `6bf92e85-abf2-4d61-b46b-39b801788d7d`: 41 passed, migrations 001–028 repeated, role reset and non-inheritance proved. Later target/acknowledgement HTTP contract: nine passed in `restore-application-http-ack-first.json`.
- Task 2: local apply/immutable receipt implemented. RED `restore-application-local-red.json`; local application/inventory/backup 41 GREEN in `restore-application-local-first.json`. Added exact ACK journal, bad scope/hash/release, restart, corrupt journal and retained fence: six GREEN in `restore-application-local-ack-first.json`. More-than-page and missing-provenance cases added for final regression; do not premark their result.
- Tasks 3/4: quarantine acknowledgement and employee orchestration implemented; final recovery release still pending. Central method RED `restore-application-ack-red.json` then nine GREEN; main flow/private IPC RED `restore-application-runtime-red.json` then 91 GREEN; expanded main restart/lost-response/changed-device + local journal: 99 GREEN in `restore-application-client-expanded.json`. PostgreSQL `5506d2b5-fa0c-4bb3-8ce9-2291159f493d`: 41 passed, migrations 001–029 repeated and cleaned, two independent account-lock waiters append one exact ACK/audit. Added revoked-lock-waiter assertion for final PostgreSQL run.
- Ruling: central acknowledgement means `quarantine_recorded`, not final recovery completion — original independent backup-after history proof has no complete verified contract yet; metadata notes/rulings alone cannot supply it — cost if wrong: recovery remains conservatively paused until that remaining work is implemented. Preserve current central guard and global local provenance fence, including other accounts. Do not check off Task 3's guard replacement or final completion claims.
- Ruling: local application/ACK journals are optional immutable auxiliary tables compatible with existing ledger schema 12 (as pause/inventory journals), rather than a destructive version transition — costs no source-record rewrites; old readers retain the existing provenance fence. Receipts verify current context before new application/acknowledgement and never alter unknown send records.
- Ruling: continue the shared `codex/reliable-agent` checkout without committing/merging; another chat actively owns learning changes — avoids capturing unrelated edits. Typechecks/full runs must report any changing-worktree failures honestly.
- Independent review `/root/restore_application_review`: no confirmed P1/P2 in this increment. Historical application retry/ACK does not prove current source health; future final recovery release must independently verify current facts. Reviewer read supplied reports; did not run physical tests. Concurrent ACK was subsequently exercised in the actual PostgreSQL report above.
- Full original D00–D20 goal remains active. No physical WeChat/WeCom tests, live Jev calls, installations, shared commits or deployments were performed in this increment. Final task verification records follow below after completion.
- Verification failure retained: first full run `restore-application-regression.json` = 119 files, 1226 passed / 1 failed / 0 skipped. The new 150-message fixture incorrectly asserted an empty display-page cursor while its full visitor still covered all source rows; its early assertion also left that fixture handle open. Corrected the fixture to assert the real default 50-item pagination contract and close its ledger on setup failure. No production guard, inventory coverage, limits or assertions were removed. Repair `restore-application-page-fixture-green.json` = all seven passed, including exactly 153 inbound quarantines across login epochs and 152 in the main conversation. Repeat full run required for final verification.
- Added real backup-after-application verification: an applied/acknowledged schema-12 file can be backed up and restored again; the new provenance has no current ACK, and neither old decision nor old ACK applies. `restore-application-new-provenance-green.json`: seven passed.
- PostgreSQL verification failure retained: `8887132e-25b8-4ee2-ac61-6105a0170d03` cleaned its container, 40 passed / 1 failed. The new revoke-waiter action ran before an original later assertion requiring the evidence basis to remain current; device revocation correctly invalidated that basis. Reordered only the new revocation action to run after all original assertions. No permissions, assertions, coverage or deadlines weakened. Repeat original 41 checks required.
- Current PostgreSQL `a74824d3-db81-4762-8903-80019c0de2a6`: all 41 passed and container cleaned; the original current-basis assertions remain, and the appended ACK waiter is denied after real locked revocation. Same-account duplicated ACK and audit remain exactly one; no old unknown is settled or restored account resumed.
- Final verification: `restore-application-regression-final.json` = 119 files / 1232 passed / 0 failed / 0 skipped. This run includes all four application-specific files with 110 passed. Temporary system-awake request was removed in `finally`; defaults and original file-specific deadlines unchanged. Current node/web/services typechecks all exit 0. Scoped 18-file lint exits 0 with no errors; its recorded formatting warnings are in concurrently edited learning-client lines. Whole-repository historical lint failure remains open.
- Actual renderer/preload: `desktop-smoke/4cb50356-a536-4352-ba8d-3f616dd6a219` passed in default hardware mode, process exit 0, no timeout. Strict empty bridge requests, duplicate clicks, malformed release claim rejection, retry and historical quarantine status checked, screenshot inspected. Zero chat reads/messages/provider calls/network attempts. Uses current source output, not an installed/new packaged release.
- Closed evidence snapshot: `.local/reports/restore-application-stage/de36d10a-1cdc-448e-b013-c27936004818/result.json`; incrementChecksPassed=true / combinationVerified=true / fullGoalComplete=false / releaseReady=false. Captures 21 source hashes; worktree is shared and unfrozen, and this record does not certify subsequent edits. Original REDs, first full failure, failed revoke-fixture ordering run and transient learning-file type failures retained. Tasks 3's final release certificate/guard and Task 4's final fence transition remain explicitly pending; no entire-plan/full-goal completion claimed.
