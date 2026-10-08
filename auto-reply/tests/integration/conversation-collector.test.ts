import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationCollector } from '../../src/core/agent/conversation-collector'
import { Ledger } from '../../src/core/persistence/ledger'
import { SyntheticCollectionSource } from '../fixtures/collection'
import { taskFixture } from '../fixtures/task'
import type { CollectionEvents } from '../../src/core/agent/conversation-collector'
import type { CollectionTimingEvent } from '../../src/core/agent/conversation-collector'

const collectors: ConversationCollector[] = [],
  ledgers: Ledger[] = []
afterEach(async () => {
  for (const collector of collectors.splice(0)) await collector.stop()
  for (const ledger of ledgers.splice(0)) ledger.close()
  vi.useRealTimers()
})
function fixture(
  count = 500,
  platform: 'wechat' | 'wework' = 'wechat',
  onTiming?: (event: CollectionTimingEvent) => void
) {
  vi.useFakeTimers()
  vi.setSystemTime(10000)
  const identity = { ...taskFixture().task.identity, platform }
  const source = new SyntheticCollectionSource(identity, count),
    ledger = new Ledger(':memory:')
  ledgers.push(ledger)
  const events: CollectionEvents = {
    onBindings: vi.fn(),
    onRead: vi.fn(),
    onPending: vi.fn(),
    onFailure: vi.fn(),
    ...{ onTiming }
  }
  const collector = new ConversationCollector(
    ledger,
    identity,
    source,
    events,
    {
      pollMs: 10,
      sweepIntervalMs: 2000,
      inventoryPagesPerTick: 2,
      readsPerTick: 8,
      operationTimeoutMs: 100
    },
    Date.now,
    Date.now
  )
  collectors.push(collector)
  return { source, ledger, identity, collector, events }
}
describe('bounded complete multi-conversation collection', () => {
  it('times the trusted read before transport and binds committed source IDs without customer text', async () => {
    const timings: CollectionTimingEvent[] = []
    const f = fixture(1, 'wechat', (event) => timings.push(event))
    f.source.add('customer-0', 'SYNTHETIC_PRIVATE_READ_TEXT')
    const read = f.source.read.bind(f.source)
    vi.spyOn(f.source, 'read').mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return read(...args)
    })
    const started = f.collector.start(new AbortController().signal)
    await vi.advanceTimersByTimeAsync(20)
    await started
    expect(timings.map((event) => event.stage)).toEqual(['read_started', 'read_completed'])
    expect(timings[1].atMs - timings[0].atMs).toBe(20)
    expect(timings[1].readId).toBe(timings[0].readId)
    expect(timings[1].sourceMessageIds).toEqual([
      f.source.history.get('customer-0')![0].sourceMessageId
    ])
    expect(JSON.stringify(timings)).not.toContain('SYNTHETIC_PRIVATE_READ_TEXT')
  })

  it.each(['wechat', 'wework'] as const)(
    'collects 500 %s conversations, including offscreen and same-name customers',
    async (platform) => {
      const f = fixture(500, platform)
      for (const entry of f.source.entries) f.source.add(entry.binding.conversationId)
      await f.collector.start(new AbortController().signal)
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.collector.status()).toMatchObject({
        coverage: 'complete',
        knownConversations: 500,
        pendingReads: 0,
        needsHuman: 0
      })
      expect(f.source.inventoryCalls).toBe(13)
      expect(f.source.readCalls).toHaveLength(500)
      for (let i = 0; i < 500; i++)
        expect(f.ledger.snapshot(f.identity, `customer-${i}`).messages).toHaveLength(1)
      expect(f.events.onFailure).not.toHaveBeenCalled()
    }
  )
  it('periodic sweeps recover muted/mark-read messages without any event or badge change', async () => {
    const f = fixture(70)
    await f.collector.start(new AbortController().signal)
    await vi.advanceTimersByTimeAsync(200)
    f.source.add('customer-69', '没有事件和红点的合成新消息')
    await vi.advanceTimersByTimeAsync(2200)
    expect(f.ledger.snapshot(f.identity, 'customer-69').messages[0].text).toContain('没有事件')
  })
  it('events wake known customers and unknown customers request a fresh inventory', async () => {
    const f = fixture(1)
    await f.collector.start(new AbortController().signal)
    f.source.add('customer-0')
    f.source.emit('customer-0')
    expect(f.ledger.collection.ready(f.identity, 'customer-0')).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    expect(f.ledger.snapshot(f.identity, 'customer-0').messages).toHaveLength(1)
    const newEntry = {
      ...f.source.entries[0],
      binding: { ...f.source.entries[0].binding, conversationId: 'new-customer' }
    }
    f.source.entries.push(newEntry)
    f.source.history.set('new-customer', [])
    f.source.add('new-customer')
    f.source.snapshotId = 'synthetic-inventory-2'
    f.source.emit('new-customer')
    await vi.advanceTimersByTimeAsync(30)
    expect(f.ledger.snapshot(f.identity, 'new-customer').messages).toHaveLength(1)
  })
  it('reports changed inventories as incomplete, then rebuilds rather than skipping shifted rows', async () => {
    const f = fixture(150)
    await f.collector.start(new AbortController().signal)
    f.source.entries.reverse()
    f.source.snapshotId = 'synthetic-reordered'
    await vi.advanceTimersByTimeAsync(10)
    expect(f.collector.status()).toMatchObject({
      coverage: 'incomplete',
      reason: 'inventory_changed'
    })
    await vi.advanceTimersByTimeAsync(2200)
    expect(f.collector.status()).toMatchObject({ coverage: 'complete', knownConversations: 150 })
  })
  it('deduplicates overlapping pages and never claims partial viewport coverage is complete', async () => {
    const f = fixture(100)
    const native = f.source.inventory.bind(f.source)
    vi.spyOn(f.source, 'inventory').mockImplementation(async (input, signal) => {
      const page = await native(input, signal),
        offset = Number(input.cursor ?? 0)
      if (offset > 0)
        page.entries.unshift(...structuredClone(f.source.entries.slice(offset - 2, offset)))
      page.authoritative = false
      return page
    })
    await f.collector.start(new AbortController().signal)
    await vi.advanceTimersByTimeAsync(200)
    expect(f.collector.status()).toMatchObject({
      knownConversations: 100,
      coverage: 'incomplete',
      reason: 'partial_inventory',
      pendingReads: 0
    })
  })
  it('stalled cursors are finite and retain discovered work', async () => {
    const f = fixture(100),
      native = f.source.inventory.bind(f.source)
    vi.spyOn(f.source, 'inventory').mockImplementation(async (_input, signal) =>
      native({ identity: f.identity, snapshotId: null, cursor: null }, signal)
    )
    await f.collector.start(new AbortController().signal)
    await vi.advanceTimersByTimeAsync(150)
    expect(f.collector.status()).toMatchObject({
      coverage: 'incomplete',
      reason: 'no_progress',
      knownConversations: 40
    })
    expect(f.source.inventoryCalls).toBe(2)
    expect(f.source.readCalls).toHaveLength(40)
  })
  it('a source read timeout preserves uncertainty and explicitly hands the conversation to a human', async () => {
    const f = fixture(1)
    vi.spyOn(f.source, 'read').mockImplementation(() => new Promise(() => {}))
    const start = f.collector.start(new AbortController().signal)
    await vi.advanceTimersByTimeAsync(101)
    await start
    expect(f.collector.status()).toMatchObject({
      needsHuman: 1,
      coverage: 'incomplete',
      reason: 'source_unavailable'
    })
    expect(f.ledger.snapshot(f.identity, 'customer-0').hasGap).toBe(true)
  })
  it('pause aborts immediately and ignores a late page without advancing cursor or calling events', async () => {
    const f = fixture(1)
    let finish!: (value: Awaited<ReturnType<SyntheticCollectionSource['read']>>) => void
    const native = f.source.read.bind(f.source)
    f.source.add('customer-0')
    const reqPage = vi.spyOn(f.source, 'read').mockImplementation((req) => {
      return new Promise((resolve) => {
        finish = async () => resolve(await native(req, new AbortController().signal))
      })
    })
    const parent = new AbortController(),
      start = f.collector.start(parent.signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(reqPage).toHaveBeenCalledOnce()
    parent.abort()
    await f.collector.stop()
    await start
    finish(undefined as never)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.ledger.snapshot(f.identity, 'customer-0').messages).toHaveLength(0)
    expect(f.events.onRead).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('never starts an unverified/background-incompatible reader', async () => {
    const f = fixture(1)
    vi.spyOn(f.source, 'capabilities').mockReturnValue({
      backgroundRead: false,
      stableIdentity: true,
      stableMessageIds: true
    })
    await expect(f.collector.start(new AbortController().signal)).rejects.toThrow(
      'collection_capability_unverified'
    )
    expect(f.source.inventoryCalls).toBe(0)
  })
  it('a message gap blocks the whole reply even when the currently loaded page is valid', async () => {
    const f = fixture(1)
    f.source.add('customer-0')
    const native = f.source.read.bind(f.source)
    vi.spyOn(f.source, 'read').mockImplementation(async (req, s) => ({
      ...(await native(req, s)),
      hasGap: true
    }))
    await f.collector.start(new AbortController().signal)
    expect(f.ledger.snapshot(f.identity, 'customer-0')).toMatchObject({
      hasGap: true,
      messages: [{ handledBy: null }]
    })
    expect(f.ledger.collection.ready(f.identity, 'customer-0')).toBe(false)
    expect(f.collector.status().needsHuman).toBe(1)
  })
  it('an inventory claim cannot become authoritative after an earlier partial page', async () => {
    const f = fixture(70),
      native = f.source.inventory.bind(f.source)
    vi.spyOn(f.source, 'inventory').mockImplementation(async (req, s) => ({
      ...(await native(req, s)),
      authoritative: req.cursor !== null
    }))
    await f.collector.start(new AbortController().signal)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.collector.status().coverage).toBe('incomplete')
  })
  it('changed activity refreshes the directory instead of treating a normal new message as an identity fault', async () => {
    const f = fixture(1),
      native = f.source.read.bind(f.source)
    let changed = false
    vi.spyOn(f.source, 'read').mockImplementation(async (req, s) => {
      if (!changed) {
        changed = true
        f.source.entries[0].activityVersion = 'activity-2'
        f.source.add('customer-0')
        return { ...(await native(req, s)), activityVersion: 'activity-2' }
      }
      return native(req, s)
    })
    await f.collector.start(new AbortController().signal)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.ledger.snapshot(f.identity, 'customer-0')).toMatchObject({
      hasGap: false,
      messages: [{ text: '合成问题' }]
    })
    expect(f.events.onFailure).not.toHaveBeenCalled()
  })
})
