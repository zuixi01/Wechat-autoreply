import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Jimp } from 'jimp'
import { z } from 'zod'
import { StickerSchema, type Sticker } from '../../shared/contracts/personal-resources'

const ManifestSchema = z.strictObject({
  assets: z.array(StickerSchema).max(100),
  lastSent: z.record(z.string(), z.number())
})
function dimensions(bytes: Buffer): [number, number] {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.length > 24
  )
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset++] !== 0xff) break
      const marker = bytes[offset++],
        length = bytes.readUInt16BE(offset)
      if (length < 2) break
      if ([0xc0, 0xc1, 0xc2].includes(marker))
        return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)]
      offset += length
    }
  }
  throw new Error('sticker_format_invalid')
}
/** Only bounded, decoded and re-encoded static images reach the clipboard. */
export class PersonalStickerStore {
  private data: z.infer<typeof ManifestSchema>
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true })
    const path = join(root, 'index.json')
    this.data = existsSync(path)
      ? ManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
      : { assets: [], lastSent: {} }
  }
  private save(): void {
    const path = join(this.root, 'index.json'),
      tmp = path + '.' + randomUUID() + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data))
    renameSync(tmp, path)
  }
  list(): Sticker[] {
    return structuredClone(this.data.assets)
  }
  available(target: string): Sticker[] {
    if (
      Date.now() - (this.data.lastSent['*'] ?? 0) < 180000 ||
      Date.now() - (this.data.lastSent[target] ?? 0) < 600000
    )
      return []
    return this.list().filter((asset) => asset.enabled)
  }
  sent(target: string): void {
    this.data.lastSent['*'] = this.data.lastSent[target] = Date.now()
    this.save()
  }
  async import(bytes: Buffer, label: string, tags: string[]): Promise<Sticker> {
    if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('sticker_size_invalid')
    const [width, height] = dimensions(bytes)
    if (!width || !height || width > 2048 || height > 2048) throw new Error('sticker_size_invalid')
    if (this.data.assets.length >= 100) throw new Error('sticker_limit')
    const image = await Jimp.read(bytes)
    if (Math.max(image.width, image.height) > 512) image.scaleToFit({ w: 512, h: 512 })
    const png = await image.getBuffer('image/png')
    const hash = createHash('sha256').update(png).digest('hex')
    const duplicate = this.data.assets.find((asset) => asset.hash === hash)
    if (duplicate) return structuredClone(duplicate)
    const asset = StickerSchema.parse({
      id: randomUUID(),
      label,
      tags,
      enabled: true,
      hash,
      width: image.width,
      height: image.height
    })
    writeFileSync(join(this.root, asset.id + '.png'), png, { flag: 'wx' })
    this.data.assets.push(asset)
    this.save()
    return structuredClone(asset)
  }
  update(id: string, patch: Partial<Pick<Sticker, 'enabled' | 'label' | 'tags'>>): void {
    const index = this.data.assets.findIndex((asset) => asset.id === id)
    if (index < 0) throw new Error('sticker_not_found')
    this.data.assets[index] = StickerSchema.parse({ ...this.data.assets[index], ...patch })
    this.save()
  }
  delete(id: string): void {
    if (!this.data.assets.some((asset) => asset.id === id)) throw new Error('sticker_not_found')
    this.data.assets = this.data.assets.filter((asset) => asset.id !== id)
    this.save()
    unlinkSync(join(this.root, id + '.png'))
  }
  async load(id: string): Promise<{ asset: Sticker; png: Buffer; dib: Buffer }> {
    const asset = this.data.assets.find((asset) => asset.id === id)
    if (!asset) throw new Error('sticker_not_found')
    if (!asset.enabled) throw new Error('sticker_disabled')
    const png = readFileSync(join(this.root, asset.id + '.png'))
    if (createHash('sha256').update(png).digest('hex') !== asset.hash)
      throw new Error('sticker_integrity_failed')
    const image = await Jimp.read(png),
      dib = Buffer.alloc(40 + image.width * image.height * 4)
    dib.writeUInt32LE(40, 0)
    dib.writeInt32LE(image.width, 4)
    dib.writeInt32LE(-image.height, 8)
    dib.writeUInt16LE(1, 12)
    dib.writeUInt16LE(32, 14)
    dib.writeUInt32LE(dib.length - 40, 20)
    for (let n = 0; n < image.bitmap.data.length; n += 4) {
      dib[40 + n] = image.bitmap.data[n + 2]
      dib[40 + n + 1] = image.bitmap.data[n + 1]
      dib[40 + n + 2] = image.bitmap.data[n]
      dib[40 + n + 3] = 255
    }
    return { asset: structuredClone(asset), png, dib }
  }
}
