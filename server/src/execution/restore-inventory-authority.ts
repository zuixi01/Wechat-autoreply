import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { AccountAuthority, type Scope } from '../auth/account-authority'
import { readRestorePauseDetail } from '../admin/restore-pause-reports'
import { DeviceScopeSchema } from '../../../src/shared/contracts/registration'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  RestoreInventoryStartSchema,
  RestoreInventoryPageSchema,
  RestoreInventoryCompleteSchema,
  RestoreInventoryManifestSchema,
  RestoreInventoryItemSchema,
  RestoreInventoryCompleteAckSchema,
  RestoreInventoryStartAckSchema,
  RestoreInventoryPageAckSchema,
  type RestoreInventoryManifest,
  type RestoreInventoryItem,
  type RestoreInventoryCompleteAck
} from '../../../src/shared/contracts/restore-inventory'

export class RestoreInventoryError extends Error {
  constructor(readonly code: 'RESTORE_INVENTORY_CONFLICT' | 'RESTORE_INVENTORY_NOT_READY') {
    super(code)
    this.name = 'RestoreInventoryError'
  }
}
export interface RestoreInventoryUploadRow {
  id: string
  case_id: string
  agent_id: string
  challenge_id: string
  manifest_json: unknown
  manifest_hash: string
  issued_at: Date
  expires_at: Date
}
function conflict(): never {
  throw new RestoreInventoryError('RESTORE_INVENTORY_CONFLICT')
}
function invalid(): never {
  throw new z.ZodError([{ code: 'custom', path: [], message: 'invalid_inventory_binding' }])
}
export function validateRestoreInventoryItem(
  item: RestoreInventoryItem,
  manifest: RestoreInventoryManifest
): void {
  const { identity } = item,
    scope = manifest.scope
  if (
    identity.tenantId !== scope.tenant_id ||
    identity.employeeId !== scope.employee_id ||
    identity.accountId !== scope.account_id ||
    identity.agentId !== scope.agent_id ||
    identity.platform !== scope.platform
  )
    invalid()
  const expectedKey =
    item.kind === 'message'
      ? `m:${hashContext({ identity, conversationId: item.conversationId })}:${String(item.sequence).padStart(16, '0')}`
      : `s:${item.executionId}`
  if (item.key !== expectedKey || (item.kind === 'message' && item.sequence > item.lastSequence))
    invalid()
}
export function validateRestoreInventoryManifest(input: unknown): RestoreInventoryManifest {
  const manifest = RestoreInventoryManifestSchema.parse(input)
  const { contextHash, ...descriptor } = manifest.context
  if (hashContext(descriptor) !== contextHash) invalid()
  return manifest
}
/** Checks both immutable pages and materialized items, including sequence/range claims. */
export async function verifyStoredRestoreInventory(
  db: PoolClient,
  s: { tenant_id: string; account_id: string },
  uploadId: string,
  manifest: RestoreInventoryManifest,
  pageCount: number
): Promise<number> {
  const seed = hashContext({ formatVersion: 1, context: manifest.context, scope: manifest.scope })
  const pageDigest = createHash('sha256').update(seed),
    itemDigest = createHash('sha256').update(seed)
  const summary = {
    conversations: 0,
    messages: 0,
    inbound: 0,
    handledInbound: 0,
    unhandledInbound: 0,
    executions: 0,
    unknownExecutions: 0,
    pendingCentral: 0
  }
  const conversations = new Set<string>(),
    sourceIds = new Set<string>(),
    counts = new Map<
      string,
      { count: number; max: number; last: number; complete: boolean; snapshotHash: string }
    >()
  let nextPage = 0,
    lastKey: string | null = null
  for (;;) {
    const rows = (
      await db.query(
        'SELECT page_index,page_hash,page_json FROM ledger_restore_inventory_pages WHERE tenant_id=$1 AND account_id=$2 AND upload_id=$3 AND page_index>=$4 ORDER BY page_index LIMIT 50',
        [s.tenant_id, s.account_id, uploadId, nextPage]
      )
    ).rows
    for (const saved of rows) {
      const page = RestoreInventoryPageSchema.parse(saved.page_json)
      if (
        page.uploadId !== uploadId ||
        page.index !== nextPage ||
        saved.page_index !== nextPage ||
        hashContext(page) !== saved.page_hash
      )
        conflict()
      nextPage++
      for (const item of page.items) {
        validateRestoreInventoryItem(item, manifest)
        if (lastKey && lastKey >= item.key) conflict()
        lastKey = item.key
        pageDigest.update(hashContext(item))
        const conversationKey = hashContext({
          identity: item.identity,
          conversationId: item.conversationId
        })
        if (item.kind === 'message' || item.conversation) conversations.add(conversationKey)
        if (item.kind === 'message') {
          const old = counts.get(conversationKey)
          const snapshotHash = hashContext({
            lastSequence: item.lastSequence,
            revision: item.revision,
            hasGap: item.hasGap,
            humanOwned: item.humanOwned,
            sequenceComplete: item.sequenceComplete
          })
          const sourceId = hashContext({ conversationKey, sourceMessageId: item.sourceMessageId })
          if (sourceIds.has(sourceId) || (old && old.snapshotHash !== snapshotHash)) conflict()
          sourceIds.add(sourceId)
          counts.set(conversationKey, {
            count: (old?.count ?? 0) + 1,
            max: item.sequence,
            last: item.lastSequence,
            complete: item.sequenceComplete,
            snapshotHash
          })
          summary.messages++
          if (item.direction === 'inbound') {
            summary.inbound++
            if (item.handledBy === null) summary.unhandledInbound++
            else summary.handledInbound++
          }
        } else {
          summary.executions++
          if (
            item.status === 'unknown' ||
            item.receiptStatus === 'unknown' ||
            item.permitStatus === 'unknown'
          )
            summary.unknownExecutions++
          if (item.phase !== null && item.phase !== 'settled') summary.pendingCentral++
          const messages = counts.get(conversationKey)
          if (
            messages &&
            (!item.conversation || hashContext(item.conversation) !== messages.snapshotHash)
          )
            conflict()
          if (
            item.conversation &&
            (item.conversation.sequenceComplete !==
              ((messages?.count ?? 0) === item.conversation.lastSequence) ||
              (messages && item.conversation.lastSequence !== messages.last))
          )
            conflict()
          const prefix = `m:${conversationKey}:`
          const actual = (
            await db.query(
              'SELECT count(*)::int AS count FROM ledger_restore_inventory_items WHERE tenant_id=$1 AND account_id=$2 AND upload_id=$3 AND item_key>=($4::text COLLATE "C") AND item_key<=($5::text COLLATE "C")',
              [
                s.tenant_id,
                s.account_id,
                uploadId,
                prefix + String(item.inboundRange.from).padStart(16, '0'),
                prefix + String(item.inboundRange.to).padStart(16, '0')
              ]
            )
          ).rows[0].count
          if (
            item.localRangePresent !==
            (actual === item.inboundRange.to - item.inboundRange.from + 1)
          )
            conflict()
        }
        if (summary.messages + summary.executions > 2000000) conflict()
      }
    }
    if (rows.length < 50) break
  }
  for (const c of counts.values())
    if (c.complete !== (c.count === c.last && c.max === c.last)) conflict()
  summary.conversations = conversations.size
  if (
    nextPage !== pageCount ||
    hashContext(summary) !== hashContext(manifest.summary) ||
    pageDigest.update(hashContext(summary)).digest('hex') !== manifest.basisHash
  )
    conflict()
  let after: string | null = null,
    itemCount = 0
  for (;;) {
    const rows: { item_key: string; item_hash: string; item_json: unknown }[] = (
      await db.query(
        'SELECT item_key,item_hash,item_json FROM ledger_restore_inventory_items WHERE tenant_id=$1 AND account_id=$2 AND upload_id=$3 AND ($4::text IS NULL OR item_key>$4 COLLATE "C") ORDER BY item_key LIMIT 500',
        [s.tenant_id, s.account_id, uploadId, after]
      )
    ).rows
    for (const saved of rows) {
      const item = RestoreInventoryItemSchema.parse(saved.item_json)
      validateRestoreInventoryItem(item, manifest)
      if (
        saved.item_key !== item.key ||
        saved.item_hash !== hashContext(item) ||
        (after && after >= item.key)
      )
        conflict()
      after = item.key
      itemDigest.update(saved.item_hash)
      itemCount++
      if (itemCount > 2000000) conflict()
    }
    if (rows.length < 500) break
  }
  if (
    itemCount !== summary.messages + summary.executions ||
    itemDigest.update(hashContext(summary)).digest('hex') !== manifest.basisHash
  )
    conflict()
  return itemCount
}
/** Append-only authenticated metadata. Completeness is never physical send evidence. */
export class RestoreInventoryAuthority {
  constructor(private readonly authority: AccountAuthority) {}
  private async ready(db: PoolClient, s: Scope): Promise<number> {
    await db.query(
      "SELECT set_config('app.restore_account_id',$1,true),set_config('app.restore_agent_id',$2,true)",
      [s.account_id, s.agent_id]
    )
    const row = (
      await db.query(
        `SELECT paused,floor(extract(epoch FROM clock_timestamp())*1000)::text AS now,
      EXISTS(SELECT 1 FROM account_leases WHERE tenant_id=$1 AND account_id=$2 AND expires_at>clock_timestamp()) AS live_lease,
      EXISTS(SELECT 1 FROM execution_permits WHERE tenant_id=$1 AND account_id=$2 AND status='issued' AND (expires_at IS NULL OR expires_at>clock_timestamp())) AS live_permit
      FROM accounts WHERE tenant_id=$1 AND id=$2`,
        [s.tenant_id, s.account_id]
      )
    ).rows[0]
    if (!row?.paused || row.live_lease || row.live_permit)
      throw new RestoreInventoryError('RESTORE_INVENTORY_NOT_READY')
    return Number(row.now)
  }
  private async bound(
    db: PoolClient,
    s: Scope,
    row: RestoreInventoryUploadRow
  ): Promise<RestoreInventoryManifest> {
    const manifest = validateRestoreInventoryManifest(row.manifest_json)
    if (
      row.agent_id !== s.agent_id ||
      hashContext(DeviceScopeSchema.parse(s)) !== hashContext(manifest.scope) ||
      hashContext(manifest) !== row.manifest_hash
    )
      conflict()
    try {
      const pause = await readRestorePauseDetail(
        db,
        { tenant_id: s.tenant_id, actor_id: s.agent_id },
        s.account_id,
        row.case_id,
        row.challenge_id
      )
      if (
        pause.restoreId !== manifest.context.restoreId ||
        pause.contextHash !== manifest.context.contextHash ||
        pause.agentId !== s.agent_id
      )
        conflict()
    } catch {
      conflict()
    }
    return manifest
  }
  private async upload(db: PoolClient, s: Scope, id: string): Promise<RestoreInventoryUploadRow> {
    const row = (
      await db.query<RestoreInventoryUploadRow>(
        'SELECT * FROM ledger_restore_inventory_uploads WHERE tenant_id=$1 AND account_id=$2 AND id=$3 AND agent_id=$4',
        [s.tenant_id, s.account_id, id, s.agent_id]
      )
    ).rows[0]
    if (!row) conflict()
    return row
  }
  private ack(row: RestoreInventoryUploadRow): z.infer<typeof RestoreInventoryStartAckSchema> {
    return {
      uploadId: row.id,
      manifestHash: row.manifest_hash,
      issuedAt: new Date(row.issued_at).getTime(),
      expiresAt: new Date(row.expires_at).getTime()
    }
  }
  async start(
    credential: string,
    input: unknown
  ): Promise<z.infer<typeof RestoreInventoryStartAckSchema>> {
    const request = RestoreInventoryStartSchema.parse(input),
      manifest = validateRestoreInventoryManifest(request.manifest)
    return this.authority.withLockedAccount(
      credential,
      async (db, s) => {
        const now = await this.ready(db, s)
        const old = (
          await db.query<RestoreInventoryUploadRow>(
            'SELECT * FROM ledger_restore_inventory_uploads WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND request_id=$4',
            [s.tenant_id, s.account_id, request.caseId, request.requestId]
          )
        ).rows[0]
        const row: RestoreInventoryUploadRow = old ?? {
          id: randomUUID(),
          case_id: request.caseId,
          agent_id: s.agent_id,
          challenge_id: request.challengeId,
          manifest_json: manifest,
          manifest_hash: hashContext(manifest),
          issued_at: new Date(now),
          expires_at: new Date(now + 900000)
        }
        if (row.challenge_id !== request.challengeId || row.manifest_hash !== hashContext(manifest))
          conflict()
        await this.bound(db, s, row)
        if (!old)
          await db.query(
            `INSERT INTO ledger_restore_inventory_uploads(tenant_id,account_id,id,agent_id,case_id,request_id,challenge_id,manifest_hash,manifest_json,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
            [
              s.tenant_id,
              s.account_id,
              row.id,
              s.agent_id,
              request.caseId,
              request.requestId,
              request.challengeId,
              row.manifest_hash,
              JSON.stringify(manifest),
              row.issued_at,
              row.expires_at
            ]
          )
        return this.ack(row)
      },
      true
    )
  }
  async page(
    credential: string,
    input: unknown
  ): Promise<z.infer<typeof RestoreInventoryPageAckSchema>> {
    const page = RestoreInventoryPageSchema.parse(input),
      pageHash = hashContext(page)
    return this.authority.withLockedAccount(
      credential,
      async (db, s) => {
        const now = await this.ready(db, s),
          row = await this.upload(db, s, page.uploadId),
          manifest = await this.bound(db, s, row)
        for (const item of page.items) validateRestoreInventoryItem(item, manifest)
        const old = (
          await db.query(
            'SELECT page_hash,page_json FROM ledger_restore_inventory_pages WHERE tenant_id=$1 AND account_id=$2 AND upload_id=$3 AND page_index=$4',
            [s.tenant_id, s.account_id, page.uploadId, page.index]
          )
        ).rows[0]
        if (old) {
          if (old.page_hash !== pageHash || hashContext(old.page_json) !== pageHash) conflict()
        } else {
          if (now >= new Date(row.expires_at).getTime())
            throw new RestoreInventoryError('RESTORE_INVENTORY_NOT_READY')
          if (
            (
              await db.query(
                'SELECT 1 FROM ledger_restore_inventory_receipts WHERE tenant_id=$1 AND account_id=$2 AND upload_id=$3',
                [s.tenant_id, s.account_id, page.uploadId]
              )
            ).rowCount
          )
            conflict()
          const previous = (
            await db.query(
              'SELECT count(*)::int AS count,max(page_index) AS last FROM ledger_restore_inventory_pages WHERE tenant_id=$1 AND account_id=$2 AND upload_id=$3',
              [s.tenant_id, s.account_id, page.uploadId]
            )
          ).rows[0]
          if (previous.count !== page.index || (page.index > 0 && previous.last !== page.index - 1))
            conflict()
          const items = (
            await db.query(
              'SELECT count(*)::int AS count,max(item_key) AS last FROM ledger_restore_inventory_items WHERE tenant_id=$1 AND account_id=$2 AND upload_id=$3',
              [s.tenant_id, s.account_id, page.uploadId]
            )
          ).rows[0]
          if (
            (items.last && items.last >= page.items[0].key) ||
            items.count + page.items.length >
              manifest.summary.messages + manifest.summary.executions
          )
            conflict()
          await db.query(
            'INSERT INTO ledger_restore_inventory_pages(tenant_id,account_id,upload_id,agent_id,page_index,page_hash,page_json) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
            [
              s.tenant_id,
              s.account_id,
              page.uploadId,
              s.agent_id,
              page.index,
              pageHash,
              JSON.stringify(page)
            ]
          )
          await db.query(
            `INSERT INTO ledger_restore_inventory_items(tenant_id,account_id,upload_id,agent_id,page_index,item_key,item_hash,item_json)
          SELECT $1,$2,$3,$4,$5,x->>'key',x->>'hash',x->'item' FROM jsonb_array_elements($6::jsonb) x`,
            [
              s.tenant_id,
              s.account_id,
              page.uploadId,
              s.agent_id,
              page.index,
              JSON.stringify(
                page.items.map((item) => ({ key: item.key, hash: hashContext(item), item }))
              )
            ]
          )
        }
        return {
          uploadId: page.uploadId,
          index: page.index,
          pageHash,
          itemCount: page.items.length
        }
      },
      true
    )
  }
  async complete(credential: string, input: unknown): Promise<RestoreInventoryCompleteAck> {
    const request = RestoreInventoryCompleteSchema.parse(input)
    return this.authority.withLockedAccount(
      credential,
      async (db, s) => {
        const now = await this.ready(db, s),
          row = await this.upload(db, s, request.uploadId),
          manifest = await this.bound(db, s, row)
        const old = (
          await db.query(
            'SELECT receipt_hash,receipt_json FROM ledger_restore_inventory_receipts WHERE tenant_id=$1 AND account_id=$2 AND upload_id=$3',
            [s.tenant_id, s.account_id, request.uploadId]
          )
        ).rows[0]
        if (old) {
          const receipt = RestoreInventoryCompleteAckSchema.parse(old.receipt_json)
          if (
            hashContext(receipt) !== old.receipt_hash ||
            receipt.pageCount !== request.pageCount ||
            receipt.uploadId !== row.id ||
            receipt.manifestHash !== row.manifest_hash ||
            receipt.basisHash !== manifest.basisHash ||
            receipt.itemCount !== manifest.summary.messages + manifest.summary.executions
          )
            conflict()
          await verifyStoredRestoreInventory(db, s, row.id, manifest, request.pageCount)
          return receipt
        }
        if (now >= new Date(row.expires_at).getTime())
          throw new RestoreInventoryError('RESTORE_INVENTORY_NOT_READY')
        const itemCount = await verifyStoredRestoreInventory(
          db,
          s,
          row.id,
          manifest,
          request.pageCount
        )
        const receipt = RestoreInventoryCompleteAckSchema.parse({
          uploadId: row.id,
          manifestHash: row.manifest_hash,
          basisHash: manifest.basisHash,
          itemCount,
          pageCount: request.pageCount,
          status: 'inventory_received',
          canRelease: false,
          externalEvidenceRequired: true
        })
        await db.query(
          'INSERT INTO ledger_restore_inventory_receipts(tenant_id,account_id,upload_id,agent_id,receipt_hash,receipt_json) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
          [
            s.tenant_id,
            s.account_id,
            row.id,
            s.agent_id,
            hashContext(receipt),
            JSON.stringify(receipt)
          ]
        )
        await db.query(
          "INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id,details_json) VALUES($1,$2,$3,'ledger_restore_inventory_received',$4,$5::jsonb)",
          [
            s.tenant_id,
            randomUUID(),
            s.agent_id,
            s.account_id,
            JSON.stringify({
              uploadId: row.id,
              caseId: row.case_id,
              manifestHash: row.manifest_hash,
              basisHash: manifest.basisHash,
              itemCount: receipt.itemCount
            })
          ]
        )
        return receipt
      },
      true
    )
  }
}
