import { describe, expect, it, vi } from 'vitest'
import {
  UiaCollectionSource,
  ViewportCollectionSource,
  type UiaCollectionReader,
  type ViewportCollectionReader
} from '../../src/core/adapters/collection-sources'
import { taskFixture } from '../fixtures/task'
import { SyntheticCollectionSource } from '../fixtures/collection'

const signal = () => new AbortController().signal
function fixture(platform: 'wechat' | 'wework') {
  const identity = { ...taskFixture().task.identity, platform }
  const synthetic = new SyntheticCollectionSource(identity, 500)
  const validation = {
    platform,
    clientVersion: 'synthetic-version-only',
    backgroundRead: true,
    stableCustomerIds: true,
    stableMessageIds: true,
    offscreenEnumeration: true
  }
  const reader: UiaCollectionReader = {
    identity: vi.fn(async () => identity),
    resolve: vi.fn(async (id) =>
      structuredClone(synthetic.entries.find((e) => e.binding.conversationId === id)!.binding)
    ),
    inventory: vi.fn((input, s) => synthetic.inventory(input, s)),
    messages: vi.fn((req, _limit, s) => synthetic.read(req, s))
  }
  return { identity, synthetic, validation, reader }
}
describe('validated UIA collection source for separate platforms', () => {
  it.each(['wechat', 'wework'] as const)(
    'rechecks account and customer before and after %s reads',
    async (platform) => {
      const f = fixture(platform),
        source = new UiaCollectionSource(f.reader, f.validation)
      f.synthetic.add('customer-499')
      const page = await source.inventory(
        { identity: f.identity, snapshotId: null, cursor: null },
        signal()
      )
      expect(page.authoritative).toBe(true)
      const message = await source.read(
        { entry: f.synthetic.entries[499], cursor: null, revision: 1 },
        signal()
      )
      expect(message.messages[0].conversationId).toBe('customer-499')
      expect(f.reader.identity).toHaveBeenCalledTimes(4)
      expect(f.reader.resolve).toHaveBeenCalledTimes(2)
      expect(f.reader.messages).toHaveBeenCalledWith(expect.anything(), 100, expect.anything())
    }
  )
  it('rejects an account changing during a native call', async () => {
    const f = fixture('wechat'),
      source = new UiaCollectionSource(f.reader, f.validation)
    vi.mocked(f.reader.identity)
      .mockResolvedValueOnce(f.identity)
      .mockResolvedValue({ ...f.identity, accountId: 'other-account' })
    await expect(
      source.inventory({ identity: f.identity, snapshotId: null, cursor: null }, signal())
    ).rejects.toThrow('identity_unverified')
  })
  it('does not resolve same-name customers by name or accept a changed target', async () => {
    const f = fixture('wework'),
      source = new UiaCollectionSource(f.reader, f.validation)
    vi.mocked(f.reader.resolve).mockResolvedValue(f.synthetic.entries[0].binding)
    await expect(
      source.read({ entry: f.synthetic.entries[2], cursor: null, revision: 1 }, signal())
    ).rejects.toThrow('identity_unverified')
    expect(f.reader.messages).not.toHaveBeenCalled()
  })
  it('does not promote visible-only controls into a verified background enumerator', () => {
    const f = fixture('wechat')
    const source = new UiaCollectionSource(f.reader, {
      ...f.validation,
      offscreenEnumeration: false
    })
    expect(source.capabilities().backgroundRead).toBe(false)
  })
  it('separates WeChat and WeCom validation and respects cancellation before reading', async () => {
    const f = fixture('wechat'),
      source = new UiaCollectionSource(f.reader, f.validation)
    await expect(
      source.inventory(
        { identity: { ...f.identity, platform: 'wework' }, snapshotId: null, cursor: null },
        signal()
      )
    ).rejects.toThrow('identity_unverified')
    const c = new AbortController()
    c.abort()
    await expect(
      source.inventory({ identity: f.identity, snapshotId: null, cursor: null }, c.signal)
    ).rejects.toThrow()
    expect(f.reader.inventory).not.toHaveBeenCalled()
  })
})
describe('controlled viewport fallback never proves complete enumeration', () => {
  function viewport() {
    const f = fixture('wechat')
    let offset = 0
    const reader: ViewportCollectionReader = {
      identity: vi.fn(async () => f.identity),
      begin: vi.fn(async () => {
        offset = 0
        return { snapshotId: 'viewport-1' }
      }),
      capture: vi.fn(async () => ({
        snapshotId: 'viewport-1',
        entries: f.synthetic.entries.slice(offset, offset + 10),
        atBottom: offset >= 490
      })),
      scroll: vi.fn(async (input) => {
        offset += 10 - input.overlapRows
      }),
      messages: vi.fn((req, s) => f.synthetic.read(req, s))
    }
    return { ...f, reader, source: new ViewportCollectionSource(reader, f.validation) }
  }
  it('scrolls with overlap and returns stable IDs while always reporting partial coverage', async () => {
    const f = viewport(),
      first = await f.source.inventory(
        { identity: f.identity, snapshotId: null, cursor: null },
        signal()
      )
    const second = await f.source.inventory(
      { identity: f.identity, snapshotId: first.snapshotId, cursor: first.nextCursor },
      signal()
    )
    expect(f.reader.scroll).toHaveBeenCalledExactlyOnceWith({ overlapRows: 2 }, expect.anything())
    expect(second.entries[0].binding.conversationId).toBe(first.entries[8].binding.conversationId)
    expect(first.authoritative).toBe(false)
    expect(second.authoritative).toBe(false)
    expect(f.source.capabilities().backgroundRead).toBe(false)
  })
  it('rejects a list changing after scrolling instead of using stale positions', async () => {
    const f = viewport(),
      first = await f.source.inventory(
        { identity: f.identity, snapshotId: null, cursor: null },
        signal()
      )
    vi.mocked(f.reader.capture).mockResolvedValue({
      snapshotId: 'viewport-reordered',
      entries: [],
      atBottom: true
    })
    await expect(
      f.source.inventory(
        { identity: f.identity, snapshotId: first.snapshotId, cursor: first.nextCursor },
        signal()
      )
    ).rejects.toThrow('inventory_changed')
  })
  it('does not claim native identities or message IDs from a pure screenshot', () => {
    const f = viewport(),
      source = new ViewportCollectionSource(f.reader, {
        ...f.validation,
        stableCustomerIds: false,
        stableMessageIds: false
      })
    expect(source.capabilities()).toEqual({
      backgroundRead: false,
      stableIdentity: false,
      stableMessageIds: false
    })
  })
})
