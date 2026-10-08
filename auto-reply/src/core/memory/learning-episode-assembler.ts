import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  EpisodeMessageEventSchema,
  EpisodeCloseEventSchema,
  type EpisodeMessageEvent,
  type EpisodeCloseEvent,
  type LearningEpisode,
  type MemoryScope,
  LearningCorrectionInputSchema,
  type LearningCorrectionInput
} from '../../shared/contracts/learning-memory'
import type { LearningStore } from './learning-store'
import { learningHash, memoryScopeKey } from './learning-scope'

type Transaction = <T>(operation: () => T) => T
type Row = Record<string, unknown>
const IDLE_CLOSE_MS = 30 * 60 * 1000

/** Persistent buffers become immutable evidence only on explicit or idle closure. */
export class LearningEpisodeAssembler {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: Transaction,
    private readonly store: LearningStore
  ) {}

  private problem(scope: MemoryScope, problemId: string): Row | undefined {
    const key = memoryScopeKey(scope)
    if (
      this.db
        .prepare(
          "SELECT 1 FROM learning_tombstones WHERE scope_key=? AND kind='problem' AND fingerprint=?"
        )
        .get(key, learningHash(problemId))
    )
      throw new Error('problem_forgotten')
    return this.db
      .prepare('SELECT * FROM learning_problems WHERE scope_key=? AND problem_id=?')
      .get(key, problemId)
  }

  append(raw: EpisodeMessageEvent): string {
    const input = EpisodeMessageEventSchema.parse(raw),
      key = memoryScopeKey(input.scope)
    const hash = learningHash({ kind: 'message', ...input })
    return this.transaction(() => {
      const existing = this.problem(input.scope, input.problemId)
      const event = this.db
        .prepare('SELECT * FROM learning_problem_events WHERE scope_key=? AND source_id=?')
        .get(key, input.sourceId)
      if (event) {
        if (event.input_hash !== hash) throw new Error('episode_event_conflict')
        return String(event.problem_id)
      }
      if (existing?.closed_episode_id) throw new Error('problem_closed')
      const id = existing ? String(existing.id) : randomUUID()
      if (existing) {
        const count = this.db
          .prepare(
            'SELECT COUNT(*) AS count FROM learning_problem_events WHERE problem_id=? AND payload IS NOT NULL'
          )
          .get(id)!
        if (Number(count.count) >= 100) throw new Error('problem_message_limit')
        if (input.at < Number(existing.started_at)) throw new Error('invalid_episode_time')
      } else {
        this.db
          .prepare('INSERT INTO learning_problems VALUES(?,?,?,?,?,?,NULL)')
          .run(id, key, JSON.stringify(input.scope), input.problemId, input.at, input.at)
      }
      this.db
        .prepare('INSERT INTO learning_problem_events VALUES(?,?,?,?,?,?)')
        .run(key, input.sourceId, id, hash, input.at, JSON.stringify(input))
      this.db
        .prepare('UPDATE learning_problems SET last_activity_at=MAX(last_activity_at,?) WHERE id=?')
        .run(input.at, id)
      return id
    })
  }

  close(raw: EpisodeCloseEvent): LearningEpisode {
    return this.finish(raw)
  }

  closeCorrected(raw: EpisodeCloseEvent, correction: LearningCorrectionInput): LearningEpisode {
    if (raw.outcome !== 'corrected') throw new Error('correction_outcome_required')
    return this.finish(raw, LearningCorrectionInputSchema.parse(correction))
  }

  private finish(raw: EpisodeCloseEvent, correction?: LearningCorrectionInput): LearningEpisode {
    const input = EpisodeCloseEventSchema.parse(raw),
      key = memoryScopeKey(input.scope)
    const hash = learningHash({ kind: 'close', ...input, correction })
    return this.transaction(() => {
      const problem = this.problem(input.scope, input.problemId)
      if (!problem) throw new Error('problem_missing')
      const old = this.db
        .prepare('SELECT input_hash FROM learning_problem_events WHERE scope_key=? AND source_id=?')
        .get(key, input.sourceId)
      if (old && old.input_hash !== hash) throw new Error('episode_event_conflict')
      if (problem.closed_episode_id) {
        if (!old) throw new Error('problem_closed')
        return this.store.episode(input.scope, String(problem.closed_episode_id))
      }
      if (input.at < Number(problem.last_activity_at)) throw new Error('invalid_episode_time')
      const events = this.db
        .prepare(
          'SELECT payload FROM learning_problem_events WHERE problem_id=? AND payload IS NOT NULL ORDER BY at, rowid'
        )
        .all(String(problem.id))
        .map((row) => EpisodeMessageEventSchema.parse(JSON.parse(String(row.payload))))
      const messages = events.map((event) => event.message)
      const episode = this.store.recordEpisode(input.scope, {
        sourceId: `problem:${learningHash({ scope: key, id: problem.id })}`,
        identityStatus: input.scope.conversationId?.startsWith('unassigned:')
          ? 'unassigned'
          : input.scope.conversationId
            ? 'verified'
            : 'account',
        topic: (
          messages.find((message) => message.role === 'customer')?.text.trim() || '对话问题'
        ).slice(0, 240),
        startedAt: Number(problem.started_at),
        endedAt: input.at,
        messages,
        draft: [...messages].reverse().find((message) => message.role === 'assistant')?.text,
        correction: correction?.text,
        correctionReason: correction?.reason,
        outcome: input.outcome
      })
      const refs = this.store.availableMemoryRefs(input.scope, [
        ...new Map(
          events
            .flatMap((event) => event.loadedMemoryRefs ?? [])
            .map((ref) => [`${ref.id}:${ref.revision}`, ref])
        ).values()
      ])
      // Aggregate evidence carries provenance through a host generation registration;
      // loaded metrics remain actual generation loads, never an extra aggregate load.
      this.store.registerGeneration(
        input.scope,
        `problem:${learningHash(problem.id)}`,
        episode.id,
        input.problemId,
        refs,
        false
      )
      // An idle/unknown problem is evidence, never a successful learning trigger.
      if (input.outcome !== 'unknown')
        this.store.jobs.enqueue(
          input.scope,
          episode.id,
          input.outcome === 'corrected' ? 'correction' : 'completed',
          `problem-close:${learningHash(problem.id)}`
        )
      this.db
        .prepare('INSERT INTO learning_problem_events VALUES(?,?,?,?,?,NULL)')
        .run(key, input.sourceId, String(problem.id), hash, input.at)
      this.db
        .prepare('UPDATE learning_problems SET closed_episode_id=? WHERE id=?')
        .run(episode.id, String(problem.id))
      // Closed buffers keep only idempotency hashes; evidence retention owns the body.
      this.db
        .prepare('UPDATE learning_problem_events SET payload=NULL WHERE problem_id=?')
        .run(String(problem.id))
      return episode
    })
  }

  flushIdle(now: number): LearningEpisode[] {
    z.number().int().nonnegative().safe().parse(now)
    return this.transaction(() =>
      this.db
        .prepare(
          'SELECT * FROM learning_problems WHERE closed_episode_id IS NULL AND last_activity_at<=? ORDER BY last_activity_at,id'
        )
        .all(now - IDLE_CLOSE_MS)
        .map((problem) =>
          this.close({
            scope: JSON.parse(String(problem.scope_json)) as MemoryScope,
            problemId: String(problem.problem_id),
            sourceId: `idle:${learningHash(problem.id)}`,
            outcome: 'unknown',
            at: Number(problem.last_activity_at) + IDLE_CLOSE_MS
          })
        )
    )
  }

  forgetScope(scope: MemoryScope, now: number): void {
    const key = memoryScopeKey(scope)
    for (const row of this.db
      .prepare('SELECT problem_id FROM learning_problems WHERE scope_key=?')
      .all(key))
      this.db
        .prepare("INSERT OR IGNORE INTO learning_tombstones VALUES(?,'problem',?,?)")
        .run(key, learningHash(String(row.problem_id)), now)
    this.db.prepare('DELETE FROM learning_problems WHERE scope_key=?').run(key)
  }

  /** Never revive years-old open buffers on startup merely to restart their retention clock. */
  pruneExpired(now: number): number {
    let removed = 0
    for (const row of this.db
      .prepare('SELECT * FROM learning_problems WHERE closed_episode_id IS NULL')
      .all()) {
      const scope = JSON.parse(String(row.scope_json)) as MemoryScope
      if (
        Number(row.last_activity_at) >=
        now - this.store.settings(scope).caseRetentionDays * 86400000
      )
        continue
      this.db
        .prepare("INSERT OR IGNORE INTO learning_tombstones VALUES(?,'problem',?,?)")
        .run(memoryScopeKey(scope), learningHash(String(row.problem_id)), now)
      this.db.prepare('DELETE FROM learning_problems WHERE id=?').run(String(row.id))
      removed++
    }
    return removed
  }
}
