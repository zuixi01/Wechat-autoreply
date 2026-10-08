import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open, realpath, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { Id } from '../../shared/contracts/identity'
import { legacyReviewDdl, LegacySettingsReviews } from './legacy-settings-reviews'
import type {
  LegacyReviewRecord,
  LegacyReviewResult
} from '../../shared/contracts/legacy-migration'
import {
  LegacySettingsDraftSchema,
  type LegacySettingsDraft,
  type LegacySettingsContent,
  type LegacySettingsImportResult
} from '../../shared/contracts/legacy-migration'
export type {
  LegacySettingsDraft,
  LegacySettingsImportResult
} from '../../shared/contracts/legacy-migration'

const maximum = 8 * 1024 * 1024
const SourceId = z.string().trim().min(1).max(256)
const ObjectInput = z.object({
  id: SourceId,
  name: z.string().trim().min(1).max(200),
  title: z.string().max(256).default(''),
  relationship: z.string().max(2000).default(''),
  modeId: z.string().max(256).optional(),
  autoReply: z.boolean().nullable().default(null)
})
const Input = z.object({
  locale: z.enum(['zh', 'en']).default('zh'),
  theme: z.enum(['dark', 'light']).default('dark'),
  appType: z.string().max(100).optional(),
  globalDefaultModeId: z.string().max(256).default(''),
  globalAutoReply: z.boolean().default(false),
  systemPrompt: z.string().max(32000).default(''),
  modes: z
    .array(
      z.object({
        id: SourceId,
        name: z.string().trim().min(1).max(200),
        prompt: z.string().max(32000),
        unifiedPrefix: z.string().max(2000).default(''),
        autoReply: z.boolean().default(false),
        specificObjects: z.array(ObjectInput).max(20000).default([])
      })
    )
    .max(200)
    .default([])
})
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const equalPath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
async function boundedRead(file: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length
    if (bytes > maximum) throw new Error('too_large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
function contents(bytes: Buffer): LegacySettingsContent[] {
  try {
    const raw: unknown = JSON.parse(bytes.toString('utf8')),
      data = Input.parse(raw)
    if (
      new Set(data.modes.map((m) => m.id)).size !== data.modes.length ||
      data.modes.reduce((sum, m) => sum + m.specificObjects.length, 0) > 20000
    )
      throw new Error('duplicate_or_large')
    const result: LegacySettingsContent[] = [
      {
        kind: 'preferences',
        localeHint: data.locale,
        themeHint: data.theme,
        platformHint: data.appType === 'wechat' || data.appType === 'wework' ? data.appType : null,
        defaultModeSourceId: data.globalDefaultModeId,
        autoReplyRequested: data.globalAutoReply
      }
    ]
    for (const mode of data.modes) {
      if (new Set(mode.specificObjects.map((o) => o.id)).size !== mode.specificObjects.length)
        throw new Error('duplicate')
      result.push({
        kind: 'mode',
        legacyModeId: mode.id,
        name: mode.name,
        prompt: mode.prompt,
        unifiedPrefix: mode.unifiedPrefix,
        autoReplyRequested: mode.autoReply
      })
      for (const object of mode.specificObjects)
        result.push({
          kind: 'relationship',
          legacyObjectId: object.id,
          originModeId: mode.id,
          requestedModeId: object.modeId ?? mode.id,
          name: object.name,
          title: object.title,
          relationship: object.relationship,
          autoReplyRequested: object.autoReply
        })
    }
    let oldPrompt = data.systemPrompt
    if (!oldPrompt && raw && typeof raw === 'object') {
      const provider = (raw as Record<string, unknown>).chatProvider
      if (provider && typeof provider === 'object') {
        const config = (provider as Record<string, unknown>).config
        if (
          config &&
          typeof config === 'object' &&
          typeof (config as Record<string, unknown>).systemPrompt === 'string'
        )
          oldPrompt = z
            .string()
            .max(32000)
            .parse((config as Record<string, unknown>).systemPrompt)
      }
    }
    if (!data.modes.length && oldPrompt)
      result.push({
        kind: 'mode',
        legacyModeId: 'legacy.global',
        name: '旧全局回复规则',
        prompt: oldPrompt,
        unifiedPrefix: '',
        autoReplyRequested: false
      })
    return result
  } catch {
    throw new Error('legacy_settings_invalid')
  }
}
export class LegacySettingsArchive {
  private readonly db: DatabaseSync
  private readonly path: string
  private readonly workspace: string
  private closed = false
  private importing = false
  private readonly readOnly: boolean
  constructor(path: string, workspace: string, options: { readOnly?: boolean } = {}) {
    this.workspace = Id.parse(workspace)
    this.path = resolve(path)
    this.readOnly = options.readOnly === true
    try {
      if (!this.readOnly) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      if (
        !equalPath(realpathSync(dirname(this.path)), dirname(this.path)) ||
        (this.readOnly && !existsSync(this.path))
      )
        throw new Error('invalid')
      if (existsSync(this.path)) {
        const info = lstatSync(this.path)
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('invalid')
      }
    } catch {
      throw new Error('legacy_settings_archive_path_invalid')
    }
    this.db = new DatabaseSync(this.path, { readOnly: this.readOnly })
    try {
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
      if (
        version > 2 ||
        (version === 0 &&
          this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").get())
      )
        throw new Error('legacy_settings_archive_version_unsupported')
      if (
        version >= 1 &&
        this.db.prepare("SELECT value FROM legacy_settings_meta WHERE key='workspace'").get()
          ?.value !== this.workspace
      )
        throw new Error('legacy_settings_owner_mismatch')
      if (this.readOnly) {
        if (version !== 1 && version !== 2)
          throw new Error('legacy_settings_archive_version_unsupported')
        return
      }
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS legacy_settings_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS legacy_settings_drafts(id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS legacy_settings_imports(source_sha TEXT PRIMARY KEY,bytes INTEGER NOT NULL,imported_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS legacy_settings_sources(source_sha TEXT NOT NULL REFERENCES legacy_settings_imports(source_sha),draft_id TEXT NOT NULL REFERENCES legacy_settings_drafts(id),PRIMARY KEY(source_sha,draft_id));
        ${legacyReviewDdl}
        PRAGMA user_version=2;`)
      this.db
        .prepare("INSERT OR IGNORE INTO legacy_settings_meta VALUES('workspace',?)")
        .run(this.workspace)
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      this.db.close()
      throw error
    }
  }
  close(): void {
    if (!this.closed) {
      if (this.importing) throw new Error('legacy_settings_import_busy')
      this.db.close()
      this.closed = true
    }
  }
  private decode(row: Record<string, unknown>): LegacySettingsDraft {
    try {
      const draft = LegacySettingsDraftSchema.parse(JSON.parse(String(row.payload)))
      const contentHash = hash(JSON.stringify(draft.content)),
        id = hash(JSON.stringify({ workspace: this.workspace, contentHash }))
      if (
        draft.workspaceId !== this.workspace ||
        draft.contentHash !== contentHash ||
        row.content_hash !== contentHash ||
        draft.id !== id ||
        row.id !== id ||
        row.created_at !== draft.createdAt
      )
        throw new Error('invalid')
      return draft
    } catch {
      throw new Error('legacy_settings_archive_corrupt')
    }
  }
  list(): LegacySettingsDraft[] {
    if (this.closed) throw new Error('legacy_settings_archive_closed')
    return this.db
      .prepare('SELECT * FROM legacy_settings_drafts ORDER BY created_at,id')
      .all()
      .map((row) => this.decode(row))
  }
  private reviews(): LegacySettingsReviews {
    if (this.closed) throw new Error('legacy_settings_archive_closed')
    return new LegacySettingsReviews(this.db, this.workspace, (id) => {
      const row = this.db.prepare('SELECT * FROM legacy_settings_drafts WHERE id=?').get(id)
      if (!row) throw new Error('legacy_settings_draft_not_found')
      return this.decode(row)
    })
  }
  reviewHistory(id: string): LegacyReviewRecord[] {
    return this.reviews().history(id)
  }
  reviewState(id: string): LegacyReviewRecord | null {
    const history = this.reviewHistory(id)
    return history.length ? history[history.length - 1] : null
  }
  recordReview(input: unknown, reviewer: string): LegacyReviewResult {
    if (this.closed) throw new Error('legacy_settings_archive_closed')
    if (this.readOnly) throw new Error('legacy_settings_archive_read_only')
    if (this.importing) throw new Error('legacy_settings_import_busy')
    return this.reviews().record(input, reviewer)
  }
  private async saveOriginal(bytes: Buffer, sha: string): Promise<string> {
    const root = this.path + '.backups',
      directory = join(root, sha),
      file = join(directory, 'source.json')
    for (const folder of [root, directory]) {
      await mkdir(folder, { recursive: true, mode: 0o700 })
      if (
        !equalPath(await realpath(folder), resolve(folder)) ||
        (await lstat(folder)).isSymbolicLink()
      )
        throw new Error('legacy_settings_backup_conflict')
    }
    try {
      const handle = await open(file, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new Error('legacy_settings_backup_failed')
    }
    try {
      const info = await lstat(file)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size !== bytes.length ||
        JSON.stringify(await readdir(directory)) !== JSON.stringify(['source.json']) ||
        hash(await boundedRead(file)) !== sha
      )
        throw new Error('conflict')
    } catch {
      throw new Error('legacy_settings_backup_conflict')
    }
    return directory
  }
  async importFile(file: string): Promise<LegacySettingsImportResult> {
    if (this.closed) throw new Error('legacy_settings_archive_closed')
    if (this.readOnly) throw new Error('legacy_settings_archive_read_only')
    if (this.importing) throw new Error('legacy_settings_import_busy')
    this.importing = true
    try {
      const absolute = resolve(file)
      let bytes: Buffer
      try {
        const info = await lstat(absolute)
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink !== 1 ||
          info.size > maximum ||
          !equalPath(await realpath(absolute), absolute)
        )
          throw new Error('invalid')
        bytes = await boundedRead(absolute)
      } catch {
        throw new Error('legacy_settings_source_invalid')
      }
      const sourceSha256 = hash(bytes),
        backupDirectory = await this.saveOriginal(bytes, sourceSha256),
        items = contents(bytes)
      let createdDrafts = 0
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const ids: string[] = []
        for (const content of items) {
          const contentHash = hash(JSON.stringify(content)),
            id = hash(JSON.stringify({ workspace: this.workspace, contentHash }))
          const draft: LegacySettingsDraft = {
            id,
            workspaceId: this.workspace,
            contentHash,
            state: 'pending',
            automaticEnabled: false,
            identityVerified: false,
            content,
            createdAt: Date.now()
          }
          const old = this.db.prepare('SELECT * FROM legacy_settings_drafts WHERE id=?').get(id)
          if (old) this.decode(old)
          const result = this.db
            .prepare('INSERT OR IGNORE INTO legacy_settings_drafts VALUES(?,?,?,?)')
            .run(id, contentHash, JSON.stringify(draft), draft.createdAt)
          createdDrafts += Number(result.changes)
          ids.push(id)
        }
        this.db
          .prepare('INSERT OR IGNORE INTO legacy_settings_imports VALUES(?,?,?)')
          .run(sourceSha256, bytes.length, Date.now())
        for (const id of ids)
          this.db
            .prepare('INSERT OR IGNORE INTO legacy_settings_sources VALUES(?,?)')
            .run(sourceSha256, id)
        this.db.exec('COMMIT')
      } catch {
        if (this.db.isTransaction) this.db.exec('ROLLBACK')
        throw new Error('legacy_settings_import_failed')
      }
      return {
        sourceSha256,
        backupDirectory,
        createdDrafts,
        reusedDrafts: items.length - createdDrafts,
        automaticEnabled: false,
        reviewRequired: true
      }
    } finally {
      this.importing = false
    }
  }
}
