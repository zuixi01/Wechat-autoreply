import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { hashContext } from '../../../src/core/reply/hashes'

const Request = z.strictObject({
  restoreId: z.uuid(),
  backupId: z.uuid(),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  archiveBytes: z.number().int().positive().safe(),
  databaseName: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)
})
const Count = z.number().int().nonnegative().safe()
const Receipt = Request.extend({
  formatVersion: z.literal(1),
  sequence: z.number().int().positive().max(10000),
  recordedAt: z.iso.datetime(),
  previousRestoreId: z.uuid().nullable(),
  previousContextHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  counts: z.strictObject({
    accounts: Count,
    unrevokedAgents: Count,
    liveLeases: Count,
    unusedEnrollmentCodes: Count,
    unresolvedPermits: Count
  }),
  canRelease: z.literal(false),
  automaticStart: z.literal(false),
  requiresHistoryReview: z.literal(true),
  contextHash: z.string().regex(/^[a-f0-9]{64}$/)
})
export type CentralRestoreReceipt = z.infer<typeof Receipt>
function validHistory(rows: Record<string, unknown>[]): CentralRestoreReceipt[] {
  try {
    if (rows.length > 10000) throw new Error('too_many')
    const receipts: CentralRestoreReceipt[] = []
    for (const [index, row] of rows.entries()) {
      const receipt = Receipt.parse(row.receipt_json),
        { contextHash, ...descriptor } = receipt
      const previous = receipts.at(-1)
      if (
        receipt.sequence !== index + 1 ||
        hashContext(descriptor) !== contextHash ||
        receipt.previousRestoreId !== (previous?.restoreId ?? null) ||
        receipt.previousContextHash !== (previous?.contextHash ?? null) ||
        Number(row.sequence) !== receipt.sequence ||
        row.restore_id !== receipt.restoreId ||
        row.backup_id !== receipt.backupId ||
        row.archive_sha256 !== receipt.archiveSha256 ||
        Number(row.archive_bytes) !== receipt.archiveBytes ||
        row.database_name !== receipt.databaseName ||
        row.previous_restore_id !== receipt.previousRestoreId ||
        row.previous_context_hash !== receipt.previousContextHash ||
        row.context_hash !== contextHash ||
        (row.recorded_at instanceof Date
          ? row.recorded_at
          : new Date(String(row.recorded_at))
        ).toISOString() !== receipt.recordedAt
      )
        throw new Error('binding')
      receipts.push(receipt)
    }
    return receipts
  } catch {
    throw new Error('central_restore_history_invalid')
  }
}

/** Maintenance-only transaction, no ordinary API/renderer authority. Never settles an old send. */
export async function applyCentralRestoreQuarantine(
  client: PoolClient,
  input: unknown
): Promise<CentralRestoreReceipt> {
  const request = Request.safeParse(structuredClone(input))
  if (!request.success) throw new Error('central_restore_request_invalid')
  const authority = await client.query(`SELECT current_database() AS database,
    EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) AS privileged`)
  if (!authority.rows[0]?.privileged) throw new Error('central_restore_denied')
  if (authority.rows[0].database !== request.data.databaseName)
    throw new Error('central_restore_database_mismatch')
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
  try {
    await client.query('SET LOCAL search_path=autoreply,pg_catalog')
    await client.query("SET LOCAL lock_timeout='2500ms'")
    await client.query("SET LOCAL statement_timeout='5000ms'")
    await client.query('LOCK TABLE database_restore_quarantines IN EXCLUSIVE MODE')
    const stored = await client.query(
      `SELECT sequence,restore_id,backup_id,archive_sha256,archive_bytes,database_name,previous_restore_id,previous_context_hash,context_hash,recorded_at,
        CASE WHEN octet_length(receipt_json::text)<=16384 THEN receipt_json ELSE NULL END AS receipt_json
        FROM database_restore_quarantines ORDER BY sequence LIMIT 10001`
    )
    const history = validHistory(stored.rows),
      existing = history.find((r) => r.restoreId === request.data.restoreId)
    if (existing) {
      const binding = {
        restoreId: existing.restoreId,
        backupId: existing.backupId,
        archiveSha256: existing.archiveSha256,
        archiveBytes: existing.archiveBytes,
        databaseName: existing.databaseName
      }
      if (hashContext(binding) !== hashContext(request.data))
        throw new Error('central_restore_context_conflict')
      // An old commit can be acknowledged historically; it never relaxes any gate.
      await client.query('COMMIT')
      return existing
    }
    if (history.length >= 10000) throw new Error('central_restore_history_invalid')
    await client.query(
      'LOCK TABLE accounts,agents,account_leases,enrollment_codes,execution_permits,learning_background_leases IN SHARE ROW EXCLUSIVE MODE'
    )
    const counts = (
      await client.query(`SELECT
      (SELECT count(*)::text FROM accounts) AS accounts,
      (SELECT count(*)::text FROM agents WHERE revoked_at IS NULL) AS "unrevokedAgents",
      (SELECT count(*)::text FROM account_leases WHERE expires_at>clock_timestamp()) AS "liveLeases",
      (SELECT count(*)::text FROM enrollment_codes WHERE used_at IS NULL AND expires_at>clock_timestamp()) AS "unusedEnrollmentCodes",
      (SELECT count(*)::text FROM execution_permits WHERE status IN ('issued','unknown')) AS "unresolvedPermits"`)
    ).rows[0]
    const previous = history.at(-1)
    const descriptor = {
      ...request.data,
      formatVersion: 1 as const,
      sequence: history.length + 1,
      recordedAt: new Date().toISOString(),
      previousRestoreId: previous?.restoreId ?? null,
      previousContextHash: previous?.contextHash ?? null,
      counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])),
      canRelease: false as const,
      automaticStart: false as const,
      requiresHistoryReview: true as const
    }
    const receipt = Receipt.parse({ ...descriptor, contextHash: hashContext(descriptor) })
    await client.query(
      `INSERT INTO database_restore_quarantines(sequence,restore_id,backup_id,archive_sha256,archive_bytes,database_name,previous_restore_id,previous_context_hash,context_hash,receipt_json,recorded_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        receipt.sequence,
        receipt.restoreId,
        receipt.backupId,
        receipt.archiveSha256,
        receipt.archiveBytes,
        receipt.databaseName,
        receipt.previousRestoreId,
        receipt.previousContextHash,
        receipt.contextHash,
        JSON.stringify(receipt),
        receipt.recordedAt
      ]
    )
    await client.query('UPDATE accounts SET paused=true WHERE NOT paused')
    await client.query('UPDATE agents SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL')
    await client.query(
      'UPDATE account_leases SET expires_at=clock_timestamp() WHERE expires_at>clock_timestamp()'
    )
    await client.query(
      'UPDATE learning_background_leases SET lease_until=floor(extract(epoch FROM clock_timestamp())*1000) WHERE lease_until>floor(extract(epoch FROM clock_timestamp())*1000)'
    )
    await client.query(
      'UPDATE enrollment_codes SET expires_at=clock_timestamp() WHERE used_at IS NULL AND expires_at>clock_timestamp()'
    )
    const tenants = await client.query('SELECT id FROM tenants ORDER BY id')
    for (const tenant of tenants.rows)
      await client.query(
        `INSERT INTO audit_events(tenant_id,id,actor_id,kind,details_json) VALUES($1,$2,'maintenance-recovery','central_database_restored',$3)`,
        [
          tenant.id,
          randomUUID(),
          JSON.stringify({
            restoreId: receipt.restoreId,
            contextHash: receipt.contextHash,
            canRelease: false
          })
        ]
      )
    await client.query('COMMIT')
    return receipt
  } catch (error) {
    await client.query('ROLLBACK')
    if (
      error instanceof Error &&
      ['central_restore_history_invalid', 'central_restore_context_conflict'].includes(
        error.message
      )
    )
      throw error
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      /^[A-Z0-9]{5}$/.test(String(error.code))
        ? String(error.code)
        : 'validation_failed'
    throw new Error('central_restore_quarantine_failed', { cause: new Error(code) })
  }
}
