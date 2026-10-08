import {
  createReadStream,
  mkdtempSync,
  openSync,
  writeSync,
  closeSync,
  unlinkSync,
  rmdirSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import type { Ledger } from '../../core/persistence/ledger'
import {
  RestoreInventoryManifestSchema,
  RestoreInventoryItemSchema,
  type RestoreInventoryManifest,
  type RestoreInventoryItem
} from '../../shared/contracts/restore-inventory'

/** One synchronous SQLite scan; network waits never hold a ledger transaction. */
export class RestoreInventorySnapshotError extends Error {
  constructor(readonly cleanup: () => void) {
    super('inventory_snapshot_unavailable')
    this.name = 'RestoreInventorySnapshotError'
  }
}
export function createRestoreInventorySnapshot(
  ledger: Ledger,
  scope: unknown
): {
  manifest: RestoreInventoryManifest
  pages: () => AsyncGenerator<RestoreInventoryItem[]>
  dispose: () => void
} {
  const directory = mkdtempSync(join(tmpdir(), 'autoreply-inventory-')),
    path = join(directory, 'metadata.jsonl')
  let descriptor: number | undefined,
    disposed = false
  const dispose = (): void => {
    if (disposed) return
    if (descriptor !== undefined) {
      closeSync(descriptor)
      descriptor = undefined
    }
    try {
      unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      rmdirSync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    disposed = true
  }
  try {
    descriptor = openSync(path, 'wx', 0o600)
    const report = ledger.visitRestoreInventory(scope, (item) => {
      const data = Buffer.from(
        JSON.stringify(RestoreInventoryItemSchema.parse(item)) + '\n',
        'utf8'
      )
      let offset = 0
      while (offset < data.length) {
        const written = writeSync(descriptor!, data, offset, data.length - offset)
        if (written <= 0) throw Error('inventory_snapshot_unavailable')
        offset += written
      }
    })
    closeSync(descriptor)
    descriptor = undefined
    const { items, nextAfter, ...input } = report
    void items
    void nextAfter
    const manifest = RestoreInventoryManifestSchema.parse(input)
    async function* pages(): AsyncGenerator<RestoreInventoryItem[]> {
      const stream = createReadStream(path),
        reader = createInterface({ input: stream, crlfDelay: Infinity })
      let batch: RestoreInventoryItem[] = []
      try {
        for await (const line of reader) {
          if (Buffer.byteLength(line, 'utf8') > 8192) throw Error('inventory_snapshot_invalid')
          batch.push(RestoreInventoryItemSchema.parse(JSON.parse(line)))
          if (batch.length === 100) {
            yield batch
            batch = []
          }
        }
        if (batch.length) yield batch
      } finally {
        reader.close()
        if (!stream.closed)
          await new Promise<void>((resolve) => {
            stream.once('close', resolve)
            stream.destroy()
          })
      }
    }
    return { manifest, pages, dispose }
  } catch (error) {
    try {
      dispose()
    } catch {
      throw new RestoreInventorySnapshotError(dispose)
    }
    throw error
  }
}
