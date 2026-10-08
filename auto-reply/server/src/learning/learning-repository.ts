import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { AccountAuthority, Scope } from '../auth/account-authority'
import {
  MemoryScopeSchema,
  NewLearningEpisodeSchema,
  MemoryProposalSchema,
  LearningSettingsPatchSchema,
  LearningHumanFeedbackInputSchema,
  LearningFeedbackSchema,
  LearningReviewResponseSchema,
  type MemoryScope,
  type LearningSettings,
  type NewLearningEpisode,
  type LearningEpisode,
  type MemoryProposal,
  type MemoryRecord,
  type MemoryRevision,
  type MemorySnapshot,
  type MemorySnapshotItem,
  type LearningHumanFeedbackInput,
  type LearningFeedback,
  type RetentionReport
} from '../../../src/shared/contracts/learning-memory'
import type {
  ClaimedLearningJob,
  LearningReviewRequest,
  LearningReviewResult
} from '../../../src/shared/contracts/learning-memory'
import { validateLearningReviewOperations } from '../../../src/core/memory/learning-reviewer'
import { learningHash } from '../../../src/core/memory/learning-scope'
import { buildLearningSettingsAudit } from '../../../src/core/memory/learning-settings-audit'
import {
  boundedMemorySnapshot,
  memorySearchText
} from '../../../src/core/memory/learning-retrieval'
import { relevance } from '../../../src/core/knowledge/retrieval'
import {
  withLearningAccount,
  effectiveLearningSettings,
  type LearningAccountAuthority
} from './learning-account'
import { forgetLearningQueue } from './learning-queue-forget'
import { invalidateLearningPreparations } from './learning-context-lifecycle'
import type { ValidationSnapshot } from '../../../src/core/memory/learning-validation-store'
import {
  discardEvaluationCheckpointsWithin,
  purgeExpiredEvaluationCheckpointsWithin
} from './learning-evaluation-checkpoint'

type Row = Record<string, unknown>
export interface EnterpriseLearningReviewInput {
  request: LearningReviewRequest
  basisHash: string
}
const Id = z.string().trim().min(1).max(128)
export function enterpriseMemoryScope(
  scope: Pick<Scope, 'tenant_id' | 'account_id' | 'platform'>,
  conversationId: string | null
): MemoryScope {
  return MemoryScopeSchema.parse({
    workspaceId: `enterprise:${learningHash({ tenant: scope.tenant_id, account: scope.account_id })}`,
    platform: scope.platform,
    tenantId: scope.tenant_id,
    accountId: scope.account_id,
    ...(conversationId ? { conversationId: Id.parse(conversationId) } : {})
  })
}
/** Only credential-derived account identity is accepted; no client MemoryScope is a capability. */
export class EnterpriseLearningRepository<A extends LearningAccountAuthority = AccountAuthority> {
  constructor(
    readonly authority: A,
    private readonly options: { now?: () => number } = {}
  ) {}
  private async locked<T>(
    credential: string,
    conversationId: string | null,
    operation: (db: PoolClient, scope: Scope, conversation: string, at: number) => Promise<T>
  ): Promise<T> {
    return withLearningAccount(
      this.authority,
      credential,
      conversationId,
      operation,
      this.options.now
    )
  }
  private keys(scope: Scope, conversation: string): [string, string, string] {
    return [scope.tenant_id, scope.account_id, conversation]
  }
  private async settingsWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string
  ): Promise<LearningSettings> {
    return effectiveLearningSettings(db, scope, conversation)
  }
  async settings(
    credential: string,
    conversationId: string | null,
    patch?: Partial<LearningSettings>
  ): Promise<LearningSettings> {
    const parsed = patch ? LearningSettingsPatchSchema.parse(patch) : undefined
    return this.locked(credential, conversationId, async (db, scope, conversation) => {
      if (parsed) {
        const before = await this.settingsWithin(db, scope, conversation)
        const old = (
          await db.query(
            'SELECT payload FROM learning_settings WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
            this.keys(scope, conversation)
          )
        ).rows[0]
        await db.query(
          'INSERT INTO learning_settings VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(tenant_id,account_id,conversation_id) DO UPDATE SET payload=excluded.payload',
          [
            ...this.keys(scope, conversation),
            JSON.stringify({ ...(old?.payload ?? {}), ...parsed })
          ]
        )
        const after = await this.settingsWithin(db, scope, conversation)
        const change = buildLearningSettingsAudit(before, after)
        if (change) {
          // Configuration evidence shares the settings transaction, never memory/send authority.
          await db.query(
            "INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id,details_json) VALUES($1,$2,$3,'learning_model_configuration_changed',$4,$5::jsonb)",
            [
              scope.tenant_id,
              randomUUID(),
              scope.employee_id,
              scope.account_id,
              JSON.stringify({ conversationHash: learningHash(conversation), ...change })
            ]
          )
        }
        return after
      }
      return this.settingsWithin(db, scope, conversation)
    })
  }
  private async tombstoned(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    kind: string,
    value: string
  ): Promise<boolean> {
    return !!(
      await db.query(
        'SELECT 1 FROM learning_tombstones WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND kind=$4 AND fingerprint=$5',
        [...this.keys(scope, conversation), kind, learningHash(value)]
      )
    ).rowCount
  }
  private async tombstone(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    kind: string,
    value: string,
    at: number
  ): Promise<void> {
    await db.query(
      'INSERT INTO learning_tombstones VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [...this.keys(scope, conversation), kind, learningHash(value), at]
    )
  }
  async recordEpisode(
    credential: string,
    conversationId: string | null,
    input: NewLearningEpisode
  ): Promise<LearningEpisode> {
    const episode = NewLearningEpisodeSchema.parse(input),
      hash = learningHash(episode)
    return this.locked(credential, conversationId, async (db, scope, conversation, at) => {
      const old = (
        await db.query(
          'SELECT payload,input_hash FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND source_id=$4',
          [...this.keys(scope, conversation), episode.sourceId]
        )
      ).rows[0]
      if (old) {
        if (old.input_hash !== hash) throw new Error('episode_source_conflict')
        return this.episodePayload(scope, conversation, old.payload)
      }
      if (await this.tombstoned(db, scope, conversation, 'episode_source', episode.sourceId))
        throw new Error('episode_forgotten')
      const result = {
        ...episode,
        id: randomUUID(),
        scope: enterpriseMemoryScope(scope, conversation || null),
        createdAt: at
      }
      await db.query('INSERT INTO learning_episodes VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)', [
        ...this.keys(scope, conversation),
        result.id,
        episode.sourceId,
        hash,
        JSON.stringify(result),
        at
      ])
      return result
    })
  }
  private episodePayload(scope: Scope, conversation: string, raw: unknown): LearningEpisode {
    const value = raw as LearningEpisode
    return { ...value, scope: enterpriseMemoryScope(scope, conversation || null) }
  }
  private async episodesWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    at: number
  ): Promise<LearningEpisode[]> {
    const settings = await this.settingsWithin(db, scope, conversation)
    const rows = await db.query(
      'SELECT payload FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND created_at>$4 ORDER BY created_at DESC,id',
      [...this.keys(scope, conversation), at - settings.caseRetentionDays * 86400000]
    )
    return rows.rows.map((row) => this.episodePayload(scope, conversation, row.payload))
  }
  episodes(credential: string, conversationId: string | null): Promise<LearningEpisode[]> {
    return this.locked(credential, conversationId, (db, scope, conversation, at) =>
      this.episodesWithin(db, scope, conversation, at)
    )
  }
  episode(
    credential: string,
    conversationId: string | null,
    episodeId: string
  ): Promise<LearningEpisode> {
    const id = z.uuid().parse(episodeId)
    return this.locked(credential, conversationId, async (db, scope, conversation, at) => {
      const settings = await this.settingsWithin(db, scope, conversation)
      const row = (
        await db.query(
          'SELECT payload FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=$4 AND created_at>$5',
          [...this.keys(scope, conversation), id, at - settings.caseRetentionDays * 86400000]
        )
      ).rows[0]
      if (!row) throw new Error('episode_not_found')
      return this.episodePayload(scope, conversation, row.payload)
    })
  }
  private async evidenceAvailable(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    evidence: MemoryProposal['evidence'],
    at: number
  ): Promise<boolean> {
    const episodes = await this.episodesWithin(db, scope, conversation, at),
      ids = new Set(episodes.map((episode) => episode.id))
    return evidence.length > 0 && evidence.every((ref) => ids.has(ref.episodeId))
  }
  private async header(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    id: string,
    expected?: number
  ): Promise<Row> {
    const row = (
      await db.query(
        'SELECT * FROM learning_memories WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=$4',
        [...this.keys(scope, conversation), Id.parse(id)]
      )
    ).rows[0]
    if (!row) throw new Error('memory_not_found')
    if (expected !== undefined && Number(row.current_revision) !== expected)
      throw new Error('memory_revision_conflict')
    return row
  }
  private async revision(
    db: PoolClient,
    scope: Scope,
    row: Row,
    version: number,
    at: number
  ): Promise<MemoryRevision> {
    const entry = (
      await db.query(
        'SELECT payload,activated_at FROM learning_revisions WHERE tenant_id=$1 AND account_id=$2 AND memory_id=$3 AND revision=$4',
        [scope.tenant_id, scope.account_id, row.id, version]
      )
    ).rows[0]
    if (!entry) throw new Error('memory_revision_not_found')
    const payload = entry.payload as MemoryRevision,
      episodes = await this.episodesWithin(db, scope, String(row.conversation_id), at)
    const redacted = payload.evidence
      .filter((ref) => !episodes.some((episode) => episode.id === ref.episodeId))
      .map((ref) => ref.episodeId)
    const quarantine = (
      await db.query(
        'SELECT at FROM learning_quarantines WHERE tenant_id=$1 AND account_id=$2 AND memory_id=$3 AND revision=$4',
        [scope.tenant_id, scope.account_id, row.id, version]
      )
    ).rows[0]
    return {
      ...payload,
      activatedAt: entry.activated_at === null ? null : Number(entry.activated_at),
      ...(redacted.length ? { redactedEvidenceIds: redacted } : {}),
      ...(quarantine ? { quarantinedAt: Number(quarantine.at) } : {})
    }
  }
  private async record(db: PoolClient, scope: Scope, row: Row, at: number): Promise<MemoryRecord> {
    const revision = await this.revision(db, scope, row, Number(row.current_revision), at)
    return {
      id: String(row.id),
      scope: enterpriseMemoryScope(scope, String(row.conversation_id) || null),
      state: row.state as MemoryRecord['state'],
      currentRevision: Number(row.current_revision),
      activeRevision: row.active_revision === null ? null : Number(row.active_revision),
      pinned: Boolean(row.pinned),
      content: revision.content,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      ...(revision.expiresAt === undefined ? {} : { expiresAt: revision.expiresAt })
    }
  }
  get(credential: string, conversationId: string | null, id: string): Promise<MemoryRecord> {
    return this.locked(credential, conversationId, async (db, scope, conversation, at) =>
      this.record(db, scope, await this.header(db, scope, conversation, id), at)
    )
  }
  list(credential: string, conversationId: string | null): Promise<MemoryRecord[]> {
    return this.locked(credential, conversationId, async (db, scope, conversation, at) => {
      const rows = (
        await db.query(
          'SELECT * FROM learning_memories WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 ORDER BY created_at,id',
          this.keys(scope, conversation)
        )
      ).rows
      return Promise.all(rows.map((row) => this.record(db, scope, row, at)))
    })
  }
  history(
    credential: string,
    conversationId: string | null,
    id: string
  ): Promise<MemoryRevision[]> {
    return this.locked(credential, conversationId, async (db, scope, conversation, at) => {
      const row = await this.header(db, scope, conversation, id)
      const revisions = (
        await db.query(
          'SELECT revision FROM learning_revisions WHERE tenant_id=$1 AND account_id=$2 AND memory_id=$3 ORDER BY revision',
          [scope.tenant_id, scope.account_id, id]
        )
      ).rows
      return Promise.all(
        revisions.map((entry) => this.revision(db, scope, row, Number(entry.revision), at))
      )
    })
  }
  private async insertRevision(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    id: string,
    version: number,
    input: MemoryProposal,
    at: number
  ): Promise<void> {
    const entry: MemoryRevision = {
      ...input,
      evidence: [...new Map(input.evidence.map((ref) => [ref.episodeId, ref])).values()],
      memoryId: id,
      revision: version,
      contentHash: learningHash(input.content),
      createdAt: at,
      activatedAt: null
    }
    await db.query('INSERT INTO learning_revisions VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,NULL)', [
      ...this.keys(scope, conversation),
      id,
      version,
      entry.contentHash,
      JSON.stringify(entry)
    ])
  }
  private async audit(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    id: string,
    action: string,
    version: number,
    at: number
  ): Promise<void> {
    await db.query('INSERT INTO learning_mutations VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      ...this.keys(scope, conversation),
      randomUUID(),
      id,
      action,
      version,
      scope.employee_id,
      at
    ])
  }
  async propose(
    credential: string,
    conversationId: string | null,
    raw: MemoryProposal
  ): Promise<MemoryRecord> {
    const input = MemoryProposalSchema.parse(raw)
    return this.locked(credential, conversationId, (db, scope, conversation, at) =>
      this.proposeWithin(db, scope, conversation, input, at)
    )
  }
  private async proposeWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    input: MemoryProposal,
    at: number
  ): Promise<MemoryRecord> {
    if (!(await this.evidenceAvailable(db, scope, conversation, input.evidence, at)))
      throw new Error('memory_evidence_unavailable')
    if (
      await this.tombstoned(db, scope, conversation, 'memory_content', learningHash(input.content))
    )
      throw new Error('memory_forgotten')
    const duplicate = (
      await db.query(
        'SELECT m.* FROM learning_memories m JOIN learning_revisions r ON (r.tenant_id,r.account_id,r.memory_id,r.revision)=(m.tenant_id,m.account_id,m.id,m.current_revision) WHERE m.tenant_id=$1 AND m.account_id=$2 AND m.conversation_id=$3 AND r.content_hash=$4',
        [...this.keys(scope, conversation), learningHash(input.content)]
      )
    ).rows[0]
    if (duplicate) {
      const previous = await this.revision(
        db,
        scope,
        duplicate,
        Number(duplicate.current_revision),
        at
      )
      const evidence = [
        ...new Map(
          [...previous.evidence, ...input.evidence].map((ref) => [ref.episodeId, ref])
        ).values()
      ]
      if (evidence.length === previous.evidence.length) return this.record(db, scope, duplicate, at)
      if (duplicate.pinned) throw new Error('memory_pinned')
      return this.reviseWithin(
        db,
        scope,
        conversation,
        duplicate,
        MemoryProposalSchema.parse({ ...input, evidence }),
        at
      )
    }
    const id = randomUUID()
    await db.query(
      "INSERT INTO learning_memories VALUES($1,$2,$3,$4,'pending',1,NULL,false,$5,$5)",
      [...this.keys(scope, conversation), id, at]
    )
    await this.insertRevision(db, scope, conversation, id, 1, input, at)
    await this.audit(db, scope, conversation, id, 'propose', 1, at)
    return this.record(db, scope, await this.header(db, scope, conversation, id), at)
  }
  /** Host-only merge proposal: preserve every source and exact replacement revision. */
  async proposeCurationWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    input: MemoryProposal,
    originals: { memoryId: string; revision: number }[],
    at: number
  ): Promise<MemoryRecord> {
    z.array(z.strictObject({ memoryId: z.uuid(), revision: z.number().int().positive() }))
      .min(2)
      .max(5)
      .parse(originals)
    if (
      new Set(originals.map((ref) => ref.memoryId)).size !== originals.length ||
      input.source !== 'curator'
    )
      throw new Error('curation_merge_invalid')
    const revisions: MemoryRevision[] = []
    for (const ref of originals) {
      const row = await this.header(db, scope, conversation, ref.memoryId, ref.revision)
      const revision = await this.assertUsable(db, scope, conversation, row, ref.revision, at)
      if (
        row.pinned ||
        row.state !== 'active' ||
        Number(row.active_revision) !== ref.revision ||
        !['review', 'curator'].includes(revision.source) ||
        revision.content.kind === 'preference'
      )
        throw new Error('curation_context_changed')
      revisions.push(revision)
    }
    const evidence = [
      ...new Set(revisions.flatMap((revision) => revision.evidence.map((ref) => ref.episodeId)))
    ].sort()
    if (learningHash(evidence) !== learningHash(input.evidence.map((ref) => ref.episodeId).sort()))
      throw new Error('curation_merge_evidence_incomplete')
    const expiries = revisions.flatMap((revision) =>
      revision.expiresAt === undefined ? [] : [revision.expiresAt]
    )
    if (expiries.length && input.expiresAt !== Math.min(...expiries))
      throw new Error('curation_merge_expiry_changed')
    if (
      (
        await db.query(
          'SELECT 1 FROM learning_revisions WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND content_hash=$4',
          [...this.keys(scope, conversation), learningHash(input.content)]
        )
      ).rowCount
    )
      throw new Error('curation_merge_duplicate')
    const candidate = await this.proposeWithin(
      db,
      scope,
      conversation,
      MemoryProposalSchema.parse(input),
      at
    )
    const manifest = [...originals].sort((a, b) => a.memoryId.localeCompare(b.memoryId))
    await db.query('INSERT INTO learning_curation_candidates VALUES($1,$2,$3,$4,$5,$6::jsonb)', [
      ...this.keys(scope, conversation),
      candidate.id,
      candidate.currentRevision,
      JSON.stringify(manifest)
    ])
    for (const ref of originals)
      await db.query('INSERT INTO learning_memory_replacements VALUES($1,$2,$3,$4,$5,$6,$7,NULL)', [
        ...this.keys(scope, conversation),
        candidate.id,
        candidate.currentRevision,
        ref.memoryId,
        ref.revision
      ])
    return candidate
  }
  replacements(
    credential: string,
    conversationId: string | null,
    id: string
  ): Promise<{ memoryId: string; revision: number }[]> {
    return this.locked(credential, conversationId, async (db, scope, conversation) => {
      const row = await this.header(db, scope, conversation, id)
      return (
        await this.replacementRowsWithin(db, scope, conversation, id, Number(row.current_revision))
      ).mappings.map((ref) => ({
        memoryId: String(ref.superseded_id),
        revision: Number(ref.superseded_revision)
      }))
    })
  }

  /** Inputs contain only the claim's evidence and the actual versions loaded by those generations. */
  reviewInput(
    credential: string,
    claim: ClaimedLearningJob
  ): Promise<EnterpriseLearningReviewInput> {
    return this.locked(
      credential,
      claim.scope.conversationId ?? null,
      (db, scope, conversation, at) => this.reviewInputWithin(db, scope, conversation, claim, at)
    )
  }
  private async reviewInputWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    claim: ClaimedLearningJob,
    at: number
  ): Promise<EnterpriseLearningReviewInput> {
    if (
      learningHash(claim.scope) !== learningHash(enterpriseMemoryScope(scope, conversation || null))
    )
      throw new Error('learning_scope_conflict')
    const settings = await this.settingsWithin(db, scope, conversation)
    const episodes = (await this.episodesWithin(db, scope, conversation, at))
      .filter((episode) => claim.episodeIds.includes(episode.id))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    if (episodes.length !== claim.episodeIds.length) throw new Error('memory_evidence_unavailable')
    const feedback = (
      await db.query(
        'SELECT payload FROM learning_feedback WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND episode_id=ANY($4::uuid[]) ORDER BY source_id',
        [...this.keys(scope, conversation), claim.episodeIds]
      )
    ).rows.map((row) => LearningFeedbackSchema.parse(row.payload))
    const loaded = [
      ...new Map(
        feedback
          .flatMap((event) => event.memoryRefs)
          .map((ref) => [`${ref.id}:${ref.revision}`, ref])
      ).values()
    ]
    const rows = (
      await db.query(
        'SELECT * FROM learning_memories WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=ANY($3::text[]) ORDER BY id',
        [scope.tenant_id, scope.account_id, [...new Set(['', conversation])]]
      )
    ).rows
    // Parent methods are visible context. The commit path below can only modify this conversation.
    const memories = await Promise.all(rows.map((row) => this.record(db, scope, row, at)))
    const loadedRevisions: NonNullable<LearningReviewRequest['loadedRevisions']> = []
    for (const ref of loaded) {
      const row = rows.find((item) => item.id === ref.id)
      if (!row) throw new Error('memory_revision_not_found')
      const revision = await this.revision(db, scope, row, ref.revision, at)
      loadedRevisions.push({
        memoryId: ref.id,
        revision: ref.revision,
        contentHash: revision.contentHash,
        content: revision.content
      })
    }
    const epochs = (
      await db.query(
        'SELECT conversation_id,version::text FROM learning_context_epochs WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=ANY($3::text[]) ORDER BY conversation_id',
        [scope.tenant_id, scope.account_id, [...new Set(['', conversation])]]
      )
    ).rows
    const request: LearningReviewRequest = {
      settings,
      episodes,
      memories,
      feedback,
      loadedRevisions
    }
    return { request, basisHash: learningHash({ scope: claim.scope, request, epochs }) }
  }
  /** Called only inside queue.complete's account transaction; no nested transaction or activation. */
  async applyReviewWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    at: number,
    claim: ClaimedLearningJob,
    input: EnterpriseLearningReviewInput,
    result: LearningReviewResult
  ): Promise<string[]> {
    const current = await this.reviewInputWithin(db, scope, conversation, claim, at)
    if (current.basisHash !== input.basisHash) throw new Error('learning_review_context_changed')
    const { operations } = LearningReviewResponseSchema.parse({ operations: result.operations })
    validateLearningReviewOperations(current.request, operations)
    const ids: string[] = []
    for (const operation of operations) {
      const proposal = MemoryProposalSchema.parse({ ...operation.proposal, source: 'review' })
      if (!(await this.evidenceAvailable(db, scope, conversation, proposal.evidence, at)))
        throw new Error('memory_evidence_unavailable')
      const record =
        operation.action === 'create'
          ? await this.proposeWithin(db, scope, conversation, proposal, at)
          : await this.reviseWithin(
              db,
              scope,
              conversation,
              await this.header(
                db,
                scope,
                conversation,
                operation.memoryId,
                operation.expectedRevision
              ),
              proposal,
              at
            )
      ids.push(record.id)
    }
    return [...new Set(ids)]
  }
  private async reviseWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    row: Row,
    input: MemoryProposal,
    at: number
  ): Promise<MemoryRecord> {
    if (row.pinned) throw new Error('memory_pinned')
    const id = String(row.id),
      next = Number(row.current_revision) + 1
    const { revisions: replacements } = await this.pendingReplacementRevisionsWithin(
      db,
      scope,
      conversation,
      id,
      next - 1,
      at
    )
    this.assertReplacementEvidence(replacements, input.evidence)
    await this.insertRevision(db, scope, conversation, id, next, input, at)
    await db.query(
      'UPDATE learning_memories SET current_revision=$5,updated_at=$6 WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=$4',
      [...this.keys(scope, conversation), id, next, at]
    )
    await this.audit(db, scope, conversation, id, 'revise', next, at)
    return this.record(db, scope, await this.header(db, scope, conversation, id), at)
  }
  async revise(
    credential: string,
    conversationId: string | null,
    id: string,
    expected: number,
    raw: MemoryProposal
  ): Promise<MemoryRecord> {
    const input = MemoryProposalSchema.parse(raw)
    z.number().int().positive().parse(expected)
    return this.locked(credential, conversationId, async (db, scope, conversation, at) => {
      const row = await this.header(db, scope, conversation, id, expected)
      if (!(await this.evidenceAvailable(db, scope, conversation, input.evidence, at)))
        throw new Error('memory_evidence_unavailable')
      return this.reviseWithin(db, scope, conversation, row, input, at)
    })
  }
  private async assertUsable(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    row: Row,
    version: number,
    at: number
  ): Promise<MemoryRevision> {
    const revision = await this.revision(db, scope, row, version, at)
    if (revision.quarantinedAt !== undefined) throw new Error('memory_revision_quarantined')
    if (revision.expiresAt !== undefined && revision.expiresAt <= at)
      throw new Error('memory_expired')
    if (!(await this.evidenceAvailable(db, scope, conversation, revision.evidence, at)))
      throw new Error('memory_evidence_unavailable')
    return revision
  }
  private async activateWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    row: Row,
    at: number
  ): Promise<MemoryRecord> {
    const id = String(row.id),
      version = Number(row.current_revision)
    const revision = await this.assertUsable(db, scope, conversation, row, version, at)
    const { revisions: replacements, proposedRevision } =
      await this.pendingReplacementRevisionsWithin(db, scope, conversation, id, version, at)
    this.assertReplacementEvidence(replacements, revision.evidence)
    await db.query(
      'UPDATE learning_revisions SET activated_at=COALESCE(activated_at,$4) WHERE tenant_id=$1 AND account_id=$2 AND memory_id=$3 AND revision=$5',
      [scope.tenant_id, scope.account_id, id, at, version]
    )
    await db.query(
      "UPDATE learning_memories SET state='active',active_revision=current_revision,updated_at=$5 WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=$4",
      [...this.keys(scope, conversation), id, at]
    )
    await this.audit(db, scope, conversation, id, 'activate', version, at)
    for (const ref of replacements) {
      await db.query(
        "UPDATE learning_memories SET state='archived',updated_at=$5 WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=$4 AND current_revision=$6",
        [...this.keys(scope, conversation), ref.memoryId, at, ref.revision]
      )
      await this.audit(db, scope, conversation, ref.memoryId, 'curator_replaced', ref.revision, at)
    }
    if (replacements.length)
      await db.query(
        'UPDATE learning_memory_replacements SET applied_at=$6 WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND proposed_id=$4 AND proposed_revision=$5 AND applied_at IS NULL',
        [...this.keys(scope, conversation), id, proposedRevision, at]
      )
    return this.record(db, scope, await this.header(db, scope, conversation, id), at)
  }
  private assertReplacementEvidence(
    replacements: MemoryRevision[],
    evidence: MemoryProposal['evidence']
  ): void {
    const supplied = new Set(evidence.map((ref) => ref.episodeId))
    if (
      replacements.some((revision) => revision.evidence.some((ref) => !supplied.has(ref.episodeId)))
    )
      throw new Error('curation_merge_evidence_incomplete')
  }
  private async replacementRowsWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    id: string,
    version: number
  ): Promise<{ manifest: Row | undefined; mappings: Row[]; proposedRevision: number }> {
    const keys = [...this.keys(scope, conversation), id, version]
    const manifest = (
      await db.query(
        'SELECT manifest,proposed_revision FROM learning_curation_candidates WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND proposed_id=$4 AND proposed_revision<=$5 ORDER BY proposed_revision DESC LIMIT 1',
        keys
      )
    ).rows[0]
    const proposedRevision = manifest ? Number(manifest.proposed_revision) : version
    const mappings = (
      await db.query(
        'SELECT superseded_id,superseded_revision,applied_at FROM learning_memory_replacements WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND proposed_id=$4 AND proposed_revision=$5 ORDER BY superseded_id',
        [...this.keys(scope, conversation), id, proposedRevision]
      )
    ).rows
    return { manifest, mappings, proposedRevision }
  }
  private async pendingReplacementRevisionsWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    id: string,
    version: number,
    at: number
  ): Promise<{ revisions: MemoryRevision[]; proposedRevision: number }> {
    const { manifest, mappings, proposedRevision } = await this.replacementRowsWithin(
      db,
      scope,
      conversation,
      id,
      version
    )
    if (!manifest) {
      if (mappings.length) throw new Error('curation_replacement_changed')
      return { revisions: [], proposedRevision }
    }
    // Applied mappings are history; a human can explicitly restore an old method.
    if (mappings.length && mappings.every((mapping) => mapping.applied_at !== null))
      return { revisions: [], proposedRevision }
    const refs = mappings.map((mapping) => ({
      memoryId: String(mapping.superseded_id),
      revision: Number(mapping.superseded_revision)
    }))
    if (
      learningHash(refs) !== learningHash(manifest.manifest) ||
      mappings.some((mapping) => mapping.applied_at !== null)
    )
      throw new Error('curation_replacement_changed')
    const revisions: MemoryRevision[] = []
    for (const ref of refs) {
      try {
        const old = await this.header(db, scope, conversation, ref.memoryId, ref.revision)
        const revision = await this.assertUsable(db, scope, conversation, old, ref.revision, at)
        if (
          old.pinned ||
          old.state !== 'active' ||
          Number(old.active_revision) !== ref.revision ||
          !['review', 'curator'].includes(revision.source) ||
          revision.content.kind === 'preference'
        )
          throw new Error('curation_replacement_changed')
        revisions.push(revision)
      } catch {
        throw new Error('curation_replacement_changed')
      }
    }
    return { revisions, proposedRevision }
  }
  /** Host validator uses the already locked account transaction; no nested authority transaction. */
  async validationCaptureWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    id: string,
    expected: number,
    at: number
  ): Promise<Omit<ValidationSnapshot, 'environment' | 'environmentEpoch'>> {
    const row = await this.header(db, scope, conversation, id, expected)
    if (row.state === 'archived') throw new Error('memory_archived')
    if (row.pinned) throw new Error('memory_pinned')
    const revision = await this.assertUsable(db, scope, conversation, row, expected, at)
    const { revisions: replacements } = await this.pendingReplacementRevisionsWithin(
      db,
      scope,
      conversation,
      id,
      expected,
      at
    )
    this.assertReplacementEvidence(replacements, revision.evidence)
    const evidence = (await this.episodesWithin(db, scope, conversation, at))
      .filter((episode) => revision.evidence.some((ref) => ref.episodeId === episode.id))
      .sort((a, b) => a.id.localeCompare(b.id))
    const settings = await this.settingsWithin(db, scope, conversation)
    const readSettings: Partial<LearningSettings> = { ...settings }
    delete readSettings.mode
    const sources = (
      await db.query(
        'SELECT conversation_id,id,input_hash FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=ANY($3::text[]) AND created_at>$4 ORDER BY conversation_id,id',
        [
          scope.tenant_id,
          scope.account_id,
          [...new Set(['', conversation])],
          at - settings.caseRetentionDays * 86400000
        ]
      )
    ).rows
    const active = (
      await db.query(
        `SELECT m.id,m.conversation_id,m.state,m.active_revision,r.content_hash,r.payload,q.at AS quarantined_at
       FROM learning_memories m JOIN learning_revisions r ON (r.tenant_id,r.account_id,r.memory_id,r.revision)=(m.tenant_id,m.account_id,m.id,m.active_revision)
       LEFT JOIN learning_quarantines q ON (q.tenant_id,q.account_id,q.memory_id,q.revision)=(m.tenant_id,m.account_id,m.id,m.active_revision)
       WHERE m.tenant_id=$1 AND m.account_id=$2 AND m.conversation_id=ANY($3::text[]) ORDER BY m.id`,
        [scope.tenant_id, scope.account_id, [...new Set(['', conversation])]]
      )
    ).rows
    return {
      scope: enterpriseMemoryScope(scope, conversation || null),
      memory: await this.record(db, scope, row, at),
      revision,
      replacements,
      baseline:
        row.state === 'active' && row.active_revision !== null
          ? await this.assertUsable(db, scope, conversation, row, Number(row.active_revision), at)
          : null,
      evidenceHash: learningHash(evidence),
      evidenceConversationIds: [
        ...new Set(
          evidence.flatMap((episode) =>
            episode.scope.conversationId ? [episode.scope.conversationId] : []
          )
        )
      ],
      corpusVersion: learningHash({ sources, active, replacements, settings: readSettings })
    }
  }
  async activateValidationWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    id: string,
    expected: number,
    at: number
  ): Promise<MemoryRecord> {
    const row = await this.header(db, scope, conversation, id, expected)
    if (row.pinned) throw new Error('memory_pinned')
    if (row.state === 'archived') throw new Error('memory_archived')
    return this.activateWithin(db, scope, conversation, row, at)
  }
  /** Human storage activation is still separate from server publication and automatic-send admission. */
  activate(
    credential: string,
    conversationId: string | null,
    id: string,
    expected: number
  ): Promise<MemoryRecord> {
    return this.locked(credential, conversationId, async (db, scope, conversation, at) =>
      this.activateWithin(
        db,
        scope,
        conversation,
        await this.header(db, scope, conversation, id, expected),
        at
      )
    )
  }
  rollback(
    credential: string,
    conversationId: string | null,
    id: string,
    expected: number,
    target: number
  ): Promise<MemoryRecord> {
    return this.locked(credential, conversationId, async (db, scope, conversation, at) => {
      const row = await this.header(db, scope, conversation, id, expected),
        revision = await this.assertUsable(db, scope, conversation, row, target, at)
      if (revision.activatedAt === null) throw new Error('rollback_target_unpublished')
      await this.reviseWithin(
        db,
        scope,
        conversation,
        row,
        {
          content: revision.content,
          evidence: revision.evidence,
          source: 'human',
          reason: `恢复已发布版本 ${target}`,
          expiresAt: revision.expiresAt
        },
        at
      )
      return this.activateWithin(
        db,
        scope,
        conversation,
        await this.header(db, scope, conversation, id),
        at
      )
    })
  }
  async setPinned(
    credential: string,
    conversationId: string | null,
    id: string,
    expected: number,
    pinned: boolean
  ): Promise<void> {
    z.boolean().parse(pinned)
    return this.locked(credential, conversationId, async (db, scope, conversation, at) => {
      await this.header(db, scope, conversation, id, expected)
      await db.query(
        'UPDATE learning_memories SET pinned=$5,updated_at=$6 WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=$4',
        [...this.keys(scope, conversation), id, pinned, at]
      )
      await this.audit(db, scope, conversation, id, pinned ? 'pin' : 'unpin', expected, at)
    })
  }
  async archive(
    credential: string,
    conversationId: string | null,
    id: string,
    expected: number,
    actor: 'human' | 'curator'
  ): Promise<void> {
    z.enum(['human', 'curator']).parse(actor)
    return this.locked(credential, conversationId, async (db, scope, conversation, at) => {
      const row = await this.header(db, scope, conversation, id, expected)
      if (actor === 'curator') {
        const settings = await this.settingsWithin(db, scope, conversation)
        if (settings.mode === 'off' || !settings.memoryEnabled || !settings.curationEnabled)
          throw new Error('learning_maintenance_disabled')
        const revision = await this.revision(db, scope, row, expected, at)
        if (row.pinned || !['review', 'curator'].includes(revision.source))
          throw new Error('memory_pinned')
      }
      await db.query(
        "UPDATE learning_memories SET state='archived',updated_at=$5 WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=$4",
        [...this.keys(scope, conversation), id, at]
      )
      await this.audit(db, scope, conversation, id, 'archive', expected, at)
    })
  }
  restore(
    credential: string,
    conversationId: string | null,
    id: string,
    expected: number
  ): Promise<void> {
    return this.locked(credential, conversationId, async (db, scope, conversation, at) => {
      const row = await this.header(db, scope, conversation, id, expected)
      let state: MemoryRecord['state'] = row.active_revision === null ? 'pending' : 'active'
      if (row.active_revision !== null) {
        try {
          await this.assertUsable(db, scope, conversation, row, Number(row.active_revision), at)
        } catch (error) {
          if (
            !(error instanceof Error) ||
            ![
              'memory_evidence_unavailable',
              'memory_revision_quarantined',
              'memory_expired'
            ].includes(error.message)
          )
            throw error
          state = 'stale'
        }
      }
      await db.query(
        'UPDATE learning_memories SET state=$5,updated_at=$6 WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=$4',
        [...this.keys(scope, conversation), id, state, at]
      )
      await this.audit(db, scope, conversation, id, 'restore', expected, at)
    })
  }
  forget(
    credential: string,
    conversationId: string | null,
    id: string,
    expected: number
  ): Promise<void> {
    return this.locked(credential, conversationId, async (db, scope, conversation, at) => {
      await this.header(db, scope, conversation, id, expected)
      const revisions = (
        await db.query(
          'SELECT payload FROM learning_revisions WHERE tenant_id=$1 AND account_id=$2 AND memory_id=$3',
          [scope.tenant_id, scope.account_id, id]
        )
      ).rows
      await this.tombstone(db, scope, conversation, 'memory_id', id, at)
      await invalidateLearningPreparations(db, scope, conversation, [id])
      for (const row of revisions)
        await this.tombstone(
          db,
          scope,
          conversation,
          'memory_content',
          learningHash((row.payload as MemoryRevision).content),
          at
        )
      await this.purgeMemoryReferences(db, scope, [id], at)
      await db.query(
        'DELETE FROM learning_mutations WHERE tenant_id=$1 AND account_id=$2 AND memory_id=$3',
        [scope.tenant_id, scope.account_id, id]
      )
      await db.query(
        'DELETE FROM learning_memories WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=$4',
        [...this.keys(scope, conversation), id]
      )
    })
  }
  /** An account method may have been loaded by many customer generations. Forget their immutable maps too. */
  private async purgeMemoryReferences(
    db: PoolClient,
    scope: Scope,
    ids: string[],
    at: number
  ): Promise<void> {
    if (!ids.length) return
    const keys = [scope.tenant_id, scope.account_id, ids]
    const predicate =
      "EXISTS(SELECT 1 FROM jsonb_array_elements(refs_json) AS ref WHERE ref->>'id'=ANY($3::text[]))"
    const generations = (
      await db.query(
        `SELECT conversation_id,generation_id FROM learning_generations WHERE tenant_id=$1 AND account_id=$2 AND ${predicate}`,
        keys
      )
    ).rows
    for (const row of generations)
      await this.tombstone(
        db,
        scope,
        String(row.conversation_id),
        'generation_source',
        String(row.generation_id),
        at
      )
    await db.query(
      `DELETE FROM learning_generations WHERE tenant_id=$1 AND account_id=$2 AND ${predicate}`,
      keys
    )
    await db.query(
      "DELETE FROM learning_feedback WHERE tenant_id=$1 AND account_id=$2 AND EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'memoryRefs') AS ref WHERE ref->>'id'=ANY($3::text[]))",
      keys
    )
  }
  private async corpusWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    at: number
  ): Promise<string> {
    const versions = (
      await db.query(
        'SELECT conversation_id,version::text FROM learning_versions WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=ANY($3::text[]) ORDER BY conversation_id',
        [scope.tenant_id, scope.account_id, [...new Set(['', conversation])]]
      )
    ).rows
    const settings = await this.settingsWithin(db, scope, conversation)
    const rows = (
      await db.query(
        "SELECT m.*,r.payload AS active_payload FROM learning_memories m JOIN learning_revisions r ON (r.tenant_id,r.account_id,r.memory_id,r.revision)=(m.tenant_id,m.account_id,m.id,m.active_revision) WHERE m.tenant_id=$1 AND m.account_id=$2 AND m.conversation_id=ANY($3::text[]) AND m.state='active' ORDER BY m.id",
        [scope.tenant_id, scope.account_id, [...new Set(['', conversation])]]
      )
    ).rows
    const usable: { id: string; revision: number }[] = []
    for (const row of rows) {
      const revision = await this.revision(db, scope, row, Number(row.active_revision), at)
      if (
        !revision.redactedEvidenceIds?.length &&
        revision.quarantinedAt === undefined &&
        (revision.expiresAt === undefined || revision.expiresAt > at)
      )
        usable.push({ id: String(row.id), revision: Number(row.active_revision) })
    }
    return learningHash({
      scope: enterpriseMemoryScope(scope, conversation || null),
      versions,
      usable,
      settings
    })
  }
  retrieve(
    credential: string,
    conversationId: string | null,
    query: string
  ): Promise<MemorySnapshot> {
    return this.locked(credential, conversationId, async (db, scope, conversation, at) => {
      const settings = await this.settingsWithin(db, scope, conversation),
        corpus = await this.corpusWithin(db, scope, conversation, at),
        memoryScope = enterpriseMemoryScope(scope, conversation || null)
      const candidates: (MemorySnapshotItem & { score: number })[] = []
      if (settings.memoryEnabled && query.trim() && query.length <= 10000) {
        const rows = (
          await db.query(
            "SELECT * FROM learning_memories WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=ANY($3::text[]) AND state='active' AND active_revision IS NOT NULL ORDER BY id",
            [scope.tenant_id, scope.account_id, [...new Set(['', conversation])]]
          )
        ).rows
        for (const row of rows) {
          const revision = await this.revision(db, scope, row, Number(row.active_revision), at),
            score = relevance(query, memorySearchText(revision.content))
          if (
            score <= 0 ||
            revision.redactedEvidenceIds?.length ||
            revision.quarantinedAt !== undefined ||
            (revision.expiresAt !== undefined && revision.expiresAt <= at)
          )
            continue
          candidates.push({
            id: String(row.id),
            revision: revision.revision,
            scope: enterpriseMemoryScope(scope, String(row.conversation_id) || null),
            content: revision.content,
            contentHash: revision.contentHash,
            evidence: revision.evidence,
            expiresAt: revision.expiresAt,
            score
          })
        }
      }
      return boundedMemorySnapshot(
        memoryScope,
        candidates
          .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
          .map(({ id, revision, scope, content, contentHash, evidence, expiresAt }) => ({
            id,
            revision,
            scope,
            content,
            contentHash,
            evidence,
            expiresAt
          })),
        { maxEntries: settings.maxEntries, maxTokens: settings.maxContextTokens },
        corpus
      )
    })
  }
  forgetScope(credential: string, conversationId: string | null): Promise<void> {
    return this.locked(credential, conversationId, async (db, scope, conversation, at) => {
      await forgetLearningQueue(db, scope, conversation)
      const episodes = (
        await db.query(
          'SELECT source_id FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
          this.keys(scope, conversation)
        )
      ).rows
      for (const episode of episodes)
        await this.tombstone(
          db,
          scope,
          conversation,
          'episode_source',
          String(episode.source_id),
          at
        )
      const memories = (
        await db.query(
          'SELECT id FROM learning_memories WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
          this.keys(scope, conversation)
        )
      ).rows
      for (const memory of memories)
        await this.tombstone(db, scope, conversation, 'memory_id', String(memory.id), at)
      await this.purgeMemoryReferences(
        db,
        scope,
        memories.map((memory) => String(memory.id)),
        at
      )
      await invalidateLearningPreparations(
        db,
        scope,
        conversation,
        memories.map((memory) => String(memory.id))
      )
      for (const table of [
        'learning_curation_reports',
        'learning_curation_state',
        'learning_calibration_sets',
        'learning_feedback',
        'learning_generations',
        'learning_memories',
        'learning_episodes',
        'learning_settings',
        'learning_mutations'
      ])
        await db.query(
          `DELETE FROM ${table} WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3`,
          this.keys(scope, conversation)
        )
    })
  }
  pruneExpired(credential: string, conversationId: string | null): Promise<RetentionReport> {
    return this.locked(credential, conversationId, (db, scope, conversation, at) =>
      this.pruneExpiredWithin(db, scope, conversation, at)
    )
  }
  /** Used by maintenance under its existing authenticated account transaction. */
  async pruneExpiredWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    at: number
  ): Promise<RetentionReport> {
    const settings = await this.settingsWithin(db, scope, conversation)
    const expired = (
      await db.query(
        'SELECT id,source_id FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND created_at<=$4',
        [...this.keys(scope, conversation), at - settings.caseRetentionDays * 86400000]
      )
    ).rows
    const redactedEvidence = expired.length
      ? Number(
          (
            await db.query(
              "SELECT count(*)::text AS n FROM learning_revisions r CROSS JOIN LATERAL jsonb_array_elements(r.payload->'evidence') AS ref WHERE r.tenant_id=$1 AND r.account_id=$2 AND r.conversation_id=$3 AND ref->>'episodeId'=ANY($4::text[])",
              [...this.keys(scope, conversation), expired.map((episode) => String(episode.id))]
            )
          ).rows[0].n
        )
      : 0
    for (const episode of expired)
      await this.tombstone(db, scope, conversation, 'episode_source', String(episode.source_id), at)
    if (expired.length) await discardEvaluationCheckpointsWithin(db, scope, at)
    await purgeExpiredEvaluationCheckpointsWithin(db, scope, at)
    if (expired.length) await invalidateLearningPreparations(db, scope, conversation)
    await db.query(
      'DELETE FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND created_at<=$4',
      [...this.keys(scope, conversation), at - settings.caseRetentionDays * 86400000]
    )
    const memories = (
      await db.query(
        "SELECT * FROM learning_memories WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND state='active'",
        this.keys(scope, conversation)
      )
    ).rows
    const invalidatedMethods: string[] = []
    for (const memory of memories)
      if (
        (await this.revision(db, scope, memory, Number(memory.active_revision), at))
          .redactedEvidenceIds?.length
      ) {
        await db.query(
          "UPDATE learning_memories SET state='stale' WHERE tenant_id=$1 AND account_id=$2 AND id=$3",
          [scope.tenant_id, scope.account_id, memory.id]
        )
        invalidatedMethods.push(String(memory.id))
      }
    return {
      deletedEpisodes: expired.length,
      redactedEvidence,
      invalidatedMethods
    }
  }
  async registerGeneration(
    credential: string,
    conversationId: string | null,
    generationId: string,
    episodeId: string,
    refs: { id: string; revision: number }[]
  ): Promise<void> {
    Id.parse(generationId)
    z.array(z.strictObject({ id: Id, revision: z.number().int().positive() }))
      .max(5)
      .parse(refs)
    return this.locked(credential, conversationId, async (db, scope, conversation, at) => {
      if (await this.tombstoned(db, scope, conversation, 'generation_source', generationId))
        throw new Error('generation_forgotten')
      if (!(await this.evidenceAvailable(db, scope, conversation, [{ episodeId }], at)))
        throw new Error('memory_evidence_unavailable')
      for (const ref of refs) {
        const row = (
          await db.query(
            'SELECT * FROM learning_memories WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=ANY($3::text[]) AND id=$4',
            [scope.tenant_id, scope.account_id, [...new Set(['', conversation])], ref.id]
          )
        ).rows[0]
        if (!row) throw new Error('memory_not_found')
        await this.revision(db, scope, row, ref.revision, at)
      }
      const hash = learningHash({ episodeId, refs }),
        old = (
          await db.query(
            'SELECT input_hash FROM learning_generations WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND generation_id=$4',
            [...this.keys(scope, conversation), generationId]
          )
        ).rows[0]
      if (old) {
        if (old.input_hash !== hash) throw new Error('generation_source_conflict')
        return
      }
      await db.query('INSERT INTO learning_generations VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)', [
        ...this.keys(scope, conversation),
        generationId,
        episodeId,
        JSON.stringify(refs),
        hash
      ])
      const feedback: LearningFeedback = {
        sourceId: `loaded:${learningHash(generationId)}`,
        episodeId,
        kind: 'loaded',
        memoryRefs: refs,
        at
      }
      await db.query('INSERT INTO learning_feedback VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [
        ...this.keys(scope, conversation),
        feedback.sourceId,
        learningHash(feedback),
        episodeId,
        JSON.stringify(feedback)
      ])
    })
  }
  async feedback(
    credential: string,
    conversationId: string | null,
    generationId: string,
    raw: LearningHumanFeedbackInput
  ): Promise<void> {
    const input = LearningHumanFeedbackInputSchema.parse(raw)
    return this.locked(credential, conversationId, async (db, scope, conversation, at) => {
      const generation = (
        await db.query(
          'SELECT * FROM learning_generations WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND generation_id=$4',
          [...this.keys(scope, conversation), generationId]
        )
      ).rows[0]
      if (!generation) throw new Error('generation_not_found')
      const loaded = generation.refs_json as LearningFeedback['memoryRefs'],
        refs = input.memoryId ? loaded.filter((ref) => ref.id === input.memoryId) : loaded
      if (input.memoryId && !refs.length) throw new Error('feedback_memory_not_loaded')
      const event = LearningFeedbackSchema.parse({
        sourceId: input.sourceId,
        episodeId: generation.episode_id,
        memoryRefs: refs,
        kind: input.kind,
        reason: input.reason,
        at
      })
      const hash = learningHash({ ...event, at: undefined }),
        old = (
          await db.query(
            'SELECT input_hash FROM learning_feedback WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND source_id=$4',
            [...this.keys(scope, conversation), event.sourceId]
          )
        ).rows[0]
      if (old) {
        if (old.input_hash !== hash) throw new Error('feedback_source_conflict')
        return
      }
      await db.query('INSERT INTO learning_feedback VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [
        ...this.keys(scope, conversation),
        event.sourceId,
        hash,
        generation.episode_id,
        JSON.stringify(event)
      ])
      if (event.kind === 'fact_error' || event.kind === 'improper_commitment')
        for (const ref of refs) {
          const memory = (
            await db.query(
              'SELECT * FROM learning_memories WHERE tenant_id=$1 AND account_id=$2 AND id=$3',
              [scope.tenant_id, scope.account_id, ref.id]
            )
          ).rows[0]
          await db.query(
            'INSERT INTO learning_quarantines VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
            [
              scope.tenant_id,
              scope.account_id,
              memory.conversation_id,
              ref.id,
              ref.revision,
              event.sourceId,
              at
            ]
          )
          await db.query(
            "UPDATE learning_memories SET state='stale',updated_at=$5 WHERE tenant_id=$1 AND account_id=$2 AND id=$3 AND active_revision=$4",
            [scope.tenant_id, scope.account_id, ref.id, ref.revision, at]
          )
          await this.audit(
            db,
            scope,
            String(memory.conversation_id),
            ref.id,
            'quarantine',
            ref.revision,
            at
          )
        }
    })
  }
}
