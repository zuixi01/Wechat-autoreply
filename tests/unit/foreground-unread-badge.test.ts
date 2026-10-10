import { describe, expect, it } from 'vitest'
import { listScrollEdges, unreadBadge } from '../../src/main/services/foreground-unread-badge'

function badge(number = false) {
  const image = { width: 100, height: 100, data: Buffer.alloc(100 * 100 * 4, 255) }
  for (let y = 10; y < 30; y++)
    for (let x = 10; x < 30; x++)
      if ((x - 19.5) ** 2 + (y - 19.5) ** 2 < 100)
        image.data.set([250, 70, 75, 255], (y * 100 + x) * 4)
  if (number) for (let y = 14; y < 26; y++) image.data.set([255, 255, 255, 255], (y * 100 + 20) * 4)
  return image
}
describe('localized unread badge pixels', () => {
  it('uses the physical scrollbar to verify the top and bottom of the list', () => {
    const image = { width: 200, height: 200, data: Buffer.alloc(200 * 200 * 4, 255) }
    const paint = (top: number, bottom: number) => {
      image.data.fill(255)
      for (let y = top; y < bottom; y++)
        for (let x = 188; x < 195; x++) image.data.set([160, 160, 160, 255], (y * 200 + x) * 4)
    }
    paint(12, 65)
    expect(listScrollEdges(image, [0, 0.05, 1, 0.9])).toEqual({ atTop: true, atBottom: false })
    for (let y = 10; y < 40; y++)
      for (let x = 170; x < 200; x++) image.data.set([16, 170, 113, 255], (y * 200 + x) * 4)
    for (let y = 12; y < 40; y++)
      for (let x = 188; x < 195; x++) image.data.set([7, 145, 94, 255], (y * 200 + x) * 4)
    expect(listScrollEdges(image, [0, 0.05, 1, 0.9])).toEqual({ atTop: true, atBottom: false })
    paint(136, 188)
    expect(listScrollEdges(image, [0, 0.05, 1, 0.9])).toEqual({ atTop: false, atBottom: true })
    image.data.fill(255)
    expect(listScrollEdges(image, [0, 0.05, 1, 0.9])).toBeUndefined()
  })
  it('recognizes a solid red dot without inventing an unread count', () => {
    expect(unreadBadge(badge(), [0.08, 0.08, 0.24, 0.24])).toBe('dot')
  })
  it('keeps an unreadable numbered badge distinct from a solid dot', () => {
    expect(unreadBadge(badge(true), [0.08, 0.08, 0.24, 0.24])).toBe('count')
  })
  it('does not detect an avatar elsewhere in the list as a badge', () => {
    expect(unreadBadge(badge(), [0.4, 0.4, 0.2, 0.2])).toBe('none')
  })
  it('rejects a broad red rectangle and oversized model geometry', () => {
    const image = badge()
    for (let y = 10; y < 30; y++)
      for (let x = 10; x < 30; x++) image.data.set([250, 70, 75, 255], (y * 100 + x) * 4)
    expect(unreadBadge(image, [0.1, 0.1, 0.2, 0.2])).toBe('unknown')
    expect(unreadBadge(image, [0, 0, 1, 1])).toBe('unknown')
  })
})
