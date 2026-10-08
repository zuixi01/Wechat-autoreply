import type { Postgres } from '../database/postgres'
import {
  LearningModelDirectorySchema,
  assertLearningReviewSelection,
  type LearningModelDirectory
} from '../../../src/shared/contracts/learning-model-directory'
import type { PoolClient } from 'pg'
import { AuthorityError, type Scope } from '../auth/account-authority'
import { withLearningAccount, type LearningAccountAuthority } from './learning-account'
import { EnterpriseLearningRepository, enterpriseMemoryScope } from './learning-repository'
import { EnterpriseLearningQueue } from './learning-queue'
import {
  recordEnterpriseTaskEventWithin,
  enterpriseEpisodeTaskReferenceWithin
} from './learning-events'
import { EnterpriseLearningValidationStore } from './learning-validation-store'
import { learningUsageWithin } from './learning-background'
import { readLearningPublicationStatus } from './learning-publication-status'
import {
  LearningActionSchema,
  type LearningWorkbenchSnapshot
} from '../../../src/shared/contracts/learning-desktop'
import {
  LearningFeedbackSchema,
  type LearningMetrics,
  type LearningCurationReport,
  type LearningValidationResult,
  type LearningValidationReport,
  type LearningEpisode
} from '../../../src/shared/contracts/learning-memory'
import {
  LearningManagementRequests,
  LearningManagementError,
  mapLearningManagementFailure,
  type LearningManagementOperation
} from './learning-routes'

export interface EnterpriseLearningManagementOptions {
  modelDirectory?: () => LearningModelDirectory
  now?: () => number
  validatorVersion?: string
  /** Host-only bridges must reauthorize the device on every worker commit. */
  validate?(
    credential: string,
    conversationId: string | null,
    id: string,
    revision: number,
    signal: AbortSignal
  ): Promise<LearningValidationResult>
  curate?(
    credential: string,
    conversationId: string | null,
    dryRun: boolean,
    signal: AbortSignal
  ): Promise<LearningCurationReport>
}
type Ports = {
  repository: EnterpriseLearningRepository<LearningAccountAuthority>
  queue: EnterpriseLearningQueue
  validation: EnterpriseLearningValidationStore
}
/** Ordinary application management cannot mint activation grants. */
export class EnterpriseLearningManagement {
  constructor(
    private readonly database: Postgres,
    private readonly authority: LearningAccountAuthority,
    private readonly options: EnterpriseLearningManagementOptions = {}
  ) {}

  private locked<T>(
    credential: string,
    conversationId: string | null,
    operation: (
      ports: Ports,
      db: PoolClient,
      scope: Scope,
      conversation: string,
      at: number
    ) => Promise<T>
  ): Promise<T> {
    return withLearningAccount(
      this.authority,
      credential,
      conversationId,
      async (db, scope, conversation, at) => {
        // Composed operations share this authorized transaction, never a second account lock.
        const bound: LearningAccountAuthority = {
          withLockedAccount: async (token, run) => {
            if (token !== credential) throw new AuthorityError('DENIED')
            return run(db, scope)
          }
        }
        return operation(
          {
            repository: new EnterpriseLearningRepository(bound, { now: () => at }),
            queue: new EnterpriseLearningQueue(this.database, bound, { now: () => at }),
            validation: new EnterpriseLearningValidationStore(bound, {
              now: () => at,
              validatorVersion:
                this.options.validatorVersion ?? 'enterprise-management-unconfigured'
            })
          },
          db,
          scope,
          conversation,
          at
        )
      },
      this.options.now
    )
  }
  async request(
    credential: string,
    operation: LearningManagementOperation,
    raw: unknown,
    signal: AbortSignal = new AbortController().signal
  ): Promise<unknown> {
    try {
      if (operation === 'validate' || operation === 'curate') {
        const input = LearningManagementRequests[operation].parse(raw)
        await withLearningAccount(
          this.authority,
          credential,
          input.conversationId,
          async () => {
            if (signal.aborted) throw new LearningManagementError(409, 'learning_cancelled')
          },
          this.options.now
        )
        // Model calls are outside the account transaction; the bridge reauthorizes commits.
        if (operation === 'validate') {
          const value = LearningManagementRequests.validate.parse(raw)
          if (!this.options.validate)
            throw new LearningManagementError(503, 'validation_unconfigured')
          return await this.options.validate(
            credential,
            value.conversationId,
            value.id,
            value.expectedRevision,
            signal
          )
        }
        const value = LearningManagementRequests.curate.parse(raw)
        if (!this.options.curate) throw new LearningManagementError(503, 'curation_unconfigured')
        return await this.options.curate(credential, value.conversationId, value.dryRun, signal)
      }
      const selected = LearningManagementRequests[operation].parse(raw)
      if (operation === 'correction' || operation === 'result' || operation === 'feedback') {
        return await this.locked(
          credential,
          null,
          async ({ repository, queue }, db, scope, _conversation, at) => {
            if (signal.aborted) throw new LearningManagementError(409, 'learning_cancelled')
            const input = LearningManagementRequests[operation].parse(raw)
            return recordEnterpriseTaskEventWithin(
              db,
              scope,
              at,
              credential,
              operation,
              input,
              repository,
              queue
            )
          }
        )
      }
      if (!('conversationId' in selected)) throw new LearningManagementError(400, 'invalid_request')
      const conversationId = selected.conversationId
      return await this.locked(
        credential,
        conversationId,
        async ({ repository, queue, validation }, db, scope, conversation, at) => {
          if (signal.aborted) throw new LearningManagementError(409, 'learning_cancelled')
          const keys = [scope.tenant_id, scope.account_id, conversation]
          switch (operation) {
            case 'episode':
              return repository.episode(
                credential,
                selected.conversationId,
                LearningManagementRequests.episode.parse(raw).episodeId
              )
            case 'model-directory':
              return LearningModelDirectorySchema.parse(this.options.modelDirectory?.() ?? [])
            case 'episode-correction':
            case 'episode-result':
            case 'episode-feedback': {
              const { episodeId, conversationId, ...input } =
                LearningManagementRequests[operation].parse(raw)
              const reference = await enterpriseEpisodeTaskReferenceWithin(
                db,
                scope,
                conversationId ?? '',
                episodeId
              )
              const kind =
                operation === 'episode-correction'
                  ? 'correction'
                  : operation === 'episode-result'
                    ? 'result'
                    : 'feedback'
              const checked = LearningManagementRequests[kind].parse({ ...input, reference })
              return recordEnterpriseTaskEventWithin(
                db,
                scope,
                at,
                credential,
                kind,
                checked,
                repository,
                queue
              )
            }
            case 'snapshot': {
              const records = await repository.list(credential, selected.conversationId)
              const episodes = await repository.episodes(credential, selected.conversationId)
              const jobs = await queue.list(credential, selected.conversationId)
              const feedback = (
                await db.query(
                  'SELECT payload FROM learning_feedback WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
                  keys
                )
              ).rows.map((row) => LearningFeedbackSchema.parse(row.payload))
              const scopes = (
                await db.query(
                  `SELECT DISTINCT conversation_id FROM (
              SELECT tenant_id,account_id,conversation_id FROM learning_memories UNION ALL
              SELECT tenant_id,account_id,conversation_id FROM learning_episodes UNION ALL
              SELECT tenant_id,account_id,conversation_id FROM learning_settings UNION ALL
              SELECT tenant_id,account_id,conversation_id FROM learning_jobs
            ) AS sources WHERE tenant_id=$1 AND account_id=$2 ORDER BY conversation_id LIMIT 500`,
                  keys.slice(0, 2)
                )
              ).rows
              const result: LearningWorkbenchSnapshot = {
                scope: enterpriseMemoryScope(scope, selected.conversationId),
                scopes: [
                  ...new Map(
                    [
                      null,
                      selected.conversationId,
                      ...scopes.map((row) => String(row.conversation_id) || null)
                    ].map((id) => [id, enterpriseMemoryScope(scope, id)])
                  ).values()
                ],
                settings: await repository.settings(credential, selected.conversationId),
                memories: records.map((record) => {
                  const metrics = Object.fromEntries(
                    LearningFeedbackSchema.shape.kind.options.map((kind) => [kind, 0])
                  ) as LearningMetrics
                  for (const event of feedback)
                    if (event.memoryRefs.some((ref) => ref.id === record.id)) metrics[event.kind]++
                  return { record, metrics }
                }),
                episodes: episodes.slice(0, 100),
                jobs: jobs.slice(0, 100),
                usage: await learningUsageWithin(db, scope, at),
                unassigned: [],
                publication: await readLearningPublicationStatus(db, scope)
              }
              return result
            }
            case 'detail': {
              const { id } = LearningManagementRequests.detail.parse(raw)
              return {
                memory: await repository.get(credential, selected.conversationId, id),
                history: await repository.history(credential, selected.conversationId, id)
              }
            }
            case 'settings': {
              const patch = LearningManagementRequests.settings.parse(raw).patch
              if (patch?.reviewModelId !== undefined)
                assertLearningReviewSelection(
                  patch.reviewModelId,
                  LearningModelDirectorySchema.parse(this.options.modelDirectory?.() ?? [])
                )
              return repository.settings(credential, selected.conversationId, patch)
            }
            case 'action': {
              const { command } = LearningManagementRequests.action.parse(raw)
              const action = LearningActionSchema.parse({
                ...command,
                scope: enterpriseMemoryScope(scope, selected.conversationId)
              })
              switch (action.action) {
                case 'propose':
                  return repository.propose(credential, selected.conversationId, {
                    content: action.content,
                    evidence: action.evidence,
                    reason: action.reason,
                    expiresAt: action.expiresAt,
                    source: 'manual'
                  })
                case 'revise':
                  return repository.revise(
                    credential,
                    selected.conversationId,
                    action.id,
                    action.expectedRevision,
                    {
                      content: action.content,
                      evidence: action.evidence,
                      reason: action.reason,
                      expiresAt: action.expiresAt,
                      source: 'human'
                    }
                  )
                case 'activate':
                  return repository.activate(
                    credential,
                    selected.conversationId,
                    action.id,
                    action.expectedRevision
                  )
                case 'rollback':
                  return repository.rollback(
                    credential,
                    selected.conversationId,
                    action.id,
                    action.expectedRevision,
                    action.targetRevision
                  )
                case 'pin':
                  await repository.setPinned(
                    credential,
                    selected.conversationId,
                    action.id,
                    action.expectedRevision,
                    action.pinned
                  )
                  break
                case 'archive':
                  await repository.archive(
                    credential,
                    selected.conversationId,
                    action.id,
                    action.expectedRevision,
                    'human'
                  )
                  break
                case 'restore':
                  return repository.restore(
                    credential,
                    selected.conversationId,
                    action.id,
                    action.expectedRevision
                  )
                case 'forget':
                  await repository.forget(
                    credential,
                    selected.conversationId,
                    action.id,
                    action.expectedRevision
                  )
                  return null
              }
              return repository.get(credential, selected.conversationId, action.id)
            }
            case 'manual': {
              const input = LearningManagementRequests.manual.parse(raw)
              const prior = (
                await db.query(
                  'SELECT payload FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND source_id=$4',
                  [...keys, input.sourceId]
                )
              ).rows[0]?.payload as LearningEpisode | undefined
              const episode = await repository.recordEpisode(credential, input.conversationId, {
                sourceId: input.sourceId,
                identityStatus: conversation ? 'verified' : 'account',
                topic: input.content.scenario,
                startedAt: prior?.startedAt ?? at,
                messages: [
                  { sourceId: input.sourceId, role: 'employee', text: input.content.guidance }
                ],
                outcome: 'corrected',
                correctionReason: input.reason
              })
              return repository.propose(credential, input.conversationId, {
                content: input.content,
                evidence: [{ episodeId: episode.id }],
                source: 'manual',
                reason: input.reason
              })
            }
            case 'review': {
              const input = LearningManagementRequests.review.parse(raw)
              const job = await queue.enqueue(
                credential,
                input.conversationId,
                input.episodeId,
                'manual',
                input.sourceId
              )
              return { jobId: job?.id ?? null }
            }
            case 'cancel': {
              const input = LearningManagementRequests.cancel.parse(raw)
              await queue.cancel(credential, input.conversationId, input.jobId)
              return { cancelled: true }
            }
            case 'forget-scope':
              await repository.forgetScope(credential, selected.conversationId)
              return { forgotten: true }
            case 'calibration': {
              const input = LearningManagementRequests.calibration.parse(raw)
              return input.input
                ? validation.importCalibration(credential, input.conversationId, input.input)
                : validation.calibration(credential, input.conversationId)
            }
            case 'reports': {
              const validation = (
                await db.query(
                  "SELECT payload FROM learning_validation_reports WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 ORDER BY (payload->>'createdAt')::bigint DESC,id DESC LIMIT 100",
                  keys
                )
              ).rows.map((row) => row.payload as LearningValidationReport)
              const curation = (
                await db.query(
                  'SELECT payload FROM learning_curation_reports WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 ORDER BY created_at DESC,id DESC LIMIT 100',
                  keys
                )
              ).rows.map((row) => row.payload as LearningCurationReport)
              return { validation, curation }
            }
            case 'search': {
              const input = LearningManagementRequests.search.parse(raw)
              const query = input.query.normalize('NFKC').toLocaleLowerCase('en-US')
              return (await repository.episodes(credential, input.conversationId))
                .filter((episode) =>
                  [
                    episode.topic,
                    episode.draft,
                    episode.correction,
                    episode.correctionReason,
                    ...episode.messages.map((message) => message.text)
                  ]
                    .filter(Boolean)
                    .join('\n')
                    .normalize('NFKC')
                    .toLocaleLowerCase('en-US')
                    .includes(query)
                )
                .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
                .slice(0, input.limit)
            }
          }
        }
      )
    } catch (error) {
      mapLearningManagementFailure(error)
    }
  }
}
