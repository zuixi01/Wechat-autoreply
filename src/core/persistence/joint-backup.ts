import { backup, DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, realpath, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { createLedgerBackup, restoreLedgerBackup, verifyLedgerBackup } from './ledger-backup'
import { supportedLedgerSchema } from './ledger-schema'
import { protectPrivateDirectory, verifyPrivatePaths } from './private-backup-directory'

// Only trusted operational code supplies the exporter, never renderer/manifest data.
export interface CentralArchive {
  exportTo(file: string): Promise<{ toolVersion: string }>
  inspect(file: string): Promise<void>
}
const definitions = [
  {
    name: 'settings',
    source: 'settings.json',
    file: 'settings.json',
    kind: 'json',
    optional: false,
    max: 8 * 1024 * 1024
  },
  {
    name: 'ledger',
    source: 'agent/ledger.sqlite',
    file: 'ledger',
    kind: 'ledger',
    optional: false,
    max: 0
  },
  {
    name: 'knowledge',
    source: 'knowledge/knowledge.sqlite',
    file: 'knowledge.sqlite',
    kind: 'sqlite',
    optional: false,
    max: 0
  },
  {
    name: 'learning',
    source: 'worktrace/memory/learning.sqlite',
    file: 'learning.sqlite',
    kind: 'sqlite',
    optional: false,
    max: 0
  },
  {
    name: 'device',
    source: 'agent-device.json',
    file: 'agent-device.json',
    kind: 'json',
    optional: true,
    max: 65536
  },
  {
    name: 'legacyCards',
    source: 'worktrace/memory/cards.json',
    file: 'cards.json',
    kind: 'json',
    optional: true,
    max: 64 * 1024 * 1024
  },
  {
    name: 'foreground',
    source: 'agent/foreground-wechat.sqlite',
    file: 'foreground.sqlite',
    kind: 'sqlite',
    optional: true,
    max: 0
  },
  { name: 'central', source: '', file: 'central.dump', kind: 'central', optional: false, max: 0 }
] as const
type Definition = (typeof definitions)[number]
const Component = z.strictObject({
  name: z.enum([
    'settings',
    'ledger',
    'knowledge',
    'learning',
    'device',
    'legacyCards',
    'foreground',
    'central'
  ]),
  status: z.enum(['present', 'absent']),
  bytes: z.number().int().nonnegative().safe(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  schemaVersion: z.number().int().nonnegative().safe().nullable()
})
const Manifest = z
  .strictObject({
    formatVersion: z.literal(1),
    kind: z.literal('joint-backup'),
    id: z.uuid(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    consistency: z.literal('independent-component-snapshots'),
    automaticStart: z.literal(false),
    requiresReview: z.literal(true),
    centralToolVersion: z.string().regex(/^pg_dump \(PostgreSQL\) 16(?:\.\d+){0,2}$/),
    components: z.array(Component).length(definitions.length)
  })
  .superRefine((manifest, ctx) => {
    if (manifest.completedAt < manifest.startedAt)
      ctx.addIssue({ code: 'custom', message: 'interval' })
    manifest.components.forEach((c, i) => {
      const d = definitions[i]
      if (
        c.name !== d.name ||
        (c.status === 'absent' &&
          (!d.optional || c.bytes !== 0 || c.sha256 !== null || c.schemaVersion !== null)) ||
        (c.status === 'present' &&
          (c.bytes <= 0 ||
            c.sha256 === null ||
            (d.kind === 'sqlite'
              ? d.name === 'learning'
                ? c.schemaVersion !== 15 && c.schemaVersion !== 16
                : c.schemaVersion !== 0
              : d.kind === 'ledger'
                ? !supportedLedgerSchema(c.schemaVersion)
                : c.schemaVersion !== null)))
      )
        ctx.addIssue({ code: 'custom', path: ['components', i], message: 'component' })
    })
  })
export type JointBackupManifest = z.infer<typeof Manifest>
const equalPath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
async function directory(path: string): Promise<string> {
  const absolute = resolve(path),
    info = await lstat(absolute)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !equalPath(absolute, await realpath(absolute))
  )
    throw new Error('path_invalid')
  return absolute
}
async function file(path: string, maximum = Number.MAX_SAFE_INTEGER): Promise<number> {
  const absolute = resolve(path),
    info = await lstat(absolute)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size <= 0 ||
    info.size > maximum ||
    !equalPath(absolute, await realpath(absolute))
  )
    throw new Error('file_invalid')
  return info.size
}
async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function durable(path: string, contents?: string | Buffer): Promise<void> {
  const handle = await open(path, contents === undefined ? 'r+' : 'wx', 0o600)
  try {
    if (contents !== undefined) await handle.writeFile(contents)
    await handle.sync()
  } finally {
    await handle.close()
  }
}
async function boundedJson(path: string, maximum: number): Promise<Buffer> {
  await file(path, maximum)
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of createReadStream(path)) {
    length += chunk.length
    if (length > maximum) throw new Error('json_too_large')
    chunks.push(chunk)
  }
  const result = Buffer.concat(chunks),
    value: unknown = JSON.parse(result.toString('utf8'))
  if (value === null || typeof value !== 'object') throw new Error('json_invalid')
  await file(path, maximum)
  if ((await digest(path)) !== createHash('sha256').update(result).digest('hex'))
    throw new Error('source_changed')
  return result
}
function inspectSqlite(db: DatabaseSync, definition: Definition): number {
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON')
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
  const required =
    definition.name === 'knowledge'
      ? ['knowledge_meta', 'knowledge_documents', 'knowledge_chunks']
      : definition.name === 'learning'
        ? [
            'learning_episodes',
            'learning_memories',
            'learning_revisions',
            'learning_settings',
            'learning_feedback',
            'learning_tombstones'
          ]
        : ['foreground_replies']
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
      .all()
      .map((r) => r.name)
  )
  const integrity = db.prepare('PRAGMA integrity_check').all()
  if (
    (definition.name === 'learning' ? version !== 15 && version !== 16 : version !== 0) ||
    !required.every((t) => tables.has(t)) ||
    integrity.length !== 1 ||
    integrity[0].integrity_check !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').get()
  )
    throw new Error('sqlite_invalid')
  return version
}
async function inspectCentral(path: string, central: CentralArchive): Promise<void> {
  if ((await file(path)) < 16) throw new Error('central_invalid')
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(5)
    await handle.read(buffer, 0, 5, 0)
    if (buffer.toString('ascii') !== 'PGDMP') throw new Error('central_invalid')
  } finally {
    await handle.close()
  }
  await central.inspect(path)
}
function componentPath(root: string, d: Definition): string {
  return join(root, d.file, ...(d.kind === 'ledger' ? ['ledger.sqlite'] : []))
}

export async function createJointBackup(
  profile: string,
  output: string,
  central: CentralArchive
): Promise<{ directory: string; manifest: JointBackupManifest }> {
  try {
    const source = await directory(profile)
    // Resolve all required paths before creating output, without constructing stores/migrating sources.
    const present = new Set<string>()
    for (const d of definitions.filter((item) => item.kind !== 'central')) {
      const path = join(source, d.source)
      try {
        await file(path, d.max || undefined)
        present.add(d.name)
      } catch (error) {
        if (!d.optional || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    await mkdir(output, { recursive: true, mode: 0o700 })
    const parent = await directory(output),
      id = randomUUID(),
      destination = join(parent, id),
      startedAt = new Date().toISOString()
    await mkdir(destination, { mode: 0o700 })
    await protectPrivateDirectory(destination)
    const components: JointBackupManifest['components'] = []
    let centralToolVersion = ''
    for (const d of definitions) {
      if (d.optional && !present.has(d.name)) {
        components.push({
          name: d.name,
          status: 'absent',
          bytes: 0,
          sha256: null,
          schemaVersion: null
        })
        continue
      }
      let schemaVersion: number | null = null
      if (d.kind === 'central') {
        centralToolVersion = (await central.exportTo(join(destination, d.file))).toolVersion
        await inspectCentral(join(destination, d.file), central)
        await durable(join(destination, d.file))
      } else if (d.kind === 'json') {
        await durable(join(destination, d.file), await boundedJson(join(source, d.source), d.max))
      } else {
        await file(join(source, d.source))
        const db = new DatabaseSync(join(source, d.source), { readOnly: true })
        try {
          if (d.kind === 'ledger') {
            const saved = await createLedgerBackup(db, destination)
            // Verify the exact owned source and destination before moving a directory on Windows.
            if (!equalPath(resolve(saved.directory), join(destination, saved.manifest.id)))
              throw new Error('ledger_path')
            await directory(saved.directory)
            await rename(saved.directory, join(destination, d.file))
            schemaVersion = saved.manifest.schemaVersion
          } else {
            inspectSqlite(db, d)
            await backup(db, join(destination, d.file))
            const snapshot = new DatabaseSync(join(destination, d.file))
            try {
              snapshot.exec('PRAGMA journal_mode=DELETE')
              schemaVersion = inspectSqlite(snapshot, d)
            } finally {
              snapshot.close()
            }
            await durable(join(destination, d.file))
          }
        } finally {
          db.close()
        }
      }
      const path = componentPath(destination, d)
      components.push({
        name: d.name,
        status: 'present',
        bytes: await file(path),
        sha256: await digest(path),
        schemaVersion
      })
    }
    const manifest = Manifest.parse({
      formatVersion: 1,
      kind: 'joint-backup',
      id,
      startedAt,
      completedAt: new Date().toISOString(),
      consistency: 'independent-component-snapshots',
      automaticStart: false,
      requiresReview: true,
      centralToolVersion,
      components
    })
    await durable(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    await verifyJointBackup(destination, central)
    return { directory: destination, manifest }
  } catch (error) {
    const diagnostic =
      error instanceof z.ZodError
        ? `manifest_schema_${error.issues.map((issue) => [...issue.path, ['interval', 'component'].includes(issue.message) ? issue.message : issue.code].join('_')).join('_')}`
        : error instanceof Error &&
            [
              'file_invalid',
              'path_invalid',
              'source_changed',
              'sqlite_invalid',
              'central_invalid',
              'json_invalid',
              'json_too_large',
              'ledger_path',
              'joint_backup_invalid',
              'postgres_archive_command_failed',
              'postgres_archive_invalid',
              'postgres_archive_version_unsupported',
              'private_backup_permissions_invalid'
            ].includes(error.message)
          ? error.message
          : 'validation_failed'
    throw new Error('joint_backup_failed', { cause: new Error(diagnostic) })
  }
}
export async function verifyJointBackup(
  root: string,
  central: CentralArchive
): Promise<JointBackupManifest> {
  try {
    const source = await directory(root)
    const manifest = Manifest.parse(
      JSON.parse((await boundedJson(join(source, 'manifest.json'), 65536)).toString('utf8'))
    )
    const expected = [
      'manifest.json',
      ...definitions
        .filter((_d, i) => manifest.components[i].status === 'present')
        .map((d) => d.file)
    ].sort()
    if (JSON.stringify((await readdir(source)).sort()) !== JSON.stringify(expected))
      throw new Error('inventory')
    await verifyPrivatePaths(source, [
      join(source, 'manifest.json'),
      ...definitions.flatMap((d, i) =>
        manifest.components[i].status !== 'present'
          ? []
          : d.kind === 'ledger'
            ? [
                join(source, d.file),
                join(source, d.file, 'manifest.json'),
                componentPath(source, d)
              ]
            : [componentPath(source, d)]
      )
    ])
    for (const [i, d] of definitions.entries()) {
      const c = manifest.components[i]
      if (c.status === 'absent') continue
      const path = componentPath(source, d)
      if ((await file(path, d.max || undefined)) !== c.bytes || (await digest(path)) !== c.sha256)
        throw new Error('digest')
      if (d.kind === 'ledger') {
        const ledger = await verifyLedgerBackup(join(source, d.file))
        if (
          ledger.sha256 !== c.sha256 ||
          ledger.bytes !== c.bytes ||
          ledger.schemaVersion !== c.schemaVersion
        )
          throw new Error('ledger')
      } else if (d.kind === 'sqlite') {
        const db = new DatabaseSync(path, { readOnly: true })
        try {
          if (inspectSqlite(db, d) !== c.schemaVersion) throw new Error('version')
        } finally {
          db.close()
        }
      } else if (d.kind === 'json') {
        await boundedJson(path, d.max)
      } else {
        await inspectCentral(path, central)
      }
    }
    return manifest
  } catch {
    throw new Error('joint_backup_invalid')
  }
}
export async function stageJointRestore(
  root: string,
  target: string,
  central: CentralArchive
): Promise<{
  directory: string
  backupId: string
  restoreId: string
  automaticStart: false
  requiresReview: true
  readyForProfile: false
}> {
  const manifest = await verifyJointBackup(root, central),
    destination = resolve(target)
  await directory(dirname(destination))
  try {
    await mkdir(destination, { mode: 0o700 })
  } catch (error) {
    throw new Error(
      (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? 'joint_restore_target_exists'
        : 'joint_restore_failed'
    )
  }
  try {
    await directory(destination)
    await protectPrivateDirectory(destination)
    const review = join(destination, 'review-only')
    await mkdir(review, { mode: 0o700 })
    const restored = await restoreLedgerBackup(join(root, 'ledger'), join(destination, 'ledger'))
    if (restored.manifest.sha256 !== manifest.components[1].sha256)
      throw new Error('source_changed')
    for (const [i, d] of definitions.entries()) {
      const c = manifest.components[i]
      if (c.status === 'absent' || d.kind === 'ledger') continue
      const path = join(review, d.file)
      await copyFile(componentPath(root, d), path, constants.COPYFILE_EXCL)
      if ((await file(path, d.max || undefined)) !== c.bytes || (await digest(path)) !== c.sha256)
        throw new Error('source_changed')
      await durable(path)
    }
    await durable(join(review, 'source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    await verifyPrivatePaths(destination, [
      review,
      join(review, 'source-manifest.json'),
      join(destination, 'ledger'),
      join(destination, 'ledger', 'ledger.sqlite'),
      join(destination, 'ledger', 'restore.json'),
      ...definitions
        .filter((d, i) => d.kind !== 'ledger' && manifest.components[i].status === 'present')
        .map((d) => join(review, d.file))
    ])
    const result = {
      directory: destination,
      backupId: manifest.id,
      restoreId: restored.restoreContext.restoreId,
      automaticStart: false as const,
      requiresReview: true as const,
      readyForProfile: false as const
    }
    await durable(join(destination, 'staging-receipt.json'), JSON.stringify(result, null, 2) + '\n')
    return result
  } catch {
    throw new Error('joint_restore_failed')
  }
}
