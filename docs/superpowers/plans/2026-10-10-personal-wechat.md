# Personal WeChat Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. The user requested direct execution in this session.

**Goal:** Stable and efficient foreground personal/batch replies, followed by multi-bubble plans, static stickers and persistent owner wording.

**Architecture:** Retain the serialized physical send guard and SQLite journal. Add durable handoff and delivery plans; use incremental list evidence and existing scoped learning primitives.

**Tech Stack:** TypeScript, Electron, SQLite, Vitest, Windows C# foreground helper.

**Spec:** ../specs/2026-10-10-personal-wechat-design.md

## Global Constraints

- Real sends only to 醉兮 and pp; foreground Windows.
- Never replay unknown dispatch; retain exact draft and receipt checks.
- Reuse existing dependencies and learning infrastructure.
- Private logs, screenshots, credentials and chat text remain ignored.

## Review Focus

- New messages during manual receipt reconciliation retain their boundary (Task 1).
- Media followed by ordinary text does not permanently disable a contact (Task 2).
- A noisy contact does not starve another queued contact (Task 2).
- Restart after the first bubble never resends it (Task 3).
- Generated replies and other-contact examples do not contaminate owner style (Task 5).

### Task 1: Durable message progress and handoff
Files: contracts/foreground-wechat.ts, core/agent/foreground-wechat.ts, core/persistence/foreground-journal.ts; tests/unit/foreground-reliability.test.ts.
Interfaces: ForegroundRecord gains handoff and source observation; journal resolution retains source checkpoint.
- [x] Write regression tests for null generation handoff, >16384 question, and late new text after reconciliation; run and observe expected failures.
- [x] Implement handoff state, full legal question limit, durable source and atomic record/checkpoint completion.
- [x] Run personal/journal regression tests, update UI states, commit.

### Task 2: Fair incremental batch and recovery
Files: foreground-batch.ts, foreground-list-scan.ts, foreground-batch-navigator.ts, foreground-wechat-driver.ts; corresponding unit tests.
Interfaces: navigator can probe current page; runtime maintains verified inventory and fair queued sessions.
- [x] Reproduce noisy queue head, mutable unrelated preview, cached stale title, cleared draft and mixed-media recovery.
- [x] Separate stable list identity from mutable summaries; cache verified inventory, probe changes and schedule sessions fairly before input.
- [x] Rebuild paused recoverable sessions from preserved checkpoints and record media handoff.
- [x] Run batch/driver regression suite and commit.

### Task 3: Resumable natural reply plans
Files: new shared/contracts/foreground-reply-plan.ts, foreground-wechat.ts, journal and driver; new reply-plan unit/integration tests.
Interfaces: ReplyPart text/image; ReplyPlan parts up to 3; checkpoint delivery cursor; legacy string remains supported.
- [x] Test ordered bubbles, partial success/restart, unknown receipt and mid-plan incoming interruption before implementation.
- [x] Add validated semantic plan generation, cursor persistence, per-part journal and receipt checks.
- [x] Run personal flow integration and commit.

### Task 4: Local static sticker delivery
Files: new sticker service/contracts/UI, IPC and preload, Windows foreground helper and driver image dispatch.
Interfaces: assets referenced by validated ID/hash, no model-provided file paths.
- [x] Test image import validation, selection/cooldown, cancellation, clipboard restoration and receipt failure.
- [x] Implement local asset controls, guarded image paste and explicit receipt verification.
- [x] Run native/desktop isolation and commit.

### Task 5: Persistent wording using existing learning infrastructure
Files: new foreground style adapter, existing LearningStore/IPC/configuration; style controls and tests.
Interfaces: local profile-scoped samples and bounded frozen retrieval, source provenance.
- [x] Test generated-text exclusion, restart retention, contact separation, bounded context and correction/deletion.
- [x] Wire verified manual observations to existing case storage and style retrieval; expose management controls.
- [x] Run learning/personal regressions and commit.

### Task 6: Release and real acceptance
- [x] Run complete suite, node/web/service type checks and relevant lint; independent branch review.
- [ ] Build Windows package, native and desktop smoke tests; integrate source and update desktop launcher.
- [ ] Switch from old executable only after it exits; real 醉兮/pp acceptance for both modes, plans, image and restart.
- [ ] Record finite measured results and remaining limits; commit and push authorized repository updates.
