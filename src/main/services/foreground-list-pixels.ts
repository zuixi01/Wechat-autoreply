import { randomUUID } from 'node:crypto'
import type { ListRow } from '../../shared/contracts/foreground-batch'
import type { BubblePixels } from './foreground-bubbles'

export interface ListRowPixels {
  id: string
  x: number
  y: number
  width: number
  height: number
  data: Buffer
}
function crop(image: BubblePixels, x: number, y: number, width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4)
  for (let row = 0; row < height; row++) {
    const start = ((y + row) * image.width + x) * 4
    image.data.copy(data, row * width * 4, start, start + width * 4)
  }
  return data
}
/** Physical row overlap is independent of a model spelling the same name differently.
 * IDs only deduplicate a traversed list; they never establish recipient identity. */
export function listRowPixels(
  image: BubblePixels,
  area: readonly number[],
  rows: ListRow[],
  previous: ListRowPixels[]
): ListRowPixels[] {
  for (const row of rows) delete row.pixelIdentity
  const left = Math.max(0, Math.floor(area[0] * image.width)),
    right = Math.min(image.width, Math.floor((area[0] + area[2]) * image.width)),
    top = Math.max(0, Math.floor(area[1] * image.height)),
    bottom = Math.min(image.height, Math.floor((area[1] + area[3]) * image.height)),
    x = left + 8,
    width = Math.max(1, right - x - 16),
    height = Math.min(24, bottom - top)
  if (height < 8 || width < 40) return []
  const links = rows.map((row) => {
    const center = Math.round(row.point[1] * image.height)
    return previous.flatMap((old) => {
      if (old.x < left || old.x + old.width > right || old.height !== height) return []
      const positions: number[] = []
      for (let y = Math.max(top, center - 44); y <= Math.min(bottom - height, center + 20); y++)
        if (crop(image, old.x, y, old.width, old.height).equals(old.data)) positions.push(y)
      return positions.length ? [{ old, positions }] : []
    })
  })
  const candidates = links.map((matches) =>
    matches.length === 1 &&
    links.filter((values) => values.some((value) => value.old === matches[0].old)).length === 1
      ? matches[0]
      : undefined
  )
  // A lone identical avatar/name can be a second contact on another page.
  // Require at least two independent rows to prove one common translation.
  const offsets = new Map<number, { count: number; error: number }>()
  candidates.forEach((match, index) => {
    if (!match) return
    for (const y of match.positions) {
      const offset = y - match.old.y,
        value = offsets.get(offset) ?? { count: 0, error: 0 }
      value.count++
      value.error += Math.abs(y - (Math.round(rows[index].point[1] * image.height) - 12))
      offsets.set(offset, value)
    }
  })
  const translation = [...offsets]
    .filter(([, value]) => value.count >= 2)
    .sort((a, b) => b[1].count - a[1].count || a[1].error - b[1].error)[0]?.[0]
  return rows.map((row, index) => {
    const match = candidates[index],
      old =
        translation !== undefined && match?.positions.includes(match.old.y + translation)
          ? match.old
          : undefined
    const id = old?.id ?? randomUUID()
    // Never trust a model-supplied opaque identity.
    row.pixelIdentity = id
    if (old) return { ...old, y: old.y + translation! }
    const y = Math.max(top, Math.min(bottom - height, Math.round(row.point[1] * image.height) - 12))
    const data = crop(image, x, y, width, height)
    let ink = 0
    for (let i = 4; i < data.length; i += 4)
      if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) ink++
    return { id, x, y, width, height: ink >= 16 ? height : 0, data }
  })
}
