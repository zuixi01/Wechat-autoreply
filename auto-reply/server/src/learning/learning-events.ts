import type { PoolClient } from 'pg'
import { AuthorityError, type Scope } from '../auth/account-authority'
import {
  GenerationResultSchema,
  type GenerationInput,
  type GenerationResult
} from '../../../src/shared/contracts/generation'
import { hashContext, hashDraft } from '../../../src/core/reply/hashes'
import { learningHash } from '../../../src/core/memory/learning-scope'
import type {
  LearningEpisode,
  LearningFeedback,
  LearningTrigger
} from '../../../src/shared/contracts/learning-memory'
import type {
  LearningTaskCorrection,
  LearningTaskFeedback,
  LearningTaskResult
} from '../../../src/shared/contracts/learning-events'
import { EnterpriseLearningRepository } from './learning-repository'
import type { EnterpriseLearningQueue } from './learning-queue'
import { effectiveLearningSettings, type LearningAccountAuthority } from './learning-account'
import {
  enterpriseDraftSource,
  type EnterpriseGenerationContext
} from './learning-generation-context'
import { LearningManagementError } from './learning-routes'
import type { LearningTaskReference } from '../../../src/shared/contracts/learning-events'

/** Resolve only an exact immutable generation source; selected text and clocks are not evidence. */
export async function enterpriseEpisodeTaskReferenceWithin(
  db: PoolClient,
  scope: Scope,
  conversation: string,
  episodeId: string
): Promise<LearningTaskReference> {
  const keys = [scope.tenant_id, scope.account_id, conversation, episodeId]
  const sources = (
    await db.query(
      `SELECT DISTINCT g.generation_id FROM learning_episodes e
    LEFT JOIN learning_task_events v ON v.tenant_id=e.tenant_id AND v.account_id=e.account_id AND v.episode_id=e.id
    LEFT JOIN learning_episode_closures c ON c.tenant_id=e.tenant_id AND c.account_id=e.account_id AND c.episode_id=e.id
    JOIN learning_generations g ON g.tenant_id=e.tenant_id AND g.account_id=e.account_id AND g.conversation_id=e.conversation_id
      AND g.episode_id=COALESCE(v.source_episode_id,c.source_episode_id,e.id)
    WHERE e.tenant_id=$1 AND e.account_id=$2 AND e.conversation_id=$3 AND e.id=$4`,
      keys
    )
  ).rows
  if (sources.length !== 1) throw new LearningManagementError(404, 'learning_evidence_unavailable')
  const rows = (
    await db.query(
      `SELECT result_json FROM generation_tasks
    WHERE tenant_id=$1 AND account_id=$2 AND status='completed' AND task_json->>'conversationId'=$3
      AND task_json->'identity'->>'employeeId'=$4
      AND 'generation:' || encode(sha256(convert_to('{"agentId":' || to_json(agent_id)::text || ',"taskId":' || to_json(task_id)::text || '}', 'UTF8')), 'hex')=$5`,
      [scope.tenant_id, scope.account_id, conversation, scope.employee_id, sources[0].generation_id]
    )
  ).rows
  if (rows.length !== 1) throw new LearningManagementError(404, 'learning_task_not_found')
  const { task, draft } = GenerationResultSchema.parse(rows[0].result_json)
  if (!draft || enterpriseDraftSource(task) !== sources[0].generation_id)
    throw new LearningManagementError(404, 'learning_evidence_unavailable')
  return {
    taskId: task.taskId,
    contextHash: task.contextHash,
    draftHash: draft.draftHash,
    draftRevision: draft.draftRevision
  }
}

function boundAuthority(
  db: PoolClient,
  scope: Scope,
  credential: string
): LearningAccountAuthority {
  return {
    withLockedAccount: async (token, run) => {
      if (token !== credential) throw new AuthorityError('DENIED')
      return run(db, scope)
    }
  }
}

/** Host-only capture, composed with generation completion under its existing account lock. */
export async function recordEnterpriseGenerationWithin(
  db: PoolClient,
  scope: Scope,
  input: GenerationInput,
  result: GenerationResult,
  context: EnterpriseGenerationContext
): Promise<void> {
  const at = Number(
    (await db.query('SELECT floor(extract(epoch from clock_timestamp())*1000)::text AS now'))
      .rows[0].now
  )
  const credential = 'host-generation-capture',
    repository = new EnterpriseLearningRepository(boundAuthority(db, scope, credential), {
      now: () => at
    })
  const episode = await repository.recordEpisode(credential, result.task.conversationId, {
    sourceId: enterpriseDraftSource(result.task),
    identityStatus: 'verified',
    topic: input.inbound.join('\n').slice(0, 240),
    startedAt: Math.min(result.task.createdAt, at),
    messages: input.context
      .filter(
        (message) =>
          message.direction === 'inbound' &&
          message.sequence >= result.task.inboundRange.from &&
          message.sequence <= result.task.inboundRange.to
      )
      .map((message) => ({
        sourceId: message.sourceMessageId,
        role: 'customer' as const,
        text: message.text!
      })),
    ...(result.draft ? { draft: result.draft.text } : {}),
    outcome: 'unknown'
  })
  await repository.registerGeneration(
    credential,
    result.task.conversationId,
    enterpriseDraftSource(result.task),
    episode.id,
    context.methodRefs.map((ref) => ({ id: ref.id, revision: ref.revision }))
  )
}

/** Task evidence comes from the saved production result, never from client identity or memory refs. */
export async function recordEnterpriseTaskEventWithin(
  db: PoolClient,
  scope: Scope,
  at: number,
  credential: string,
  kind: 'correction' | 'result' | 'feedback',
  input: LearningTaskCorrection | LearningTaskResult | LearningTaskFeedback,
  repository: EnterpriseLearningRepository<LearningAccountAuthority>,
  queue: EnterpriseLearningQueue
): Promise<LearningEpisode | null> {
  const row = (
    await db.query(
      "SELECT task_json,result_json,agent_id FROM generation_tasks WHERE tenant_id=$1 AND account_id=$2 AND task_id=$3 AND status='completed'",
      [scope.tenant_id, scope.account_id, input.reference.taskId]
    )
  ).rows[0]
  if (!row) throw new LearningManagementError(404, 'learning_task_not_found')
  const result = GenerationResultSchema.parse(row.result_json),
    task = result.task,
    draft = result.draft
  if (
    task.identity.tenantId !== scope.tenant_id ||
    task.identity.accountId !== scope.account_id ||
    task.identity.employeeId !== scope.employee_id ||
    task.identity.platform !== scope.platform ||
    task.identity.agentId !== row.agent_id ||
    hashContext(task) !== hashContext(row.task_json)
  )
    throw new LearningManagementError(404, 'learning_task_not_found')
  if (
    !draft ||
    task.contextHash !== input.reference.contextHash ||
    draft.draftHash !== input.reference.draftHash ||
    draft.draftRevision !== input.reference.draftRevision ||
    hashDraft(draft.text) !== draft.draftHash
  )
    throw new LearningManagementError(409, 'learning_task_changed')
  const conversation = task.conversationId,
    keys = [scope.tenant_id, scope.account_id, conversation],
    generationId = enterpriseDraftSource(task)
  const generation = (
    await db.query(
      'SELECT g.*,e.payload AS episode FROM learning_generations g JOIN learning_episodes e ON e.tenant_id=g.tenant_id AND e.account_id=g.account_id AND e.id=g.episode_id WHERE g.tenant_id=$1 AND g.account_id=$2 AND g.conversation_id=$3 AND g.generation_id=$4',
      [...keys, generationId]
    )
  ).rows[0]
  if (!generation) throw new LearningManagementError(404, 'learning_evidence_unavailable')
  const original = generation.episode as LearningEpisode,
    settings = await effectiveLearningSettings(db, scope, conversation)
  if (original.createdAt <= at - settings.caseRetentionDays * 86400000)
    throw new LearningManagementError(404, 'learning_evidence_unavailable')
  const hash = learningHash({ kind, input }),
    prior = (
      await db.query(
        'SELECT * FROM learning_task_events WHERE tenant_id=$1 AND account_id=$2 AND source_id=$3',
        [scope.tenant_id, scope.account_id, input.sourceId]
      )
    ).rows[0]
  if (prior) {
    if (prior.input_hash !== hash) throw new LearningManagementError(409, 'learning_event_conflict')
    if (kind === 'feedback') return null
    return (
      await db.query(
        'SELECT payload FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND id=$3',
        [scope.tenant_id, scope.account_id, prior.episode_id]
      )
    ).rows[0].payload as LearningEpisode
  }
  const refs = generation.refs_json as LearningFeedback['memoryRefs']
  let episode = original,
    trigger: LearningTrigger | undefined
  if (kind === 'feedback') {
    const value = input as LearningTaskFeedback
    const feedback = {
      sourceId: value.sourceId,
      kind: value.kind,
      reason: value.reason,
      ...(value.memoryId ? { memoryId: value.memoryId } : {})
    }
    await repository.feedback(credential, conversation, generationId, feedback)
    if (feedback.kind === 'fact_error' || feedback.kind === 'improper_commitment')
      trigger = 'severe_error'
    if (feedback.kind === 'repeated_question') {
      const failures = Number(
        (
          await db.query(
            "SELECT count(*)::text AS n FROM learning_feedback WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND episode_id=$4 AND payload->>'kind'='repeated_question'",
            [...keys, original.id]
          )
        ).rows[0].n
      )
      if (failures >= 2) trigger = 'repeated_failure'
    }
  } else {
    // Derived evidence shares the original retention baseline; feedback cannot renew old private text.
    const evidence = new EnterpriseLearningRepository(boundAuthority(db, scope, credential), {
      now: () => original.createdAt
    })
    let correction: Pick<LearningTaskCorrection, 'text' | 'reason'> | undefined =
      kind === 'correction' ? (input as LearningTaskCorrection) : undefined
    if (kind === 'result') {
      const latest = (
        await db.query(
          "SELECT e.payload FROM learning_task_events v JOIN learning_episodes e ON e.tenant_id=v.tenant_id AND e.account_id=v.account_id AND e.id=v.episode_id WHERE v.tenant_id=$1 AND v.account_id=$2 AND v.conversation_id=$3 AND v.source_episode_id=$4 AND v.kind='correction' ORDER BY v.event_sequence DESC LIMIT 1",
          [...keys, original.id]
        )
      ).rows[0]?.payload as LearningEpisode | undefined
      if (latest?.correction && latest.correctionReason)
        correction = { text: latest.correction, reason: latest.correctionReason }
    }
    const outcome = kind === 'result' ? (input as LearningTaskResult).outcome : 'corrected'
    episode = await evidence.recordEpisode(credential, conversation, {
      sourceId: `task-event:${hash}`,
      identityStatus: original.identityStatus,
      topic: original.topic,
      startedAt: original.startedAt,
      endedAt: at,
      messages: original.messages,
      draft: draft.text,
      ...(correction ? { correction: correction.text, correctionReason: correction.reason } : {}),
      outcome
    })
    const event: LearningFeedback = {
      sourceId: input.sourceId,
      episodeId: episode.id,
      kind: kind === 'correction' ? 'substantially_corrected' : 'outcome_confirmed',
      memoryRefs: refs,
      reason: input.reason,
      at
    }
    const existing = (
      await db.query(
        'SELECT 1 FROM learning_feedback WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND source_id=$4',
        [...keys, event.sourceId]
      )
    ).rows[0]
    if (existing) throw new LearningManagementError(409, 'learning_event_conflict')
    await db.query('INSERT INTO learning_feedback VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [
      ...keys,
      event.sourceId,
      learningHash({ ...event, at: undefined }),
      episode.id,
      JSON.stringify(event)
    ])
    trigger = kind === 'correction' ? 'correction' : 'completed'
  }
  if (trigger) await queue.enqueue(credential, conversation, episode.id, trigger, input.sourceId)
  await db.query(
    'INSERT INTO learning_task_events(tenant_id,account_id,conversation_id,source_id,input_hash,kind,source_episode_id,episode_id,employee_id,at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [...keys, input.sourceId, hash, kind, original.id, episode.id, scope.employee_id, at]
  )
  return kind === 'feedback' ? null : episode
}
