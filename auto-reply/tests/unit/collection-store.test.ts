import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from '../../src/core/persistence/ledger'
import { taskFixture } from '../fixtures/task'
import { SyntheticCollectionSource } from '../fixtures/collection'

const ledgers: Ledger[] = [],
  directories: string[] = []
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function fixture(path = ':memory:') {
  const identity = taskFixture().task.identity,
    source = new SyntheticCollectionSource(identity, 2)
  source.add('customer-0')
  source.add('customer-1')
  const ledger = new Ledger(path)
  ledgers.push(ledger)
  const scan = ledger.collection.begin(identity)
  const page = await source.inventory(
    { identity, snapshotId: null, cursor: null },
    new AbortController().signal
  )
  ledger.collection.page(
    identity,
    scan,
    page.entries,
    page.snapshotId,
    page.nextCursor,
    page.total,
    page.authoritative,
    10000
  )
  return { identity, source, ledger }
}
describe('atomic durable collection cursor and message catalogue', () => {
  it('rotates a stale read behind other customers without moving its checkpoint', async () => {
    const f = await fixture(),
      request = f.ledger.collection.next(f.identity)!
    const page = await f.source.read(request, new AbortController().signal)
    f.ledger.collection.hint(f.identity, 'customer-0')
    expect(f.ledger.collection.commit(f.identity, request, page, 100).stale).toBe(true)
    expect(f.ledger.collection.request(f.identity, 'customer-0')!.cursor).toBeNull()
    expect(f.ledger.collection.next(f.identity)!.entry.binding.conversationId).toBe('customer-1')
  })
  it('gives each fresh event drain its own page budget', async () => {
    const f = await fixture()
    const drain = async () => {
      const request = f.ledger.collection.request(f.identity, 'customer-0')!
      return f.ledger.collection.commit(
        f.identity,
        request,
        await f.source.read(request, new AbortController().signal),
        3
      )
    }
    await drain()
    for (let i = 0; i < 3; i++) {
      f.source.add('customer-0')
      f.ledger.collection.hint(f.identity, 'customer-0')
      await drain()
    }
    f.source.messagePageSize = 1
    f.source.add('customer-0')
    f.source.add('customer-0')
    f.ledger.collection.hint(f.identity, 'customer-0')
    expect((await drain()).complete).toBe(false)
    expect((await drain()).complete).toBe(true)
    expect(f.ledger.snapshot(f.identity, 'customer-0').messages).toHaveLength(6)
  })
  it('keeps same names and source IDs isolated and never treats a cleared badge as processed', async () => {
    const f = await fixture()
    for (let i = 0; i < 2; i++) {
      const request = f.ledger.collection.next(f.identity)!
      f.ledger.collection.commit(
        f.identity,
        request,
        await f.source.read(request, new AbortController().signal),
        100
      )
    }
    for (let i = 0; i < 2; i++) {
      const messages = f.ledger.snapshot(f.identity, `customer-${i}`).messages
      expect(messages).toHaveLength(1)
      expect(messages[0].handledBy).toBeNull()
    }
    expect(f.ledger.collection.status(f.identity)).toMatchObject({
      coverage: 'complete',
      knownConversations: 2,
      pendingReads: 0
    })
  })
  it('rejects a read superseded by a hint without advancing cursor or losing the new message', async () => {
    const f = await fixture(),
      req = f.ledger.collection.next(f.identity)!
    const page = await f.source.read(req, new AbortController().signal)
    f.ledger.collection.hint(f.identity, req.entry.binding.conversationId)
    expect(f.ledger.collection.commit(f.identity, req, page, 100)).toMatchObject({ stale: true })
    expect(f.ledger.collection.next(f.identity)!.cursor).toBeNull()
    expect(f.ledger.snapshot(f.identity, req.entry.binding.conversationId).messages).toHaveLength(0)
  })
  it('rolls back messages with the cursor when SQLite fails at the checkpoint update', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autoreply-collection-rollback-'))
    directories.push(dir)
    const path = join(dir, 'ledger.sqlite'),
      f = await fixture(path)
    const db = new DatabaseSync(path)
    db.exec(
      "CREATE TRIGGER collection_failure BEFORE UPDATE OF cursor ON collection_directory BEGIN SELECT RAISE(ABORT,'synthetic disk error'); END;"
    )
    db.close()
    const req = f.ledger.collection.next(f.identity)!,
      page = await f.source.read(req, new AbortController().signal)
    expect(() => f.ledger.collection.commit(f.identity, req, page, 100)).toThrow(
      'synthetic disk error'
    )
    expect(f.ledger.snapshot(f.identity, req.entry.binding.conversationId).messages).toHaveLength(0)
    expect(f.ledger.collection.next(f.identity)!.cursor).toBeNull()
  })
  it('survives disk restart, revalidates before automation, and separates login/client epochs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autoreply-collection-restart-'))
    directories.push(dir)
    const path = join(dir, 'ledger.sqlite'),
      f = await fixture(path)
    const req = f.ledger.collection.next(f.identity)!
    f.ledger.collection.commit(
      f.identity,
      req,
      await f.source.read(req, new AbortController().signal),
      100
    )
    f.ledger.close()
    ledgers.splice(ledgers.indexOf(f.ledger), 1)
    const restarted = new Ledger(path)
    ledgers.push(restarted)
    expect(restarted.collection.ready(f.identity, 'customer-0')).toBe(true)
    restarted.collection.revalidate(f.identity)
    expect(restarted.collection.ready(f.identity, 'customer-0')).toBe(false)
    expect(restarted.collection.request(f.identity, 'customer-0')!.cursor).toBe('1')
    expect(restarted.collection.status({ ...f.identity, loginEpoch: 2 })).toMatchObject({
      knownConversations: 0
    })
    expect(restarted.collection.status({ ...f.identity, platform: 'wechat' })).toMatchObject({
      knownConversations: 0
    })
    expect(restarted.snapshot(f.identity, 'customer-0').messages).toHaveLength(1)
  })
  it('rejects cross-tenant/customer pages before changing either cursor or messages', async () => {
    const f = await fixture(),
      req = f.ledger.collection.next(f.identity)!
    const page = await f.source.read(req, new AbortController().signal)
    expect(() =>
      f.ledger.collection.commit(
        f.identity,
        req,
        { ...page, messages: [{ ...page.messages[0], conversationId: 'other' }] },
        100
      )
    ).toThrow('identity_unverified')
    expect(f.ledger.collection.next(f.identity)!.cursor).toBeNull()
  })
  it('rotates long message histories behind waiting customers and detects cursor cycles', async () => {
    const f = await fixture()
    f.source.messagePageSize = 1
    f.source.add('customer-0', '第二条')
    f.source.add('customer-0', '第三条')
    const first = f.ledger.collection.next(f.identity)!
    f.ledger.collection.commit(
      f.identity,
      first,
      await f.source.read(first, new AbortController().signal),
      100
    )
    expect(f.ledger.collection.next(f.identity)!.entry.binding.conversationId).toBe('customer-1')
    const other = f.ledger.collection.next(f.identity)!
    f.ledger.collection.commit(
      f.identity,
      other,
      await f.source.read(other, new AbortController().signal),
      100
    )
    const second = f.ledger.collection.next(f.identity)!
    f.ledger.collection.commit(
      f.identity,
      second,
      await f.source.read(second, new AbortController().signal),
      100
    )
    const third = f.ledger.collection.next(f.identity)!,
      page = await f.source.read(third, new AbortController().signal)
    expect(() =>
      f.ledger.collection.commit(
        f.identity,
        third,
        { ...page, nextCursor: '1', complete: false },
        100
      )
    ).toThrow('no_progress')
  })
})
