import type { BubblePixels } from './foreground-bubbles'

/** The real scrollbar takes precedence over a model's guessed edge flags. */
export function listScrollEdges(
  image: BubblePixels,
  area: readonly number[]
): { atTop: boolean; atBottom: boolean } | undefined {
  const right = Math.min(image.width, Math.floor((area[0] + area[2]) * image.width)),
    top = Math.max(0, Math.floor(area[1] * image.height)),
    bottom = Math.min(image.height, Math.floor((area[1] + area[3]) * image.height))
  const runs: { start: number; end: number }[] = []
  for (let x = Math.max(0, right - 16); x < right - 2; x++) {
    let start = -1
    for (let y = top; y <= bottom; y++) {
      const i = (y * image.width + x) * 4,
        r = image.data[i],
        g = image.data[i + 1],
        b = image.data[i + 2]
      const background = (y * image.width + Math.max(0, right - 24)) * 4,
        dr = image.data[background] - r,
        dg = image.data[background + 1] - g,
        db = image.data[background + 2] - b
      const thumb =
        y < bottom &&
        ((r >= 90 && r <= 205 && Math.max(r, g, b) - Math.min(r, g, b) <= 3) ||
          (Math.min(dr, dg, db) >= 4 && Math.max(dr, dg, db) >= 15))
      if (thumb && start < 0) start = y
      if (!thumb && start >= 0) {
        if (y - start >= 20) runs.push({ start, end: y })
        start = -1
      }
    }
  }
  const candidates = runs.filter(
    (run) =>
      runs.filter(
        (other) => Math.abs(run.start - other.start) <= 4 && Math.abs(run.end - other.end) <= 4
      ).length >= 3
  )
  const thumb = candidates.sort((a, b) => b.end - b.start - (a.end - a.start))[0]
  if (!thumb) return undefined
  const margin = Math.max(8, Math.round(image.height * 0.012))
  return { atTop: thumb.start - top <= margin, atBottom: bottom - thumb.end <= margin }
}

/** Only inspect the tightly located badge, never the red pixels of an avatar.
 * A number has a non-red center; a solid circular dot does not provide a count. */
export function unreadBadge(
  image: BubblePixels,
  area: readonly number[]
): 'dot' | 'count' | 'none' | 'unknown' {
  const left = Math.max(0, Math.floor(area[0] * image.width)),
    top = Math.max(0, Math.floor(area[1] * image.height)),
    right = Math.min(image.width, Math.ceil((area[0] + area[2]) * image.width)),
    bottom = Math.min(image.height, Math.ceil((area[1] + area[3]) * image.height))
  if (right <= left || bottom <= top || right - left > 96 || bottom - top > 96) return 'unknown'
  let minX = right,
    minY = bottom,
    maxX = left - 1,
    maxY = top - 1,
    total = 0
  const red = (x: number, y: number): boolean => {
    const i = (y * image.width + x) * 4,
      r = image.data[i],
      g = image.data[i + 1],
      b = image.data[i + 2]
    return r >= 185 && g <= 135 && b <= 145 && r - Math.max(g, b) >= 75
  }
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++)
      if (red(x, y)) {
        total++
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
  if (total < 4) return 'none'
  const width = maxX - minX + 1,
    height = maxY - minY + 1,
    density = total / (width * height)
  if (width < 3 || height < 3 || density < 0.4 || density > 0.92) return 'unknown'
  let center = 0,
    filled = 0
  for (let y = minY + Math.ceil(height * 0.25); y <= minY + Math.floor(height * 0.75); y++)
    for (let x = minX + Math.ceil(width * 0.25); x <= minX + Math.floor(width * 0.75); x++) {
      center++
      if (red(x, y)) filled++
    }
  return width / height >= 0.75 && width / height <= 1.33 && filled / center >= 0.94
    ? 'dot'
    : 'count'
}
