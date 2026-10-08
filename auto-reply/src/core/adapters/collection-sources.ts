import { hashContext } from '../reply/hashes'
import {
  sameIdentity,
  type Identity,
  type ConversationBinding
} from '../../shared/contracts/identity'
import {
  InventoryPageSchema,
  MessagePageSchema,
  type CollectionEntry,
  type CollectionSource,
  type CollectionReadRequest,
  type InventoryPage,
  type MessagePage
} from '../../shared/contracts/collection'

/** Main-process evidence for a specific platform/version. Metadata probes are insufficient.
 * Production must provide an actually validated reader; neither renderer nor OCR can
 * manufacture these claims. The current native helper deliberately has no such reader. */
export interface CollectionReaderValidation {
  platform: Identity['platform']
  clientVersion: string
  backgroundRead: boolean
  stableCustomerIds: boolean
  stableMessageIds: boolean
  offscreenEnumeration: boolean
}
export interface UiaCollectionReader {
  identity(signal: AbortSignal): Promise<Identity>
  resolve(conversationId: string, signal: AbortSignal): Promise<ConversationBinding>
  inventory(
    input: { identity: Identity; snapshotId: string | null; cursor: string | null; limit: number },
    signal: AbortSignal
  ): Promise<InventoryPage>
  messages(request: CollectionReadRequest, limit: number, signal: AbortSignal): Promise<MessagePage>
  subscribe?(hint: (id: string) => void): () => void
}

/** UIA transport-independent reader with identity rechecks around every native operation. */
export class UiaCollectionSource implements CollectionSource {
  constructor(
    private readonly reader: UiaCollectionReader,
    private readonly validation: CollectionReaderValidation
  ) {
    if (!validation.clientVersion.trim()) throw new Error('client_version_unverified')
  }
  capabilities(): ReturnType<CollectionSource['capabilities']> {
    return {
      backgroundRead: this.validation.backgroundRead && this.validation.offscreenEnumeration,
      stableIdentity: this.validation.stableCustomerIds,
      stableMessageIds: this.validation.stableMessageIds
    }
  }
  private async verify(identity: Identity, signal: AbortSignal): Promise<void> {
    if (
      signal.aborted ||
      identity.platform !== this.validation.platform ||
      !sameIdentity(await this.reader.identity(signal), identity)
    )
      throw new Error('identity_unverified')
    if (signal.aborted) throw new Error('collection_cancelled')
  }
  async inventory(
    input: { identity: Identity; snapshotId: string | null; cursor: string | null },
    signal: AbortSignal
  ): Promise<InventoryPage> {
    await this.verify(input.identity, signal)
    const page = InventoryPageSchema.parse(
      await this.reader.inventory({ ...input, limit: 100 }, signal)
    )
    await this.verify(input.identity, signal)
    if (!sameIdentity(page.identity, input.identity)) throw new Error('identity_unverified')
    return { ...page, authoritative: page.authoritative && this.validation.offscreenEnumeration }
  }
  async read(request: CollectionReadRequest, signal: AbortSignal): Promise<MessagePage> {
    const expected = request.entry.binding
    await this.verify(expected.identity, signal)
    const resolved = await this.reader.resolve(expected.conversationId, signal)
    if (hashContext(resolved) !== hashContext(expected) || !resolved.identityVerified)
      throw new Error('identity_unverified')
    const page = MessagePageSchema.parse(await this.reader.messages(request, 100, signal))
    await this.verify(expected.identity, signal)
    const after = await this.reader.resolve(expected.conversationId, signal)
    if (hashContext(after) !== hashContext(expected)) throw new Error('identity_unverified')
    return page
  }
  subscribe(hint: (id: string) => void): () => void {
    return this.reader.subscribe?.(hint) ?? (() => {})
  }
}

export interface ViewportCollectionReader {
  identity(signal: AbortSignal): Promise<Identity>
  // Must acquire exclusive access to the list before repositioning it.
  begin(identity: Identity, signal: AbortSignal): Promise<{ snapshotId: string }>
  capture(signal: AbortSignal): Promise<{
    snapshotId: string
    entries: CollectionEntry[]
    atBottom: boolean
  }>
  scroll(input: { overlapRows: number }, signal: AbortSignal): Promise<void>
  messages(request: CollectionReadRequest, signal: AbortSignal): Promise<MessagePage>
}

/** Explicit foreground fallback. A screenshot alone never proves complete coverage or IDs.
 * Stable native identity/message IDs must come from the hybrid reader's validation. */
export class ViewportCollectionSource implements CollectionSource {
  private scan?: { id: string; expectedCursor: string | null; page: number }
  constructor(
    private readonly reader: ViewportCollectionReader,
    private readonly validation: CollectionReaderValidation
  ) {}
  capabilities(): ReturnType<CollectionSource['capabilities']> {
    return {
      backgroundRead: false,
      stableIdentity: this.validation.stableCustomerIds,
      stableMessageIds: this.validation.stableMessageIds
    }
  }
  private async verify(identity: Identity, signal: AbortSignal): Promise<void> {
    if (
      signal.aborted ||
      identity.platform !== this.validation.platform ||
      !sameIdentity(await this.reader.identity(signal), identity)
    )
      throw new Error('identity_unverified')
    if (signal.aborted) throw new Error('collection_cancelled')
  }
  async inventory(
    input: { identity: Identity; snapshotId: string | null; cursor: string | null },
    signal: AbortSignal
  ): Promise<InventoryPage> {
    await this.verify(input.identity, signal)
    if (input.cursor === null) {
      const initial = await this.reader.begin(input.identity, signal)
      this.scan = { id: initial.snapshotId, expectedCursor: null, page: 0 }
    }
    const scan = this.scan
    if (!scan || scan.id !== (input.snapshotId ?? scan.id) || scan.expectedCursor !== input.cursor)
      throw new Error('inventory_changed')
    if (input.cursor) await this.reader.scroll({ overlapRows: 2 }, signal)
    const view = await this.reader.capture(signal)
    await this.verify(input.identity, signal)
    if (view.snapshotId !== scan.id) throw new Error('inventory_changed')
    scan.page++
    scan.expectedCursor = view.atBottom ? null : `${scan.id}:${scan.page}`
    return InventoryPageSchema.parse({
      identity: input.identity,
      snapshotId: scan.id,
      entries: view.entries,
      nextCursor: scan.expectedCursor,
      total: 100000,
      authoritative: false
    })
  }
  async read(request: CollectionReadRequest, signal: AbortSignal): Promise<MessagePage> {
    await this.verify(request.entry.binding.identity, signal)
    const page = MessagePageSchema.parse(await this.reader.messages(request, signal))
    await this.verify(request.entry.binding.identity, signal)
    return page
  }
}
