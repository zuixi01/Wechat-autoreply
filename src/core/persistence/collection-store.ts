import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { hashContext } from '../reply/hashes'
import {
  IdentitySchema,
  sameIdentity,
  type Identity,
  type ConversationBinding
} from '../../shared/contracts/identity'
import {
  CollectionEntrySchema,
  MessagePageSchema,
  type CollectionEntry,
  type CollectionReadRequest,
  type CollectionStatus,
  type MessagePage
} from '../../shared/contracts/collection'
import type { ObservedMessage } from '../../shared/contracts/message'
import type { RestoreObservationGrant } from '../../shared/contracts/restore-observation'

interface Scan {
  id: string
  snapshot: string | null
  cursor: string | null
  total: number | null
  pages: number
  authoritative: boolean
}
interface Observation {
  inserted: boolean
  hasGap: boolean
  historical?: boolean
}

/** Shares the ledger transaction: messages and source cursor commit together. */
export class CollectionStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly atomic: <T>(operation: () => T) => T,
    private readonly observe: (message: ObservedMessage) => Observation,
    private readonly markGap: (identity: Identity, conversationId: string) => void,
    private readonly restoreGrant: (
      identity: Identity
    ) => RestoreObservationGrant | undefined = () => undefined
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS collection_scopes (
        scope TEXT PRIMARY KEY, identity TEXT NOT NULL, scan TEXT,
        coverage TEXT NOT NULL DEFAULT 'not_started', reason TEXT NOT NULL DEFAULT 'none',
        last_completed INTEGER
      );
      CREATE TABLE IF NOT EXISTS collection_directory (
        scope TEXT NOT NULL REFERENCES collection_scopes(scope), conversation_id TEXT NOT NULL,
        entry TEXT NOT NULL, cursor TEXT, revision INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL CHECK(state IN ('pending','idle','human')),
        queued_order INTEGER NOT NULL, served_order INTEGER NOT NULL DEFAULT 0,
        read_pages INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(scope,conversation_id)
      );
      CREATE INDEX IF NOT EXISTS collection_pending ON collection_directory(scope,state,served_order,queued_order);
      CREATE TABLE IF NOT EXISTS collection_scan_items (
        scope TEXT NOT NULL, scan_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        PRIMARY KEY(scope,scan_id,conversation_id)
      );
      CREATE TABLE IF NOT EXISTS collection_scan_cursors (
        scope TEXT NOT NULL, scan_id TEXT NOT NULL, cursor TEXT NOT NULL,
        PRIMARY KEY(scope,scan_id,cursor)
      );
      CREATE TABLE IF NOT EXISTS collection_read_cursors (
        scope TEXT NOT NULL, conversation_id TEXT NOT NULL, cursor TEXT NOT NULL,
        PRIMARY KEY(scope,conversation_id,cursor)
      );
    `)
  }
  private scope(identity: Identity): string {
    const scope = hashContext(IdentitySchema.parse(identity))
    this.db
      .prepare('INSERT OR IGNORE INTO collection_scopes(scope,identity) VALUES(?,?)')
      .run(scope, JSON.stringify(identity))
    return scope
  }
  private order(): number {
    const value =
      Number(
        this.db.prepare("SELECT value FROM runtime_metadata WHERE key='collection_order'").get()
          ?.value ?? 0
      ) + 1
    this.db
      .prepare(
        "INSERT INTO runtime_metadata(key,value) VALUES('collection_order',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(value)
    return value
  }
  begin(identity: Identity): Scan {
    return this.atomic(() => {
      const scope = this.scope(identity)
      const scan: Scan = {
        id: randomUUID(),
        snapshot: null,
        cursor: null,
        total: null,
        pages: 0,
        authoritative: true
      }
      this.db.prepare('DELETE FROM collection_scan_items WHERE scope=?').run(scope)
      this.db.prepare('DELETE FROM collection_scan_cursors WHERE scope=?').run(scope)
      this.db
        .prepare(
          "UPDATE collection_scopes SET scan=?,coverage='scanning',reason='none' WHERE scope=?"
        )
        .run(JSON.stringify(scan), scope)
      return scan
    })
  }
  scan(identity: Identity): Scan | undefined {
    const row = this.db
      .prepare("SELECT scan FROM collection_scopes WHERE scope=? AND coverage='scanning'")
      .get(hashContext(identity))
    return row?.scan ? (JSON.parse(String(row.scan)) as Scan) : undefined
  }
  page(
    identity: Identity,
    scan: Scan,
    entries: CollectionEntry[],
    snapshot: string,
    cursor: string | null,
    total: number,
    authoritative: boolean,
    now: number
  ): void {
    this.atomic(() => {
      const scope = this.scope(identity)
      const current = this.scan(identity)
      if (!current || hashContext(current) !== hashContext(scan))
        throw new Error('inventory_changed')
      if (
        (scan.snapshot !== null && scan.snapshot !== snapshot) ||
        (scan.total !== null && scan.total !== total)
      )
        throw new Error('inventory_changed')
      if (
        cursor &&
        this.db
          .prepare('SELECT 1 FROM collection_scan_cursors WHERE scope=? AND scan_id=? AND cursor=?')
          .get(scope, scan.id, cursor)
      )
        throw new Error('no_progress')
      const priorCount = Number(
        this.db
          .prepare(
            'SELECT COUNT(*) AS count FROM collection_scan_items WHERE scope=? AND scan_id=?'
          )
          .get(scope, scan.id)!.count
      )
      for (const input of entries) {
        const entry = CollectionEntrySchema.parse(input)
        if (!sameIdentity(entry.binding.identity, identity)) throw new Error('identity_unverified')
        this.discover(identity, entry)
        this.db
          .prepare('INSERT OR IGNORE INTO collection_scan_items VALUES(?,?,?)')
          .run(scope, scan.id, entry.binding.conversationId)
      }
      const count = Number(
        this.db
          .prepare(
            'SELECT COUNT(*) AS count FROM collection_scan_items WHERE scope=? AND scan_id=?'
          )
          .get(scope, scan.id)!.count
      )
      if (count > total || (cursor && count === priorCount)) throw new Error('no_progress')
      if (cursor)
        this.db
          .prepare('INSERT INTO collection_scan_cursors VALUES(?,?,?)')
          .run(scope, scan.id, cursor)
      const next: Scan = {
        ...scan,
        snapshot,
        cursor,
        total,
        pages: scan.pages + 1,
        authoritative: scan.authoritative && authoritative
      }
      const complete = !cursor && next.authoritative && count === total
      this.db
        .prepare(
          'UPDATE collection_scopes SET scan=?,coverage=?,reason=?,last_completed=CASE WHEN ? THEN ? ELSE last_completed END WHERE scope=?'
        )
        .run(
          cursor ? JSON.stringify(next) : null,
          cursor ? 'scanning' : complete ? 'complete' : 'incomplete',
          cursor || complete ? 'none' : 'partial_inventory',
          complete ? 1 : 0,
          now,
          scope
        )
    })
  }
  private discover(identity: Identity, entry: CollectionEntry): void {
    const scope = this.scope(identity),
      id = entry.binding.conversationId
    const row = this.db
      .prepare('SELECT * FROM collection_directory WHERE scope=? AND conversation_id=?')
      .get(scope, id)
    if (!row) {
      this.db
        .prepare(
          'INSERT INTO collection_directory(scope,conversation_id,entry,state,queued_order) VALUES(?,?,?,?,?)'
        )
        .run(
          scope,
          id,
          JSON.stringify(entry),
          entry.binding.identityVerified ? 'pending' : 'human',
          this.order()
        )
      return
    }
    const old = CollectionEntrySchema.parse(JSON.parse(String(row.entry)))
    if (
      entry.binding.bindingVersion < old.binding.bindingVersion ||
      (entry.binding.bindingVersion === old.binding.bindingVersion &&
        hashContext(entry.binding) !== hashContext(old.binding))
    )
      throw new Error('identity_unverified')
    const changed = hashContext(entry) !== hashContext(old)
    // Recheck even unchanged activity: opening a chat can clear its unread badge.
    const state = !entry.binding.identityVerified
      ? 'human'
      : row.state === 'human'
        ? 'human'
        : 'pending'
    this.db
      .prepare(
        "UPDATE collection_directory SET entry=?,revision=revision+?,state=?,queued_order=CASE WHEN state='idle' THEN ? ELSE queued_order END,read_pages=CASE WHEN state='idle' THEN 0 ELSE read_pages END WHERE scope=? AND conversation_id=?"
      )
      .run(
        JSON.stringify(entry),
        changed || row.state === 'idle' ? 1 : 0,
        state,
        this.order(),
        scope,
        id
      )
    if (row.state === 'idle')
      this.db
        .prepare('DELETE FROM collection_read_cursors WHERE scope=? AND conversation_id=?')
        .run(scope, id)
  }
  hint(identity: Identity, id: string): boolean {
    return this.atomic(() => {
      const scope = this.scope(identity)
      const row = this.db
        .prepare('SELECT state FROM collection_directory WHERE scope=? AND conversation_id=?')
        .get(scope, id)
      if (!row) return false
      if (row.state === 'human') return true
      this.db
        .prepare(
          "UPDATE collection_directory SET state='pending',revision=revision+1,queued_order=CASE WHEN state='idle' THEN ? ELSE queued_order END,read_pages=CASE WHEN state='idle' THEN 0 ELSE read_pages END WHERE scope=? AND conversation_id=?"
        )
        .run(this.order(), scope, id)
      if (row.state === 'idle')
        this.db
          .prepare('DELETE FROM collection_read_cursors WHERE scope=? AND conversation_id=?')
          .run(scope, id)
      return true
    })
  }
  revalidate(identity: Identity): void {
    this.atomic(() => {
      const scope = this.scope(identity)
      this.db
        .prepare(
          "UPDATE collection_directory SET state='pending',revision=revision+1,read_pages=0 WHERE scope=? AND state='idle'"
        )
        .run(scope)
      this.db.prepare('DELETE FROM collection_read_cursors WHERE scope=?').run(scope)
    })
  }
  next(identity: Identity): CollectionReadRequest | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM collection_directory WHERE scope=? AND state='pending' ORDER BY served_order,queued_order,conversation_id LIMIT 1"
      )
      .get(hashContext(identity))
    return row
      ? {
          entry: CollectionEntrySchema.parse(JSON.parse(String(row.entry))),
          cursor: row.cursor === null ? null : String(row.cursor),
          revision: Number(row.revision),
          ...this.grantFor(identity)
        }
      : undefined
  }
  request(identity: Identity, id: string): CollectionReadRequest | undefined {
    const row = this.db
      .prepare('SELECT * FROM collection_directory WHERE scope=? AND conversation_id=?')
      .get(hashContext(identity), id)
    return row
      ? {
          entry: CollectionEntrySchema.parse(JSON.parse(String(row.entry))),
          cursor: row.cursor === null ? null : String(row.cursor),
          revision: Number(row.revision),
          ...this.grantFor(identity)
        }
      : undefined
  }
  bindings(identity: Identity): ConversationBinding[] {
    return this.db
      .prepare('SELECT entry FROM collection_directory WHERE scope=? ORDER BY conversation_id')
      .all(hashContext(identity))
      .map((row) => CollectionEntrySchema.parse(JSON.parse(String(row.entry))).binding)
  }
  private grantFor(identity: Identity): { restoreGrant?: RestoreObservationGrant } {
    const restoreGrant = this.restoreGrant(identity)
    return restoreGrant ? { restoreGrant } : {}
  }
  commit(
    identity: Identity,
    request: CollectionReadRequest,
    input: MessagePage,
    maximumPages: number
  ): {
    changed: ObservedMessage[]
    complete: boolean
    stale: boolean
    hasGap: boolean
  } {
    const page = MessagePageSchema.parse(input)
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') > 262144)
      throw new Error('message_page_too_large')
    const binding = request.entry.binding,
      id = binding.conversationId
    if (
      !sameIdentity(binding.identity, identity) ||
      hashContext(page.binding) !== hashContext(binding) ||
      page.messages.some((m) => !sameIdentity(m.identity, identity) || m.conversationId !== id)
    )
      throw new Error('identity_unverified')
    if (page.activityVersion !== request.entry.activityVersion) throw new Error('activity_changed')
    if (page.fromCursor !== request.cursor) throw new Error('message_cursor_mismatch')
    return this.atomic(() => {
      const scope = this.scope(identity)
      const row = this.db
        .prepare('SELECT * FROM collection_directory WHERE scope=? AND conversation_id=?')
        .get(scope, id)
      if (!row || row.state !== 'pending' || Number(row.revision) !== request.revision) {
        if (row?.state === 'pending')
          this.db
            .prepare(
              'UPDATE collection_directory SET served_order=? WHERE scope=? AND conversation_id=?'
            )
            .run(this.order(), scope, id)
        return { changed: [], complete: false, stale: true, hasGap: false }
      }
      if (
        !page.complete &&
        (!page.nextCursor ||
          page.nextCursor === request.cursor ||
          this.db
            .prepare(
              'SELECT 1 FROM collection_read_cursors WHERE scope=? AND conversation_id=? AND cursor=?'
            )
            .get(scope, id, page.nextCursor))
      )
        throw new Error('no_progress')
      if (!page.complete && Number(row.read_pages) + 1 >= maximumPages)
        throw new Error('limit_reached')
      const changed: ObservedMessage[] = []
      let gap = page.hasGap || !binding.identityVerified
      for (const message of page.messages) {
        const result = this.observe(message)
        gap ||= result.hasGap
        if (!result.historical && (result.inserted || result.hasGap)) changed.push(message)
      }
      if (gap) this.markGap(identity, id)
      if (!page.complete && page.nextCursor)
        this.db
          .prepare('INSERT INTO collection_read_cursors VALUES(?,?,?)')
          .run(scope, id, page.nextCursor)
      this.db
        .prepare(
          'UPDATE collection_directory SET cursor=?,state=?,revision=revision+1,served_order=?,read_pages=read_pages+1 WHERE scope=? AND conversation_id=?'
        )
        .run(
          page.nextCursor,
          gap ? 'human' : page.complete ? 'idle' : 'pending',
          this.order(),
          scope,
          id
        )
      return { changed, complete: page.complete && !gap, stale: false, hasGap: gap }
    })
  }
  failRead(identity: Identity, id: string): void {
    this.atomic(() => {
      this.db
        .prepare(
          "UPDATE collection_directory SET state='human',revision=revision+1 WHERE scope=? AND conversation_id=?"
        )
        .run(hashContext(identity), id)
      this.markGap(identity, id)
    })
  }
  interrupt(identity: Identity, reason: CollectionStatus['reason']): void {
    this.db
      .prepare(
        "UPDATE collection_scopes SET scan=NULL,coverage='incomplete',reason=? WHERE scope=?"
      )
      .run(reason, this.scope(identity))
  }
  ready(identity: Identity, id: string): boolean {
    const row = this.db
      .prepare('SELECT state FROM collection_directory WHERE scope=? AND conversation_id=?')
      .get(hashContext(identity), id)
    return !row || row.state === 'idle'
  }
  status(identity: Identity): CollectionStatus {
    const scope = hashContext(identity)
    const row = this.db.prepare('SELECT * FROM collection_scopes WHERE scope=?').get(scope)
    const counts = this.db
      .prepare(
        "SELECT COUNT(*) AS known,SUM(state='pending') AS pending,SUM(state='human') AS human FROM collection_directory WHERE scope=?"
      )
      .get(scope)!
    return {
      coverage: (row?.coverage ?? 'not_started') as CollectionStatus['coverage'],
      reason: (row?.reason ?? 'none') as CollectionStatus['reason'],
      knownConversations: Number(counts.known),
      pendingReads: Number(counts.pending ?? 0),
      needsHuman: Number(counts.human ?? 0),
      lastCompletedAt: row?.last_completed == null ? null : Number(row.last_completed)
    }
  }
}
