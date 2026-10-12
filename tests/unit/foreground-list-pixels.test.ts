import { describe, it, expect } from 'vitest'
import { listRowPixels } from '../../src/main/services/foreground-list-pixels'
import type { ListRow } from '../../src/shared/contracts/foreground-batch'

function screen(offset = 0, changed = false) {
  const image = { width: 400, height: 500, data: Buffer.alloc(400 * 500 * 4, 245) }
  for (let n = 0; n < 4; n++)
    for (let y = 70 + n * 90 - offset; y < 100 + n * 90 - offset; y++)
      if (y >= 50 && y < 450)
        for (let x = 48; x < 120; x++)
          image.data.set([30 + n * 40, 80, changed && n === 1 ? 20 : 160, 255], (y * 400 + x) * 4)
  return image
}
function rows(offset = 0): ListRow[] {
  return Array.from({ length: 4 }, (_, n) => ({
    name: `联系人${n}`,
    nameComplete: true,
    preview: '消息',
    unread: 1,
    point: [0.2, (84 + n * 90 - offset) / 500]
  }))
}
describe('physical list overlap', () => {
  it('does not merge a lone identical row that could be a hidden duplicate on another page', () => {
    const first = [rows()[0]],
      templates = listRowPixels(screen(), [0.1, 0.1, 0.5, 0.8], first, [])
    const next = [rows()[0]]
    listRowPixels(screen(), [0.1, 0.1, 0.5, 0.8], next, templates)
    expect(next[0].pixelIdentity).not.toBe(first[0].pixelIdentity)
  })
  it('does not treat an empty background or model-supplied ID as physical row evidence', () => {
    const blank = { width: 400, height: 500, data: Buffer.alloc(400 * 500 * 4, 245) }
    const first = [rows()[0]]
    first[0].pixelIdentity = '00000000-0000-4000-8000-000000000001'
    const templates = listRowPixels(blank, [0.1, 0.1, 0.5, 0.8], first, [])
    expect(first[0].pixelIdentity).not.toBe('00000000-0000-4000-8000-000000000001')
    const next = [rows()[0]]
    listRowPixels(blank, [0.1, 0.1, 0.5, 0.8], next, templates)
    expect(next[0].pixelIdentity).not.toBe(first[0].pixelIdentity)
  })
  it('retains identity across integer scrolling and OCR point/spelling jitter using exact pixels', () => {
    const first = rows(),
      templates = listRowPixels(screen(), [0.1, 0.1, 0.5, 0.8], first, [])
    const next = rows(20)
    next[1].name = '不同的识别结果'
    next[1].point[1] += 0.012
    listRowPixels(screen(20), [0.1, 0.1, 0.5, 0.8], next, templates)
    expect(next.map((row) => row.pixelIdentity)).toEqual(first.map((row) => row.pixelIdentity))
  })
  it('does not match changed avatar pixels or ambiguous duplicate templates', () => {
    const first = rows(),
      templates = listRowPixels(screen(), [0.1, 0.1, 0.5, 0.8], first, [])
    const next = rows()
    listRowPixels(screen(0, true), [0.1, 0.1, 0.5, 0.8], next, templates)
    expect(next[1].pixelIdentity).not.toBe(first[1].pixelIdentity)
    const duplicate = [{ ...rows()[0] }, { ...rows()[0] }]
    listRowPixels(screen(), [0.1, 0.1, 0.5, 0.8], duplicate, templates)
    expect(duplicate[0].pixelIdentity).not.toBe(first[0].pixelIdentity)
    expect(duplicate[0].pixelIdentity).not.toBe(duplicate[1].pixelIdentity)
  })
})
