import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { Scope } from '../auth/account-authority'
import { Id, Hash } from '../../../src/shared/contracts/identity'
import {
  LearningSettingsSchema,
  MemoryContentSchema,
  MemoryEvidenceSchema,
  type MemoryRevision
} from '../../../src/shared/contracts/learning-memory'
import { learningHash } from '../../../src/core/memory/learning-scope'

export { EMPTY_ENTERPRISE_MEMORY_VERSION } from '../../../src/shared/contracts/learning-task'
import { EMPTY_ENTERPRISE_MEMORY_VERSION } from '../../../src/shared/contracts/learning-task'
export const PublishedMemoryRefSchema = z.strictObject({
  id: Id,
  revision: z.number().int().positive(),
  contentHash: Hash
})
export const PublishedMemoryManifestSchema = z
  .array(PublishedMemoryRefSchema)
  .max(10000)
  .refine(
    (refs) => new Set(refs.map((ref) => ref.id)).size === refs.length,
    'duplicate_published_method'
  )
export interface EnterpriseMemoryCatalog {
  memoryCorpusVersion: string
  memoryManifest: z.infer<typeof PublishedMemoryManifestSchema>
}
/** Publication versions describe usable methods, not unconfirmed draft/usage counters. */
export async function loadEnterpriseMemoryCatalog(
  db: PoolClient,
  scope: Pick<Scope, 'tenant_id' | 'account_id'>
): Promise<EnterpriseMemoryCatalog> {
  await db.query("SELECT set_config('app.learning_account_id',$1,true)", [scope.account_id])
  const settingsRows = (
    await db.query(
      'SELECT conversation_id,payload FROM learning_settings WHERE tenant_id=$1 AND account_id=$2',
      [scope.tenant_id, scope.account_id]
    )
  ).rows
  const parent = LearningSettingsSchema.parse(
    settingsRows.find((row) => row.conversation_id === '')?.payload ?? {}
  )
  const rows = (
    await db.query(
      `SELECT m.id,m.conversation_id,m.active_revision,r.content_hash,r.payload,q.at AS quarantine_at
    FROM learning_memories m JOIN learning_revisions r ON (r.tenant_id,r.account_id,r.memory_id,r.revision)=(m.tenant_id,m.account_id,m.id,m.active_revision)
    LEFT JOIN learning_quarantines q ON (q.tenant_id,q.account_id,q.memory_id,q.revision)=(m.tenant_id,m.account_id,m.id,m.active_revision)
    WHERE m.tenant_id=$1 AND m.account_id=$2 AND m.state='active' ORDER BY m.id`,
      [scope.tenant_id, scope.account_id]
    )
  ).rows
  const at = Number(
    (await db.query('SELECT floor(extract(epoch from clock_timestamp())*1000)::text AS now'))
      .rows[0].now
  )
  const methods: {
    ref: z.infer<typeof PublishedMemoryRefSchema>
    conversationId: string
    expiresAt?: number
    settingsHash: string
    evidenceHash: string
  }[] = []
  for (const row of rows) {
    const settings = LearningSettingsSchema.parse({
      ...parent,
      ...(settingsRows.find((entry) => entry.conversation_id === row.conversation_id)?.payload ??
        {})
    })
    if (!parent.memoryEnabled || !settings.memoryEnabled || row.quarantine_at !== null) continue
    const revision = row.payload as MemoryRevision,
      content = MemoryContentSchema.parse(revision.content)
    if (revision.expiresAt !== undefined && revision.expiresAt <= at) continue
    if (learningHash(content) !== row.content_hash)
      throw new Error('published_memory_content_invalid')
    const evidence = z.array(MemoryEvidenceSchema).min(1).max(100).parse(revision.evidence)
    const ids = [...new Set(evidence.map((ref) => ref.episodeId))]
    const sources = (
      await db.query(
        'SELECT id,input_hash FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=ANY($4::uuid[]) AND created_at>$5 ORDER BY id',
        [
          scope.tenant_id,
          scope.account_id,
          row.conversation_id,
          ids,
          at - settings.caseRetentionDays * 86400000
        ]
      )
    ).rows
    if (sources.length !== ids.length) continue
    methods.push({
      ref: PublishedMemoryRefSchema.parse({
        id: row.id,
        revision: Number(row.active_revision),
        contentHash: row.content_hash
      }),
      conversationId: row.conversation_id,
      expiresAt: revision.expiresAt,
      settingsHash: learningHash({
        maxEntries: settings.maxEntries,
        maxContextTokens: settings.maxContextTokens,
        caseRetentionDays: settings.caseRetentionDays
      }),
      evidenceHash: learningHash(sources)
    })
  }
  return {
    memoryCorpusVersion: methods.length
      ? learningHash({ format: 'enterprise-method-catalog-v1', methods })
      : EMPTY_ENTERPRISE_MEMORY_VERSION,
    memoryManifest: methods.map((method) => method.ref)
  }
}
