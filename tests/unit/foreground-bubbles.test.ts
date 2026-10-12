import { describe, expect, it } from 'vitest'
import {
  chatInputTop,
  chatHeaderBottom,
  textBubbles,
  hasUnpairedChatAvatars,
  type BubblePixels
} from '../../src/main/services/foreground-bubbles'
function frame(): BubblePixels {
  return { width: 800, height: 600, data: Buffer.alloc(800 * 600 * 4, 248) }
}
function rect(
  image: BubblePixels,
  x: number,
  y: number,
  w: number,
  h: number,
  color: number[]
): void {
  for (let row = y; row < y + h; row++)
    for (let col = x; col < x + w; col++) {
      const i = (row * image.width + col) * 4
      image.data[i] = color[0]
      image.data[i + 1] = color[1]
      image.data[i + 2] = color[2]
      image.data[i + 3] = 255
    }
}
function bubble(image: BubblePixels, x: number, y: number, outbound = false): void {
  const color = outbound ? [155, 240, 157] : [236, 236, 238]
  rect(image, x, y, 150, 44, color)
  for (let dx = 0; dx < 8; dx++)
    rect(
      image,
      outbound ? x + 150 + dx : x - 8 + dx,
      y + 22 - (outbound ? 8 - dx : dx),
      1,
      1 + 2 * (outbound ? 8 - dx : dx),
      color
    )
  rect(image, x + 20, y + 12, 80, 3, [15, 15, 15])
}
describe('physical WeChat text bubble segmentation', () => {
  it.each([false, true])(
    'detects a media avatar even when a new text bubble is present: %s',
    (media) => {
      const image = frame()
      bubble(image, 230, 160)
      bubble(image, 230, 300)
      rect(image, 182, 160, 40, 40, [80, 100, 180])
      rect(image, 182, 300, 40, 40, [80, 100, 180])
      if (media) {
        rect(image, 182, 230, 40, 40, [80, 100, 180])
        rect(image, 235, 230, 95, 45, [180, 100, 70])
      }
      const area = [0.2, 0.18, 0.8, 0.55]
      expect(hasUnpairedChatAvatars(image, area, textBubbles(image, area))).toBe(media)
    }
  )
  it('anchors the title above a clipped green bubble even when its grey divider is very light', () => {
    const image = frame()
    bubble(image, 550, 90, true)
    rect(image, 160, 0, 640, 100, [248, 248, 248])
    rect(image, 160, 100, 640, 1, [246, 246, 246])
    expect(chatHeaderBottom(image, 0.2, 0.2)).toBeCloseTo(101 / 600)
    expect(
      chatHeaderBottom({ ...image, data: Buffer.alloc(image.data.length, 60) }, 0.2, 0.2)
    ).toBeUndefined()
  })
  it.each([0.55, 0.8])('uses the editor divider despite an imprecise top estimate: %s', (hint) => {
    const image = frame()
    rect(image, 160, 450, 640, 2, [230, 230, 230])
    expect(chatInputTop(image, 0.2, hint)).toBe(0.75)
  })
  it('does not infer an editor border from a narrow message decoration or a dark theme', () => {
    const image = frame()
    rect(image, 300, 450, 150, 2, [230, 230, 230])
    expect(chatInputTop(image, 0.2, 0.55)).toBeUndefined()
    image.data.fill(60)
    expect(chatInputTop(image, 0.2, 0.7)).toBeUndefined()
  })
  it('uses the physical header divider to reject a clipped top bubble despite an imprecise layout', () => {
    const image = frame()
    bubble(image, 230, 78)
    bubble(image, 230, 160)
    rect(image, 160, 0, 640, 100, [248, 248, 248])
    rect(image, 160, 100, 640, 1, [237, 237, 237])
    const result = textBubbles(image, [0.2, 0.1, 0.8, 0.7])
    expect(result).toHaveLength(1)
    expect(result[0].y).toBe(160)
  })
  it('keeps identical bubbles at distinct positions and separates directions', () => {
    const image = frame()
    bubble(image, 230, 110)
    bubble(image, 230, 190)
    bubble(image, 550, 270, true)
    const result = textBubbles(image, [0.2, 0.1, 0.8, 0.7])
    expect(result.map((b) => b.direction)).toEqual(['inbound', 'inbound', 'outbound'])
    expect(result[0].fingerprint).toBe(result[1].fingerprint)
    expect(result[0].y).not.toBe(result[1].y)
  })
  it('rejects untailored avatars, image rectangles and clipped bubbles', () => {
    const image = frame()
    rect(image, 230, 110, 150, 44, [236, 236, 238])
    rect(image, 550, 190, 150, 44, [155, 240, 157])
    rect(image, 190, 270, 44, 44, [236, 236, 238])
    bubble(image, 230, 50)
    expect(textBubbles(image, [0.2, 0.1, 0.8, 0.7])).toEqual([])
  })
  it('does not mistake an unsupported blank/dark surface for received text', () => {
    expect(textBubbles(frame(), [0.2, 0.1, 0.8, 0.7])).toEqual([])
    const image = frame()
    image.data.fill(25)
    expect(textBubbles(image, [0.2, 0.1, 0.8, 0.7])).toEqual([])
  })
})
