import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { learningHash } from '../../core/memory/learning-scope'

/** Fingerprints only: the ledger never stores model credentials, endpoints or customer text. */
export function hostModelConfigurationHash(settings: {
  models?: unknown
  vision?: unknown
  chatProvider?: unknown
  globalReplyModelId?: unknown
  globalVisionModelId?: unknown
}): string {
  return learningHash({
    models: Array.isArray(settings.models)
      ? settings.models.map((model: unknown) => {
          if (!model || typeof model !== 'object') return null
          const entry = model as Record<string, unknown>
          return {
            id: entry.id,
            name: entry.name,
            provider: entry.provider,
            modelName: entry.modelName,
            apiKey: entry.apiKey,
            baseURL: entry.baseURL,
            capabilities: entry.capabilities
          }
        })
      : settings.models,
    fallback: settings.vision,
    provider: settings.chatProvider,
    defaultReplyModelId: settings.globalReplyModelId,
    defaultVisionModelId: settings.globalVisionModelId
  })
}

export class HostModelConfigurationAudit {
  private readonly db: DatabaseSync
  private closed = false

  constructor(
    path: string,
    currentHash: string,
    private readonly now: () => number = Date.now
  ) {
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS learning_host_model_audit (
          id TEXT PRIMARY KEY, before_hash TEXT NOT NULL, after_hash TEXT NOT NULL,
          observed_hash TEXT, state TEXT NOT NULL CHECK(state IN ('prepared','applied','not_applied','uncertain')),
          reason TEXT NOT NULL CHECK(reason IN ('host_settings_change','observed_after_restart')),
          prepared_at INTEGER NOT NULL, resolved_at INTEGER);
        CREATE TABLE IF NOT EXISTS learning_host_model_audit_state (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), observed_hash TEXT NOT NULL);
      `)
      this.reconcile(currentHash)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private transaction(run: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      run()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Resolve durable intents using actual persisted settings, without inventing edit times. */
  reconcile(currentHash: string): void {
    this.transaction(() => {
      const at = this.now()
      const previous = this.db
        .prepare('SELECT observed_hash FROM learning_host_model_audit_state WHERE singleton=1')
        .get()
      const matchingIntent =
        previous &&
        this.db
          .prepare(
            `SELECT 1 FROM learning_host_model_audit
        WHERE state='prepared' AND before_hash=? AND after_hash=?`
          )
          .get(String(previous.observed_hash), currentHash)
      this.db
        .prepare(
          `UPDATE learning_host_model_audit SET
        state=CASE WHEN after_hash=? THEN 'applied' WHEN before_hash=? THEN 'not_applied' ELSE 'uncertain' END,
        observed_hash=?, resolved_at=? WHERE state='prepared'`
        )
        .run(currentHash, currentHash, currentHash, at)
      if (previous && previous.observed_hash !== currentHash) {
        if (!matchingIntent)
          this.db
            .prepare(
              `INSERT INTO learning_host_model_audit
          VALUES(?,?,?,?,?,?,?,?)`
            )
            .run(
              randomUUID(),
              String(previous.observed_hash),
              currentHash,
              currentHash,
              'applied',
              'observed_after_restart',
              at,
              at
            )
      }
      this.db
        .prepare(
          `INSERT INTO learning_host_model_audit_state VALUES(1,?)
        ON CONFLICT(singleton) DO UPDATE SET observed_hash=excluded.observed_hash`
        )
        .run(currentHash)
    })
  }

  change(nextHash: string, write: () => void, readHash: () => string): void {
    const beforeHash = readHash()
    this.reconcile(beforeHash)
    if (beforeHash === nextHash) {
      write()
      return
    }
    const id = randomUUID()
    // The intent commits before the separate Electron settings file is changed.
    this.db
      .prepare(
        `INSERT INTO learning_host_model_audit
      VALUES(?,?,?,NULL,'prepared','host_settings_change',?,NULL)`
      )
      .run(id, beforeHash, nextHash, this.now())
    let observed: string
    try {
      write()
    } finally {
      observed = readHash()
      this.transaction(() => {
        this.db
          .prepare(
            `UPDATE learning_host_model_audit SET state=?,observed_hash=?,resolved_at=?
          WHERE id=? AND state='prepared'`
          )
          .run(
            observed === nextHash
              ? 'applied'
              : observed === beforeHash
                ? 'not_applied'
                : 'uncertain',
            observed,
            this.now(),
            id
          )
        this.db
          .prepare(`UPDATE learning_host_model_audit_state SET observed_hash=? WHERE singleton=1`)
          .run(observed)
      })
    }
    if (observed !== nextHash) throw new Error('model_configuration_write_not_confirmed')
  }

  close(): void {
    if (!this.closed) {
      this.closed = true
      this.db.close()
    }
  }
}
