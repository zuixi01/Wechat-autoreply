# 工作记忆持续学习 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 完整实现上一轮七步计划的持续学习工作记忆并按证据验收。

**Architecture:** TypeScript shared contracts/logic, SQLite local authority, PostgreSQL enterprise authority. Background reviewers propose immutable revisions; retrieval uses scoped published snapshots; feedback and evaluations govern activation and rollback.

**Tech Stack:** Electron/React/TypeScript/Zod/node:sqlite/pg/Vitest, existing model and Jev transports.

**Spec:** ../specs/2026-10-03-learning-memory-design.md

## Global Constraints

- Scope must be trusted; cross-customer generalization is a separate proposal. No customer display-name identity.
- Defaults: suggest mode; retrieval max 5 entries, 2000-token conservative budget; learner concurrency 1.
- Immutable revisions, optimistic locking, evidence, tombstones, transactional writes; no successful save on disk failure.
- Learning cannot change business facts or sending authority. Enterprise changes use publication/evaluation admission.
- Preserve all preexisting uncommitted changes. Do not reset, stash, bulk stage, or install unneeded dependencies.
- Real labels and live platform acceptance remain explicit requirements; synthetic fixtures do not substitute.

## Review Focus

- Same display names across accounts/customers must not contaminate memories.
- Late learning response after forget/update must not resurrect or overwrite content.
- Repeated generic successful sends must not inflate quality claims.
- New memory publication must invalidate reuse of previously reviewed generated results.
- Chinese compound queries and empty queries must not load arbitrary unrelated memories.

## Task 1: Scoped durable records, revisions, feedback and legacy import

Files: create src/shared/contracts/learning-memory.ts; src/core/memory/learning-store.ts; src/core/memory/learning-schema.ts; src/core/memory/learning-scope.ts; tests/unit/learning-store.test.ts.
Interfaces: MemoryScope, LearningEpisode, MemoryContent, MemoryRevision, LearningSettings; LearningStore(path). recordEpisode(scope, episode), propose(scope, input), activate(scope,id,expectedRevision), revise(scope,id,expectedRevision,input), rollback(scope,id,expectedRevision,targetRevision), forget(scope,id,expectedRevision), migrateLegacy(filePath), list(scope), history(scope,id), feedback(scope,input), close().
- [ ] Write failing tests for isolation, durable restart, idempotency/conflicting events, pending proposals, revision conflicts/rollback, provenance, forgotten replay suppression, failed writes and unknown-scope import.
- [ ] Run `scripts/dev-tools.ps1 test -- tests/unit/learning-store.test.ts`; confirm missing feature failure.
- [ ] Implement contracts/schema/store with transactions and strict validation, preserving legacy source.
- [ ] Run task tests + typecheck:services; record exact evidence. Commit only this task's new files if appropriate, never preexisting changes.

## Task 2: Chinese retrieval, snapshots and local generation

Files: create src/core/memory/learning-retrieval.ts, memory-provider.ts; modify runtime-host.ts/session-types.ts/ai-client.ts/main integration and provider bundle; tests/unit/learning-retrieval.test.ts; tests/integration/local-learning-memory.test.ts.
Interfaces: retrieve(scope,query,{maxEntries,maxTokens}) -> {snapshotId,items,estimatedTokens}; buildLearningContext(snapshot). MemoryProvider wraps existing ProviderAdapter and records loaded independently of declared adoption. Old fallback compatible without injecting unscoped legacy cards.
- [ ] Failing tests for Chinese pricing/complaints, expired/inactive/private entries, budget/max5, no-match, version snapshot and stale changes.
- [ ] Run tests RED, implement scoped FTS and pure ranking, trusted binding at local runtime, context separate from facts.
- [ ] Run GREEN and existing provider/generation regression tests; record evidence.

## Task 3: Persistent automatic review queue and model adapter

Files: create learning-jobs.ts, learning-reviewer.ts, learning-scheduler.ts, main/services/learning-runtime.ts; tests/unit/learning-jobs.test.ts and tests/integration/learning-runtime.test.ts.
Interfaces: enqueue(scope,episodeId,trigger), claim(owner,now), complete/fail/cancel; LearningReviewer.review(request,signal) returns validated proposed operations with evidence and usage; scheduler start/stop/wake/off.
- [ ] RED: event coalescing, only trusted feedback, durable queued/running recovery, same-scope multi-case review, max retries, deadlines, foreground preemption, late response after forget, budget.
- [ ] Implement one-worker persistent queue with bounded model request, case digest, existing-memory read-before-write, no-op permitted, no desktop/network side-effect tools.
- [ ] GREEN and normal reply failure-isolation checks; capture real model adapter protocol evidence without customer data.

## Task 4: Feedback, replay validation, publication and curation

Files: create learning-evaluation.ts, learning-curator.ts and evals/memory/ runner/metrics/README; tests/unit/learning-evaluation.test.ts, learning-curator.test.ts and tests/regression/learning-loop.test.ts.
Interfaces: immutable evaluation binding content/scope/dataset/model, publishCandidate evaluationHash+expectedRevision; three modes; curator proposes merges and archives owned/unpinned content.
- [ ] RED: V1→feedback→V2→validation→activate/rollback, old-base refusal, absent labels fail admission, pinned protection, merge evidence, budget accounting, adoption vs delivery counters.
- [ ] Implement paired A/B/C replay, leakage checks by conversation, real label distinction, independent publish gates, maintenance and recoverable archives.
- [ ] GREEN; document business-evidence outstanding separately from synthetic acceptance.

## Task 5: Enterprise authority and version binding

Files: create server migrations (next available index), server/src/memory/ repositories/services; extend shared generation/publication/contracts and existing model quota stages; authenticated device feedback/proposal routes, administrator publish integration.
- [ ] RED: tenant/account/customer isolation in actual SQL, authenticated scope overrides forged fields, idempotent events, memory version publication hash/evaluation fingerprint/cache, optimistic edits, revoked publication, quota.
- [ ] Implement PostgreSQL authority with same shared semantics, server-side retrieval in text generator and review, immutable version pinning through current publication system. Devices cannot publish by their own credentials.
- [ ] GREEN on PGlite integration and PostgreSQL concurrency harness where configured. Version compatibility explicitly tested.

## Task 6: Desktop APIs and complete working memory UI

Files: create trusted learning IPC/preload APIs and renderer learning views; reuse MemoryWindow trace viewer; feedback in ReplyWorkbench; tests/integration/learning-ipc.test.ts; desktop smoke extensions.
- [ ] RED: wrong sender/scope rejected, no generic IPC privilege bypass; UI pending/saved/error states accurately represent committed storage.
- [ ] Implement cases/memories/skills/candidate-diffs/jobs/quality/cost/version actions and mode switches. No fake learning data presented as actual state. Keep existing trace playback.
- [ ] Run desktop smoke and browser skill visual/keyboard/narrow-window checks, inspect screenshots.

## Task 7: Full verification, review and acceptance evidence

Files: docs/learning-memory.md, docs/learning-memory-acceptance.md, scripts/learning acceptance demo; final review package.
- [ ] Run all tests, all typechecks, build, lint changed code and standalone complete learning demo on durable DB.
- [ ] Freeze A/B/C versions/data; run labeled evaluation when actual business material available; mark absent evidence incomplete, never synthetic as business success.
- [ ] Fresh independent final code review per executing-plans skill; fix material findings and verify.
- [ ] Requirement-by-requirement completion audit; only mark active goal complete if all required evidence exists.
