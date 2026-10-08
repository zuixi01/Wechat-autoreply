import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { verifyJointBackup, type CentralArchive } from '../../../src/core/persistence/joint-backup'
import {
  protectPrivateDirectory,
  verifyPrivatePaths
} from '../../../src/core/persistence/private-backup-directory'
import {
  applyCentralRestoreQuarantine,
  type CentralRestoreReceipt
} from './central-restore-quarantine'

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
async function durable(path: string, bytes?: string): Promise<void> {
  const handle = await open(path, bytes === undefined ? 'r+' : 'wx', 0o600)
  try {
    if (bytes !== undefined) await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}
async function exactDirectory(path: string): Promise<string> {
  const absolute = resolve(path),
    info = await lstat(absolute),
    canonical = await realpath(absolute)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform === 'win32'
      ? absolute.toLowerCase() !== canonical.toLowerCase()
      : absolute !== canonical)
  )
    throw new Error('central_restore_path_invalid')
  return absolute
}
/** Maintenance adapter is trusted internal code. It cannot be supplied by an employee or manifest. */
export interface CentralRestoreMaintenance {
  cluster: Pick<Pool, 'connect'>
  connectDatabase(database: string): Promise<PoolClient>
  importArchive(database: string, file: string): Promise<void>
  centralArchive: CentralArchive
}
export async function restoreCentralDatabase(
  backup: string,
  output: string,
  maintenance: CentralRestoreMaintenance
): Promise<{
  directory: string
  databaseName: string
  receipt: CentralRestoreReceipt
  canRelease: false
  automaticStart: false
}> {
  const manifest = await verifyJointBackup(backup, maintenance.centralArchive)
  const destination = resolve(output),
    central = manifest.components.find((c) => c.name === 'central')!
  await exactDirectory(dirname(destination))
  try {
    await mkdir(destination, { mode: 0o700 })
  } catch (error) {
    throw new Error(
      (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? 'central_restore_target_exists'
        : 'central_restore_failed'
    )
  }
  let cluster: PoolClient | undefined, target: PoolClient | undefined
  try {
    await exactDirectory(destination)
    await protectPrivateDirectory(destination)
    const frozen = join(destination, 'central.dump')
    await copyFile(join(resolve(backup), 'central.dump'), frozen, constants.COPYFILE_EXCL)
    if ((await lstat(frozen)).size !== central.bytes || (await digest(frozen)) !== central.sha256)
      throw new Error('central_restore_source_changed')
    await durable(frozen)
    await verifyPrivatePaths(destination, [frozen])
    await maintenance.centralArchive.inspect(frozen)
    cluster = await maintenance.cluster.connect()
    const identity = (
      await cluster.query(`SELECT current_user AS owner,current_database() AS source_database,
      EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) AS privileged`)
    ).rows[0]
    if (!identity?.privileged) throw new Error('central_restore_denied')
    const roles = (
      await cluster.query(`SELECT rolname,rolcanlogin,rolsuper,rolbypassrls FROM pg_roles
      WHERE rolname IN ('autoreply_app','autoreply_admin','autoreply_learning_worker','autoreply_restore_reader')`)
    ).rows
    if (roles.length !== 4 || roles.some((r) => r.rolcanlogin || r.rolsuper || r.rolbypassrls))
      throw new Error('central_restore_role_invalid')
    const databaseName = `autoreply_restore_${randomUUID().replaceAll('-', '')}`
    // Identifier is generated here, never accepted from input. CREATE DATABASE cannot be transactional.
    await cluster.query(
      `CREATE DATABASE "${databaseName}" TEMPLATE template0 ALLOW_CONNECTIONS false`
    )
    await cluster.query(`REVOKE ALL ON DATABASE "${databaseName}" FROM PUBLIC`)
    const access = await cluster.query(
      `SELECT rolname FROM pg_roles WHERE NOT rolsuper AND has_database_privilege(oid,$1,'CONNECT')`,
      [databaseName]
    )
    if (access.rowCount) throw new Error('central_restore_database_access_invalid')
    await durable(
      join(destination, 'attempt.json'),
      JSON.stringify({
        backupId: manifest.id,
        databaseName,
        automaticStart: false,
        canRelease: false
      }) + '\n'
    )
    await cluster.query(`ALTER DATABASE "${databaseName}" ALLOW_CONNECTIONS true`)
    await maintenance.importArchive(databaseName, frozen)
    if ((await digest(frozen)) !== central.sha256) throw new Error('central_restore_source_changed')
    target = await maintenance.connectDatabase(databaseName)
    const targetIdentity = (
      await target.query('SELECT current_database() AS database, current_user AS owner')
    ).rows[0]
    if (targetIdentity.database !== databaseName || targetIdentity.owner !== identity.owner)
      throw new Error('central_restore_database_mismatch')
    // Supports existing 001–029 archives; migration source is trusted repository code, never archived SQL instructions.
    await target.query(
      await readFile(resolve('server/migrations/030-central-restore-quarantine.sql'), 'utf8')
    )
    const receipt = await applyCentralRestoreQuarantine(target, {
      restoreId: randomUUID(),
      backupId: manifest.id,
      archiveSha256: central.sha256,
      archiveBytes: central.bytes,
      databaseName
    })
    if (
      (
        await cluster.query(
          `SELECT rolname FROM pg_roles WHERE NOT rolsuper AND has_database_privilege(oid,$1,'CONNECT')`,
          [databaseName]
        )
      ).rowCount
    )
      throw new Error('central_restore_database_access_invalid')
    await verifyPrivatePaths(destination, [frozen, join(destination, 'attempt.json')])
    const result = {
      directory: destination,
      databaseName,
      receipt,
      canRelease: false as const,
      automaticStart: false as const
    }
    await durable(join(destination, 'restore-receipt.json'), JSON.stringify(result, null, 2) + '\n')
    return result
  } catch (error) {
    const safe =
      error instanceof Error &&
      [
        'central_restore_denied',
        'central_restore_role_invalid',
        'central_restore_database_mismatch',
        'central_restore_database_access_invalid',
        'central_restore_source_changed'
      ].includes(error.message)
        ? error.message
        : 'central_restore_failed'
    throw new Error(safe)
  } finally {
    target?.release()
    cluster?.release()
  }
}
