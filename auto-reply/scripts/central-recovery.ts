import { Pool } from 'pg'
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import {
  createPostgresCentralArchive,
  importPostgresArchive
} from '../src/core/persistence/postgres-archive'
import { restoreCentralDatabase } from '../server/src/recovery/central-restoration'

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      allowPositionals: true,
      strict: true,
      tokens: true,
      options: {
        backup: { type: 'string' },
        output: { type: 'string' },
        'pg-bin': { type: 'string' },
        help: { type: 'boolean' }
      }
    })
  } catch {
    throw new Error('central_recovery_arguments_invalid')
  }
  const seen = new Set<string>()
  for (const token of parsed.tokens ?? [])
    if (token.kind === 'option') {
      if (seen.has(token.name)) throw new Error('central_recovery_arguments_invalid')
      seen.add(token.name)
    }
  const { values, positionals } = parsed
  if (values.help || !positionals.length) {
    process.stdout.write(
      'Central recovery (maintenance-only, trusted private archive)\nrestore --backup <joint-bundle> --output <new-private-attempt-directory> [--pg-bin <PostgreSQL16-bin>]\nUses PGDATABASE and libpq PG* environment credentials; requires maintenance superuser and existing non-login service roles.\nCreates a fresh restricted database, imports atomically, pauses accounts and revokes old device credentials.\nDoes not connect to chat clients, invoke models, resume accounts or cut over production.\nFailed attempts remain isolated; never overwrites or drops an existing database.\n'
    )
    return
  }
  if (
    positionals.length !== 1 ||
    positionals[0] !== 'restore' ||
    typeof values.backup !== 'string' ||
    typeof values.output !== 'string'
  )
    throw new Error('central_recovery_arguments_invalid')
  if (!process.env.PGDATABASE) throw new Error('central_recovery_database_required')
  let bin: string | undefined
  if (typeof values['pg-bin'] === 'string') {
    bin = resolve(values['pg-bin'])
    const info = await lstat(bin),
      canonical = await realpath(bin)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform === 'win32'
        ? bin.toLowerCase() !== canonical.toLowerCase()
        : bin !== canonical)
    )
      throw new Error('central_recovery_arguments_invalid')
  }
  const executable = (name: string): string =>
    bin ? join(bin, name + (process.platform === 'win32' ? '.exe' : '')) : name
  const cluster = new Pool({ max: 1, connectionTimeoutMillis: 5000, statement_timeout: 30000 }),
    targets: Pool[] = []
  cluster.on('error', () => process.stderr.write('central_recovery_connection_unavailable\n'))
  try {
    const result = await restoreCentralDatabase(values.backup, values.output, {
      cluster,
      centralArchive: createPostgresCentralArchive({
        dump: { executable: executable('pg_dump') },
        restore: { executable: executable('pg_restore') }
      }),
      connectDatabase: async (database) => {
        const pool = new Pool({
          database,
          max: 1,
          connectionTimeoutMillis: 5000,
          statement_timeout: 5000
        })
        targets.push(pool)
        pool.on('error', () => process.stderr.write('central_recovery_connection_unavailable\n'))
        return pool.connect()
      },
      importArchive: (database, archive) =>
        importPostgresArchive({ executable: executable('pg_restore') }, database, archive)
    })
    process.stdout.write(JSON.stringify({ passed: true, command: 'restore', ...result }) + '\n')
  } finally {
    await Promise.allSettled([...targets.map((p) => p.end()), cluster.end()])
  }
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : ''
  process.stderr.write(
    ([
      'central_recovery_arguments_invalid',
      'central_recovery_database_required',
      'joint_backup_invalid',
      'central_restore_target_exists',
      'central_restore_failed',
      'central_restore_denied',
      'central_restore_role_invalid',
      'central_restore_database_mismatch',
      'central_restore_database_access_invalid',
      'central_restore_source_changed'
    ].includes(message)
      ? message
      : 'central_recovery_failed') + '\n'
  )
  process.exitCode = 1
})
