import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Postgres } from '../../server/src/database/postgres'

/** Actual PostgreSQL SQL on ONE embedded connection. Serialization here avoids
 * overlapping transactions on that connection; it is not a row-lock stress test. */
export async function embeddedPostgres(
  role: 'autoreply_app' | 'autoreply_learning_worker' = 'autoreply_app'
) {
  const sql = new PGlite()
  for (const file of [
    '001-core.sql',
    '002-reviewed-execution.sql',
    '003-generation.sql',
    '004-administration.sql',
    '005-evaluation-admission.sql',
    '006-human-confirmation.sql',
    '007-reconciliation-cases.sql',
    '008-device-reconciliation.sql',
    '009-reconciliation-decisions.sql',
    '010-execution-request-seals.sql',
    '011-model-call-ledger.sql',
    '012-generation-capacity.sql',
    '013-learning-memory.sql',
    '014-learning-queue.sql',
    '015-learning-context.sql',
    '016-learning-worker.sql',
    '017-learning-validation.sql',
    '018-learning-validation-runs.sql',
    '019-ledger-restore-reviews.sql',
    '020-restore-pause-evidence.sql',
    '021-learning-maintenance.sql',
    '022-learning-curation-merges.sql',
    '023-learning-events.sql',
    '024-learning-episode-closures.sql',
    '025-restore-inventory.sql',
    '026-restore-evidence.sql',
    '027-restore-decisions.sql',
    '028-restore-reader.sql',
    '029-restore-application-acks.sql',
    '030-central-restore-quarantine.sql',
    '031-device-runtime-status.sql',
    '032-account-pause-confirmation.sql',
    '033-tenant-pause-batches.sql',
    '034-learning-evaluation-purpose.sql',
    '035-restore-history-proofs.sql',
    '036-restore-history-maintenance.sql',
    '037-learning-evaluation-checkpoints.sql',
    '038-restore-execution-reviews.sql',
    '039-learning-evaluation-resume.sql',
    '040-restore-recovery-authorizations.sql',
    '041-restore-recovery-reader.sql',
    '042-restore-recovery-completions.sql',
    '043-learning-evaluation-executions.sql',
    '044-restore-admission.sql'
  ]) {
    const source = await readFile(resolve('server/migrations', file), 'utf8')
    await sql.exec(source)
    await sql.exec(source)
  }
  const query = async (text: string, values?: unknown[]) => {
    const result = await sql.query(text, values)
    return { ...result, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
  }
  let tail = Promise.resolve()
  async function serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = tail
    let release!: () => void
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
  const db = {
    pool: { query },
    transaction: async (tenant: string, operation: (client: unknown) => Promise<unknown>) =>
      serial(async () => {
        await sql.exec('BEGIN')
        try {
          await sql.query("SELECT set_config('app.tenant_id',$1,true)", [tenant])
          const result = await operation({ query })
          await sql.exec('COMMIT')
          return result
        } catch (e) {
          await sql.exec('ROLLBACK')
          throw e
        }
      }),
    close: () => sql.close()
  } as unknown as Postgres
  const adminExec = (text: string) =>
    serial(async () => {
      await sql.exec('RESET ROLE')
      try {
        await sql.exec(text)
      } finally {
        await sql.exec(`SET ROLE ${role}`)
      }
    })
  const adminQuery = (text: string, values?: unknown[]) =>
    serial(async () => {
      await sql.exec('RESET ROLE')
      try {
        return await query(text, values)
      } finally {
        await sql.exec(`SET ROLE ${role}`)
      }
    })
  return { db, sql, adminExec, adminQuery }
}
