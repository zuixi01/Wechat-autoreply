import { z } from 'zod'
import { Id, Hash } from '../../../src/shared/contracts/identity'
import { hashContext } from '../../../src/core/reply/hashes'
import { CalibrationSettingsSchema } from '../../../evals/jev/calibration-replay'
import { Administration } from '../admin/administration'
import type { Postgres } from '../database/postgres'

const Request = z.strictObject({ tenantId: Id, accountId: Id, runId: Id, settings: z.unknown() })
export interface JevCalibrationDeclarationReceipt {
  declarationId: string
  runId: string
  snapshotHash: string
  settingsHash: string
  declaredAt: string
  candidatePredeclarationVerified: true
  releaseAuthorized: false
}

/** Binds a single immutable grid before this run starts. This cannot establish
 * that the operator has never seen similar examples outside this experiment. */
export class JevCalibrationDeclarations {
  constructor(
    private readonly db: Postgres,
    private readonly generatorVersion: string
  ) {}
  declare(raw: z.infer<typeof Request>): Promise<JevCalibrationDeclarationReceipt> {
    return this.record(raw, true)
  }
  verify(raw: z.infer<typeof Request>): Promise<JevCalibrationDeclarationReceipt> {
    return this.record(raw, false)
  }
  private async record(
    raw: z.infer<typeof Request>,
    create: boolean
  ): Promise<JevCalibrationDeclarationReceipt> {
    const request = Request.parse(structuredClone(raw))
    const settings = CalibrationSettingsSchema.parse(request.settings)
    const frozen = await new Administration(this.db, this.generatorVersion).readFrozenEvaluation(
      request.tenantId,
      request.accountId,
      request.runId
    )
    // Settings contain only flat policies and targets; sorted keys match hashContext.
    const sorted = (value: object): object =>
      Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    const canonical = JSON.stringify({
      candidates: settings.candidates.map(sorted),
      targets: sorted(settings.targets)
    })
    if (Buffer.byteLength(canonical, 'utf8') > 1048576)
      throw new Error('jev_calibration_settings_invalid')
    return this.db.transaction(request.tenantId, async (db) => {
      const row = (
        await db.query('SELECT * FROM autoreply.jev_calibration_declaration($1,$2,$3,$4,$5)', [
          request.tenantId,
          request.accountId,
          request.runId,
          canonical,
          create
        ])
      ).rows[0]
      if (
        !row ||
        row.tenant_id !== request.tenantId ||
        row.account_id !== request.accountId ||
        row.run_id !== request.runId ||
        row.snapshot_hash !== frozen.snapshotHash ||
        hashContext(row.publication_json) !== hashContext(frozen.publication) ||
        hashContext(row.plan_json) !== hashContext(frozen.plan) ||
        row.settings_canonical !== canonical ||
        hashContext(row.settings_json) !== hashContext(settings) ||
        row.settings_hash !== hashContext(settings)
      )
        throw new Error('jev_calibration_declaration_changed')
      return {
        declarationId: z.uuid().parse(row.id),
        runId: request.runId,
        snapshotHash: Hash.parse(row.snapshot_hash),
        settingsHash: Hash.parse(row.settings_hash),
        declaredAt: new Date(row.declared_at as Date).toISOString(),
        candidatePredeclarationVerified: true,
        releaseAuthorized: false
      }
    })
  }
}
