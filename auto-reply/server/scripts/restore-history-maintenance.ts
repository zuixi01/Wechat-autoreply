import { open } from 'node:fs/promises'
import { parseArgs, TextDecoder } from 'node:util'
import { Postgres } from '../src/database/postgres'
import {
  RestoreHistoryMaintenance,
  RestoreHistoryMaintenanceError
} from '../src/recovery/restore-history-maintenance'
import { writePrivateAdminOutput } from './private-admin-output'
import { RestoreExecutionMaintenance } from '../src/recovery/restore-execution-maintenance'
import { RestoreExecutionError } from '../src/recovery/restore-execution-proof'
import { RestoreResolutionError } from '../src/recovery/restore-resolution-basis'
import {
  RestoreRecoveryMaintenance,
  RestoreRecoveryError
} from '../src/recovery/restore-recovery-authorization'

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs({
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        file: { type: 'string' },
        output: { type: 'string' },
        database: { type: 'string' },
        help: { type: 'boolean' }
      }
    })
  } catch {
    throw new Error('maintenance_arguments_invalid')
  }
  const seen = new Set<string>()
  for (const token of args.tokens ?? [])
    if (token.kind === 'option') {
      if (seen.has(token.name)) throw new Error('maintenance_arguments_invalid')
      seen.add(token.name)
    }
  if (args.values.help && args.positionals.length === 0 && seen.size === 1) {
    process.stdout.write(
      'Independent maintenance only: register|revoke|review-executions|authorize-recovery --database NAME --file PATH --output .local/PRIVATE.json\n' +
        'Requires RESTORE_HISTORY_MAINTENANCE_DATABASE_URL and an actual maintenance superuser login. No service/admin credential fallback.\n' +
        'Authenticate before opening input; reauthenticate inside the mutation. Operator must independently verify the physical review facts.\n' +
        'Bounded 16 KiB registration/revocation/recovery approval or 1 MiB execution review JSON; original ID retries only. No source seeding, resume, chat operations or model calls.\n'
    )
    return
  }
  const command = args.positionals[0],
    { file, output, database } = args.values
  if (
    args.positionals.length !== 1 ||
    !['register', 'revoke', 'review-executions', 'authorize-recovery'].includes(command) ||
    seen.has('help') ||
    typeof file !== 'string' ||
    typeof output !== 'string' ||
    typeof database !== 'string' ||
    !database
  )
    throw new Error('maintenance_arguments_invalid')
  const url = process.env.RESTORE_HISTORY_MAINTENANCE_DATABASE_URL
  if (!url) throw new Error('maintenance_credentials_required')
  const db = new Postgres(url),
    maintenance = new RestoreHistoryMaintenance(db)
  try {
    await maintenance.authenticate()
    const actual = (await db.pool.query('SELECT current_database() AS name')).rows[0]?.name
    if (actual !== database) throw new Error('maintenance_database_mismatch')
    const handle = await open(file, 'r')
    let input: unknown
    try {
      if (!(await handle.stat()).isFile()) throw new Error('maintenance_input_invalid')
      const limit = command === 'review-executions' ? 1048576 : 16384
      const bytes = Buffer.alloc(limit + 1)
      let length = 0
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      if (length > limit) throw new Error('maintenance_input_invalid')
      input = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
      )
    } finally {
      await handle.close()
    }
    const result =
      command === 'register'
        ? await maintenance.register(input)
        : command === 'revoke'
          ? await maintenance.revoke(input)
          : command === 'review-executions'
            ? await new RestoreExecutionMaintenance(db).record(input)
            : await new RestoreRecoveryMaintenance(db).approve(input)
    await writePrivateAdminOutput(output, result)
    process.stdout.write('Maintenance record saved; canRelease=false.\n')
  } finally {
    await db.close()
  }
}
main().catch((error: unknown) => {
  const message =
    error instanceof RestoreHistoryMaintenanceError ||
    error instanceof RestoreExecutionError ||
    error instanceof RestoreResolutionError ||
    error instanceof RestoreRecoveryError
      ? error.code
      : error instanceof Error
        ? error.message
        : ''
  process.stderr.write(
    ([
      'maintenance_denied',
      'maintenance_conflict',
      'maintenance_not_ready',
      'maintenance_arguments_invalid',
      'maintenance_credentials_required',
      'maintenance_database_mismatch',
      'maintenance_input_invalid',
      'restore_execution_conflict',
      'restore_execution_not_ready',
      'RESTORE_RESOLUTION_CONFLICT',
      'RESTORE_RESOLUTION_NOT_READY',
      'RESTORE_RECOVERY_CONFLICT',
      'RESTORE_RECOVERY_NOT_READY',
      'private_admin_output_required'
    ].includes(message)
      ? message
      : 'maintenance_unconfirmed') + '\n'
  )
  process.exitCode = 1
})
