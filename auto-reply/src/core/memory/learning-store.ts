import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, constants } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import {
  MemoryScopeSchema,
  MemoryProposalSchema,
  MemoryContentSchema,
  NewLearningEpisodeSchema,
  LearningFeedbackSchema,
  LearningSettingsSchema,
  LearningSettingsPatchSchema,
  LearningCorrectionInputSchema,
  LearningResultInputSchema,
  LearningHumanFeedbackInputSchema,
  type MemoryScope,
  type NewLearningEpisode,
  type LearningEpisode,
  type MemoryProposal,
  type MemoryRecord,
  type MemoryRevision,
  type LearningFeedback,
  type LearningMetrics,
  type LearningSettings,
  type UnassignedMemory,
  type MemorySnapshotItem,
  type MemorySnapshot,
  type ClaimedLearningJob,
  type LearningReviewResult,
  type RetentionReport,
  type LearningCorrectionInput,
  type LearningResultInput,
  type LearningHumanFeedbackInput
} from '../../shared/contracts/learning-memory'
import type { MemoryContent } from '../../shared/contracts/learning-memory'
import { initializeLearningDatabase } from './learning-schema'
import { accountMemoryScope, learningHash, memoryScopeKey } from './learning-scope'
import { boundedMemorySnapshot, memorySearchText } from './learning-retrieval'
import { knowledgeTerms, relevance } from '../knowledge/retrieval'
import { LearningJobs } from './learning-jobs'
import { episodeSearchText } from './learning-episodes'
import { LearningEpisodeAssembler } from './learning-episode-assembler'
import { LearningValidationStore } from './learning-validation-store'
import { LearningValidationBudget } from './learning-validation-budget'
import { LearningCurationStore } from './learning-curation-store'
import { buildLearningSettingsAudit } from './learning-settings-audit'

type Row = Record<string, unknown>
const decode = <T>(row: Row): T => JSON.parse(String(row.payload)) as T
const LegacyCard = z.object({
  cardId: z.string().min(1),
  scenario: z.string().trim().min(1),
  guidance: z.string().trim().min(1),
  rationale: z.string().default(''),
  stats: z
    .object({ used: z.number().nonnegative(), success: z.number().nonnegative() })
    .default({ used: 0, success: 0 })
})

/** One connection owns all learning writes. No model or desktop actions inside transactions. */
export class LearningStore {
  private readonly db: DatabaseSync
  readonly jobs: LearningJobs
  readonly assembler: LearningEpisodeAssembler
  readonly validation: LearningValidationStore
  readonly validationBudget: LearningValidationBudget
  readonly curation: LearningCurationStore
  private closed = false
  private transactionDepth = 0
  constructor(
    path: string,
    private readonly now: () => number = Date.now
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    try {
      initializeLearningDatabase(this.db)
    } catch (error) {
      this.db.close()
      throw error
    }
    this.jobs = new LearningJobs(
      this.db,
      (operation) => this.transaction(operation),
      (scope) => this.settings(scope),
      this.now
    )
    this.assembler = new LearningEpisodeAssembler(
      this.db,
      (operation) => this.transaction(operation),
      this
    )
    this.validation = new LearningValidationStore(
      this.db,
      (operation) => this.transaction(operation),
      this,
      this.now
    )
    this.validationBudget = new LearningValidationBudget(
      this.db,
      (operation) => this.transaction(operation),
      this,
      this.now
    )
    this.curation = new LearningCurationStore(
      this.db,
      (operation) => this.transaction(operation),
      this
    )
  }
  close(): void {
    if (!this.closed) {
      this.db.close()
      this.closed = true
    }
  }
  /** A manual retry has one immutable source and one atomic evidence/proposal write. */
  teach(
    scopeInput: MemoryScope,
    raw: { sourceId: string; content: MemoryContent; reason: string }
  ): MemoryRecord {
    const scope = MemoryScopeSchema.parse(scopeInput)
    const input = z
      .strictObject({
        sourceId: z.string().trim().min(1).max(128),
        content: MemoryContentSchema,
        reason: z.string().trim().min(1).max(2000)
      })
      .parse(raw)
    return this.transaction(() => {
      const sourceId = `manual:${learningHash(input.sourceId)}`
      const previous = this.findEpisode(scope, sourceId)
      const episode = this.recordEpisode(scope, {
        sourceId,
        identityStatus: scope.conversationId ? 'verified' : 'account',
        topic: input.content.scenario.slice(0, 240),
        startedAt: previous?.startedAt ?? this.now(),
        messages: [
          {
            sourceId: `manual-body:${learningHash({ content: input.content, reason: input.reason })}`,
            role: 'employee',
            text: input.content.guidance
          }
        ],
        outcome: 'corrected',
        correctionReason: input.reason
      })
      return this.propose(scope, {
        content: input.content,
        reason: input.reason,
        evidence: [{ episodeId: episode.id }],
        source: 'manual'
      })
    })
  }
  private transaction<T>(operation: () => T): T {
    if (this.transactionDepth) return operation()
    this.db.exec('BEGIN IMMEDIATE')
    this.transactionDepth++
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.transactionDepth--
    }
  }
  applyReview(claim: ClaimedLearningJob, result: LearningReviewResult): MemoryRecord[] {
    return this.transaction(() => {
      this.jobs.assertClaim(claim)
      if (this.settings(claim.scope).mode === 'off') throw new Error('learning_disabled')
      const memories = result.operations.map((operation) => {
        if (
          operation.proposal.evidence.some(
            (evidence) => !claim.episodeIds.includes(evidence.episodeId)
          )
        )
          throw new Error('review_evidence_invalid')
        const proposal: MemoryProposal = { ...operation.proposal, source: 'review' }
        return operation.action === 'create'
          ? this.propose(claim.scope, proposal)
          : this.revise(claim.scope, operation.memoryId, operation.expectedRevision, proposal)
      })
      this.jobs.complete(
        claim,
        result.usage,
        memories.map((memory) => memory.id)
      )
      return memories
    })
  }
  private audit(scope: MemoryScope, id: string, action: string, revision: number): void {
    this.curation.touch(scope, this.now())
    this.db
      .prepare('INSERT INTO learning_mutations VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), memoryScopeKey(scope), id, action, revision, this.now())
  }
  recordEpisode(scopeInput: MemoryScope, input: NewLearningEpisode): LearningEpisode {
    const scope = MemoryScopeSchema.parse(scopeInput),
      episode = NewLearningEpisodeSchema.parse(input)
    const key = memoryScopeKey(scope),
      hash = learningHash(episode)
    return this.transaction(() => {
      const old = this.db
        .prepare('SELECT * FROM learning_episodes WHERE scope_key=? AND source_id=?')
        .get(key, episode.sourceId)
      if (old) {
        if (old.input_hash !== hash) throw new Error('episode_source_conflict')
        return decode<LearningEpisode>(old)
      }
      if (this.tombstone(key, 'source', episode.sourceId)) throw new Error('episode_forgotten')
      const result: LearningEpisode = { ...episode, id: randomUUID(), scope, createdAt: this.now() }
      this.db
        .prepare('INSERT INTO learning_episodes VALUES(?,?,?,?,?,?,?)')
        .run(
          result.id,
          key,
          JSON.stringify(scope),
          episode.sourceId,
          hash,
          JSON.stringify(result),
          result.createdAt
        )
      this.db
        .prepare('INSERT INTO learning_episode_search VALUES(?,?)')
        .run(result.id, knowledgeTerms(episodeSearchText(result)).join(' '))
      this.curation.touch(scope, this.now())
      return result
    })
  }
  recordGeneratedEpisode(
    scope: MemoryScope,
    generationId: string,
    input: NewLearningEpisode,
    refs: LearningFeedback['memoryRefs'],
    problemId?: string
  ): LearningEpisode {
    return this.transaction(() => {
      const episode = this.recordEpisode(scope, input)
      this.registerGeneration(scope, generationId, episode.id, problemId ?? generationId, refs)
      if (problemId) {
        this.assembler.append({
          scope,
          problemId,
          sourceId: `input:${learningHash(generationId)}`,
          message: episode.messages[0],
          generationId,
          loadedMemoryRefs: refs,
          at: episode.startedAt
        })
        const sourceId = input.sourceId
        this.assembler.append({
          scope,
          problemId,
          sourceId,
          message: { sourceId, role: 'assistant', text: episode.draft ?? '' },
          generationId,
          loadedMemoryRefs: refs,
          at: episode.endedAt ?? episode.startedAt
        })
      }
      return episode
    })
  }
  episodes(scope: MemoryScope): LearningEpisode[] {
    return this.db
      .prepare(
        'SELECT payload FROM learning_episodes WHERE scope_key=? ORDER BY created_at DESC,id'
      )
      .all(memoryScopeKey(scope))
      .map(decode<LearningEpisode>)
  }
  /** Evidence, employee feedback and queued review either all persist, or all roll back. */
  recordCorrection(
    scopeInput: MemoryScope,
    episodeId: string,
    input: LearningCorrectionInput
  ): LearningEpisode {
    const scope = MemoryScopeSchema.parse(scopeInput),
      correction = LearningCorrectionInputSchema.parse(input)
    return this.transaction(() => {
      const base = this.episode(scope, episodeId)
      const sourceId = `correction:${learningHash({ episodeId, sourceId: correction.sourceId })}`
      const old = this.findEpisode(scope, sourceId)
      const generation = this.db
        .prepare('SELECT * FROM learning_generations WHERE scope_key=? AND episode_id=?')
        .get(memoryScopeKey(scope), episodeId)
      const problem = generation
        ? this.db
            .prepare('SELECT * FROM learning_problems WHERE scope_key=? AND problem_id=?')
            .get(memoryScopeKey(scope), String(generation.problem_id))
        : undefined
      const closedByThisCorrection =
        problem?.closed_episode_id &&
        this.db
          .prepare('SELECT 1 FROM learning_problem_events WHERE scope_key=? AND source_id=?')
          .get(memoryScopeKey(scope), sourceId)
      const correctedProblem =
        problem && (!problem.closed_episode_id || closedByThisCorrection)
          ? this.assembler.closeCorrected(
              {
                scope,
                problemId: String(generation!.problem_id),
                sourceId,
                outcome: 'corrected',
                at: problem.closed_episode_id
                  ? this.episode(scope, String(problem.closed_episode_id)).endedAt!
                  : this.now()
              },
              correction
            )
          : null
      const changed =
        correctedProblem ??
        this.recordEpisode(scope, {
          sourceId,
          identityStatus: base.identityStatus,
          topic: base.topic,
          startedAt: base.startedAt,
          endedAt: old?.endedAt ?? this.now(),
          messages: problem?.closed_episode_id
            ? this.episode(scope, String(problem.closed_episode_id)).messages
            : base.messages,
          draft: base.draft,
          correction: correction.text,
          correctionReason: correction.reason,
          outcome: 'corrected'
        })
      const refs = generation
        ? (JSON.parse(String(generation.refs_json)) as LearningFeedback['memoryRefs'])
        : (this.feedbackEvents(scope).find(
            (event) => event.episodeId === base.id && event.kind === 'loaded'
          )?.memoryRefs ?? [])
      this.feedback(scope, {
        sourceId,
        episodeId: changed.id,
        kind: 'substantially_corrected',
        memoryRefs: refs,
        at: changed.createdAt,
        reason: correction.reason
      })
      if (!correctedProblem) this.jobs.enqueue(scope, changed.id, 'correction', sourceId)
      return changed
    })
  }
  scopes(): MemoryScope[] {
    const rows = this.db
      .prepare(
        'SELECT scope_json FROM learning_episodes UNION SELECT scope_json FROM learning_memories UNION SELECT scope_json FROM learning_problems'
      )
      .all()
    return [
      ...new Map(
        rows.map((row) => {
          const scope = MemoryScopeSchema.parse(JSON.parse(String(row.scope_json)))
          return [memoryScopeKey(scope), scope]
        })
      ).values()
    ]
  }
  findEpisode(scope: MemoryScope, sourceId: string): LearningEpisode | null {
    const row = this.db
      .prepare('SELECT payload FROM learning_episodes WHERE scope_key=? AND source_id=?')
      .get(memoryScopeKey(scope), sourceId)
    return row ? decode<LearningEpisode>(row) : null
  }
  episode(scope: MemoryScope, id: string): LearningEpisode {
    const row = this.db
      .prepare('SELECT payload FROM learning_episodes WHERE scope_key=? AND id=?')
      .get(memoryScopeKey(scope), id)
    if (!row) throw new Error('evidence_scope_mismatch')
    const episode = decode<LearningEpisode>(row)
    if (episode.createdAt < this.now() - this.settings(scope).caseRetentionDays * 86400000)
      throw new Error('evidence_expired')
    if (this.tombstone(memoryScopeKey(scope), 'episode', id)) throw new Error('memory_forgotten')
    return episode
  }
  searchEpisodes(scope: MemoryScope, query: string, limit: number): LearningEpisode[] {
    z.number().int().min(1).max(3).parse(limit)
    return this.searchEpisodeRows(scope, query, limit, false)
  }
  searchEpisodeHistory(scope: MemoryScope, query: string, limit = 10): LearningEpisode[] {
    z.number().int().min(1).max(20).parse(limit)
    z.string().trim().min(1).max(240).parse(query)
    return this.searchEpisodeRows(scope, query, limit, true)
  }
  private searchEpisodeRows(
    scope: MemoryScope,
    query: string,
    limit: number,
    management: boolean
  ): LearningEpisode[] {
    const key = memoryScopeKey(scope),
      terms = knowledgeTerms(query).slice(0, 80)
    if (!terms.length || (!management && !this.settings(scope).memoryEnabled)) return []
    const rows = this.db
      .prepare(
        `SELECT e.payload FROM learning_episode_search
      JOIN learning_episodes e ON e.id=learning_episode_search.episode_id
      WHERE learning_episode_search MATCH ? AND e.scope_key=? AND e.created_at>=?
        AND NOT EXISTS (SELECT 1 FROM learning_tombstones t WHERE t.scope_key=e.scope_key AND t.kind='episode' AND t.fingerprint=e.id)
      ORDER BY bm25(learning_episode_search),e.created_at DESC,e.id LIMIT 30`
      )
      .all(
        terms.map((term) => '"' + term.replace(/"/g, '""') + '"').join(' OR '),
        key,
        this.now() - this.settings(scope).caseRetentionDays * 86400000
      )
    return rows
      .map(decode<LearningEpisode>)
      .filter((episode) => relevance(query, episodeSearchText(episode)) >= 0.2)
      .slice(0, limit)
  }
  private tombstone(key: string, kind: string, fingerprint: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM learning_tombstones WHERE scope_key=? AND kind=? AND fingerprint=?')
        .get(key, kind, fingerprint)
    )
  }
  private validateEvidence(scope: MemoryScope, input: MemoryProposal): void {
    const key = memoryScopeKey(scope)
    if (this.tombstone(key, 'content', learningHash(input.content)))
      throw new Error('memory_forgotten')
    for (const evidence of input.evidence) {
      if (this.tombstone(key, 'episode', evidence.episodeId)) throw new Error('memory_forgotten')
      this.episode(scope, evidence.episodeId)
    }
  }
  private header(scope: MemoryScope, id: string, expectedRevision?: number): Row {
    const row = this.db
      .prepare('SELECT * FROM learning_memories WHERE scope_key=? AND id=?')
      .get(memoryScopeKey(scope), id)
    if (!row) throw new Error('memory_not_found')
    if (expectedRevision !== undefined && row.current_revision !== expectedRevision)
      throw new Error('memory_revision_conflict')
    return row
  }
  private revision(id: string, revision: number): MemoryRevision {
    const row = this.db
      .prepare('SELECT * FROM learning_revisions WHERE memory_id=? AND revision=?')
      .get(id, revision)
    if (!row) throw new Error('memory_revision_not_found')
    const result = {
      ...decode<MemoryRevision>(row),
      activatedAt: row.activated_at === null ? null : Number(row.activated_at)
    }
    const redacted = this.db
      .prepare(
        `SELECT episode_id FROM learning_redacted_evidence WHERE episode_id IN
      (SELECT json_extract(value,'$.episodeId') FROM json_each(?)) ORDER BY episode_id`
      )
      .all(JSON.stringify(result.evidence))
    if (redacted.length)
      result.redactedEvidenceIds = redacted.map((entry) => String(entry.episode_id))
    const quarantine = this.db
      .prepare('SELECT at FROM learning_revision_quarantines WHERE memory_id=? AND revision=?')
      .get(id, revision)
    if (quarantine) result.quarantinedAt = Number(quarantine.at)
    return result
  }
  private asRecord(row: Row, active = false): MemoryRecord {
    const revision = this.revision(
      String(row.id),
      Number(active ? row.active_revision : row.current_revision)
    )
    return {
      id: String(row.id),
      scope: JSON.parse(String(row.scope_json)) as MemoryScope,
      state: row.state as MemoryRecord['state'],
      currentRevision: Number(row.current_revision),
      activeRevision: row.active_revision === null ? null : Number(row.active_revision),
      pinned: Boolean(row.pinned),
      content: revision.content,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      ...(revision.expiresAt !== undefined ? { expiresAt: revision.expiresAt } : {})
    }
  }
  get(scope: MemoryScope, id: string): MemoryRecord {
    return this.asRecord(this.header(scope, id))
  }
  list(scope: MemoryScope): MemoryRecord[] {
    return this.db
      .prepare('SELECT * FROM learning_memories WHERE scope_key=? ORDER BY updated_at DESC,id')
      .all(memoryScopeKey(scope))
      .map((row) => this.asRecord(row))
  }
  active(scope: MemoryScope, options: { includeAccount?: boolean } = {}): MemoryRecord[] {
    const keys = [memoryScopeKey(scope)]
    if (options.includeAccount && scope.conversationId)
      keys.push(memoryScopeKey(accountMemoryScope(scope)))
    return keys
      .flatMap((key) =>
        this.db
          .prepare(
            "SELECT * FROM learning_memories WHERE scope_key=? AND state='active' AND active_revision IS NOT NULL"
          )
          .all(key)
      )
      .map((row) => this.asRecord(row, true))
      .filter((record) => record.expiresAt === undefined || record.expiresAt > this.now())
  }
  retrieve(
    scope: MemoryScope,
    query: string,
    options: { maxEntries?: number; maxTokens?: number } = {}
  ): MemorySnapshot {
    options = {
      maxEntries: this.settings(scope).maxEntries,
      maxTokens: this.settings(scope).maxContextTokens,
      ...options
    }
    const corpusVersion = this.corpusVersion(scope)
    const terms = knowledgeTerms(query).slice(0, 80)
    if (!terms.length || !this.settings(scope).memoryEnabled)
      return boundedMemorySnapshot(scope, [], options, corpusVersion)
    const keys = [memoryScopeKey(scope)]
    if (scope.conversationId) keys.push(memoryScopeKey(accountMemoryScope(scope)))
    const rows = this.db
      .prepare(
        `SELECT m.* FROM learning_search
      JOIN learning_memories m ON m.id=learning_search.memory_id AND m.active_revision=learning_search.revision
      WHERE learning_search MATCH ? AND m.scope_key IN (${keys.map(() => '?').join(',')}) AND m.state='active'
      ORDER BY bm25(learning_search),m.id LIMIT 100`
      )
      .all(terms.map((term) => '"' + term.replace(/"/g, '""') + '"').join(' OR '), ...keys)
    const items: MemorySnapshotItem[] = []
    for (const row of rows) {
      const entry = this.revision(String(row.id), Number(row.active_revision))
      if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) continue
      if (relevance(query, memorySearchText(entry.content)) < 0.2) continue
      items.push({
        id: String(row.id),
        revision: entry.revision,
        scope: JSON.parse(String(row.scope_json)) as MemoryScope,
        content: entry.content,
        contentHash: entry.contentHash,
        evidence: entry.evidence,
        expiresAt: entry.expiresAt
      })
    }
    return boundedMemorySnapshot(scope, items, options, corpusVersion)
  }
  corpusVersion(scope: MemoryScope): string {
    const keys = [...new Set([memoryScopeKey(scope), memoryScopeKey(accountMemoryScope(scope))])]
    const generations = keys.map((key) => ({
      key,
      version: Number(
        this.db.prepare('SELECT version FROM learning_corpus WHERE scope_key=?').get(key)
          ?.version ?? 0
      )
    }))
    // Time expiry must invalidate even when no timer has performed a database mutation.
    const published = this.active(scope, { includeAccount: true })
      .map((memory) => ({ id: memory.id, revision: memory.activeRevision }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const { memoryEnabled, maxEntries, maxContextTokens } = this.settings(scope)
    return learningHash({ generations, published, memoryEnabled, maxEntries, maxContextTokens })
  }
  snapshotCurrent(snapshot: MemorySnapshot): boolean {
    if (snapshot.corpusVersion !== this.corpusVersion(snapshot.scope)) return false
    if (
      snapshot.contextVersion !== undefined &&
      snapshot.contextVersion !== this.contextVersion(snapshot.scope, snapshot.excludedCaseSourceId)
    )
      return false
    for (const item of snapshot.items) {
      // A snapshot's item scope is not caller authority: constrain it to the requested scope or its account parent.
      const key = memoryScopeKey(item.scope)
      if (
        ![
          memoryScopeKey(snapshot.scope),
          memoryScopeKey(accountMemoryScope(snapshot.scope))
        ].includes(key)
      )
        return false
      const row = this.db
        .prepare(
          "SELECT * FROM learning_memories WHERE scope_key=? AND id=? AND state='active' AND active_revision=?"
        )
        .get(key, item.id, item.revision)
      if (!row) return false
      const entry = this.revision(item.id, item.revision)
      if (
        entry.contentHash !== item.contentHash ||
        (entry.expiresAt !== undefined && entry.expiresAt <= this.now())
      )
        return false
    }
    return (
      snapshot.snapshotId ===
      learningHash({
        scope: snapshot.scope,
        corpusVersion: snapshot.corpusVersion,
        items: snapshot.items,
        ...(snapshot.contextVersion !== undefined
          ? {
              contextVersion: snapshot.contextVersion,
              excludedCaseSourceId: snapshot.excludedCaseSourceId
            }
          : {})
      })
    )
  }
  /** New and expired cases must invalidate replies too, including an initially empty retrieval. */
  contextVersion(scope: MemoryScope, excludedSourceId?: string): string {
    const settings = this.settings(scope),
      key = memoryScopeKey(scope)
    const cases = settings.memoryEnabled
      ? this.db
          .prepare(
            `SELECT e.id,e.input_hash FROM learning_episodes e
      WHERE e.scope_key=? AND e.created_at>=? AND (? IS NULL OR e.source_id!=?)
        AND NOT EXISTS (SELECT 1 FROM learning_tombstones t WHERE t.scope_key=e.scope_key AND t.kind='episode' AND t.fingerprint=e.id)
      ORDER BY e.id`
          )
          .all(
            key,
            this.now() - settings.caseRetentionDays * 86400000,
            excludedSourceId ?? null,
            excludedSourceId ?? null
          )
      : []
    return learningHash({
      corpusVersion: this.corpusVersion(scope),
      cases,
      caseRetentionDays: settings.caseRetentionDays
    })
  }
  history(scope: MemoryScope, id: string): MemoryRevision[] {
    if (this.tombstone(memoryScopeKey(scope), 'id', id)) return []
    this.header(scope, id)
    return this.db
      .prepare('SELECT revision FROM learning_revisions WHERE memory_id=? ORDER BY revision')
      .all(id)
      .map((row) => this.revision(id, Number(row.revision)))
  }
  private insertRevision(id: string, revision: number, input: MemoryProposal): void {
    const evidence = [...new Map(input.evidence.map((e) => [e.episodeId, e])).values()]
    const entry: MemoryRevision = {
      ...input,
      evidence,
      memoryId: id,
      revision,
      contentHash: learningHash(input.content),
      createdAt: this.now(),
      activatedAt: null
    }
    this.db
      .prepare('INSERT INTO learning_revisions VALUES(?,?,?,?,NULL)')
      .run(id, revision, entry.contentHash, JSON.stringify(entry))
    this.db
      .prepare('INSERT INTO learning_search VALUES(?,?,?)')
      .run(id, revision, knowledgeTerms(memorySearchText(entry.content)).join(' '))
  }
  propose(scopeInput: MemoryScope, proposal: MemoryProposal): MemoryRecord {
    const scope = MemoryScopeSchema.parse(scopeInput),
      input = MemoryProposalSchema.parse(proposal)
    return this.transaction(() => {
      this.validateEvidence(scope, input)
      const key = memoryScopeKey(scope),
        hash = learningHash(input.content)
      const duplicate = this.db
        .prepare(
          `SELECT m.* FROM learning_memories m JOIN learning_revisions r
        ON r.memory_id=m.id AND r.revision=m.current_revision WHERE m.scope_key=? AND r.content_hash=?`
        )
        .get(key, hash)
      if (duplicate) {
        const old = this.revision(String(duplicate.id), Number(duplicate.current_revision))
        const evidence = [
          ...new Map([...old.evidence, ...input.evidence].map((e) => [e.episodeId, e])).values()
        ]
        if (evidence.length === old.evidence.length) return this.asRecord(duplicate)
        if (duplicate.pinned) throw new Error('memory_pinned')
        if (evidence.length > 100) throw new Error('memory_evidence_limit')
        return this.reviseWithin(scope, duplicate, { ...input, evidence })
      }
      const id = randomUUID(),
        at = this.now()
      this.db
        .prepare("INSERT INTO learning_memories VALUES(?,?,?,'pending',1,NULL,0,?,?)")
        .run(id, key, JSON.stringify(scope), at, at)
      this.insertRevision(id, 1, input)
      this.audit(scope, id, 'propose', 1)
      return this.get(scope, id)
    })
  }
  private reviseWithin(scope: MemoryScope, old: Row, input: MemoryProposal): MemoryRecord {
    const id = String(old.id),
      revision = Number(old.current_revision) + 1
    this.insertRevision(id, revision, input)
    this.db
      .prepare('UPDATE learning_memories SET current_revision=?,updated_at=? WHERE id=?')
      .run(revision, this.now(), id)
    this.audit(scope, id, 'revise', revision)
    return this.get(scope, id)
  }
  revise(
    scope: MemoryScope,
    id: string,
    expectedRevision: number,
    proposal: MemoryProposal
  ): MemoryRecord {
    const input = MemoryProposalSchema.parse(proposal)
    return this.transaction(() => {
      const old = this.header(scope, id, expectedRevision)
      if (old.pinned) throw new Error('memory_pinned')
      this.validateEvidence(scope, input)
      return this.reviseWithin(scope, old, input)
    })
  }
  /** Trusted human activation; automatic activation must additionally use evaluation admission. */
  activate(scope: MemoryScope, id: string, expectedRevision: number): MemoryRecord {
    return this.transaction(() => {
      this.header(scope, id, expectedRevision)
      const candidate = this.revision(id, expectedRevision)
      this.validation.assertNotQuarantined(scope, id, expectedRevision)
      this.curation.assertReplacements(scope, id)
      this.validateEvidence(scope, candidate)
      if (candidate.expiresAt !== undefined && candidate.expiresAt <= this.now())
        throw new Error('memory_expired')
      this.db
        .prepare(
          'UPDATE learning_revisions SET activated_at=COALESCE(activated_at,?) WHERE memory_id=? AND revision=?'
        )
        .run(this.now(), id, expectedRevision)
      this.db
        .prepare(
          "UPDATE learning_memories SET active_revision=?,state='active',updated_at=? WHERE id=?"
        )
        .run(expectedRevision, this.now(), id)
      this.audit(scope, id, 'activate', expectedRevision)
      this.curation.applyReplacements(scope, id, this.now())
      return this.get(scope, id)
    })
  }
  activateValidated(
    scope: MemoryScope,
    id: string,
    expectedRevision: number,
    grantId: string
  ): MemoryRecord {
    return this.validation.activate(scope, id, expectedRevision, grantId)
  }
  rollback(
    scope: MemoryScope,
    id: string,
    expectedRevision: number,
    targetRevision: number
  ): MemoryRecord {
    return this.transaction(() => {
      const old = this.header(scope, id, expectedRevision),
        target = this.revision(id, targetRevision)
      if (target.activatedAt === null) throw new Error('rollback_target_unpublished')
      this.validation.assertNotQuarantined(scope, id, targetRevision)
      this.validateEvidence(scope, target)
      if (target.expiresAt !== undefined && target.expiresAt <= this.now())
        throw new Error('memory_expired')
      const result = this.reviseWithin(scope, old, {
        content: target.content,
        evidence: target.evidence,
        source: 'human',
        reason: `恢复已发布版本 ${targetRevision}`,
        expiresAt: target.expiresAt
      })
      this.db
        .prepare('UPDATE learning_revisions SET activated_at=? WHERE memory_id=? AND revision=?')
        .run(this.now(), id, result.currentRevision)
      this.db
        .prepare(
          "UPDATE learning_memories SET active_revision=current_revision,state='active' WHERE id=?"
        )
        .run(id)
      this.audit(scope, id, 'rollback', result.currentRevision)
      return this.get(scope, id)
    })
  }
  setPinned(scope: MemoryScope, id: string, expectedRevision: number, pinned: boolean): void {
    this.transaction(() => {
      this.header(scope, id, expectedRevision)
      this.db
        .prepare('UPDATE learning_memories SET pinned=?,updated_at=? WHERE id=?')
        .run(Number(pinned), this.now(), id)
      this.audit(scope, id, pinned ? 'pin' : 'unpin', expectedRevision)
    })
  }
  archive(
    scope: MemoryScope,
    id: string,
    expectedRevision: number,
    actor: 'human' | 'curator'
  ): void {
    this.transaction(() => {
      const old = this.header(scope, id, expectedRevision)
      if (
        actor === 'curator' &&
        (old.pinned || !['review', 'curator'].includes(this.revision(id, expectedRevision).source))
      )
        throw new Error('memory_pinned')
      this.db
        .prepare("UPDATE learning_memories SET state='archived',updated_at=? WHERE id=?")
        .run(this.now(), id)
      this.audit(scope, id, 'archive', expectedRevision)
    })
  }
  restore(scope: MemoryScope, id: string, expectedRevision: number): void {
    this.transaction(() => {
      const old = this.header(scope, id, expectedRevision)
      let state = old.active_revision === null ? 'pending' : 'active'
      if (old.active_revision !== null) {
        try {
          this.validation.assertNotQuarantined(scope, id, Number(old.active_revision))
          this.validateEvidence(scope, this.revision(id, Number(old.active_revision)))
        } catch {
          state = 'stale'
        }
      }
      this.db
        .prepare('UPDATE learning_memories SET state=?,updated_at=? WHERE id=?')
        .run(state, this.now(), id)
      this.audit(scope, id, 'restore', expectedRevision)
    })
  }
  forget(scope: MemoryScope, id: string, expectedRevision: number): void {
    this.transaction(() => {
      this.header(scope, id, expectedRevision)
      const key = memoryScopeKey(scope)
      const revisions = this.history(scope, id)
      const tombstone = this.db.prepare('INSERT OR IGNORE INTO learning_tombstones VALUES(?,?,?,?)')
      tombstone.run(key, 'id', id, this.now())
      for (const revision of revisions) {
        tombstone.run(key, 'content', revision.contentHash, this.now())
        for (const evidence of revision.evidence)
          tombstone.run(key, 'episode', evidence.episodeId, this.now())
      }
      this.db.prepare('DELETE FROM learning_memories WHERE id=?').run(id)
      this.db.prepare('DELETE FROM learning_mutations WHERE memory_id=?').run(id)
      // Remove old usage rows rather than leave snapshots of forgotten references.
      for (const row of this.db
        .prepare('SELECT source_id,payload FROM learning_feedback WHERE scope_key=?')
        .all(key))
        if (decode<LearningFeedback>(row).memoryRefs.some((ref) => ref.id === id))
          this.db
            .prepare('DELETE FROM learning_feedback WHERE scope_key=? AND source_id=?')
            .run(key, String(row.source_id))
    })
  }
  forgetScope(scope: MemoryScope): void {
    this.transaction(() => {
      const key = memoryScopeKey(scope)
      this.jobs.forgetScope(scope)
      this.validationBudget.forgetScope(scope)
      this.assembler.forgetScope(scope, this.now())
      this.validation.clearCalibration(scope)
      this.curation.forgetScope(scope)
      for (const episode of this.episodes(scope))
        this.db
          .prepare('INSERT OR IGNORE INTO learning_tombstones VALUES(?,?,?,?)')
          .run(key, 'source', episode.sourceId, this.now())
      this.db.prepare('DELETE FROM learning_feedback WHERE scope_key=?').run(key)
      this.db.prepare('DELETE FROM learning_memories WHERE scope_key=?').run(key)
      this.db.prepare('DELETE FROM learning_episodes WHERE scope_key=?').run(key)
      this.db.prepare('DELETE FROM learning_mutations WHERE scope_key=?').run(key)
      this.db.prepare('DELETE FROM learning_settings WHERE scope_key=?').run(key)
      this.db.prepare('DELETE FROM learning_settings_audit WHERE scope_key=?').run(key)
      this.db.prepare('DELETE FROM learning_redacted_evidence WHERE scope_key=?').run(key)
      this.db.prepare('DELETE FROM learning_validation_environment WHERE scope_key=?').run(key)
    })
  }
  pruneExpiredEpisodes(at: number): RetentionReport {
    z.number().int().nonnegative().safe().parse(at)
    return this.transaction(() => {
      this.assembler.pruneExpired(at)
      this.validation.pruneCalibration(at)
      const report: RetentionReport = {
        deletedEpisodes: 0,
        redactedEvidence: 0,
        invalidatedMethods: []
      }
      const affected = new Set<string>()
      for (const scope of this.scopes()) {
        const key = memoryScopeKey(scope),
          cutoff = at - this.settings(scope).caseRetentionDays * 86400000
        const expired = this.db
          .prepare(
            'SELECT id,source_id FROM learning_episodes WHERE scope_key=? AND created_at<? ORDER BY id'
          )
          .all(key, cutoff)
        for (const episode of expired) {
          const episodeId = String(episode.id)
          for (const job of this.jobs.list(scope))
            if (
              job.episodeIds.includes(episodeId) &&
              job.state !== 'completed' &&
              job.state !== 'cancelled'
            )
              this.jobs.cancel(scope, job.id)
          const refs = this.db
            .prepare(
              `SELECT r.memory_id,r.revision,m.active_revision FROM learning_revisions r
            JOIN learning_memories m ON m.id=r.memory_id WHERE m.scope_key=? AND EXISTS
            (SELECT 1 FROM json_each(r.payload,'$.evidence') e WHERE json_extract(e.value,'$.episodeId')=?)`
            )
            .all(key, episodeId)
          report.redactedEvidence += refs.length
          for (const ref of refs)
            if (ref.active_revision !== null && ref.active_revision === ref.revision) {
              const memoryId = String(ref.memory_id)
              const changed = this.db
                .prepare(
                  "UPDATE learning_memories SET state='stale',updated_at=? WHERE id=? AND state='active'"
                )
                .run(at, memoryId)
              if (changed.changes) affected.add(memoryId)
            }
          this.db
            .prepare('INSERT OR IGNORE INTO learning_redacted_evidence VALUES(?,?,?)')
            .run(key, episodeId, at)
          this.db
            .prepare('INSERT OR IGNORE INTO learning_tombstones VALUES(?,?,?,?)')
            .run(key, 'source', String(episode.source_id), at)
          this.db
            .prepare('INSERT OR IGNORE INTO learning_tombstones VALUES(?,?,?,?)')
            .run(key, 'episode', episodeId, at)
          this.db
            .prepare('DELETE FROM learning_episodes WHERE scope_key=? AND id=?')
            .run(key, episodeId)
          report.deletedEpisodes++
        }
      }
      report.invalidatedMethods = [...affected].sort()
      return report
    })
  }
  feedback(scope: MemoryScope, feedback: LearningFeedback): void {
    const input = LearningFeedbackSchema.parse(feedback),
      key = memoryScopeKey(scope),
      hash = learningHash(input)
    this.transaction(() => {
      this.episode(scope, input.episodeId)
      const old = this.db
        .prepare('SELECT input_hash FROM learning_feedback WHERE scope_key=? AND source_id=?')
        .get(key, input.sourceId)
      if (old) {
        if (old.input_hash !== hash) throw new Error('feedback_source_conflict')
        return
      }
      const allowedKeys = [key, memoryScopeKey(accountMemoryScope(scope))]
      for (const ref of input.memoryRefs) {
        const row = this.db
          .prepare(
            `SELECT 1 FROM learning_memories WHERE id=? AND scope_key IN (${allowedKeys.map(() => '?').join(',')})`
          )
          .get(ref.id, ...allowedKeys)
        if (!row) throw new Error('memory_not_found')
        this.revision(ref.id, ref.revision)
      }
      this.db
        .prepare('INSERT INTO learning_feedback VALUES(?,?,?,?,?)')
        .run(key, input.sourceId, hash, input.episodeId, JSON.stringify(input))
      this.curation.touch(scope, this.now())
    })
  }
  /** Registers host-owned generation provenance and loaded references atomically. */
  registerGeneration(
    scope: MemoryScope,
    generationId: string,
    episodeId: string,
    problemId: string,
    refs: LearningFeedback['memoryRefs'],
    countLoad = true
  ): void {
    z.string().trim().min(1).max(128).parse(generationId)
    z.string().trim().min(1).max(128).parse(problemId)
    const key = memoryScopeKey(scope),
      sorted = [...refs].sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision)
    this.transaction(() => {
      const episode = this.episode(scope, episodeId)
      const prior = this.db
        .prepare('SELECT * FROM learning_generations WHERE scope_key=? AND generation_id=?')
        .get(key, generationId)
      if (prior) {
        if (
          prior.episode_id !== episodeId ||
          prior.problem_id !== problemId ||
          prior.refs_json !== JSON.stringify(sorted)
        )
          throw new Error('generation_source_conflict')
        return
      }
      // Validate the references even when this is an aggregate rather than an actual load.
      if (countLoad)
        this.feedback(scope, {
          sourceId: `loaded:${learningHash(generationId)}`,
          episodeId,
          kind: 'loaded',
          memoryRefs: sorted,
          at: episode.createdAt
        })
      else
        for (const ref of sorted) {
          const allowedKeys = [key, memoryScopeKey(accountMemoryScope(scope))]
          const item = this.db
            .prepare('SELECT 1 FROM learning_memories WHERE id=? AND scope_key IN (?,?)')
            .get(ref.id, ...allowedKeys)
          if (!item) throw new Error('memory_not_found')
          this.revision(ref.id, ref.revision)
        }
      this.db
        .prepare('INSERT INTO learning_generations VALUES(?,?,?,?,?)')
        .run(key, generationId, episodeId, problemId, JSON.stringify(sorted))
    })
  }
  availableMemoryRefs(
    scope: MemoryScope,
    refs: LearningFeedback['memoryRefs']
  ): LearningFeedback['memoryRefs'] {
    const allowedKeys = [memoryScopeKey(scope), memoryScopeKey(accountMemoryScope(scope))]
    return refs.filter((ref) =>
      Boolean(
        this.db
          .prepare(
            `SELECT 1 FROM learning_memories m JOIN learning_revisions r ON r.memory_id=m.id
      WHERE m.id=? AND m.scope_key IN (?,?) AND r.revision=?`
          )
          .get(ref.id, ...allowedKeys, ref.revision)
      )
    )
  }
  /** Employee feedback cannot invent adoption of a method the generation never loaded. */
  recordTrustedFeedback(scope: MemoryScope, raw: LearningFeedback): void {
    const event = LearningFeedbackSchema.parse(raw),
      key = memoryScopeKey(scope)
    if (event.kind === 'loaded') throw new Error('feedback_generation_required')
    this.transaction(() => {
      this.episode(scope, event.episodeId)
      const generation = this.db
        .prepare('SELECT * FROM learning_generations WHERE scope_key=? AND episode_id=?')
        .get(key, event.episodeId)
      if (!generation) throw new Error('feedback_generation_required')
      const refs = [...event.memoryRefs].sort(
        (a, b) => a.id.localeCompare(b.id) || a.revision - b.revision
      )
      const loaded = JSON.parse(String(generation.refs_json)) as LearningFeedback['memoryRefs']
      if (
        (loaded.length && !refs.length) ||
        refs.some(
          (ref) => !loaded.some((item) => item.id === ref.id && item.revision === ref.revision)
        )
      )
        throw new Error('feedback_usage_mismatch')
      this.feedback(scope, event)
      if (event.kind === 'fact_error' || event.kind === 'improper_commitment') {
        for (const ref of event.memoryRefs) {
          const row = this.db.prepare('SELECT * FROM learning_memories WHERE id=?').get(ref.id)!
          const owner = JSON.parse(String(row.scope_json)) as MemoryScope
          const inserted = this.db
            .prepare('INSERT OR IGNORE INTO learning_revision_quarantines VALUES(?,?,?,?,?)')
            .run(memoryScopeKey(owner), ref.id, ref.revision, event.sourceId, this.now())
          if (!Number(inserted.changes)) continue
          if (row.active_revision === ref.revision)
            this.db
              .prepare("UPDATE learning_memories SET state='stale',updated_at=? WHERE id=?")
              .run(this.now(), ref.id)
          this.audit(owner, ref.id, 'quarantine', ref.revision)
          this.jobs.enqueue(
            scope,
            event.episodeId,
            'severe_error',
            `severe:${learningHash({ sourceId: event.sourceId, ref })}`
          )
        }
      }
      if (!['fact_error', 'repeated_question', 'improper_commitment'].includes(event.kind)) return
      const failures = this.db
        .prepare(
          `SELECT f.payload FROM learning_feedback f
        JOIN learning_generations g ON g.scope_key=f.scope_key AND g.episode_id=f.episode_id
        WHERE f.scope_key=? AND g.problem_id=? AND json_extract(f.payload,'$.kind') IN ('fact_error','repeated_question','improper_commitment')
        ORDER BY json_extract(f.payload,'$.at'),f.source_id`
        )
        .all(key, String(generation.problem_id))
        .map(decode<LearningFeedback>)
      // Multiple reports about one draft are one failure, not independent repeated failures.
      const episodes = [...new Set(failures.map((failure) => failure.episodeId))]
      if (episodes.length < 2) return
      const pair = episodes.slice(-2).sort()
      for (const episodeId of pair)
        this.jobs.enqueue(
          scope,
          episodeId,
          'repeated_failure',
          `quality:${learningHash({ problemId: generation.problem_id, pair, episodeId })}`
        )
    })
  }
  recordEmployeeFeedback(
    scope: MemoryScope,
    episodeId: string,
    raw: LearningHumanFeedbackInput
  ): void {
    const input = LearningHumanFeedbackInputSchema.parse(raw),
      key = memoryScopeKey(scope)
    this.transaction(() => {
      const generation = this.db
        .prepare('SELECT refs_json FROM learning_generations WHERE scope_key=? AND episode_id=?')
        .get(key, episodeId)
      if (!generation) throw new Error('feedback_generation_required')
      const sourceId = `human:${learningHash({ episodeId, sourceId: input.sourceId })}`
      const old = this.db
        .prepare('SELECT payload FROM learning_feedback WHERE scope_key=? AND source_id=?')
        .get(key, sourceId)
      const allRefs = JSON.parse(String(generation.refs_json)) as LearningFeedback['memoryRefs']
      const selectedRefs = input.memoryId
        ? allRefs.filter((ref) => ref.id === input.memoryId)
        : allRefs
      if (input.memoryId && !selectedRefs.length) throw new Error('feedback_usage_mismatch')
      this.recordTrustedFeedback(scope, {
        kind: input.kind,
        reason: input.reason,
        sourceId,
        episodeId,
        memoryRefs: selectedRefs,
        at: old ? decode<LearningFeedback>(old).at : this.now()
      })
    })
  }
  loadedRevisions(
    scope: MemoryScope,
    feedback: LearningFeedback[]
  ): NonNullable<
    import('../../shared/contracts/learning-memory').LearningReviewRequest['loadedRevisions']
  > {
    const allowedKeys = [memoryScopeKey(scope), memoryScopeKey(accountMemoryScope(scope))]
    return [
      ...new Map(
        feedback
          .flatMap((event) => event.memoryRefs)
          .map((ref) => [`${ref.id}:${ref.revision}`, ref])
      ).values()
    ].map((ref) => {
      if (
        !this.db
          .prepare('SELECT 1 FROM learning_memories WHERE id=? AND scope_key IN (?,?)')
          .get(ref.id, ...allowedKeys)
      )
        throw new Error('memory_not_found')
      const revision = this.revision(ref.id, ref.revision)
      return {
        memoryId: ref.id,
        revision: ref.revision,
        contentHash: revision.contentHash,
        content: revision.content
      }
    })
  }
  recordResult(scope: MemoryScope, episodeId: string, raw: LearningResultInput): LearningEpisode {
    const input = LearningResultInputSchema.parse(raw),
      key = memoryScopeKey(scope)
    return this.transaction(() => {
      const base = this.episode(scope, episodeId),
        sourceId = `result:${learningHash({ episodeId, sourceId: input.sourceId })}`
      const generation = this.db
        .prepare('SELECT * FROM learning_generations WHERE scope_key=? AND episode_id=?')
        .get(key, episodeId)
      const problem = generation
        ? this.db
            .prepare('SELECT * FROM learning_problems WHERE scope_key=? AND problem_id=?')
            .get(key, String(generation.problem_id))
        : undefined
      const old = this.findEpisode(scope, sourceId)
      const alreadyClosed =
        problem?.closed_episode_id &&
        this.db
          .prepare('SELECT 1 FROM learning_problem_events WHERE scope_key=? AND source_id=?')
          .get(key, sourceId)
      const aggregate =
        problem && (!problem.closed_episode_id || alreadyClosed)
          ? this.assembler.close({
              scope,
              problemId: String(generation!.problem_id),
              sourceId,
              outcome: input.outcome,
              at: problem.closed_episode_id
                ? this.episode(scope, String(problem.closed_episode_id)).endedAt!
                : this.now()
            })
          : null
      const result =
        aggregate ??
        this.recordEpisode(scope, {
          sourceId,
          identityStatus: base.identityStatus,
          topic: base.topic,
          startedAt: base.startedAt,
          endedAt: old?.endedAt ?? this.now(),
          messages: base.messages,
          draft: base.draft,
          correction: base.correction,
          correctionReason: base.correctionReason,
          outcome: input.outcome
        })
      const refs = generation
        ? (JSON.parse(String(generation.refs_json)) as LearningFeedback['memoryRefs'])
        : []
      this.feedback(scope, {
        sourceId,
        episodeId: result.id,
        kind: 'outcome_confirmed',
        memoryRefs: refs,
        at: result.createdAt,
        reason: input.reason
      })
      if (!aggregate) this.jobs.enqueue(scope, result.id, 'completed', sourceId)
      return result
    })
  }
  feedbackEvents(scope: MemoryScope): LearningFeedback[] {
    return this.db
      .prepare('SELECT payload FROM learning_feedback WHERE scope_key=? ORDER BY source_id')
      .all(memoryScopeKey(scope))
      .map(decode<LearningFeedback>)
  }
  metrics(scope: MemoryScope, id: string): LearningMetrics {
    this.header(scope, id)
    const counts: LearningMetrics = {
      loaded: 0,
      model_reported: 0,
      adopted: 0,
      substantially_corrected: 0,
      delivery_confirmed: 0,
      outcome_confirmed: 0,
      fact_error: 0,
      repeated_question: 0,
      improper_commitment: 0
    }
    const rows = this.db
      .prepare(
        `SELECT f.payload FROM learning_feedback f WHERE EXISTS
      (SELECT 1 FROM json_each(f.payload,'$.memoryRefs') ref WHERE json_extract(ref.value,'$.id')=?)`
      )
      .all(id)
    for (const row of rows) counts[decode<LearningFeedback>(row).kind]++
    return counts
  }
  settings(scope: MemoryScope, input?: Partial<LearningSettings>): LearningSettings {
    const key = memoryScopeKey(scope)
    if (input) {
      const patch = LearningSettingsPatchSchema.parse(input)
      this.transaction(() => {
        const before = this.settings(scope)
        const old = this.db
          .prepare('SELECT payload FROM learning_settings WHERE scope_key=?')
          .get(key)
        const oldOverrides = old ? decode<Partial<LearningSettings>>(old) : {}
        const overrides = { ...oldOverrides, ...patch }
        this.db
          .prepare(
            'INSERT INTO learning_settings VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET payload=excluded.payload'
          )
          .run(key, JSON.stringify(overrides))
        const audit = buildLearningSettingsAudit(before, this.settings(scope))
        if (audit)
          this.db
            .prepare('INSERT INTO learning_settings_audit VALUES(?,?,?,?,?,?)')
            .run(
              randomUUID(),
              key,
              audit.beforeHash,
              audit.afterHash,
              JSON.stringify(audit),
              this.now()
            )
      })
      return this.settings(scope)
    }
    const row = this.db.prepare('SELECT payload FROM learning_settings WHERE scope_key=?').get(key)
    const parentKey = memoryScopeKey(accountMemoryScope(scope))
    const inherited =
      parentKey !== key
        ? this.db.prepare('SELECT payload FROM learning_settings WHERE scope_key=?').get(parentKey)
        : undefined
    const parent = LearningSettingsSchema.parse(
      inherited ? decode<Partial<LearningSettings>>(inherited) : {}
    )
    const result = LearningSettingsSchema.parse({
      ...parent,
      ...(row ? decode<Partial<LearningSettings>>(row) : {})
    })
    if (parentKey !== key) {
      if (parent.mode === 'off') result.mode = 'off'
      if (!parent.memoryEnabled) result.memoryEnabled = false
      if (!parent.curationEnabled) result.curationEnabled = false
    }
    return result
  }
  migrateLegacy(filePath: string): {
    imported: number
    alreadyImported: number
    backupPath?: string
  } {
    if (!existsSync(filePath)) return { imported: 0, alreadyImported: 0 }
    const raw = readFileSync(filePath, 'utf8'),
      data = z
        .object({ version: z.literal(1), cards: z.array(LegacyCard.passthrough()).max(10000) })
        .parse(JSON.parse(raw))
    const backupPath = `${filePath}.learning-backup`
    if (!existsSync(backupPath)) copyFileSync(filePath, backupPath, constants.COPYFILE_EXCL)
    return this.transaction(() => {
      let imported = 0,
        alreadyImported = 0
      for (const card of data.cards) {
        const key = learningHash({ file: resolve(filePath), cardId: card.cardId }),
          hash = learningHash(card)
        const old = this.db
          .prepare('SELECT source_hash FROM learning_legacy WHERE source_key=?')
          .get(key)
        if (old) {
          if (old.source_hash !== hash) throw new Error('legacy_source_conflict')
          alreadyImported++
          continue
        }
        const entry: UnassignedMemory = {
          id: randomUUID(),
          content: {
            kind: 'lesson',
            scenario: card.scenario,
            guidance: card.guidance,
            rationale: card.rationale,
            steps: [],
            pitfalls: [],
            verification: []
          },
          state: 'pending',
          legacyStats: card.stats,
          original: card,
          importedAt: this.now()
        }
        this.db
          .prepare('INSERT INTO learning_legacy VALUES(?,?,?)')
          .run(key, hash, JSON.stringify(entry))
        imported++
      }
      return { imported, alreadyImported, backupPath }
    })
  }
  /** Human assignment is once per legacy source, independent of retries or new button request IDs. */
  assignLegacy(scopeInput: MemoryScope, legacyId: string, sourceId: string): MemoryRecord {
    const scope = MemoryScopeSchema.parse(scopeInput),
      key = memoryScopeKey(scope)
    z.string().trim().min(1).max(128).parse(legacyId)
    z.string().trim().min(1).max(128).parse(sourceId)
    return this.transaction(() => {
      const old = this.db
        .prepare('SELECT * FROM learning_legacy_assignments WHERE legacy_id=?')
        .get(legacyId)
      if (old) {
        if (old.scope_key !== key) throw new Error('legacy_assignment_conflict')
        if (
          this.tombstone(key, 'id', String(old.memory_id)) ||
          !this.db
            .prepare('SELECT 1 FROM learning_memories WHERE id=? AND scope_key=?')
            .get(String(old.memory_id), key)
        )
          throw new Error('legacy_assignment_forgotten')
        return this.get(scope, String(old.memory_id))
      }
      const row = this.db
        .prepare("SELECT * FROM learning_legacy WHERE json_extract(payload,'$.id')=?")
        .get(legacyId)
      if (!row) throw new Error('legacy_memory_not_found')
      const legacy = decode<UnassignedMemory>(row)
      const episode = this.recordEpisode(scope, {
        sourceId: `legacy-assignment:${learningHash({ legacyId, sourceId })}`,
        identityStatus: scope.conversationId ? 'verified' : 'account',
        topic: legacy.content.scenario.slice(0, 240),
        startedAt: this.now(),
        messages: [
          {
            sourceId: `legacy:${learningHash(legacyId)}`,
            role: 'employee',
            text: legacy.content.guidance
          }
        ],
        outcome: 'corrected',
        correctionReason: '员工确认旧资料归属；旧统计不证明方法有效'
      })
      const memory = this.propose(scope, {
        content: legacy.content,
        evidence: [{ episodeId: episode.id }],
        source: 'manual',
        reason: '员工确认旧资料归属，重新作为待审候选'
      })
      this.db
        .prepare('INSERT INTO learning_legacy_assignments VALUES(?,?,?,?,?,?)')
        .run(legacyId, String(row.source_key), key, memory.id, episode.id, this.now())
      return memory
    })
  }
  unassigned(): UnassignedMemory[] {
    return this.db
      .prepare(
        `SELECT l.payload FROM learning_legacy l WHERE NOT EXISTS
      (SELECT 1 FROM learning_legacy_assignments a WHERE a.source_key=l.source_key) ORDER BY l.source_key`
      )
      .all()
      .map(decode<UnassignedMemory>)
  }
}
