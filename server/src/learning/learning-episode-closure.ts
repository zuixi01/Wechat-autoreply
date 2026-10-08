import type { PoolClient } from 'pg'
import type { Scope } from '../auth/account-authority'
import { LearningEpisodeSchema } from '../../../src/shared/contracts/learning-memory'
import { learningHash } from '../../../src/core/memory/learning-scope'
import { effectiveLearningSettings, type LearningAccountAuthority } from './learning-account'
import { EnterpriseLearningRepository } from './learning-repository'

export interface EnterpriseEpisodeClosure {
  conversationId: string | null
  sourceEpisodeId: string
  episodeId: string
}
const IDLE_CLOSE_MS = 30 * 60 * 1000

/** Registered fragments remain independent unless the host supplies a trusted problem binding. */
export async function closeIdleEnterpriseEpisodesWithin(
  db: PoolClient,
  scope: Scope,
  conversation: string,
  at: number,
  signal: AbortSignal
): Promise<EnterpriseEpisodeClosure[]> {
  const cancelled = (): void => {
    if (signal.aborted) throw new Error('curation_cancelled')
  }
  cancelled()
  const settings = await effectiveLearningSettings(db, scope, conversation)
  const rows = (
    await db.query(
      `SELECT e.payload,GREATEST(e.created_at,COALESCE((SELECT max(v.at) FROM learning_task_events v
      WHERE v.tenant_id=e.tenant_id AND v.account_id=e.account_id AND v.source_episode_id=e.id),e.created_at)) AS last_activity_at
    FROM learning_episodes e WHERE e.tenant_id=$1 AND e.account_id=$2 AND e.conversation_id=$3
      AND e.created_at>$4 AND e.payload->>'outcome'='unknown' AND NOT(e.payload ? 'endedAt')
      AND EXISTS(SELECT 1 FROM learning_generations g WHERE g.tenant_id=e.tenant_id AND g.account_id=e.account_id AND g.conversation_id=e.conversation_id AND g.episode_id=e.id)
      AND NOT EXISTS(SELECT 1 FROM learning_episode_closures c WHERE c.tenant_id=e.tenant_id AND c.account_id=e.account_id AND c.source_episode_id=e.id)
      AND NOT EXISTS(SELECT 1 FROM learning_task_events v WHERE v.tenant_id=e.tenant_id AND v.account_id=e.account_id AND v.source_episode_id=e.id AND v.kind IN ('correction','result'))
      AND GREATEST(e.created_at,COALESCE((SELECT max(v.at) FROM learning_task_events v WHERE v.tenant_id=e.tenant_id AND v.account_id=e.account_id AND v.source_episode_id=e.id),e.created_at))<=$5
    ORDER BY e.created_at,e.id LIMIT 100`,
      [
        scope.tenant_id,
        scope.account_id,
        conversation,
        at - settings.caseRetentionDays * 86400000,
        at - IDLE_CLOSE_MS
      ]
    )
  ).rows
  const result: EnterpriseEpisodeClosure[] = []
  for (const row of rows) {
    cancelled()
    const original = LearningEpisodeSchema.parse(row.payload)
    // Compose on the authenticated maintenance transaction, keeping the source retention baseline.
    const reference = 'host-idle-closure'
    const repository = new EnterpriseLearningRepository<LearningAccountAuthority>(
      {
        withLockedAccount: async (credential, run) => {
          if (credential !== reference) throw new Error('learning_closure_denied')
          return run(db, scope)
        }
      },
      { now: () => original.createdAt }
    )
    const episode = await repository.recordEpisode(reference, conversation || null, {
      sourceId: `idle-closure:${learningHash(original.id)}`,
      identityStatus: original.identityStatus,
      topic: original.topic,
      startedAt: original.startedAt,
      endedAt: at,
      messages: original.messages,
      ...(original.draft === undefined ? {} : { draft: original.draft }),
      outcome: 'unknown'
    })
    cancelled()
    await db.query('INSERT INTO learning_episode_closures VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [
      scope.tenant_id,
      scope.account_id,
      conversation,
      original.id,
      episode.id,
      Number(row.last_activity_at),
      at,
      'idle_unknown'
    ])
    cancelled()
    result.push({
      conversationId: conversation || null,
      sourceEpisodeId: original.id,
      episodeId: episode.id
    })
  }
  return result
}
