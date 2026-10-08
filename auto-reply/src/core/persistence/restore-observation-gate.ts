import type { DatabaseSync } from 'node:sqlite'
import { createPublicKey, verify } from 'node:crypto'
import type { Identity } from '../../shared/contracts/identity'
import type { DeviceScope } from '../../shared/contracts/registration'
import type { ObservedMessage } from '../../shared/contracts/message'
import {
  RestoreRecoveryPackageSchema,
  type RestoreRecoveryPackage
} from '../../shared/contracts/restore-recovery'
import {
  parseRestoreObservationGrant,
  SignedRestoreObservationSchema,
  restoreObservationSigningBytes,
  type RestoreObservationGrant
} from '../../shared/contracts/restore-observation'
import { readLedgerRestoreContext } from './ledger-restoration'
import { readRestoreRecoveryApplication } from './restore-recovery-journal'
import { hashContext } from '../reply/hashes'

function conflict(): never {
  throw new Error('restore_observation_conflict')
}
function scopeOf(i: Identity): DeviceScope {
  return {
    tenant_id: i.tenantId,
    employee_id: i.employeeId,
    account_id: i.accountId,
    agent_id: i.agentId,
    platform: i.platform
  }
}
type Anchor = { direction: string; contentHash: string; position: number }
interface Boundary {
  key: string
  package: RestoreRecoveryPackage
  anchors: Map<string, Map<string, Anchor>>
  frontiers: Map<string, { position: number; sourceMessageId: string; contentHash: string }>
}

/** Only authenticated host preparation installs trust. Source signatures grant observation,
 * never model, lease, send, resume or permission to replay historical messages. */
export class RestoreObservationGate {
  private cached?: Boundary
  constructor(private readonly db: DatabaseSync) {}
  private exists(table: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)
    )
  }
  private boundary(scope: DeviceScope): Boundary | undefined {
    const context = readLedgerRestoreContext(this.db)
    if (!context || !this.exists('ledger_restore_recovery_applications')) return undefined
    const rows = this.db
      .prepare(
        `SELECT authorization_id,request_hash,receipt_hash,
      json_extract(request_json,'$.authorization.scope') AS scope_json
      FROM ledger_restore_recovery_applications WHERE restore_id=? ORDER BY sequence DESC`
      )
      .all(context.restoreId.toLowerCase())
    for (const row of rows) {
      if (typeof row.scope_json !== 'string') conflict()
      const recordedScope = JSON.parse(row.scope_json)
      if (
        recordedScope.tenant_id !== scope.tenant_id ||
        recordedScope.account_id !== scope.account_id ||
        recordedScope.platform !== scope.platform
      )
        continue
      if (hashContext(recordedScope) !== hashContext(scope)) conflict()
      const key = hashContext({
        authorization: row.authorization_id,
        request: row.request_hash,
        receipt: row.receipt_hash,
        context: context.contextHash,
        dataVersion: this.db.prepare('PRAGMA data_version').get()?.data_version
      })
      if (this.cached?.key === key) return this.cached
      const stored = this.db
        .prepare(
          'SELECT CASE WHEN length(CAST(request_json AS BLOB))<=2097152 THEN request_json END AS request_json FROM ledger_restore_recovery_applications WHERE authorization_id=?'
        )
        .get(String(row.authorization_id))
      if (typeof stored?.request_json !== 'string') conflict()
      const raw = JSON.parse(stored.request_json)
      const p = RestoreRecoveryPackageSchema.parse(raw)
      if (
        hashContext(p) !== row.request_hash ||
        p.authorization.contextHash !== context.contextHash ||
        !readRestoreRecoveryApplication(this.db, p.authorization.authorizationId)
      )
        conflict()
      const anchors = new Map<string, Map<string, Anchor>>(),
        frontiers: Boundary['frontiers'] = new Map()
      for (const c of p.boundary.history.conversations) {
        const values = new Map<string, Anchor>()
        for (const m of c.messages) {
          values.set(m.sourceMessageId, m)
          frontiers.set(c.conversationId, m)
        }
        anchors.set(c.conversationId, values)
      }
      return (this.cached = { key, package: p, anchors, frontiers })
    }
    return undefined
  }
  private initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS ledger_restore_observation_grants (
      grant_id TEXT PRIMARY KEY, authorization_id TEXT NOT NULL, grant_hash TEXT NOT NULL,
      grant_json TEXT NOT NULL, installed_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ledger_restore_ordered_observations (
      authorization_id TEXT NOT NULL, conversation_id TEXT NOT NULL, source_id TEXT NOT NULL,
      position INTEGER NOT NULL, grant_id TEXT NOT NULL REFERENCES ledger_restore_observation_grants(grant_id),
      frame_hash TEXT NOT NULL, frame_json TEXT NOT NULL,
      PRIMARY KEY(authorization_id,conversation_id,source_id), UNIQUE(authorization_id,conversation_id,position)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS ledger_restore_observation_grants_no_update BEFORE UPDATE ON ledger_restore_observation_grants BEGIN SELECT RAISE(ABORT,'restore_observation_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_restore_observation_grants_no_delete BEFORE DELETE ON ledger_restore_observation_grants BEGIN SELECT RAISE(ABORT,'restore_observation_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_restore_ordered_observations_no_update BEFORE UPDATE ON ledger_restore_ordered_observations BEGIN SELECT RAISE(ABORT,'restore_observation_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_restore_ordered_observations_no_delete BEFORE DELETE ON ledger_restore_ordered_observations BEGIN SELECT RAISE(ABORT,'restore_observation_immutable'); END;`)
  }
  install(scope: DeviceScope, raw: unknown, now: number): RestoreObservationGrant {
    if (!this.db.isTransaction || !Number.isSafeInteger(now)) conflict()
    const b = this.boundary(scope)
    if (!b) conflict()
    const g = parseRestoreObservationGrant(raw, b.package)
    if (createPublicKey(g.sourceTrust.publicKeyPem).asymmetricKeyType !== 'ed25519') conflict()
    this.initialize()
    const old = this.db
      .prepare('SELECT grant_hash FROM ledger_restore_observation_grants WHERE grant_id=?')
      .get(g.grantId)
    if (old) {
      if (old.grant_hash !== hashContext(g)) conflict()
      return this.readGrant(g.grantId, b)
    }
    if (now < g.issuedAt || now >= g.expiresAt) conflict()
    this.db
      .prepare('INSERT INTO ledger_restore_observation_grants VALUES(?,?,?,?,?)')
      .run(g.grantId, g.authorizationId, hashContext(g), JSON.stringify(g), now)
    return g
  }
  private readGrant(id: string, b: Boundary): RestoreObservationGrant {
    const row = this.db
      .prepare(
        `SELECT grant_hash,authorization_id,installed_at,
      CASE WHEN length(CAST(grant_json AS BLOB))<=16384 THEN grant_json END AS grant_json
      FROM ledger_restore_observation_grants WHERE grant_id=?`
      )
      .get(id)
    if (!row || typeof row.grant_json !== 'string') conflict()
    const g = parseRestoreObservationGrant(JSON.parse(row.grant_json), b.package)
    if (
      g.grantId !== id ||
      g.authorizationId !== row.authorization_id ||
      hashContext(g) !== row.grant_hash ||
      Number(row.installed_at) < g.issuedAt ||
      Number(row.installed_at) >= g.expiresAt
    )
      conflict()
    return g
  }
  current(identity: Identity, now: number): RestoreObservationGrant | undefined {
    const b = this.boundary(scopeOf(identity))
    if (!b || !this.exists('ledger_restore_observation_grants')) return undefined
    const row = this.db
      .prepare(
        'SELECT grant_id FROM ledger_restore_observation_grants WHERE authorization_id=? ORDER BY installed_at DESC,grant_id DESC LIMIT 1'
      )
      .get(b.package.authorization.authorizationId)
    if (!row) return undefined
    const g = this.readGrant(String(row.grant_id), b)
    return now >= g.issuedAt && now < g.expiresAt ? g : undefined
  }
  private frame(
    row: Record<string, unknown>,
    b: Boundary
  ): ReturnType<typeof SignedRestoreObservationSchema.parse> {
    if (typeof row.frame_json !== 'string' || Buffer.byteLength(row.frame_json) > 16384) conflict()
    const signed = SignedRestoreObservationSchema.parse(JSON.parse(row.frame_json)),
      p = signed.proof,
      g = this.readGrant(String(row.grant_id), b)
    if (
      hashContext(signed) !== row.frame_hash ||
      p.grantId !== g.grantId ||
      p.grantHash !== hashContext(g) ||
      p.conversationId !== row.conversation_id ||
      p.sourceMessageId !== row.source_id ||
      p.position !== Number(row.position) ||
      hashContext(scopeOf(p.identity)) !== hashContext(b.package.authorization.scope) ||
      p.capturedAt < g.issuedAt ||
      p.capturedAt >= g.expiresAt ||
      p.sentAt <= b.package.boundary.history.observedThrough ||
      p.sentAt > p.capturedAt ||
      !verify(
        null,
        restoreObservationSigningBytes(p),
        createPublicKey(g.sourceTrust.publicKeyPem),
        Buffer.from(signed.signature, 'base64url')
      )
    )
      conflict()
    return signed
  }
  classify(message: ObservedMessage, contentHash: string, now: number): boolean {
    const b = this.boundary(scopeOf(message.identity))
    if (!b) return false
    if (!message.identityVerified || !message.messageIdVerified) conflict()
    const old = b.anchors.get(message.conversationId)?.get(message.sourceMessageId)
    if (old) {
      if (old.direction !== message.direction || old.contentHash !== contentHash) conflict()
      return true
    }
    const auth = b.package.authorization.authorizationId
    if (this.exists('ledger_restore_ordered_observations')) {
      const row = this.db
        .prepare(
          'SELECT * FROM ledger_restore_ordered_observations WHERE authorization_id=? AND conversation_id=? AND source_id=?'
        )
        .get(auth, message.conversationId, message.sourceMessageId)
      if (row) {
        const p = this.frame(row, b).proof
        if (p.direction !== message.direction || p.contentHash !== contentHash) conflict()
        // A new login/client may reread an accepted message, but cannot acquire replay rights.
        return hashContext(p.identity) !== hashContext(message.identity)
      }
    }
    if (!message.restoreEvidence || !this.exists('ledger_restore_observation_grants'))
      throw new Error('restore_observation_evidence_required')
    const signed = SignedRestoreObservationSchema.parse(message.restoreEvidence),
      p = signed.proof,
      g = this.readGrant(p.grantId, b)
    if (
      !Number.isSafeInteger(now) ||
      now < g.issuedAt ||
      now >= g.expiresAt ||
      p.capturedAt > now ||
      hashContext(p.identity) !== hashContext(message.identity) ||
      p.conversationId !== message.conversationId ||
      p.sourceMessageId !== message.sourceMessageId ||
      p.direction !== message.direction ||
      p.contentHash !== contentHash
    )
      conflict()
    this.frame(
      {
        frame_json: JSON.stringify(signed),
        frame_hash: hashContext(signed),
        grant_id: p.grantId,
        conversation_id: p.conversationId,
        source_id: p.sourceMessageId,
        position: p.position
      },
      b
    )
    const last = this.db
      .prepare(
        'SELECT * FROM ledger_restore_ordered_observations WHERE authorization_id=? AND conversation_id=? ORDER BY position DESC LIMIT 1'
      )
      .get(auth, message.conversationId)
    const frontier = last ? this.frame(last, b).proof : b.frontiers.get(message.conversationId)
    if (
      p.position !== (frontier?.position ?? 0) + 1 ||
      p.previousSourceMessageId !== (frontier?.sourceMessageId ?? null) ||
      p.previousContentHash !== (frontier?.contentHash ?? null)
    )
      conflict()
    this.db
      .prepare('INSERT INTO ledger_restore_ordered_observations VALUES(?,?,?,?,?,?,?)')
      .run(
        auth,
        message.conversationId,
        message.sourceMessageId,
        p.position,
        p.grantId,
        hashContext(signed),
        JSON.stringify(signed)
      )
    return false
  }
}
