import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Jimp } from 'jimp'
import { PersonalStickerStore } from '../../src/main/services/personal-sticker-store'

it('imports a local PNG, persists tags and rejects a modified asset before sending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'personal-assets-'))
  try {
    const image = await new Jimp({ width: 32, height: 32, color: 0xffcc00ff }).getBuffer(
      'image/png'
    )
    const store = new PersonalStickerStore(root)
    const asset = await store.import(image, '开心', ['开心', '感谢'])
    expect(new PersonalStickerStore(root).list()[0]).toMatchObject({
      id: asset.id,
      label: '开心',
      enabled: true
    })
    expect((await store.load(asset.id)).dib.length).toBe(40 + 32 * 32 * 4)
    writeFileSync(join(root, asset.id + '.png'), Buffer.from('changed'))
    await expect(store.load(asset.id)).rejects.toThrow('sticker_integrity_failed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
it('rejects non-image input, oversized input and disabled images', async () => {
  const root = mkdtempSync(join(tmpdir(), 'personal-assets-'))
  try {
    const store = new PersonalStickerStore(root)
    await expect(store.import(Buffer.from('<svg/>'), 'bad', [])).rejects.toThrow(
      'sticker_format_invalid'
    )
    await expect(store.import(Buffer.alloc(5 * 1024 * 1024), 'big', [])).rejects.toThrow(
      'sticker_size_invalid'
    )
    const asset = await store.import(
      await new Jimp({ width: 32, height: 32, color: 0xffcc00ff }).getBuffer('image/png'),
      '开心',
      []
    )
    store.update(asset.id, { enabled: false })
    await expect(store.load(asset.id)).rejects.toThrow('sticker_disabled')
    store.delete(asset.id)
    expect(store.list()).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
