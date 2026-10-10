import { hashContext } from '../reply/hashes'
import type { BatchNavigator, ListRow } from '../../shared/contracts/foreground-batch'

export const rowKey = (row: ListRow): string =>
  hashContext([row.name, row.nameComplete, row.preview, row.unread, Boolean(row.unreadDot)])
export const mayMatchTruncatedName = (row: ListRow, name: string): boolean =>
  !row.nameComplete && name.startsWith(row.name.replace(/(?:\.\.\.|…)$/, '').trim())
/** A traversed screenshot list is not a directory of stable native customer IDs. */
export async function scanForegroundList(
  navigator: BatchNavigator,
  signal: AbortSignal,
  progress: (pages: number, rows: ListRow[]) => void = () => {},
  maxPages = 200
): Promise<ListRow[]> {
  await navigator.top(signal)
  const rows: ListRow[] = []
  let previous: ListRow[] | undefined,
    still = 0
  for (let page = 1; page <= maxPages; page++) {
    if (signal.aborted) throw new Error('cancelled')
    const view = await navigator.page(signal),
      next = view.rows
    if (signal.aborted) throw new Error('cancelled')
    if (previous) {
      const oldKeys = previous.map(rowKey),
        newKeys = next.map(rowKey)
      if (hashContext(oldKeys) === hashContext(newKeys)) {
        if (++still === 2) {
          if (!view.atBottom) throw new Error('list_incomplete')
          progress(page, rows)
          return rows
        }
      } else {
        still = 0
        let overlap = 0
        for (let n = Math.min(previous.length, next.length); n > 0; n--) {
          if (hashContext(oldKeys.slice(-n)) === hashContext(newKeys.slice(0, n))) {
            overlap = n
            break
          }
        }
        if (!overlap) throw new Error('list_changed')
        rows.push(...next.slice(overlap))
      }
    } else rows.push(...next)
    if (rows.length > 10000) throw new Error('list_limit')
    previous = next
    progress(page, rows)
    await navigator.down(signal)
  }
  throw new Error('list_limit')
}

export async function findForegroundRow(
  navigator: BatchNavigator,
  expected: ListRow,
  signal: AbortSignal,
  checkPreview = true,
  fromCurrent = false
): Promise<void> {
  let reset = !fromCurrent
  if (reset) await navigator.top(signal)
  let previous = ''
  for (let page = 0; page < 200; page++) {
    if (signal.aborted) throw new Error('cancelled')
    const rows = (await navigator.page(signal)).rows
    if (rows.some((row) => mayMatchTruncatedName(row, expected.name)))
      throw new Error('contact_not_unique')
    const matches = rows.filter((row) => row.nameComplete && row.name === expected.name)
    if (matches.length > 1) throw new Error('contact_not_unique')
    if (matches.length) {
      if (checkPreview && rowKey(matches[0]) !== rowKey(expected)) throw new Error('list_changed')
      await navigator.open(matches[0], signal)
      return
    }
    const key = hashContext(rows.map(rowKey))
    if (key === previous) {
      if (reset) throw new Error('list_changed')
      await navigator.top(signal)
      previous = ''
      reset = true
      continue
    }
    previous = key
    await navigator.down(signal)
  }
  throw new Error('list_limit')
}
