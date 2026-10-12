import { createHash } from 'node:crypto'
export interface BubblePixels {
  width: number
  height: number
  data: Buffer
}
export interface TextBubble {
  direction: 'inbound' | 'outbound'
  x: number
  y: number
  width: number
  height: number
  fingerprint: string
}
/** Keep partially clipped messages below the title out of the header anchor. */
export function chatHeaderBottom(
  image: BubblePixels,
  left: number,
  hint: number
): number | undefined {
  const candidates: number[] = []
  let last = -2
  for (
    let row = Math.max(3, Math.floor((hint - 0.08) * image.height));
    row < Math.min(image.height * 0.25, (hint + 0.08) * image.height);
    row++
  ) {
    let total = 0,
      line = 0
    for (let col = Math.floor(left * image.width) + 16; col < image.width - 20; col += 8) {
      total++
      const i = (row * image.width + col) * 4,
        r = image.data[i],
        g = image.data[i + 1],
        b = image.data[i + 2]
      if (
        r >= 215 &&
        r <= 247 &&
        Math.max(r, g, b) - Math.min(r, g, b) <= 3 &&
        image.data[i - image.width * 12] >= 248
      )
        line++
    }
    if (total && line / total > 0.9) {
      if (last !== row - 1) candidates.push(row)
      last = row
    }
  }
  const row = candidates.sort(
    (a, b) => Math.abs((a + 1) / image.height - hint) - Math.abs((b + 1) / image.height - hint)
  )[0]
  return row === undefined ? undefined : (row + 1) / image.height
}
/** Locate the thin, full-width divider above the editor in the light theme.
 * Narrow message decorations cannot establish an editor boundary. */
export function chatInputTop(image: BubblePixels, left: number, hint: number): number | undefined {
  const candidates: number[] = []
  let lastLineRow = -2
  const start = Math.max(3, Math.floor(Math.max(0.4, hint - 0.25) * image.height))
  const end = Math.min(image.height - 3, Math.floor(Math.min(0.95, hint + 0.25) * image.height))
  for (let row = start; row < end; row++) {
    let total = 0,
      divider = 0
    for (let col = Math.floor(left * image.width) + 16; col < image.width - 20; col += 8) {
      total++
      const i = (row * image.width + col) * 4
      const r = image.data[i],
        g = image.data[i + 1],
        b = image.data[i + 2]
      if (
        r >= 215 &&
        r <= 244 &&
        Math.max(r, g, b) - Math.min(r, g, b) <= 3 &&
        image.data[i - image.width * 4 * 3] >= 245 &&
        image.data[i + image.width * 4 * 3] >= 245
      )
        divider++
    }
    if (total && divider / total > 0.9) {
      if (lastLineRow !== row - 1) candidates.push(row)
      lastLineRow = row
    }
  }
  const row = candidates.sort(
    (a, b) => Math.abs(a / image.height - hint) - Math.abs(b / image.height - hint)
  )[0]
  return row === undefined ? undefined : row / image.height
}
/** An unmatched message avatar may indicate media beside a newly received text.
 * This only requests a full visual read and never authorizes desktop input. */
export function hasUnpairedChatAvatars(
  image: BubblePixels,
  area: readonly number[],
  bubbles: readonly TextBubble[]
): boolean {
  const [x, y, w, h] = area,
    left = Math.floor(x * image.width),
    right = Math.min(image.width, Math.ceil((x + w) * image.width)),
    top = Math.max(0, Math.ceil(y * image.height)),
    bottom = Math.min(image.height, Math.floor((y + h) * image.height))
  for (const [start, end, direction] of [
    [left + 16, left + 72, 'inbound'],
    [right - 90, right - 25, 'outbound']
  ] as const) {
    let first = -1,
      last = -1
    const unpaired = (): boolean => {
      if (first < 0 || last - first < 18 || last - first > 100) return false
      const center = (first + last) / 2
      return !bubbles.some(
        (b) => b.direction === direction && center >= b.y - 8 && center <= b.y + b.height + 8
      )
    }
    for (let row = top; row <= bottom; row++) {
      let ink = 0
      if (row < bottom)
        for (let col = Math.max(left, start); col < Math.min(right, end); col++) {
          const i = (row * image.width + col) * 4,
            r = image.data[i],
            g = image.data[i + 1],
            b = image.data[i + 2]
          if (Math.min(r, g, b) < 225 || Math.max(r, g, b) - Math.min(r, g, b) > 16) ink++
        }
      // A clipped text bubble can touch this strip with a narrow edge or tail.
      // A real avatar occupies a substantial width across consecutive rows.
      if (ink >= 18) {
        if (first < 0) first = row
        last = row
      } else if (first >= 0 && (row - last > 3 || row === bottom)) {
        if (unpaired()) return true
        first = -1
        last = -1
      }
    }
  }
  return false
}
/** Read-only geometry for WeChat's uniform, tailed text bubbles. Images and avatars
 * lack that shape. Unsupported themes return no candidates and use visual reading. */
export function textBubbles(image: BubblePixels, area: readonly number[]): TextBubble[] {
  const [x, y, w, h] = area
  const left = Math.max(0, Math.floor(x * image.width))
  let top = Math.max(0, Math.floor(y * image.height))
  // Locate the actual thin grey divider under the chat title. Model rectangles
  // can extend into the header, making a clipped first bubble look complete.
  for (let row = Math.max(1, top - 30); row < Math.min(image.height - 1, top + 80); row++) {
    let total = 0,
      divider = 0
    for (let col = left + 8; col < image.width - 8; col += 8) {
      total++
      const i = (row * image.width + col) * 4,
        before = i - image.width * 4,
        after = i + image.width * 4
      const r = image.data[i],
        g = image.data[i + 1],
        b = image.data[i + 2]
      if (
        r >= 220 &&
        r <= 244 &&
        Math.max(r, g, b) - Math.min(r, g, b) <= 3 &&
        image.data[before] >= 245 &&
        image.data[after] >= 245
      )
        divider++
    }
    if (total && divider / total > 0.9) {
      top = row + 1
      break
    }
  }
  const right = Math.min(image.width, Math.ceil((x + w) * image.width))
  const bottom = Math.min(image.height, Math.ceil((y + h) * image.height))
  const palette = [new Map<number, number>(), new Map<number, number>()]
  for (let row = top; row < bottom; row++)
    for (let col = left; col < right; col++) {
      const offset = (row * image.width + col) * 4
      const r = image.data[offset],
        g = image.data[offset + 1],
        b = image.data[offset + 2]
      const kind =
        g > r + 20 && g > b + 20
          ? 1
          : Math.max(r, g, b) - Math.min(r, g, b) <= 4 && r > 35 && r < 245
            ? 0
            : -1
      if (kind >= 0) {
        const color = (r << 16) | (g << 8) | b
        palette[kind].set(color, (palette[kind].get(color) ?? 0) + 1)
      }
    }
  const colors = palette.map(
    (values) => [...values].sort((a, b) => b[1] - a[1]).find(([, count]) => count >= 600)?.[0]
  )
  const near = (r: number, g: number, b: number, target: number | undefined): boolean =>
    target !== undefined &&
    Math.abs(r - ((target >> 16) & 255)) <= 8 &&
    Math.abs(g - ((target >> 8) & 255)) <= 8 &&
    Math.abs(b - (target & 255)) <= 8
  const mask = new Uint8Array(image.width * image.height)
  for (let row = top; row < bottom; row++)
    for (let col = left; col < right; col++) {
      const i = row * image.width + col,
        offset = i * 4
      const r = image.data[offset],
        g = image.data[offset + 1],
        b = image.data[offset + 2]
      if (near(r, g, b, colors[0])) mask[i] = 1
      else if (near(r, g, b, colors[1])) mask[i] = 2
    }
  const seen = new Uint8Array(mask.length),
    queue = new Int32Array(mask.length)
  const bubbles: TextBubble[] = []
  for (let row = top; row < bottom; row++)
    for (let col = left; col < right; col++) {
      const start = row * image.width + col,
        kind = mask[start]
      if (!kind || seen[start]) continue
      let head = 0,
        tail = 1,
        minX = col,
        maxX = col,
        minY = row,
        maxY = row
      queue[0] = start
      seen[start] = 1
      while (head < tail) {
        const i = queue[head++],
          cx = i % image.width,
          cy = Math.floor(i / image.width)
        minX = Math.min(minX, cx)
        maxX = Math.max(maxX, cx)
        minY = Math.min(minY, cy)
        maxY = Math.max(maxY, cy)
        for (const n of [
          cx > left ? i - 1 : -1,
          cx + 1 < right ? i + 1 : -1,
          cy > top ? i - image.width : -1,
          cy + 1 < bottom ? i + image.width : -1
        ])
          if (n >= 0 && !seen[n] && mask[n] === kind) {
            seen[n] = 1
            queue[tail++] = n
          }
      }
      const width = maxX - minX + 1,
        height = maxY - minY + 1
      if (
        width < 28 ||
        height < 20 ||
        minY <= top + 2 ||
        maxY >= bottom - 3 ||
        minX < left + 50 ||
        maxX > right - 50 ||
        tail < width * height * 0.5
      )
        continue
      const edge = kind === 1 ? minX : maxX,
        inside = edge + (kind === 1 ? 8 : -8)
      let tipPixels = 0,
        bodyPixels = 0
      for (let cy = minY; cy <= maxY; cy++) {
        if (mask[cy * image.width + edge] === kind) tipPixels++
        if (mask[cy * image.width + inside] === kind) bodyPixels++
      }
      let detachedTail = false
      if (kind === 2)
        for (let dx = 1; dx <= 12; dx++) {
          let count = 0
          for (
            let cy = minY + Math.floor(height * 0.2);
            cy <= minY + Math.ceil(height * 0.8);
            cy++
          ) {
            const offset = (cy * image.width + maxX + dx) * 4
            if (
              image.data[offset + 1] > image.data[offset] + 6 &&
              image.data[offset + 1] > image.data[offset + 2] + 6
            )
              count++
          }
          if (count > 0 && count < height * 0.4) detachedTail = true
        }
      if ((tipPixels > height * 0.4 && !detachedTail) || bodyPixels < height * 0.6) continue
      const hash = createHash('sha256').update(JSON.stringify([width, height]))
      for (let cy = minY; cy <= maxY; cy++) {
        const offset = (cy * image.width + minX) * 4
        hash.update(image.data.subarray(offset, offset + width * 4))
      }
      bubbles.push({
        direction: kind === 1 ? 'inbound' : 'outbound',
        x: minX,
        y: minY,
        width,
        height,
        fingerprint: hash.digest('hex')
      })
    }
  return bubbles.sort((a, b) => a.y - b.y || a.x - b.x)
}
