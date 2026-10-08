import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import {
  createJointBackup,
  stageJointRestore,
  verifyJointBackup
} from '../src/core/persistence/joint-backup'
import { createPostgresCentralArchive } from '../src/core/persistence/postgres-archive'

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      allowPositionals: true,
      strict: true,
      tokens: true,
      options: {
        profile: { type: 'string' },
        output: { type: 'string' },
        backup: { type: 'string' },
        'pg-bin': { type: 'string' },
        help: { type: 'boolean' }
      }
    })
  } catch {
    throw new Error('joint_recovery_arguments_invalid')
  }
  const { values, positionals, tokens } = parsed,
    seen = new Set<string>()
  for (const token of tokens ?? [])
    if (token.kind === 'option') {
      if (seen.has(token.name)) throw new Error('joint_recovery_arguments_invalid')
      seen.add(token.name)
    }
  if (values.help || !positionals.length) {
    process.stdout.write(
      'Joint recovery (operational; no chat/provider calls)\nbackup --profile <closed-employee-profile> --output <private-backup-root> [--pg-bin <PostgreSQL16-bin>]\nverify --backup <bundle-directory> [--pg-bin <PostgreSQL16-bin>]\nstage --backup <bundle-directory> --output <new-staging-directory> [--pg-bin <PostgreSQL16-bin>]\nBackup requires PGDATABASE and libpq PG* credentials in the environment. Never pass secrets on command lines.\nStaging does not activate employee settings, credentials, learning or PostgreSQL.\nEach component has its own consistent snapshot; the bundle is not one distributed transaction.\n'
    )
    return
  }
  const command = positionals[0]
  if (
    positionals.length !== 1 ||
    !(
      (command === 'backup' &&
        typeof values.profile === 'string' &&
        typeof values.output === 'string' &&
        values.backup === undefined) ||
      (command === 'verify' &&
        typeof values.backup === 'string' &&
        values.output === undefined &&
        values.profile === undefined) ||
      (command === 'stage' &&
        typeof values.backup === 'string' &&
        typeof values.output === 'string' &&
        values.profile === undefined)
    )
  )
    throw new Error('joint_recovery_arguments_invalid')
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
      throw new Error('joint_recovery_arguments_invalid')
  }
  const executable = (name: string): string =>
    bin ? join(bin, name + (process.platform === 'win32' ? '.exe' : '')) : name
  const central = createPostgresCentralArchive({
    dump: { executable: executable('pg_dump') },
    restore: { executable: executable('pg_restore') }
  })
  if (command === 'backup') {
    if (!process.env.PGDATABASE) throw new Error('joint_recovery_database_required')
    const saved = await createJointBackup(
      values.profile as string,
      values.output as string,
      central
    )
    process.stdout.write(JSON.stringify({ passed: true, command, ...saved }) + '\n')
  } else if (command === 'verify') {
    process.stdout.write(
      JSON.stringify({
        passed: true,
        command,
        manifest: await verifyJointBackup(values.backup as string, central)
      }) + '\n'
    )
  } else {
    process.stdout.write(
      JSON.stringify({
        passed: true,
        command,
        ...(await stageJointRestore(values.backup as string, values.output as string, central))
      }) + '\n'
    )
  }
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : ''
  process.stderr.write(
    ([
      'joint_recovery_arguments_invalid',
      'joint_recovery_database_required',
      'joint_backup_failed',
      'joint_backup_invalid',
      'joint_restore_failed',
      'joint_restore_target_exists'
    ].includes(message)
      ? message
      : 'joint_recovery_failed') + '\n'
  )
  process.exitCode = 1
})
