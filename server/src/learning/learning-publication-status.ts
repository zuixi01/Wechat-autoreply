import type { PoolClient } from 'pg'
import type { Scope } from '../auth/account-authority'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  LearningPublicationStatusSchema,
  type LearningPublicationStatus
} from '../../../src/shared/contracts/learning-publication-status'
import { loadEnterpriseMemoryCatalog, PublishedMemoryManifestSchema } from './learning-publication'

/** Caller holds the authenticated account lock. Status is metadata, never send admission. */
export async function readLearningPublicationStatus(
  db: PoolClient,
  scope: Pick<Scope, 'tenant_id' | 'account_id'>
): Promise<LearningPublicationStatus> {
  const catalog = await loadEnterpriseMemoryCatalog(db, scope)
  const row = (
    await db.query(
      `SELECT a.paused,c.config_version,c.automatic_enabled,c.memory_corpus_version AS configured_corpus,
      p.memory_corpus_version AS published_corpus,p.memory_manifest_json
    FROM accounts a LEFT JOIN published_configurations c ON (c.tenant_id,c.account_id)=(a.tenant_id,a.id)
    LEFT JOIN generation_publications p ON (p.tenant_id,p.account_id,p.config_version)=(c.tenant_id,c.account_id,c.config_version)
    WHERE a.tenant_id=$1 AND a.id=$2`,
      [scope.tenant_id, scope.account_id]
    )
  ).rows[0]
  if (!row) throw new Error('learning_scope_unavailable')
  let state: LearningPublicationStatus['state'] = row.config_version ? 'unavailable' : 'unpublished'
  let published: LearningPublicationStatus['published'] = null
  if (
    row.config_version &&
    row.published_corpus &&
    row.configured_corpus === row.published_corpus
  ) {
    const manifest = PublishedMemoryManifestSchema.parse(row.memory_manifest_json)
    // A matching version with inconsistent immutable references is unavailable, not current.
    const versionMatches = row.published_corpus === catalog.memoryCorpusVersion
    if (!versionMatches || hashContext(manifest) === hashContext(catalog.memoryManifest)) {
      state = versionMatches ? 'current' : 'outdated'
      published = {
        configVersion: row.config_version,
        memoryCorpusVersion: row.published_corpus,
        methodCount: manifest.length,
        automaticEnabled: row.automatic_enabled
      }
    }
  }
  return LearningPublicationStatusSchema.parse({
    tenantId: scope.tenant_id,
    accountId: scope.account_id,
    state,
    currentMemoryCorpusVersion: catalog.memoryCorpusVersion,
    currentMethodCount: catalog.memoryManifest.length,
    serverPaused: row.paused,
    published
  })
}
