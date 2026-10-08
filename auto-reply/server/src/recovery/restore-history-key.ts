import { createHash, createPublicKey } from 'node:crypto'
import type { PoolClient } from 'pg'

/** Labels and PEM whitespace cannot give a revoked Ed25519 key another identity. */
export function restoreHistoryKeySha256(pem: string): string {
  const key = createPublicKey(pem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('restore_history_key_invalid')
  return createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex')
}
/** Held through commit: all accepted-history and maintenance paths share this
 * actual-key lock. A hash collision only serializes unrelated keys. */
export async function lockRestoreHistoryKey(db: PoolClient, sha256: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('restore_history_key_invalid')
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `autoreply.restore-history-key.v1:${sha256}`
  ])
}
