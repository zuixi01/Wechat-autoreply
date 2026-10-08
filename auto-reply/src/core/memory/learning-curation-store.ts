import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { LearningStore } from './learning-store'
import { learningHash, memoryScopeKey } from './learning-scope'
import {
  MemoryScopeSchema,
  type MemoryScope,
  type LearningCurationState,
  type LearningCurationReport,
  type MemoryProposal
} from '../../shared/contracts/learning-memory'

type Transaction = <T>(operation: () => T) => T
export class LearningCurationStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: Transaction,
    private readonly store: LearningStore
  ) {}
  state(scope: MemoryScope): LearningCurationState | null {
    const row = this.db
      .prepare('SELECT * FROM learning_curation_state WHERE scope_key=?')
      .get(memoryScopeKey(scope))
    return row
      ? {
          observedAt: row.observed_at === null ? null : Number(row.observed_at),
          lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
          lastActivityAt: Number(row.last_activity_at),
          epoch: Number(row.epoch)
        }
      : null
  }
  touch(scope: MemoryScope, at: number): void {
    z.number().int().nonnegative().safe().parse(at)
    this.db
      .prepare(
        `INSERT INTO learning_curation_state VALUES(?,?,NULL,NULL,?,1) ON CONFLICT(scope_key) DO UPDATE SET
      last_activity_at=MAX(last_activity_at,excluded.last_activity_at),epoch=epoch+1`
      )
      .run(memoryScopeKey(scope), JSON.stringify(MemoryScopeSchema.parse(scope)), at)
  }
  initialize(scope: MemoryScope, report: LearningCurationReport): void {
    this.transaction(() => {
      if (this.store.settings(scope).mode === 'off') throw new Error('learning_disabled')
      if (!this.state(scope)) this.touch(scope, report.createdAt)
      this.db
        .prepare(
          'UPDATE learning_curation_state SET observed_at=?,last_run_at=?,epoch=epoch+1 WHERE scope_key=? AND observed_at IS NULL'
        )
        .run(report.createdAt, report.createdAt, memoryScopeKey(scope))
      this.record(scope, report)
    })
  }
  basis(scope: MemoryScope): string {
    return learningHash({
      state: this.state(scope),
      memories: this.store.list(scope),
      feedback: this.store.feedbackEvents(scope),
      settings: this.store.settings(scope)
    })
  }
  apply(
    scope: MemoryScope,
    basis: string,
    report: LearningCurationReport,
    assertAllowed: () => void,
    merge?: MemoryProposal
  ): void {
    this.transaction(() => {
      assertAllowed()
      const state = this.state(scope)
      if (!state || state.observedAt === null || this.basis(scope) !== basis)
        throw new Error('curation_context_changed')
      if (this.store.settings(scope).mode === 'off' || !this.store.settings(scope).curationEnabled)
        throw new Error('learning_disabled')
      const merged = report.items.filter((item) => item.action === 'propose_merge')
      if (merged.length) {
        if (!merge || merge.source !== 'curator') throw new Error('curation_merge_invalid')
        if (merged.length < 2 || merged.length > 5) throw new Error('curation_merge_invalid')
        for (const item of merged) {
          const memory = this.store.get(scope, item.memoryId),
            revision = this.store
              .history(scope, item.memoryId)
              .find((entry) => entry.revision === item.beforeRevision)
          if (
            memory.pinned ||
            memory.currentRevision !== item.beforeRevision ||
            memory.activeRevision !== item.beforeRevision ||
            memory.state !== 'active' ||
            !revision ||
            !['review', 'curator'].includes(revision.source)
          )
            throw new Error('curation_context_changed')
        }
        if (
          this.store
            .list(scope)
            .some((memory) => learningHash(memory.content) === learningHash(merge.content))
        )
          throw new Error('curation_merge_duplicate')
        const evidence = [
          ...new Set(
            merged.flatMap((item) =>
              this.store
                .history(scope, item.memoryId)
                .find((entry) => entry.revision === item.beforeRevision)!
                .evidence.map((ref) => ref.episodeId)
            )
          )
        ].sort()
        if (
          learningHash(evidence) !== learningHash(merge.evidence.map((ref) => ref.episodeId).sort())
        )
          throw new Error('curation_merge_evidence_incomplete')
        const candidate = this.store.propose(scope, merge)
        for (const item of merged) {
          item.proposedId = candidate.id
          this.db
            .prepare('INSERT INTO learning_memory_replacements VALUES(?,?,?,?,NULL)')
            .run(memoryScopeKey(scope), candidate.id, item.memoryId, item.beforeRevision)
        }
      }
      for (const item of report.items) {
        assertAllowed()
        if (item.action === 'keep' || item.action === 'propose_merge') continue
        const memory = this.store.get(scope, item.memoryId),
          revision = this.store
            .history(scope, item.memoryId)
            .find((entry) => entry.revision === item.beforeRevision)
        if (
          memory.currentRevision !== item.beforeRevision ||
          memory.pinned ||
          !revision ||
          !['review', 'curator'].includes(revision.source)
        )
          throw new Error('curation_context_changed')
        if (item.action === 'archive')
          this.store.archive(scope, memory.id, item.beforeRevision, 'curator')
        else if (item.action === 'stale') {
          // A maintenance marker is not meaningful use; preserve the item's inactivity anchor.
          this.db
            .prepare(
              "UPDATE learning_memories SET state='stale' WHERE scope_key=? AND id=? AND current_revision=?"
            )
            .run(memoryScopeKey(scope), memory.id, item.beforeRevision)
          this.db
            .prepare('INSERT INTO learning_mutations VALUES(?,?,?,?,?,?)')
            .run(
              randomUUID(),
              memoryScopeKey(scope),
              memory.id,
              'curator_stale',
              item.beforeRevision,
              report.createdAt
            )
        }
      }
      assertAllowed()
      this.db
        .prepare('UPDATE learning_curation_state SET last_run_at=?,epoch=epoch+1 WHERE scope_key=?')
        .run(report.createdAt, memoryScopeKey(scope))
      this.record(scope, report)
    })
  }
  private record(scope: MemoryScope, report: LearningCurationReport): void {
    const key = memoryScopeKey(scope)
    this.db
      .prepare('INSERT INTO learning_curation_reports VALUES(?,?,?)')
      .run(report.runId, key, JSON.stringify(report))
    this.db
      .prepare(
        'DELETE FROM learning_curation_reports WHERE scope_key=? AND id NOT IN (SELECT id FROM learning_curation_reports WHERE scope_key=? ORDER BY rowid DESC LIMIT 100)'
      )
      .run(key, key)
  }
  recordFailure(scope: MemoryScope, basis: string, report: LearningCurationReport): void {
    this.transaction(() => {
      const state = this.state(scope)
      if (!state || state.observedAt === null || this.basis(scope) !== basis)
        throw new Error('curation_context_changed')
      this.record(scope, report)
    })
  }
  replacements(scope: MemoryScope, id: string): { memoryId: string; revision: number }[] {
    this.store.get(scope, id)
    return this.db
      .prepare(
        'SELECT superseded_id,superseded_revision FROM learning_memory_replacements WHERE scope_key=? AND proposed_id=? ORDER BY superseded_id'
      )
      .all(memoryScopeKey(scope), id)
      .map((row) => ({
        memoryId: String(row.superseded_id),
        revision: Number(row.superseded_revision)
      }))
  }
  assertReplacements(scope: MemoryScope, id: string): void {
    for (const ref of this.pendingReplacements(scope, id)) {
      const memory = this.store.get(scope, ref.memoryId),
        revision = this.store
          .history(scope, ref.memoryId)
          .find((entry) => entry.revision === ref.revision)
      if (
        memory.pinned ||
        memory.currentRevision !== ref.revision ||
        memory.activeRevision !== ref.revision ||
        memory.state !== 'active' ||
        !revision ||
        !['review', 'curator'].includes(revision.source)
      )
        throw new Error('memory_replacement_conflict')
    }
  }
  private pendingReplacements(
    scope: MemoryScope,
    id: string
  ): { memoryId: string; revision: number }[] {
    return this.db
      .prepare(
        'SELECT superseded_id,superseded_revision FROM learning_memory_replacements WHERE scope_key=? AND proposed_id=? AND applied_at IS NULL'
      )
      .all(memoryScopeKey(scope), id)
      .map((row) => ({
        memoryId: String(row.superseded_id),
        revision: Number(row.superseded_revision)
      }))
  }
  applyReplacements(scope: MemoryScope, id: string, at: number): void {
    for (const ref of this.pendingReplacements(scope, id))
      this.store.archive(scope, ref.memoryId, ref.revision, 'curator')
    this.db
      .prepare(
        'UPDATE learning_memory_replacements SET applied_at=? WHERE scope_key=? AND proposed_id=? AND applied_at IS NULL'
      )
      .run(at, memoryScopeKey(scope), id)
  }
  reports(scope: MemoryScope): LearningCurationReport[] {
    return this.db
      .prepare(
        'SELECT payload FROM learning_curation_reports WHERE scope_key=? ORDER BY rowid DESC LIMIT 100'
      )
      .all(memoryScopeKey(scope))
      .map((row) => JSON.parse(String(row.payload)) as LearningCurationReport)
  }
  forgetScope(scope: MemoryScope): void {
    const key = memoryScopeKey(scope)
    this.db.prepare('DELETE FROM learning_curation_state WHERE scope_key=?').run(key)
    this.db.prepare('DELETE FROM learning_curation_reports WHERE scope_key=?').run(key)
  }
}
