import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import type { CentralArchive } from './joint-backup'

export interface PostgresTool {
  executable: string
  // Trusted operational/test setup only (e.g. a disposable Docker container).
  prefix?: readonly string[]
  environment?: NodeJS.ProcessEnv
}
export function postgresArchiveArguments(): string[] {
  return ['--format=custom', '--no-password', '--lock-wait-timeout=5s']
}
export function postgresArchiveVersion(output: string): string {
  const match = /^pg_dump \(PostgreSQL\) (16(?:\.\d+){0,2})(?: \([A-Za-z0-9 .+~_-]+\))?$/.exec(
    output.trim()
  )
  if (!match) throw new Error('postgres_archive_version_unsupported')
  return `pg_dump (PostgreSQL) ${match[1]}`
}
export function validatePostgresArchiveList(contents: string): void {
  for (const table of [
    'accounts',
    'agents',
    'execution_permits',
    'audit_events',
    'generation_publications',
    'learning_memories',
    'ledger_restore_reviews'
  ])
    for (const kind of ['TABLE', 'TABLE DATA']) {
      const expression = new RegExp(`^\\d+; \\d+ \\d+ ${kind} autoreply ${table} \\S+\\r?$`, 'm')
      if (!expression.test(contents)) throw new Error('postgres_archive_invalid')
    }
}
async function command(
  tool: PostgresTool,
  args: readonly string[],
  destination?: string,
  timeoutMs = destination ? 180000 : 15000
): Promise<string> {
  // Shell is disabled; libpq connection credentials are inherited via PG* environment variables.
  const child = spawn(tool.executable, [...(tool.prefix ?? []), ...args], {
    shell: false,
    env: tool.environment ?? process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let result = '',
    warning = false,
    overflow = false
  child.stderr.on('data', (chunk: Buffer) => {
    if (chunk.length) warning = true
  })
  if (!destination)
    child.stdout.on('data', (chunk: Buffer) => {
      if (result.length + chunk.length > 8 * 1024 * 1024) {
        overflow = true
        child.kill()
        return
      }
      result += chunk.toString('utf8')
    })
  const timer = setTimeout(() => child.kill(), timeoutMs)
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('postgres_archive_command_failed')))
    child.once('close', (code) =>
      code === 0 && !warning && !overflow
        ? resolve()
        : reject(new Error('postgres_archive_command_failed'))
    )
  })
  try {
    if (destination)
      await Promise.all([
        completion,
        pipeline(child.stdout, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
      ])
    else await completion
    return result.trim()
  } catch {
    child.kill()
    throw new Error('postgres_archive_command_failed')
  } finally {
    clearTimeout(timer)
  }
}
export function createPostgresCentralArchive(tools: {
  dump: PostgresTool
  restore: PostgresTool
}): CentralArchive {
  return {
    async exportTo(file) {
      const toolVersion = postgresArchiveVersion(await command(tools.dump, ['--version']))
      await command(tools.dump, postgresArchiveArguments(), file)
      return { toolVersion }
    },
    async inspect(file) {
      validatePostgresArchiveList(await command(tools.restore, ['--list', file]))
    }
  }
}
export function postgresRestoreArguments(database: string, archive: string): string[] {
  if (!/^autoreply_restore_[a-f0-9]{32}$/.test(database))
    throw new Error('postgres_restore_target_invalid')
  return [
    '--single-transaction',
    '--exit-on-error',
    '--no-owner',
    '--no-privileges',
    '--no-password',
    '--dbname',
    database,
    archive
  ]
}
export async function importPostgresArchive(
  tool: PostgresTool,
  database: string,
  archive: string
): Promise<void> {
  // Full imports get the same bounded operational budget as full exports.
  // Metadata inspection retains its shorter budget.
  await command(tool, postgresRestoreArguments(database, archive), undefined, 180000)
}
