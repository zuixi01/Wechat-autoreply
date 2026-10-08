import { lockRestoreHistoryKey, restoreHistoryKeySha256 } from './restore-history-key'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { Id, Hash } from '../../../src/shared/contracts/identity'
import { hashContext } from '../../../src/core/reply/hashes'
import type { Postgres } from '../database/postgres'
import { RestoreHistoryRequirementRecordSchema } from '../admin/restore-history'
import { readRestoreReview } from '../admin/restore-review'
import { readCompleteRestoreInventory } from '../admin/restore-inventory'
import { readCompleteRestoreAssessment } from '../admin/restore-assessment'
import {
  RestoreHistorySourceTrustSchema,
  RestoreHistoryProofVerifier
} from './restore-history-proof'

const Millis = z.number().int().nonnegative().safe()
const Review = z.strictObject({
  reviewerId: Id,
  evidenceSha256: Hash,
  reviewedAt: Millis,
  backupStartVerified: z.literal(true),
  allDevicesStoppedVerified: z.literal(true),
  physicalSourceHistoryVerified: z.literal(true)
})
export const RestoreHistoryRegistrationSchema = z.strictObject({
  registrationId: z.uuid().toLowerCase(),
  tenantId: Id,
  accountId: Id,
  caseId: z.uuid().toLowerCase(),
  uploadId: z.uuid().toLowerCase(),
  expectedContextHash: Hash,
  expectedInventoryBasisHash: Hash,
  expectedAssessmentBasisHash: Hash,
  expectedScopeHash: Hash,
  platformAccountIdHash: Hash,
  backupStartedAt: Millis,
  backupStartVerificationSha256: Hash,
  allDevicesStoppedAt: Millis,
  deviceStopVerificationSha256: Hash,
  sourceTrust: RestoreHistorySourceTrustSchema,
  review: Review
})
export const RestoreHistoryKeyRevocationSchema = z.strictObject({
  registrationId: z.uuid().toLowerCase(),
  publicKeyPem: z.string().min(1).max(4096),
  reasonSha256: Hash,
  reviewerId: Id,
  reviewedAt: Millis
})
const Receipt = z.strictObject({
  formatVersion: z.literal(1),
  registrationId: z.uuid().toLowerCase(),
  kind: z.enum(['requirement', 'key_revocation']),
  tenantId: Id.nullable(),
  accountId: Id.nullable(),
  subjectHash: Hash,
  requestHash: Hash,
  recordedBy: Id,
  recordedAt: Millis,
  factVerificationPerformedByThisCommand: z.literal(false),
  automaticStart: z.literal(false),
  canRelease: z.literal(false)
})
export type RestoreHistoryMaintenanceReceipt = z.infer<typeof Receipt>
export class RestoreHistoryMaintenanceError extends Error {
  constructor(
    readonly code: 'maintenance_denied' | 'maintenance_conflict' | 'maintenance_not_ready'
  ) {
    super(code)
  }
}
function fail(code: RestoreHistoryMaintenanceError['code']): never {
  throw new RestoreHistoryMaintenanceError(code)
}
function keyHash(pem: string): string {
  try {
    return restoreHistoryKeySha256(pem)
  } catch {
    fail('maintenance_conflict')
  }
}
export async function authenticateRestoreMaintenance(db: PoolClient): Promise<string> {
  const row = (
    await db.query(`SELECT session_user AS login,current_user AS current,
   EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper AND rolcanlogin) AS privileged`)
  ).rows[0]
  if (!row?.privileged || row.login !== row.current) fail('maintenance_denied')
  return Id.parse(row.login)
}
async function now(db: PoolClient): Promise<number> {
  return Millis.parse(
    Number(
      (await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'))
        .rows[0].now
    )
  )
}
function bounded(raw: unknown): void {
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 16384) fail('maintenance_conflict')
}
async function previous(
  db: PoolClient,
  id: string,
  request: unknown,
  login: string
): Promise<RestoreHistoryMaintenanceReceipt | null> {
  const row = (
    await db.query(
      `SELECT *,CASE WHEN octet_length(receipt_json::text)<=16384 THEN receipt_json ELSE NULL END AS receipt_json
   FROM restore_history_maintenance_records WHERE id=$1`,
      [id]
    )
  ).rows[0]
  if (!row) return null
  const receipt = Receipt.parse(row.receipt_json)
  if (
    row.request_hash !== hashContext(request) ||
    hashContext(row.request_json) !== row.request_hash ||
    row.receipt_hash !== hashContext(receipt) ||
    receipt.requestHash !== row.request_hash ||
    receipt.registrationId !== row.id ||
    receipt.kind !== row.kind ||
    receipt.tenantId !== row.tenant_id ||
    receipt.accountId !== row.account_id ||
    receipt.recordedBy !== row.recorded_by ||
    receipt.recordedAt !== new Date(row.recorded_at).getTime() ||
    receipt.recordedBy !== login
  )
    fail('maintenance_conflict')
  return receipt
}
async function save(
  db: PoolClient,
  receipt: RestoreHistoryMaintenanceReceipt,
  request: unknown
): Promise<void> {
  await db.query(
    `INSERT INTO restore_history_maintenance_records
   (id,kind,tenant_id,account_id,request_hash,request_json,receipt_hash,receipt_json,recorded_by,recorded_at)
   VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10)`,
    [
      receipt.registrationId,
      receipt.kind,
      receipt.tenantId,
      receipt.accountId,
      receipt.requestHash,
      JSON.stringify(request),
      hashContext(receipt),
      JSON.stringify(receipt),
      receipt.recordedBy,
      new Date(receipt.recordedAt)
    ]
  )
}
/** Trust is an explicit independent maintenance review, not automatic verification
 * of the physical claims. No production sources or true flags are seeded here. */
export class RestoreHistoryMaintenance {
  constructor(private readonly db: Postgres) {}
  authenticate(): Promise<string> {
    return this.db.transaction('', authenticateRestoreMaintenance)
  }
  register(raw: unknown): Promise<{
    receipt: RestoreHistoryMaintenanceReceipt
    requirement: z.infer<typeof RestoreHistoryRequirementRecordSchema>
  }> {
    bounded(raw)
    const input = RestoreHistoryRegistrationSchema.parse(raw)
    return this.db.transaction(input.tenantId, async (db) => {
      const login = await authenticateRestoreMaintenance(db)
      const account = (
        await db.query(
          'SELECT paused,platform FROM accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [input.tenantId, input.accountId]
        )
      ).rows[0]
      if (!account) fail('maintenance_conflict')
      // All maintenance writers serialize key revocation/registration. This does not release any send authority.
      await db.query('LOCK TABLE restore_history_key_revocations IN SHARE MODE')
      const old = await previous(db, input.registrationId, input, login)
      if (old) {
        if (old.kind !== 'requirement') fail('maintenance_conflict')
        const row = (
          await db.query(
            'SELECT requirement_json,requirement_hash FROM ledger_restore_history_requirements WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND id=$4',
            [input.tenantId, input.accountId, input.caseId, input.registrationId]
          )
        ).rows[0]
        if (!row) fail('maintenance_conflict')
        const requirement = RestoreHistoryRequirementRecordSchema.parse(row.requirement_json)
        if (
          hashContext(requirement) !== row.requirement_hash ||
          row.requirement_hash !== old.subjectHash ||
          requirement.requirementId !== input.registrationId ||
          requirement.recordedAt !== old.recordedAt
        )
          fail('maintenance_conflict')
        return { receipt: old, requirement }
      }
      if (!account.paused) fail('maintenance_not_ready')
      const at = await now(db),
        scope = { tenant_id: input.tenantId, actor_id: login }
      const review = await readRestoreReview(db, scope, input.accountId, input.caseId)
      const inventory = await readCompleteRestoreInventory(
        db,
        scope,
        input.accountId,
        input.caseId,
        input.uploadId
      )
      const assessment = await readCompleteRestoreAssessment(
        db,
        scope,
        input.accountId,
        input.caseId,
        input.uploadId
      )
      if (
        review.contextHash !== input.expectedContextHash ||
        inventory.manifest.basisHash !== input.expectedInventoryBasisHash ||
        hashContext(inventory.manifest.scope) !== input.expectedScopeHash ||
        assessment.basisHash !== input.expectedAssessmentBasisHash ||
        input.sourceTrust.tenantId !== input.tenantId ||
        input.sourceTrust.accountId !== input.accountId ||
        input.sourceTrust.platform !== account.platform ||
        input.sourceTrust.platformAccountIdHash !== input.platformAccountIdHash
      )
        fail('maintenance_conflict')
      if (
        input.backupStartedAt > Date.parse(inventory.manifest.context.restoredAt) ||
        input.allDevicesStoppedAt <
          Math.max(Date.parse(inventory.manifest.context.restoredAt), review.openedAt) ||
        input.allDevicesStoppedAt > input.review.reviewedAt ||
        input.review.reviewedAt > at ||
        at - input.review.reviewedAt > 300000 ||
        at - input.allDevicesStoppedAt > 300000 ||
        input.sourceTrust.notBefore > at ||
        input.sourceTrust.notAfter <= at ||
        input.sourceTrust.revokedAt !== null
      )
        fail('maintenance_not_ready')
      new RestoreHistoryProofVerifier([input.sourceTrust])
      const fingerprint = keyHash(input.sourceTrust.publicKeyPem)
      await lockRestoreHistoryKey(db, fingerprint)
      if (
        (
          await db.query('SELECT 1 FROM restore_history_key_revocations WHERE key_sha256=$1', [
            fingerprint
          ])
        ).rowCount ||
        (
          await db.query(
            'SELECT 1 FROM account_leases WHERE tenant_id=$1 AND account_id=$2 AND expires_at>clock_timestamp()',
            [input.tenantId, input.accountId]
          )
        ).rowCount
      )
        fail('maintenance_not_ready')
      const requirement = RestoreHistoryRequirementRecordSchema.parse({
        formatVersion: 1,
        requirementId: input.registrationId,
        caseId: input.caseId,
        uploadId: input.uploadId,
        restoreId: review.restoreId,
        contextHash: review.contextHash,
        inventoryBasisHash: inventory.manifest.basisHash,
        assessmentBasisHash: assessment.basisHash,
        scopeHash: input.expectedScopeHash,
        platformAccountIdHash: input.platformAccountIdHash,
        backupStartedAt: input.backupStartedAt,
        backupStartVerificationSha256: input.backupStartVerificationSha256,
        allDevicesStoppedAt: input.allDevicesStoppedAt,
        deviceStopVerificationSha256: input.deviceStopVerificationSha256,
        sourceTrust: input.sourceTrust,
        recordedAt: at
      })
      await db.query(
        `INSERT INTO ledger_restore_history_requirements(tenant_id,account_id,case_id,upload_id,id,requirement_hash,requirement_json,recorded_at)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [
          input.tenantId,
          input.accountId,
          input.caseId,
          input.uploadId,
          input.registrationId,
          hashContext(requirement),
          JSON.stringify(requirement),
          new Date(at)
        ]
      )
      const receipt = Receipt.parse({
        formatVersion: 1,
        registrationId: input.registrationId,
        kind: 'requirement',
        tenantId: input.tenantId,
        accountId: input.accountId,
        subjectHash: hashContext(requirement),
        requestHash: hashContext(input),
        recordedBy: login,
        recordedAt: at,
        factVerificationPerformedByThisCommand: false,
        automaticStart: false,
        canRelease: false
      })
      await save(db, receipt, input)
      return { receipt, requirement }
    })
  }
  revoke(raw: unknown): Promise<RestoreHistoryMaintenanceReceipt> {
    bounded(raw)
    const input = RestoreHistoryKeyRevocationSchema.parse(raw)
    return this.db.transaction('', async (db) => {
      const login = await authenticateRestoreMaintenance(db)
      await db.query('LOCK TABLE restore_history_key_revocations IN SHARE ROW EXCLUSIVE MODE')
      const old = await previous(db, input.registrationId, input, login)
      const fingerprint = keyHash(input.publicKeyPem)
      await lockRestoreHistoryKey(db, fingerprint)
      if (old) {
        const row = (
          await db.query(
            'SELECT reason_sha256,recorded_at FROM restore_history_key_revocations WHERE key_sha256=$1',
            [fingerprint]
          )
        ).rows[0]
        if (
          old.kind !== 'key_revocation' ||
          old.subjectHash !== fingerprint ||
          !row ||
          row.reason_sha256 !== input.reasonSha256 ||
          new Date(row.recorded_at).getTime() !== old.recordedAt
        )
          fail('maintenance_conflict')
        return old
      }
      const at = await now(db)
      if (input.reviewedAt > at || at - input.reviewedAt > 300000) fail('maintenance_not_ready')
      if (
        (
          await db.query('SELECT 1 FROM restore_history_key_revocations WHERE key_sha256=$1', [
            fingerprint
          ])
        ).rowCount
      )
        fail('maintenance_conflict')
      await db.query(
        'INSERT INTO restore_history_key_revocations(key_sha256,reason_sha256,recorded_at) VALUES($1,$2,$3)',
        [fingerprint, input.reasonSha256, new Date(at)]
      )
      const receipt = Receipt.parse({
        formatVersion: 1,
        registrationId: input.registrationId,
        kind: 'key_revocation',
        tenantId: null,
        accountId: null,
        subjectHash: fingerprint,
        requestHash: hashContext(input),
        recordedBy: login,
        recordedAt: at,
        factVerificationPerformedByThisCommand: false,
        automaticStart: false,
        canRelease: false
      })
      await save(db, receipt, input)
      return receipt
    })
  }
}
