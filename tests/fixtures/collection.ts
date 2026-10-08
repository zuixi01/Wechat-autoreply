import type { Identity } from '../../src/shared/contracts/identity'
import type { ObservedMessage } from '../../src/shared/contracts/message'
import type {
  CollectionEntry,
  CollectionSource,
  CollectionReadRequest,
  InventoryPage,
  MessagePage
} from '../../src/shared/contracts/collection'

/** Synthetic semantic reader only; never used by the installed desktop application. */
export class SyntheticCollectionSource implements CollectionSource {
  entries: CollectionEntry[]
  readonly history = new Map<string, ObservedMessage[]>()
  inventoryCalls = 0
  readCalls: string[] = []
  snapshotId = 'synthetic-inventory-1'
  authoritative = true
  pageSize = 40
  messagePageSize = 10
  private hint?: (id: string) => void
  constructor(
    readonly identity: Identity,
    count = 500
  ) {
    this.entries = Array.from({ length: count }, (_, i) => ({
      binding: {
        identity,
        conversationId: `customer-${i}`,
        bindingVersion: 1,
        identityVerified: true,
        identityEvidence: [`synthetic-native-${i}`]
      },
      displayName: i % 2 === 0 ? '同名客户' : `客户${i}`,
      activityVersion: 'activity-1'
    }))
    for (const entry of this.entries) this.history.set(entry.binding.conversationId, [])
  }
  capabilities() {
    return { backgroundRead: true, stableIdentity: true, stableMessageIds: true }
  }
  subscribe(hint: (id: string) => void) {
    this.hint = hint
    return () => {
      this.hint = undefined
    }
  }
  emit(id: string) {
    this.hint?.(id)
  }
  add(id: string, text = '合成问题', direction: ObservedMessage['direction'] = 'inbound') {
    const history = this.history.get(id)!
    history.push({
      identity: this.identity,
      conversationId: id,
      sourceMessageId: `source-${history.length}`,
      direction,
      kind: 'text',
      text,
      observedAt: Date.now(),
      identityVerified: true,
      messageIdVerified: true
    })
  }
  async inventory(
    input: { identity: Identity; snapshotId: string | null; cursor: string | null },
    signal: AbortSignal
  ): Promise<InventoryPage> {
    if (signal.aborted) throw new Error('synthetic_cancelled')
    this.inventoryCalls++
    const offset = Number(input.cursor ?? 0)
    return {
      identity: this.identity,
      snapshotId: this.snapshotId,
      entries: structuredClone(this.entries.slice(offset, offset + this.pageSize)),
      nextCursor:
        offset + this.pageSize < this.entries.length ? String(offset + this.pageSize) : null,
      total: this.entries.length,
      authoritative: this.authoritative
    }
  }
  async read(request: CollectionReadRequest, signal: AbortSignal): Promise<MessagePage> {
    if (signal.aborted) throw new Error('synthetic_cancelled')
    const id = request.entry.binding.conversationId
    this.readCalls.push(id)
    const history = this.history.get(id)!
    const offset = Number(request.cursor ?? 0),
      end = Math.min(history.length, offset + this.messagePageSize)
    return {
      binding: structuredClone(request.entry.binding),
      activityVersion: request.entry.activityVersion,
      fromCursor: request.cursor,
      nextCursor: String(end),
      messages: structuredClone(history.slice(offset, end)),
      complete: end === history.length,
      hasGap: false
    }
  }
}
