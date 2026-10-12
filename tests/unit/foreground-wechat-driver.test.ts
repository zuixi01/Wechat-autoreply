import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Jimp } from 'jimp'
import { PNG } from 'pngjs'
import { z } from 'zod'

const f = vi.hoisted(() => ({
  active: 71,
  occluded: false,
  searchOccluded: undefined as boolean | undefined,
  searchTyping: false,
  revision: 'rules-1',
  png: Buffer.alloc(0) as Buffer<ArrayBufferLike>,
  tap: vi.fn(),
  type: vi.fn(),
  readEditor: vi.fn(),
  move: vi.fn(),
  click: vi.fn(),
  scroll: vi.fn(),
  fetch: vi.fn(),
  inspectEffect: undefined as undefined | (() => void),
  extraWindows: [] as (typeof nativeWindow)[]
}))
function changeScreen(x = 400, y = 200): void {
  const png = PNG.sync.read(f.png)
  const offset = (y * png.width + x) * 4
  png.data[offset] = (png.data[offset] + 1) % 255
  f.png = PNG.sync.write(png)
}
const nativeWindow = {
  id: '71',
  pid: 123,
  path: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
  startTicks: '123456',
  bounds: { x: 0, y: 0, width: 800, height: 600 }
}
const windows = {
  inspect: async () => {
    f.inspectEffect?.()
    return {
      id: '00000000-0000-4000-8000-000000000000',
      ok: true as const,
      windows: [nativeWindow, ...f.extraWindows],
      foreground: String(f.active),
      occluded: f.occluded,
      searchOccluded: f.searchOccluded
    }
  },
  focus: async () => {
    f.active = 71
  },
  typeText: async (binding: typeof nativeWindow, text: string, signal: AbortSignal) => {
    if (signal.aborted || String(f.active) !== binding.id) throw new Error('foreground_lost')
    changeScreen(400, 470)
    if (f.searchTyping) {
      f.occluded = true
      f.searchOccluded = false
    }
    return f.type(text) as void | string
  },
  typeSearch: async (_binding: typeof nativeWindow, text: string) => {
    if (f.searchTyping) {
      f.occluded = true
      f.searchOccluded = false
    }
    return f.type(text) as string
  },
  readEditorText: async () => f.readEditor() as Promise<string>
}
vi.mock('electron', () => ({
  desktopCapturer: {
    getSources: async () => {
      const png = Buffer.from(f.png)
      return [
        {
          id: 'window:71:0',
          thumbnail: {
            isEmpty: () => false,
            toPNG: () => png,
            toDataURL: () => 'data:image/png;base64,' + png.toString('base64')
          }
        }
      ]
    }
  }
}))
vi.mock('../../src/core/rpa/util', () => ({
  getRobot: () => ({
    moveMouse: f.move,
    mouseClick: f.click,
    typeString: () => {
      throw new Error('RobotJS Unicode input must not be used')
    },
    keyTap: f.tap,
    scrollMouse: f.scroll,
    getScreenSize: () => ({ width: 1920, height: 1080 }),
    screen: {
      capture: () => {
        const png = PNG.sync.read(f.png),
          image = Buffer.from(png.data)
        for (let i = 0; i < image.length; i += 4) {
          const r = image[i]
          image[i] = image[i + 2]
          image[i + 2] = r
        }
        return {
          width: png.width,
          height: png.height,
          image,
          bytesPerPixel: 4,
          byteWidth: png.width * 4
        }
      }
    }
  })
}))
import { ForegroundWechatDriver } from '../../src/main/services/foreground-wechat-driver'
import type { PersonalStickerStore } from '../../src/main/services/personal-sticker-store'

const visual = (inputText = '', messages = [{ direction: 'inbound', text: '问题' }]) => ({
  contact: 'Q',
  privateChat: true,
  inputText,
  messages,
  header: [0.4, 0.1, 0.5, 0.1],
  history: [0.4, 0.2, 0.5, 0.4],
  input: [0.4, 0.7, 0.5, 0.2]
})
const model = {
  apiKey: 'synthetic-key',
  modelName: 'synthetic-model',
  baseURL: 'https://model.example/v1',
  capabilities: ['text', 'vision']
}
const response = (value: unknown) => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }]
  })
})
const controllers: AbortController[] = []
const operations = new Set<Promise<unknown>>()
function controller(): AbortController {
  const value = new AbortController()
  controllers.push(value)
  return value
}
// These unit tests use synthetic native input and HTTP. Advance real driver UI waits,
// while retaining actual PNG encoding, cancellation and all send/echo assertions.
async function advance<T>(work: Promise<T>): Promise<T> {
  const settled = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  )
  operations.add(settled)
  try {
    await vi.runAllTimersAsync()
    const result = await settled
    if (!result.ok) throw result.error
    return result.value
  } finally {
    operations.delete(settled)
  }
}
beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  f.active = 71
  f.occluded = false
  f.searchOccluded = undefined
  f.searchTyping = false
  f.revision = 'rules-1'
  f.inspectEffect = undefined
  f.extraWindows = []
  f.readEditor.mockResolvedValue('')
  nativeWindow.bounds = { x: 0, y: 0, width: 800, height: 600 }
  f.png = await new Jimp({ width: 800, height: 600, color: 0xffffffff }).getBuffer('image/png')
  vi.stubGlobal('fetch', f.fetch)
  f.tap.mockImplementation((key) => {
    if (key === 'enter') changeScreen()
  })
})
afterEach(async () => {
  try {
    for (const value of controllers.splice(0)) value.abort()
    await vi.runAllTimersAsync()
    await Promise.allSettled([...operations])
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
async function connected() {
  const driver = new ForegroundWechatDriver(
    () => ({ vision: model, reply: model, rules: '简洁回复', revision: f.revision }),
    windows
  )
  f.fetch
    .mockResolvedValueOnce(response({ search: [0.2, 0.1], loggedIn: true }))
    .mockResolvedValueOnce(
      response({ matches: [{ name: 'Q', privateChat: true, point: [0.2, 0.25] }], hasMore: false })
    )
    .mockResolvedValueOnce(response(visual()))
  const signal = controller().signal
  await advance(driver.connect('Q', signal))
  const observation = await advance(driver.read(signal))
  f.tap.mockClear()
  f.type.mockClear()
  return { driver, signal, observation }
}
describe('project foreground sender boundaries', () => {
  it('preserves an independently stored non-text boundary when identical pixels get a new OCR label', async () => {
    const png = PNG.sync.read(f.png),
      color = [155, 240, 157, 255]
    for (let row = 160; row < 204; row++)
      for (let col = 580; col < 720; col++) png.data.set(color, (row * 800 + col) * 4)
    for (let dx = 0; dx < 8; dx++)
      for (let row = 182 - dx; row <= 182 + dx; row++)
        png.data.set(color, (row * 800 + 727 - dx) * 4)
    f.png = PNG.sync.write(png)
    const make = () =>
      new ForegroundWechatDriver(
        () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
        windows
      )
    const first = make(),
      signal = controller().signal
    await advance(first.connect('Q', signal, 'current_chat'))
    f.fetch.mockResolvedValueOnce(
      response(visual('', [{ direction: 'system', text: '[非文本消息]' }]))
    )
    const old = await advance(first.read(signal))
    expect(old.messages[0].pixelFingerprint).toMatch(/^[a-f0-9]{64}$/)
    const second = make()
    await advance(second.connect('Q', signal, 'current_chat'))
    second.seed(old.messages)
    f.fetch.mockResolvedValueOnce(response(visual('', [{ direction: 'outbound', text: '😄' }])))
    expect((await advance(second.read(signal))).messages).toEqual(old.messages)
  })
  it('keeps non-text placeholders out of incoming text even when OCR labels their direction', async () => {
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    const signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    f.fetch.mockResolvedValue(
      response(
        visual('', [
          { direction: 'inbound', text: '普通问题' },
          { direction: 'inbound', text: '[非文本消息]' },
          { direction: 'outbound', text: '[非文本消息]' }
        ])
      )
    )
    expect(
      (await advance(driver.read(signal))).messages.map((message) => message.direction)
    ).toEqual(['inbound', 'system', 'system'])
  })
  it('constrains full chat reading without accepting invented message fields', async () => {
    await connected()
    const body = JSON.parse(f.fetch.mock.calls.at(-1)![1].body)
    expect(body.response_format.type).toBe('json_schema')
    expect(body.response_format.json_schema.schema.properties.messages.items).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['direction', 'text'],
      properties: { direction: { enum: ['inbound', 'outbound', 'system'] } }
    })
  })
  it('constrains search coordinates and result shape at the provider boundary', async () => {
    const t = await connected()
    const body = JSON.parse(f.fetch.mock.calls[0][1].body)
    expect(body.response_format.type).toBe('json_schema')
    expect(body.response_format.json_schema.strict).toBe(true)
    const schema = body.response_format.json_schema.schema
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['search', 'loggedIn'])
    expect(schema.properties.search).toMatchObject({
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: { type: 'number', minimum: 0, maximum: 1 }
    })
    expect(f.type).not.toHaveBeenCalled()
    expect(t.observation.contact).toBe('Q')
  })
  it('falls back once only when strict structured vision is explicitly unsupported', async () => {
    let rejected = 0
    f.fetch.mockImplementation(async (_url, request) => {
      const body = JSON.parse(request.body)
      if (body.response_format?.type === 'json_schema') {
        rejected++
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: {
              param: 'response_format',
              message: 'json_schema is not supported by this model'
            }
          })
        }
      }
      const prompt = body.messages[1].content[0].text as string
      return response(
        prompt.startsWith('定位')
          ? { search: [0.2, 0.1], loggedIn: true }
          : { matches: [{ name: 'Q', privateChat: true, point: [0.2, 0.25] }], hasMore: false }
      )
    })
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    await advance(driver.connect('Q', controller().signal))
    expect(rejected).toBe(1)
    expect(f.fetch).toHaveBeenCalledTimes(3)
  })
  it('reads screenshots without a provider default reasoning delay', async () => {
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    const signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    f.fetch.mockImplementation(async (_url, request) => {
      const body = JSON.parse(request.body)
      return body.reasoning_effort === 'none'
        ? response(visual())
        : {
            ok: false,
            status: 504,
            json: async () => ({ error: { message: 'reasoning timeout' } })
          }
    })
    expect((await advance(driver.read(signal))).contact).toBe('Q')
    expect(f.type).not.toHaveBeenCalled()
  })
  it('negotiates an unsupported reasoning option once and retains legacy vision compatibility', async () => {
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    const signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    let rejected = 0
    f.fetch.mockImplementation(async (_url, request) => {
      if ('reasoning_effort' in JSON.parse(request.body)) {
        if (++rejected > 1) throw new Error('unsupported option was not remembered')
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: { param: 'reasoning_effort', message: 'Unsupported parameter: reasoning_effort' }
          })
        }
      }
      return response(visual())
    })
    expect((await advance(driver.read(signal))).contact).toBe('Q')
    changeScreen()
    expect((await advance(driver.read(signal))).contact).toBe('Q')
    expect(rejected).toBe(1)
    expect(f.type).not.toHaveBeenCalled()
  })
  it('does not disguise unrelated provider rejection as reasoning negotiation', async () => {
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    const signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    let calls = 0
    f.fetch.mockImplementation(async () => {
      if (++calls > 1) return response(visual())
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { param: 'model', message: 'Invalid model' } })
      }
    })
    await expect(advance(driver.read(signal))).rejects.toThrow('model_failed')
    expect(calls).toBe(1)
  })
  it('does not keep polling the model for an unchanged media chat after cache expiry', async () => {
    const driver = new ForegroundWechatDriver(
        () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
        windows
      ),
      signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    f.fetch.mockResolvedValueOnce(
      response(visual('', [{ direction: 'system', text: '[非文本消息]' }]))
    )
    const first = await advance(driver.read(signal))
    driver.accept(first)
    const calls = f.fetch.mock.calls.length
    vi.setSystemTime(Date.now() + 31000)
    f.fetch.mockResolvedValueOnce(response({ inputText: '' }))
    expect(await advance(driver.read(signal))).toEqual(first)
    expect(f.fetch).toHaveBeenCalledTimes(calls)
    f.fetch.mockReset()
    changeScreen(500, 250)
    const changed = visual('', [
      { direction: 'system', text: '[非文本消息]' },
      { direction: 'inbound', text: '新问题' }
    ])
    f.fetch.mockResolvedValueOnce(response(changed))
    expect((await advance(driver.read(signal))).messages).toEqual(changed.messages)
    expect(f.fetch).toHaveBeenCalledTimes(1)
    f.revision = 'updated-rules'
    f.fetch.mockResolvedValueOnce(response(changed))
    expect((await advance(driver.read(signal))).revision).toBe('updated-rules')
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })
  it('keeps media received together with a new text instead of silently dropping it', async () => {
    const draw = (y: number, text: boolean): void => {
      const image = PNG.sync.read(f.png)
      for (let row = y; row < y + 40; row++)
        for (let x = 342; x < 382; x++) image.data.set([80, 100, 180, 255], (row * 800 + x) * 4)
      for (let row = y; row < y + 44; row++)
        for (let x = 400; x < 550; x++)
          image.data.set(text ? [236, 236, 238, 255] : [180, 100, 70, 255], (row * 800 + x) * 4)
      if (text)
        for (let dx = 0; dx < 8; dx++)
          for (let row = y + 22 - dx; row <= y + 22 + dx; row++)
            image.data.set([236, 236, 238, 255], (row * 800 + 392 + dx) * 4)
      f.png = PNG.sync.write(image)
    }
    draw(160, true)
    const driver = new ForegroundWechatDriver(
        () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
        windows
      ),
      signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    f.fetch.mockResolvedValueOnce(response(visual('', [{ direction: 'inbound', text: '旧消息' }])))
    driver.accept(await driver.read(signal))
    draw(230, false)
    draw(310, true)
    const messages = [
      { direction: 'inbound', text: '旧消息' },
      { direction: 'system', text: '[非文本消息]' },
      { direction: 'inbound', text: '新消息' }
    ]
    f.fetch.mockImplementationOnce(async (_url, request) => {
      const prompt = JSON.parse(request.body).messages[1].content[0].text
      return response(
        prompt.includes('读取当前实际打开的聊天')
          ? visual('', messages)
          : { text: '新消息', inputText: '' }
      )
    })
    const next = await driver.read(signal)
    expect(next.messages.map(({ direction, text }) => ({ direction, text }))).toEqual(messages)
    expect(f.tap).not.toHaveBeenCalled()
    expect(f.type).not.toHaveBeenCalled()
  })
  it.each(['confirmed', 'unverified', 'unchanged_history', 'incoming_only', 'unrelated_unread'])(
    'sends an image only after draft and receipt verification: %s',
    async (receiptCase) => {
      const verifiedReceipt = receiptCase !== 'unverified'
      const oldImages = [
        { direction: 'system', text: '[非文本消息]' },
        { direction: 'system', text: '[非文本消息]' }
      ]
      const assetId = '00000000-0000-4000-8000-000000000001',
        png = await new Jimp({ width: 32, height: 32, color: 0xffcc00ff }).getBuffer('image/png')
      const sent = vi.fn()
      const stickerStore = {
        load: async () => ({ png, dib: Buffer.alloc(44) }),
        sent
      } as unknown as PersonalStickerStore
      const driver = new ForegroundWechatDriver(
        () => ({ vision: model, reply: model, rules: '回复', revision: f.revision, stickerStore }),
        {
          ...windows,
          pasteImage: async () => {
            changeScreen(400, 470)
          }
        }
      )
      const signal = controller().signal
      await advance(driver.connect('Q', signal, 'current_chat'))
      f.fetch.mockResolvedValueOnce(
        response(
          receiptCase === 'unchanged_history'
            ? visual('', oldImages)
            : receiptCase === 'incoming_only'
              ? visual('', oldImages.slice(0, 1))
              : visual()
        )
      )
      const before = await advance(driver.read(signal))
      f.fetch
        .mockImplementationOnce(async () => {
          if (receiptCase === 'unrelated_unread') changeScreen(100, 150)
          return response({
            contact: 'Q',
            privateChat: true,
            matchingDraft: true,
            draftImageCount: 1,
            draftTextEmpty: true,
            overlay: false
          })
        })
        .mockResolvedValueOnce(
          response(
            visual(
              '',
              receiptCase === 'unchanged_history' || receiptCase === 'incoming_only'
                ? oldImages
                : [
                    { direction: 'inbound', text: '问题' },
                    { direction: 'system', text: '[非文本消息]' }
                  ]
            )
          )
        )
        .mockResolvedValueOnce(
          response({
            contact: 'Q',
            privateChat: true,
            latestOutboundMatches: verifiedReceipt,
            newOutboundMatches: ['confirmed', 'unrelated_unread'].includes(receiptCase),
            editorEmpty: true,
            outboundImageCount: 1
          })
        )
      expect(await advance(driver.dispatchImage(before, { kind: 'image', assetId }, signal))).toBe(
        ['confirmed', 'unrelated_unread'].includes(receiptCase) ? 'sent' : 'unknown'
      )
      expect(f.tap.mock.calls).toEqual([['enter']])
      expect(sent).toHaveBeenCalledTimes(
        ['confirmed', 'unrelated_unread'].includes(receiptCase) ? 1 : 0
      )
    }
  )
  it('never sends an image when the pasted preview belongs to another conversation', async () => {
    const png = await new Jimp({ width: 32, height: 32, color: 0xffcc00ff }).getBuffer('image/png')
    const driver = new ForegroundWechatDriver(
      () => ({
        vision: model,
        reply: model,
        rules: '回复',
        revision: f.revision,
        stickerStore: {
          load: async () => ({ png, dib: Buffer.alloc(44) })
        } as unknown as PersonalStickerStore
      }),
      {
        ...windows,
        pasteImage: async () => {
          changeScreen(400, 470)
        }
      }
    )
    const signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    f.fetch.mockResolvedValueOnce(response(visual()))
    const before = await advance(driver.read(signal))
    f.fetch.mockResolvedValueOnce(
      response({
        contact: 'wrong',
        privateChat: true,
        matchingDraft: true,
        draftImageCount: 1,
        draftTextEmpty: true,
        overlay: false
      })
    )
    expect(
      await advance(
        driver.dispatchImage(
          before,
          { kind: 'image', assetId: '00000000-0000-4000-8000-000000000001' },
          signal
        )
      )
    ).toBe('not_sent')
    expect(f.tap).not.toHaveBeenCalled()
  })
  it.each([false, true])(
    'reanchors an expanded image editor and rejects intervening new input: %s',
    async (newInput) => {
      const png = await new Jimp({ width: 32, height: 32, color: 0xffcc00ff }).getBuffer(
        'image/png'
      )
      const original = PNG.sync.read(f.png)
      for (let x = 320; x < 800; x++) original.data.set([230, 230, 230, 255], (450 * 800 + x) * 4)
      f.png = PNG.sync.write(original)
      const driver = new ForegroundWechatDriver(
        () => ({
          vision: model,
          reply: model,
          rules: '回复',
          revision: f.revision,
          stickerStore: {
            load: async () => ({ png, dib: Buffer.alloc(44) }),
            sent: vi.fn()
          } as unknown as PersonalStickerStore
        }),
        {
          ...windows,
          pasteImage: async () => {
            const resized = PNG.sync.read(f.png)
            for (let x = 320; x < 800; x++) {
              resized.data.set([255, 255, 255, 255], (450 * 800 + x) * 4)
              resized.data.set([230, 230, 230, 255], (390 * 800 + x) * 4)
            }
            resized.data.set([20, 20, 20, 255], (300 * 800 + 500) * 4)
            f.png = PNG.sync.write(resized)
          }
        }
      )
      const signal = controller().signal
      await advance(driver.connect('Q', signal, 'current_chat'))
      f.fetch.mockResolvedValueOnce(response(visual()))
      const before = await advance(driver.read(signal))
      f.fetch
        .mockResolvedValueOnce(
          response({
            contact: 'Q',
            privateChat: true,
            matchingDraft: true,
            draftImageCount: 1,
            draftTextEmpty: true,
            overlay: false
          })
        )
        .mockResolvedValueOnce(
          response({
            ...visual(
              '',
              newInput
                ? [
                    { direction: 'inbound', text: '问题' },
                    { direction: 'inbound', text: '先别发表情了' }
                  ]
                : [{ direction: 'inbound', text: '问题' }]
            ),
            input: [0.4, 0.65, 0.5, 0.25]
          })
        )
        .mockResolvedValueOnce(
          response(
            visual('', [
              { direction: 'inbound', text: '问题' },
              { direction: 'system', text: '[非文本消息]' }
            ])
          )
        )
        .mockResolvedValueOnce(
          response({
            contact: 'Q',
            privateChat: true,
            latestOutboundMatches: true,
            newOutboundMatches: true,
            editorEmpty: true,
            outboundImageCount: 1
          })
        )
      expect(
        await advance(
          driver.dispatchImage(
            before,
            { kind: 'image', assetId: '00000000-0000-4000-8000-000000000001' },
            signal
          )
        )
      ).toBe(newInput ? 'not_sent' : 'sent')
      expect(f.tap.mock.calls).toEqual(newInput ? [] : [['enter']])
    }
  )
  it('waits without vision requests or input while a notification covers the foreground chat', async () => {
    const t = await connected()
    const calls = f.fetch.mock.calls.length
    f.occluded = true
    await expect(t.driver.read(t.signal)).rejects.toThrow('screen_obscured')
    expect(await t.driver.dispatch(t.observation, '未输入的回复', t.signal)).toBe('not_sent')
    expect(t.driver.dispatchFailure()).toMatchObject({
      failureReason: 'screen_obscured',
      failureStage: 'before_input'
    })
    expect(f.fetch).toHaveBeenCalledTimes(calls)
    expect(f.type).not.toHaveBeenCalled()
    expect(f.tap).not.toHaveBeenCalled()
    f.occluded = false
    expect(await t.driver.read(t.signal)).toEqual(t.observation)
  })
  it('revalidates focus-related chat pixels before typing and retains all send checks', async () => {
    const t = await connected()
    const text = '确认后的回复'
    f.click.mockImplementationOnce(() => changeScreen(400, 200))
    f.type.mockReturnValueOnce(text)
    f.readEditor.mockResolvedValueOnce(text)
    f.fetch.mockResolvedValueOnce(response(visual())).mockResolvedValueOnce(
      response(
        visual('', [
          { direction: 'inbound', text: '问题' },
          { direction: 'outbound', text }
        ])
      )
    )
    expect(await advance(t.driver.dispatch(t.observation, text, t.signal))).toBe('sent')
    expect(f.type).toHaveBeenCalledTimes(1)
    expect(f.tap.mock.calls).toEqual([['enter']])
  })
  it('re-reads the complete screen during recovery and replaces poisoned bubble OCR', async () => {
    const t = await connected()
    const png = PNG.sync.read(f.png)
    for (const y of [160, 230]) {
      for (let row = y; row < y + 44; row++)
        for (let x = 400; x < 550; x++) png.data.set([236, 236, 238, 255], (row * 800 + x) * 4)
      for (let dx = 0; dx < 8; dx++)
        for (let row = y + 22 - dx; row <= y + 22 + dx; row++)
          png.data.set([236, 236, 238, 255], (row * 800 + 392 + dx) * 4)
    }
    f.png = PNG.sync.write(png)
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '简洁回复', revision: f.revision }),
      windows
    )
    const messages = (text: string) => [
      { direction: 'inbound', text },
      { direction: 'inbound', text }
    ]
    f.fetch.mockResolvedValueOnce(response(visual('', messages('误读'))))
    await advance(driver.connect('Q', t.signal, 'current_chat'))
    const first = await driver.read(t.signal)
    driver.accept(first)
    const calls = f.fetch.mock.calls.length
    f.fetch.mockResolvedValueOnce(response(visual('', messages('正确原文'))))
    const recovered = await driver.read(t.signal, true)
    expect(recovered.messages.map((message) => message.text)).toEqual(['正确原文', '正确原文'])
    expect(f.fetch).toHaveBeenCalledTimes(calls + 1)
    driver.accept(recovered)
    expect((await driver.read(t.signal)).messages).toEqual(recovered.messages)
    expect(f.fetch).toHaveBeenCalledTimes(calls + 1)
  })
  it('retains the bottom reply when the model puts the editor above its physical divider', async () => {
    const t = await connected()
    const png = PNG.sync.read(f.png)
    for (let col = 320; col < 800; col++) png.data.set([230, 230, 230, 255], (450 * 800 + col) * 4)
    for (let row = 370; row < 414; row++)
      for (let col = 580; col < 720; col++)
        png.data.set([155, 240, 157, 255], (row * 800 + col) * 4)
    for (let dx = 0; dx < 8; dx++)
      for (let row = 392 - dx; row <= 392 + dx; row++)
        png.data.set([155, 240, 157, 255], (row * 800 + 720 + dx) * 4)
    f.png = PNG.sync.write(png)
    f.fetch.mockResolvedValueOnce(
      response({
        ...visual('', [{ direction: 'outbound', text: '最下面的回复' }]),
        input: [0.4, 0.6, 0.5, 0.3]
      })
    )
    const next = await t.driver.read(t.signal, true)
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]).toMatchObject({
      direction: 'outbound',
      text: '最下面的回复',
      pixelFingerprint: expect.any(String)
    })
    expect(f.type).not.toHaveBeenCalled()
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('sends an exact native Unicode readback including emoji without a draft vision request', async () => {
    const t = await connected()
    const text = '你好呀，带 emoji 🤣。'
    f.type.mockReturnValueOnce(text)
    f.readEditor.mockResolvedValueOnce(text)
    const before = f.fetch.mock.calls.length
    f.fetch.mockResolvedValueOnce(
      response(
        visual('', [
          { direction: 'inbound', text: '问题' },
          { direction: 'outbound', text }
        ])
      )
    )
    expect(await advance(t.driver.dispatch(t.observation, text, t.signal))).toBe('sent')
    expect(f.fetch).toHaveBeenCalledTimes(before + 1)
    expect(f.type).toHaveBeenCalledTimes(1)
    expect(f.readEditor).toHaveBeenCalledTimes(2)
    expect(f.tap.mock.calls).toEqual([['enter']])
  })
  it('blocks a dropped supplementary character before Enter and records the actual failure', async () => {
    const t = await connected()
    f.type.mockReturnValueOnce('你好呀。')
    expect(await advance(t.driver.dispatch(t.observation, '你好呀。🤣', t.signal))).toBe('not_sent')
    expect(t.driver.dispatchFailure()).toEqual({
      failureReason: 'send_draft_mismatch',
      failureStage: 'draft_validation'
    })
    expect(f.tap).not.toHaveBeenCalled()
    expect(f.readEditor).not.toHaveBeenCalled()
  })
  it('blocks human input appearing between native readback and the anchored capture', async () => {
    const t = await connected()
    f.type.mockReturnValueOnce('测试回复')
    f.readEditor.mockResolvedValueOnce('我来自己回复')
    expect(await advance(t.driver.dispatch(t.observation, '测试回复', t.signal))).toBe('not_sent')
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('blocks human input during the second native readback using the earlier pixel anchor', async () => {
    const t = await connected()
    f.type.mockReturnValueOnce('测试回复')
    f.readEditor.mockImplementationOnce(async () => {
      changeScreen(500, 480)
      return '测试回复'
    })
    expect(await advance(t.driver.dispatch(t.observation, '测试回复', t.signal))).toBe('not_sent')
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('blocks a nonhuman knowledge fallback without calling the model or typing', async () => {
    const driver = new ForegroundWechatDriver(
      () => ({
        vision: model,
        reply: model,
        rules: '自然聊天',
        revision: f.revision,
        knowledge: () => ({ instructions: '', fallback: '我没有真实的身体，无法外出。' })
      }),
      windows
    )
    await expect(
      driver.generate(
        {
          windowToken: 'synthetic',
          contact: 'Q',
          privateChat: true,
          inputText: '',
          messages: [{ direction: 'inbound', text: '出去玩吗？' }],
          revision: f.revision
        },
        controller().signal
      )
    ).rejects.toThrow('reply_identity_invalid')
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.type).not.toHaveBeenCalled()
    expect(f.tap).not.toHaveBeenCalled()
  })

  it('refuses a virtual self-description supplied directly to dispatch before any input', async () => {
    const t = await connected()
    expect(await t.driver.dispatch(t.observation, '我是一个虚拟助手。', t.signal)).toBe('not_sent')
    expect(f.type).not.toHaveBeenCalled()
    expect(f.tap).not.toHaveBeenCalled()
  })

  it.each(['', '人工草稿'])(
    'reads a new bubble and changed draft evidence in one request: %s',
    async (inputText) => {
      const t = await connected()
      const draw = (y: number, width: number): void => {
        const png = PNG.sync.read(f.png)
        for (let row = y; row < y + 44; row++)
          for (let x = 400; x < 400 + width; x++)
            png.data.set([236, 236, 238, 255], (row * 800 + x) * 4)
        for (let dx = 0; dx < 8; dx++)
          for (let row = y + 22 - dx; row <= y + 22 + dx; row++)
            png.data.set([236, 236, 238, 255], (row * 800 + 392 + dx) * 4)
        f.png = PNG.sync.write(png)
      }
      draw(160, 150)
      const driver = new ForegroundWechatDriver(
        () => ({ vision: model, reply: model, rules: '简洁回复', revision: f.revision }),
        windows
      )
      f.fetch.mockResolvedValueOnce(
        response(visual('', [{ direction: 'inbound', text: '旧消息' }]))
      )
      await advance(driver.connect('Q', t.signal, 'current_chat'))
      driver.accept(await driver.read(t.signal))
      vi.setSystemTime(Date.now() + 31000)
      draw(230, 175)
      changeScreen(400, 470)
      const before = f.fetch.mock.calls.length
      f.fetch.mockResolvedValueOnce(response({ text: '新消息', inputText }))
      const next = await driver.read(t.signal)
      expect(next.messages.map((message) => message.text)).toEqual(['旧消息', '新消息'])
      expect(next.inputText).toBe(inputText)
      expect(f.fetch).toHaveBeenCalledTimes(before + 1)
      expect(f.type).not.toHaveBeenCalled()
      expect(f.tap).not.toHaveBeenCalled()
    }
  )
  it('keeps clipped message pixels out of the title and reuses exact unchanged draft pixels after idle', async () => {
    const t = await connected()
    const draw = (y: number, x: number, width: number, outbound = false): void => {
      const png = PNG.sync.read(f.png),
        color = outbound ? [155, 240, 157, 255] : [236, 236, 238, 255]
      for (let row = y; row < y + 44; row++)
        for (let col = x; col < x + width; col++) png.data.set(color, (row * 800 + col) * 4)
      for (let dx = 0; dx < 8; dx++)
        for (let row = y + 22 - dx; row <= y + 22 + dx; row++)
          png.data.set(color, (row * 800 + (outbound ? x + width + 7 - dx : x - 8 + dx)) * 4)
      f.png = PNG.sync.write(png)
    }
    draw(90, 580, 140, true)
    draw(160, 400, 150)
    const png = PNG.sync.read(f.png)
    for (let row = 0; row < 100; row++)
      for (let col = 320; col < 800; col++)
        png.data.set([248, 248, 248, 255], (row * 800 + col) * 4)
    for (let col = 320; col < 800; col++) png.data.set([246, 246, 246, 255], (100 * 800 + col) * 4)
    f.png = PNG.sync.write(png)
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '简洁回复', revision: f.revision }),
      windows
    )
    f.fetch.mockResolvedValueOnce(response(visual('', [{ direction: 'inbound', text: '旧消息' }])))
    await advance(driver.connect('Q', t.signal, 'current_chat'))
    driver.accept(await driver.read(t.signal))
    const calls = f.fetch.mock.calls.length
    vi.setSystemTime(Date.now() + 31000)
    await driver.read(t.signal)
    expect(f.fetch).toHaveBeenCalledTimes(calls)
    changeScreen(600, 110)
    draw(230, 400, 175)
    f.fetch.mockResolvedValueOnce(response({ text: '新消息' }))
    const next = await driver.read(t.signal)
    expect(next.messages.map((m) => m.text)).toEqual(['旧消息', '新消息'])
    expect(next.inputText).toBe('')
    expect(f.fetch).toHaveBeenCalledTimes(calls + 1)
    expect(JSON.parse(f.fetch.mock.calls.at(-1)![1].body).messages[1].content[0].text).toContain(
      '图片仅包含一个聊天气泡'
    )
    expect(f.type).not.toHaveBeenCalled()
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('retains duplicate physical messages and reads only newly appearing bubbles', async () => {
    const t = await connected()
    const draw = (y: number) => {
      const png = PNG.sync.read(f.png)
      const rect = (x: number, y: number, w: number, h: number, color: number[]) => {
        for (let row = y; row < y + h; row++)
          for (let col = x; col < x + w; col++) {
            const i = (row * png.width + col) * 4
            png.data.set([...color, 255], i)
          }
      }
      rect(400, y, 150, 44, [236, 236, 238])
      for (let dx = 0; dx < 8; dx++) rect(392 + dx, y + 22 - dx, 1, 1 + dx * 2, [236, 236, 238])
      rect(420, y + 12, 80, 3, [15, 15, 15])
      f.png = PNG.sync.write(png)
    }
    draw(160)
    draw(230)
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '简洁回复', revision: f.revision }),
      windows
    )
    f.fetch
      .mockResolvedValueOnce(response(visual()))
      .mockResolvedValueOnce(response({ text: '重复消息' }))
    await advance(driver.connect('Q', t.signal, 'current_chat'))
    const first = await driver.read(t.signal)
    expect(first.messages.map(({ direction, text }) => ({ direction, text }))).toEqual([
      { direction: 'inbound', text: '重复消息' },
      { direction: 'inbound', text: '重复消息' }
    ])
    expect(first.messages[0].pixelFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(first.messages[0].pixelFingerprint).toBe(first.messages[1].pixelFingerprint)
    driver.accept(first)
    const calls = f.fetch.mock.calls.length
    expect((await driver.read(t.signal)).messages).toEqual(first.messages)
    expect(f.fetch).toHaveBeenCalledTimes(calls)
    // Updating the sidebar preview does not change the actual contact header.
    changeScreen(200, 100)
    expect((await driver.read(t.signal)).contact).toBe('Q')
    expect(f.fetch).toHaveBeenCalledTimes(calls)
    draw(300)
    // A third identical bubble is another message, even though its text is cached.
    expect((await driver.read(t.signal)).messages).toHaveLength(3)
    expect(f.fetch).toHaveBeenCalledTimes(calls)
    changeScreen(400, 100)
    f.fetch.mockResolvedValueOnce(response({ ...visual(), contact: '其他联系人' }))
    expect((await driver.read(t.signal)).contact).toBe('其他联系人')
    expect(f.fetch).toHaveBeenCalledTimes(calls + 1)
    const restarted = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '简洁回复', revision: f.revision }),
      windows
    )
    f.fetch.mockResolvedValueOnce(
      response(
        visual(
          '',
          Array.from({ length: 3 }, () => ({ direction: 'inbound', text: '误读' }))
        )
      )
    )
    await advance(restarted.connect('Q', t.signal, 'current_chat'))
    restarted.seed(first.messages)
    const resumed = await restarted.read(t.signal)
    expect(resumed.messages).toHaveLength(3)
    expect(resumed.messages.every((message) => message.text === '重复消息')).toBe(true)
    // Only the contact/layout request is needed; known glyphs keep their saved text.
    expect(f.fetch).toHaveBeenCalledTimes(calls + 2)
  })
  it('preserves pixel-identical history when only the draft changes, while reading every draft character', async () => {
    const t = await connected()
    t.driver.accept(t.observation)
    changeScreen(400, 470)
    f.fetch.mockResolvedValueOnce(response({ inputText: 'I' }))
    const typed = await t.driver.read(t.signal)
    expect(typed.inputText).toBe('I')
    expect(typed.messages).toEqual(t.observation.messages)
    const request = JSON.parse(f.fetch.mock.calls.at(-1)![1].body)
    const image = PNG.sync.read(
      Buffer.from(request.messages[1].content[1].image_url.url.split(',')[1], 'base64')
    )
    expect(image.width).toBe(400)
    expect(image.height).toBe(120)
    changeScreen(400, 200)
    f.fetch.mockResolvedValueOnce(response(visual()))
    await t.driver.read(t.signal)
    expect(JSON.parse(f.fetch.mock.calls.at(-1)![1].body).messages[1].content[0].text).toContain(
      '上次核对通过'
    )
  })
  it('never reuses history or contact when pixels outside the input changed', async () => {
    const t = await connected()
    t.driver.accept(t.observation)
    changeScreen(400, 100)
    f.fetch.mockResolvedValueOnce(response({ ...visual(), contact: '其他联系人' }))
    expect((await t.driver.read(t.signal)).contact).toBe('其他联系人')
    expect(JSON.parse(f.fetch.mock.calls.at(-1)![1].body).messages[1].content[0].text).toContain(
      '读取当前实际打开的聊天'
    )
  })
  it('rereads moved-window geometry without treating the same WeChat process as a new instance', async () => {
    const t = await connected()
    nativeWindow.bounds = { ...nativeWindow.bounds, x: 20 }
    f.fetch.mockResolvedValueOnce(response(visual()))
    const moved = await t.driver.read(t.signal)
    expect(moved.windowToken).toBe(t.observation.windowToken)
    expect(f.fetch).toHaveBeenCalledTimes(4)
    f.fetch.mockResolvedValueOnce(response(visual('测试回复'))).mockResolvedValueOnce(
      response(
        visual('', [
          { direction: 'inbound', text: '问题' },
          { direction: 'outbound', text: '测试回复' }
        ])
      )
    )
    expect(await advance(t.driver.dispatch(moved, '测试回复', t.signal))).toBe('sent')
    expect(f.tap.mock.calls).toEqual([['enter']])
  })
  it('refuses Enter if a window moves during draft validation', async () => {
    const t = await connected()
    f.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        nativeWindow.bounds = { ...nativeWindow.bounds, x: 20 }
        return { choices: [{ message: { content: JSON.stringify(visual('测试回复')) } }] }
      }
    })
    expect(await advance(t.driver.dispatch(t.observation, '测试回复', t.signal))).toBe('not_sent')
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('reuses only an identical full window with a current revision and bounded lifetime', async () => {
    const t = await connected()
    const calls = f.fetch.mock.calls.length
    expect(await t.driver.read(t.signal)).toEqual(t.observation)
    expect(f.fetch).toHaveBeenCalledTimes(calls)
    // Even a pixel outside the old model-provided regions invalidates the cache.
    changeScreen(20, 20)
    f.fetch.mockResolvedValueOnce(response(visual()))
    await t.driver.read(t.signal)
    expect(f.fetch).toHaveBeenCalledTimes(calls + 1)
    f.revision = 'rules-2'
    f.fetch.mockResolvedValueOnce(response(visual()))
    expect((await t.driver.read(t.signal)).revision).toBe('rules-2')
    await vi.advanceTimersByTimeAsync(30001)
    f.fetch.mockResolvedValueOnce(response(visual()))
    await t.driver.read(t.signal)
    expect(f.fetch).toHaveBeenCalledTimes(calls + 3)
    f.active = 8
    await expect(t.driver.read(t.signal)).rejects.toThrow('foreground_lost')
  })
  it('confirms a delayed echo and a fast contact response without pressing Enter again', async () => {
    const t = await connected()
    f.fetch
      .mockResolvedValueOnce(response(visual('测试回复')))
      .mockResolvedValueOnce(response(visual('测试回复')))
      .mockResolvedValueOnce(
        response(
          visual('', [
            { direction: 'inbound', text: '问题' },
            { direction: 'outbound', text: '测试回复' },
            { direction: 'inbound', text: '好的，收到' }
          ])
        )
      )
    expect(await advance(t.driver.dispatch(t.observation, '测试回复', t.signal))).toBe('sent')
    expect(f.tap.mock.calls).toEqual([['enter']])
    expect(f.type).toHaveBeenCalledTimes(1)
  })
  it('keeps the observed receipt text when only fullwidth punctuation differs', async () => {
    const t = await connected()
    f.fetch.mockResolvedValueOnce(response(visual('你好～'))).mockResolvedValueOnce(
      response(
        visual('', [
          { direction: 'inbound', text: '问题' },
          { direction: 'outbound', text: '你好~' }
        ])
      )
    )
    expect(await advance(t.driver.dispatch(t.observation, '你好～', t.signal))).toBe('sent')
    expect(t.driver.receiptText()).toBe('你好~')
    expect(f.tap.mock.calls).toEqual([['enter']])
  })
  it('independently rereads a failed cached receipt without pressing Enter again', async () => {
    const t = await connected()
    f.type.mockReturnValueOnce('测试回复')
    f.readEditor.mockResolvedValueOnce('测试回复')
    const read = t.driver.read.bind(t.driver)
    let receipts = 0
    vi.spyOn(t.driver, 'read').mockImplementation(async (signal, fresh) => {
      receipts++
      if ((t.driver as unknown as { receiptReading: boolean }).receiptReading)
        return {
          ...t.observation,
          messages: [...t.observation.messages, { direction: 'outbound', text: '误读' }]
        }
      return read(signal, fresh)
    })
    f.fetch.mockResolvedValueOnce(
      response(
        visual('', [
          { direction: 'inbound', text: '问题' },
          { direction: 'outbound', text: '测试回复' }
        ])
      )
    )
    expect(await advance(t.driver.dispatch(t.observation, '测试回复', t.signal))).toBe('sent')
    expect(receipts).toBe(2)
    expect(f.type).toHaveBeenCalledTimes(1)
    expect(f.tap.mock.calls).toEqual([['enter']])
  })
  it('repairs a scroll-related OCR difference only when both captured bubbles read identically', async () => {
    const t = await connected()
    const prior = t.driver['evidence']!
    const bubble = {
      direction: 'inbound' as const,
      x: 400,
      y: 180,
      width: 140,
      height: 44,
      fingerprint: 'a'.repeat(64)
    }
    prior.bubbles = [bubble]
    const before = { ...t.observation, messages: [{ direction: 'inbound' as const, text: '问提' }] }
    const after = {
      ...t.observation,
      messages: [
        { direction: 'inbound' as const, text: '问题' },
        { direction: 'outbound' as const, text: '测试回复' }
      ]
    }
    t.driver['evidence'] = {
      ...prior,
      observation: after,
      bubbles: [
        { ...bubble, fingerprint: 'b'.repeat(64) },
        { ...bubble, direction: 'outbound', fingerprint: 'c'.repeat(64) }
      ]
    }
    f.fetch.mockResolvedValueOnce(response({ beforeText: '问题', afterText: '问题' }))
    expect(await t.driver['verifyReceiptHistory'](before, after, 1, prior, t.signal)).toBe(true)
    f.fetch.mockResolvedValueOnce(response({ beforeText: '问题', afterText: '另一条问题' }))
    expect(await t.driver['verifyReceiptHistory'](before, after, 1, prior, t.signal)).toBe(false)
    f.fetch.mockResolvedValueOnce(response({ beforeText: 'a b', afterText: 'ab' }))
    expect(await t.driver['verifyReceiptHistory'](before, after, 1, prior, t.signal)).toBe(false)
    expect(f.type).not.toHaveBeenCalled()
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('accepts the same visible draft when OCR changes only fullwidth punctuation', async () => {
    const t = await connected()
    f.fetch.mockResolvedValueOnce(response(visual('你好~今天好吗?'))).mockResolvedValueOnce(
      response(
        visual('', [
          { direction: 'inbound', text: '问题' },
          { direction: 'outbound', text: '你好~今天好吗?' }
        ])
      )
    )
    expect(await advance(t.driver.dispatch(t.observation, '你好～今天好吗？', t.signal))).toBe(
      'sent'
    )
    expect(f.tap.mock.calls).toEqual([['enter']])
  })
  it('waits for a receipt read after a transient provider failure without replaying send', async () => {
    const t = await connected()
    f.fetch
      .mockResolvedValueOnce(response(visual('测试回复')))
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(
        response(
          visual('', [
            { direction: 'inbound', text: '问题' },
            { direction: 'outbound', text: '测试回复' }
          ])
        )
      )
    expect(await advance(t.driver.dispatch(t.observation, '测试回复', t.signal))).toBe('sent')
    expect(f.tap.mock.calls).toEqual([['enter']])
  })
  it('rechecks an uncertain receipt later without typing or pressing Enter again', async () => {
    const t = await connected()
    const text = '测试回复'
    f.type.mockReturnValueOnce(text)
    f.readEditor.mockResolvedValueOnce(text)
    f.fetch.mockResolvedValue(response(visual()))
    expect(await advance(t.driver.dispatch(t.observation, text, t.signal))).toBe('unknown')
    expect(t.driver.dispatchFailure()).toMatchObject({
      failureStage: 'receipt',
      failureReason: 'send_echo_unverified'
    })
    f.fetch.mockResolvedValueOnce(
      response(
        visual('', [
          { direction: 'inbound', text: '问题' },
          { direction: 'outbound', text }
        ])
      )
    )
    expect(await advance(t.driver.verifyReceipt(t.observation, text, t.signal))).toBe('sent')
    expect(f.type).toHaveBeenCalledTimes(1)
    expect(f.tap.mock.calls).toEqual([['enter']])
    await expect(t.driver.verifyReceipt(t.observation, text, t.signal)).rejects.toThrow(
      'receipt_context_invalid'
    )
  })
  it('uses exact native empty-editor readback when receipt OCR cannot identify the input', async () => {
    const t = await connected(),
      text = '测试回复'
    f.type.mockReturnValueOnce(text)
    f.readEditor.mockResolvedValueOnce(text)
    f.fetch.mockResolvedValueOnce(
      response({
        ...visual('', [
          { direction: 'inbound', text: '问题' },
          { direction: 'outbound', text }
        ]),
        inputText: null
      })
    )
    expect(await advance(t.driver.dispatch(t.observation, text, t.signal))).toBe('sent')
    expect(f.tap.mock.calls).toEqual([['enter']])
  })
  it.each([
    { inputText: '', outcome: 'sent' },
    { inputText: '人工草稿', outcome: 'unknown' }
  ])(
    'requires visual draft proof after unavailable native copy: $outcome',
    async ({ inputText, outcome }) => {
      const t = await connected(),
        text = '测试回复'
      f.type.mockReturnValueOnce(text)
      f.readEditor
        .mockResolvedValueOnce(text)
        .mockRejectedValueOnce(new Error('editor_text_unavailable'))
      f.fetch.mockResolvedValueOnce(
        response(
          visual(inputText, [
            { direction: 'inbound', text: '问题' },
            { direction: 'outbound', text }
          ])
        )
      )
      expect(await advance(t.driver.dispatch(t.observation, text, t.signal))).toBe(outcome)
      expect(f.type).toHaveBeenCalledTimes(1)
      expect(f.tap.mock.calls).toEqual([['enter']])
    }
  )
  it('retries invalid paired receipt OCR without typing or pressing Enter again', async () => {
    const t = await connected(),
      text = '测试回复'
    f.type.mockReturnValueOnce(text)
    f.readEditor.mockResolvedValueOnce(text)
    vi.spyOn(
      t.driver as unknown as { verifyReceiptHistory: () => Promise<boolean> },
      'verifyReceiptHistory'
    )
      .mockRejectedValueOnce(new z.ZodError([]))
      .mockResolvedValue(true)
    f.fetch.mockResolvedValue(
      response(
        visual('', [
          { direction: 'inbound', text: '误读了旧问题' },
          { direction: 'outbound', text }
        ])
      )
    )
    expect(await advance(t.driver.dispatch(t.observation, text, t.signal))).toBe('sent')
    expect(f.type).toHaveBeenCalledTimes(1)
    expect(f.tap.mock.calls).toEqual([['enter']])
  })
  it('rereads a malformed visual response once without desktop input and requests JSON output', async () => {
    const t = await connected()
    changeScreen()
    f.fetch.mockResolvedValueOnce(response('not-json')).mockResolvedValueOnce(response(visual()))
    expect((await t.driver.read(t.signal)).contact).toBe('Q')
    const request = JSON.parse(f.fetch.mock.calls.at(-1)![1].body)
    expect(request.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { strict: true }
    })
    expect(f.type).not.toHaveBeenCalled()
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('stops after two invalid visual responses rather than inferring chat data', async () => {
    const t = await connected()
    changeScreen()
    f.fetch.mockClear()
    f.fetch
      .mockResolvedValueOnce(response({ ...visual(), history: [0.9, 0.2, 0.5, 0.4] }))
      .mockResolvedValueOnce(response('not-json'))
    await expect(t.driver.read(t.signal)).rejects.toThrow('visual_response_invalid')
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect(f.type).not.toHaveBeenCalled()
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('binds a human-selected current chat without searching or typing into the desktop', async () => {
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '简洁回复', revision: 'rules-1' }),
      windows
    )
    await advance(driver.connect('Q', controller().signal, 'current_chat'))
    expect(f.type).not.toHaveBeenCalled()
    expect(f.tap).not.toHaveBeenCalled()
    expect(f.click).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('keeps the visible chat binding when a separate small already-logged-in window exists', async () => {
    f.extraWindows = [
      { ...nativeWindow, id: '72', pid: 124, bounds: { x: 900, y: 300, width: 352, height: 476 } }
    ]
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    await advance(driver.connect('Q', controller().signal, 'current_chat'))
    f.fetch.mockResolvedValueOnce(response(visual()))
    expect((await advance(driver.read(controller().signal))).contact).toBe('Q')
    f.active = 72
    await expect(advance(driver.read(controller().signal))).rejects.toThrow('foreground_lost')
    expect(f.type).not.toHaveBeenCalled()
  })
  it('still refuses to choose between two full-size WeChat windows', async () => {
    f.extraWindows = [{ ...nativeWindow, id: '72', pid: 124 }]
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    await expect(advance(driver.connect('Q', controller().signal, 'current_chat'))).rejects.toThrow(
      'wechat_window_unavailable'
    )
    expect(f.click).not.toHaveBeenCalled()
  })
  it('reports a network connection failure without exposing request data', async () => {
    const t = await connected()
    changeScreen()
    f.fetch.mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))
    await expect(advance(t.driver.read(t.signal))).rejects.toThrow('model_network_failed')
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('waits without input when Windows declines initial focus, then accepts the manually foregrounded chat', async () => {
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '简洁回复', revision: 'rules-1' }),
      windows
    )
    f.active = 8
    vi.spyOn(windows, 'focus').mockResolvedValueOnce()
    setTimeout(() => {
      f.active = 71
    }, 1000)
    await advance(driver.connect('Q', controller().signal, 'current_chat'))
    expect(f.type).not.toHaveBeenCalled()
    expect(f.tap).not.toHaveBeenCalled()
    expect(f.click).not.toHaveBeenCalled()
  })
  it('uses Unicode typing without clipboard and sends Enter once after draft validation and echo', async () => {
    const t = await connected()
    f.fetch.mockResolvedValueOnce(response(visual('测试回复'))).mockResolvedValueOnce(
      response(
        visual('', [
          { direction: 'inbound', text: '问题' },
          { direction: 'outbound', text: '测试回复' }
        ])
      )
    )
    expect(await advance(t.driver.dispatch(t.observation, '测试回复', t.signal))).toBe('sent')
    expect(f.type).toHaveBeenCalledWith('测试回复')
    expect(f.tap.mock.calls).toEqual([['enter']])
  })
  it('waits for an exact frame after temporary caret animation without masking changed pixels', async () => {
    const t = await connected(),
      original = Buffer.from(f.png)
    const image = await Jimp.read(original)
    image.setPixelColor(0x000000ff, 400, 470)
    const caret = await image.getBuffer('image/png')
    let checks = 0
    f.inspectEffect = () => {
      checks++
      f.png = checks <= 2 ? caret : original
    }
    f.fetch.mockResolvedValueOnce(response(visual('测试回复'))).mockResolvedValueOnce(
      response(
        visual('', [
          { direction: 'inbound', text: '问题' },
          { direction: 'outbound', text: '测试回复' }
        ])
      )
    )
    expect(await advance(t.driver.dispatch(t.observation, '测试回复', t.signal))).toBe('sent')
    expect(checks).toBeGreaterThan(2)
    expect(f.tap.mock.calls).toEqual([['enter']])
  })
  it('treats a failing send keystroke as unknown and never tries alternate shortcuts', async () => {
    const t = await connected()
    f.fetch.mockResolvedValueOnce(response(visual('测试回复')))
    f.tap.mockImplementationOnce(() => {
      throw new Error('injection_unknown')
    })
    expect(await advance(t.driver.dispatch(t.observation, '测试回复', t.signal))).toBe('unknown')
    expect(f.tap).toHaveBeenCalledTimes(1)
  })
  it('never presses Enter after native Unicode input fails or loses focus mid-input', async () => {
    const t = await connected()
    f.type.mockImplementationOnce(() => {
      throw new Error('input_failed')
    })
    expect(await advance(t.driver.dispatch(t.observation, '测试回复', t.signal))).toBe('not_sent')
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('does not press Enter if a person changes the draft during validation', async () => {
    const t = await connected()
    f.fetch.mockResolvedValueOnce(response(visual('我正在输入')))
    expect(await advance(t.driver.dispatch(t.observation, '测试回复', t.signal))).toBe('not_sent')
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('does not type after another app gains focus', async () => {
    const t = await connected()
    f.active = 8
    expect(await advance(t.driver.dispatch(t.observation, '测试回复', t.signal))).toBe('not_sent')
    expect(f.type).not.toHaveBeenCalled()
  })
  it('rechecks the latest rule revision immediately before Enter', async () => {
    const t = await connected()
    f.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        f.revision = 'rules-2'
        return { choices: [{ message: { content: JSON.stringify(visual('测试回复')) } }] }
      }
    })
    expect(await advance(t.driver.dispatch(t.observation, '测试回复', t.signal))).toBe('not_sent')
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('checks input pixels changed during the final visual model wait', async () => {
    const t = await connected()
    f.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        const changed = await Jimp.read(f.png)
        changed.setPixelColor(0x000000ff, 400, 470)
        f.png = await changed.getBuffer('image/png')
        return { choices: [{ message: { content: JSON.stringify(visual('测试回复')) } }] }
      }
    })
    expect(await advance(t.driver.dispatch(t.observation, '测试回复', t.signal))).toBe('not_sent')
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('does not type multiline text that could activate sending', async () => {
    const t = await connected()
    expect(await advance(t.driver.dispatch(t.observation, '第一行\n第二行', t.signal))).toBe(
      'not_sent'
    )
    expect(f.type).not.toHaveBeenCalled()
  })
  it('blocks a changed input during the final awaited native inspection', async () => {
    const t = await connected()
    const changed = await Jimp.read(f.png)
    changed.setPixelColor(0x000000ff, 400, 470)
    const changedPng = await changed.getBuffer('image/png')
    f.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        let calls = 0
        f.inspectEffect = () => {
          if (++calls === 1) f.png = changedPng
        }
        return { choices: [{ message: { content: JSON.stringify(visual('测试回复')) } }] }
      }
    })
    expect(await advance(t.driver.dispatch(t.observation, '测试回复', t.signal))).toBe('not_sent')
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('does not send when paused during the final native check', async () => {
    const t = await connected(),
      ctl = controller()
    f.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        f.inspectEffect = () => queueMicrotask(() => ctl.abort())
        return { choices: [{ message: { content: JSON.stringify(visual('测试回复')) } }] }
      }
    })
    expect(await advance(t.driver.dispatch(t.observation, '测试回复', ctl.signal))).toBe('not_sent')
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('rejects ambiguous contacts before opening a result', async () => {
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '简洁回复', revision: 'rules-1' }),
      windows
    )
    f.fetch
      .mockResolvedValueOnce(response({ search: [0.2, 0.1], loggedIn: true }))
      .mockResolvedValueOnce(
        response({
          matches: [
            { name: 'Q', privateChat: true, point: [0.2, 0.25] },
            { name: 'Q', privateChat: true, point: [0.2, 0.3] }
          ],
          hasMore: false
        })
      )
    await expect(advance(driver.connect('Q', controller().signal))).rejects.toThrow(
      'contact_not_unique'
    )
    expect(f.click).toHaveBeenCalledTimes(1)
  })
  it('checks list-recipient uniqueness without opening a result or consuming unread messages', async () => {
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    const signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    const search = { search: [0.2, 0.1], loggedIn: true },
      match = { name: 'Q', privateChat: true, point: [0.2, 0.25] }
    f.fetch
      .mockResolvedValueOnce(response(search))
      .mockResolvedValueOnce(response({ matches: [match], hasMore: false }))
    expect(await advance(driver.verifyListName('Q', signal))).toBe(true)
    expect(f.click).toHaveBeenCalledTimes(1)
    expect(f.tap).toHaveBeenLastCalledWith('escape')
    f.fetch
      .mockResolvedValueOnce(response(search))
      .mockResolvedValueOnce(response({ matches: [match, match], hasMore: false }))
    expect(await advance(driver.verifyListName('Q', signal))).toBe(false)
    expect(f.click).toHaveBeenCalledTimes(2)
    expect(f.tap.mock.calls.some(([key]) => key === 'enter')).toBe(false)
  })
  it('does not hide WeChat with a second Escape after search has already closed', async () => {
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    const signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    let escapes = 0
    f.tap.mockImplementation((key) => {
      if (key === 'escape' && ++escapes > 1) f.active = 8
    })
    f.fetch
      .mockResolvedValueOnce(response({ search: [0.2, 0.1], loggedIn: true }))
      .mockResolvedValueOnce(
        response({
          matches: [{ name: 'Q', privateChat: true, point: [0.2, 0.25] }],
          hasMore: false
        })
      )
    expect(await advance(driver.verifyListName('Q', signal))).toBe(true)
    expect(f.active).toBe(71)
    expect(escapes).toBe(1)
  })
  it('preserves a pre-search model timeout without pressing Escape on the main window', async () => {
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    const signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    f.fetch.mockRejectedValue(
      Object.assign(new Error('synthetic timeout'), { name: 'TimeoutError' })
    )
    f.tap.mockImplementation((key) => {
      if (key === 'escape') f.active = 8
    })
    await expect(advance(driver.verifyListName('Q', signal))).rejects.toThrow('model_timeout')
    expect(f.active).toBe(71)
    expect(f.click).not.toHaveBeenCalled()
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('dismisses a remaining owned search popup through freshly verified chat navigation', async () => {
    f.searchTyping = true
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    const signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    let escapes = 0,
      clicks = 0
    f.tap.mockImplementation((key) => {
      if (key === 'escape' && ++escapes > 1) f.active = 8
    })
    f.click.mockImplementation(() => {
      if (++clicks === 2) f.occluded = false
    })
    f.fetch
      .mockResolvedValueOnce(response({ search: [0.2, 0.1], loggedIn: true }))
      .mockResolvedValueOnce(
        response({
          matches: [{ name: 'Q', privateChat: true, point: [0.2, 0.25] }],
          hasMore: false
        })
      )
      .mockResolvedValueOnce(response({ loggedIn: true, overlay: false, chatTab: [0.04, 0.18] }))
    expect(await advance(driver.verifyListName('Q', signal))).toBe(true)
    expect(f.active).toBe(71)
    expect(f.occluded).toBe(false)
    expect(escapes).toBe(1)
    expect(f.move).toHaveBeenCalledWith(32, 108)
  })
  it('allows a verified owned search popup only while searching and closes it before normal reads', async () => {
    f.searchTyping = true
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    const signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    f.type.mockReturnValue('Q')
    f.tap.mockImplementation((key) => {
      if (key === 'escape') {
        f.occluded = false
        f.searchOccluded = undefined
      }
    })
    f.fetch
      .mockResolvedValueOnce(response({ search: [0.2, 0.1], loggedIn: true }))
      .mockResolvedValueOnce(
        response({
          matches: [{ name: 'Q', privateChat: true, point: [0.2, 0.25] }],
          hasMore: false
        })
      )
    expect(await advance(driver.verifyListName('Q', signal))).toBe(true)
    expect(f.occluded).toBe(false)
    // The same allowance must never bypass ordinary chat/editor protection.
    f.occluded = true
    f.searchOccluded = false
    await expect(advance(driver.read(signal))).rejects.toThrow('screen_obscured')
  })
  it('does not interact with search when a foreign overlay blocks it, including cleanup', async () => {
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      {
        ...windows,
        typeSearch: async () => {
          f.occluded = true
          f.searchOccluded = true
        }
      }
    )
    const signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    f.fetch.mockResolvedValueOnce(response({ search: [0.2, 0.1], loggedIn: true }))
    await expect(advance(driver.verifyListName('Q', signal))).rejects.toThrow('screen_obscured')
    expect(f.tap).toHaveBeenCalledTimes(1)
    expect(f.tap).toHaveBeenCalledWith('a', ['control'])
    expect(f.click).toHaveBeenCalledTimes(1)
  })
  it('does not mark a recipient duplicate when search has not finished loading', async () => {
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    const signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    f.fetch
      .mockResolvedValueOnce(response({ search: [0.2, 0.1], loggedIn: true }))
      .mockResolvedValueOnce(
        response({ matches: [{ name: 'Q', privateChat: true, point: [0.2, 0.25] }], hasMore: true })
      )
    await expect(advance(driver.verifyListName('Q', signal))).rejects.toThrow('list_incomplete')
    expect(f.tap).toHaveBeenLastCalledWith('escape')
  })
  const listVisual = (inputText = '') => ({
    loggedIn: true,
    completeRows: true,
    currentContact: 'Q',
    inputText,
    list: [0.1, 0.15, 0.25, 0.7],
    input: [0.4, 0.7, 0.5, 0.2],
    atTop: true,
    atBottom: true,
    rows: [{ name: 'Q', nameComplete: true, preview: '新问题', unread: 1, point: [0.2, 0.25] }]
  })
  async function listed(inputText = '') {
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    const signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    f.fetch.mockResolvedValueOnce(response(listVisual(inputText)))
    const page = await advance(driver.listPage(signal))
    return { driver, signal, page }
  }
  it('scrolls inside the verified left list with bounded overlapping wheel steps', async () => {
    const t = await listed()
    await advance(t.driver.listScroll(false, t.signal))
    expect(f.scroll).toHaveBeenCalledWith(0, -240)
    expect(f.move).toHaveBeenCalledWith(220, 300)
    expect(f.move).toHaveBeenLastCalledWith(20, 20)
    expect(f.type).not.toHaveBeenCalled()
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('reuses a verified unchanged list instead of calling the model again', async () => {
    const t = await listed()
    const calls = f.fetch.mock.calls.length
    expect(await advance(t.driver.listPage(t.signal))).toEqual(t.page)
    expect(f.fetch).toHaveBeenCalledTimes(calls)
    f.revision = 'new-rules'
    f.fetch.mockResolvedValueOnce(response(listVisual()))
    await advance(t.driver.listPage(t.signal))
    expect(f.fetch).toHaveBeenCalledTimes(calls + 1)
  })
  it('proves a hidden scrollbar edge only after two unchanged controlled wheel actions', async () => {
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    const signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    f.fetch.mockResolvedValueOnce(response({ ...listVisual(), atTop: false, atBottom: false }))
    expect((await advance(driver.listPage(signal))).atTop).toBe(false)
    await advance(driver.listScroll(true, signal))
    changeScreen(400, 470)
    f.fetch.mockResolvedValueOnce(
      response({ ...listVisual(), list: [0.1, 0.151, 0.25, 0.699], atTop: false, atBottom: false })
    )
    expect((await advance(driver.listPage(signal))).atTop).toBe(false)
    await advance(driver.listScroll(true, signal))
    expect((await advance(driver.listPage(signal))).atTop).toBe(true)
    await advance(driver.listScroll(false, signal))
    expect((await advance(driver.listPage(signal))).atBottom).toBe(false)
    await advance(driver.listScroll(false, signal))
    expect((await advance(driver.listPage(signal))).atBottom).toBe(true)
    changeScreen(160, 150)
    f.fetch.mockResolvedValueOnce(response({ ...listVisual(), atTop: false, atBottom: false }))
    expect((await advance(driver.listPage(signal))).atBottom).toBe(false)
  })
  it('invalidates the list current-contact cache when only the right title changes', async () => {
    const t = await listed()
    const calls = f.fetch.mock.calls.length
    changeScreen(500, 40)
    f.fetch.mockResolvedValueOnce(response({ ...listVisual(), currentContact: 'pp' }))
    expect((await t.driver.listPage(t.signal)).currentContact).toBe('pp')
    expect(f.fetch).toHaveBeenCalledTimes(calls + 1)
  })
  it('verifies a plain unread dot using its current pixels and never guesses a count', async () => {
    const t = await listed()
    const png = PNG.sync.read(f.png)
    for (let y = 142; y < 158; y++)
      for (let x = 112; x < 128; x++)
        if ((x - 119.5) ** 2 + (y - 149.5) ** 2 < 64)
          png.data.set([250, 70, 75, 255], (y * 800 + x) * 4)
    f.png = PNG.sync.write(png)
    const list = listVisual()
    f.fetch.mockResolvedValueOnce(
      response({
        ...list,
        rows: [
          {
            ...list.rows[0],
            unread: null,
            unreadDot: true,
            badge: [0.1375, 0.233333, 0.025, 0.033334]
          }
        ]
      })
    )
    const next = await t.driver.listPage(t.signal)
    expect(next.rows[0]).toMatchObject({ unread: null, unreadDot: true })
    expect(await t.driver.listPage(t.signal)).toEqual(next)
    expect(f.click).not.toHaveBeenCalled()
  })
  it('marks an unverified badge unknown without blocking other contacts on the page', async () => {
    const t = await listed()
    f.revision = 'new-rules'
    const list = listVisual()
    f.fetch.mockResolvedValueOnce(
      response({
        ...list,
        rows: [
          {
            ...list.rows[0],
            unread: null,
            unreadDot: true,
            badge: [0.1375, 0.233333, 0.025, 0.033334]
          }
        ]
      })
    )
    const page = await advance(t.driver.listPage(t.signal))
    expect(page.rows[0]).toMatchObject({ unread: null, unreadDot: false })
    expect(f.click).not.toHaveBeenCalled()
  })
  it('retries a single transient model connection failure without any desktop send action', async () => {
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    const signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    f.fetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(response(listVisual()))
    await advance(driver.listPage(signal))
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect(f.tap).not.toHaveBeenCalled()
    expect(f.type).not.toHaveBeenCalled()
    expect(f.click).not.toHaveBeenCalled()
  })
  it('opens only a row from the latest verified list snapshot', async () => {
    const t = await listed()
    await expect(
      advance(t.driver.listOpen({ ...t.page.rows[0], name: '其他客户' }, t.signal))
    ).rejects.toThrow('list_changed')
    expect(f.click).not.toHaveBeenCalled()
    await advance(t.driver.listOpen(t.page.rows[0], t.signal))
    expect(f.click).toHaveBeenCalledTimes(1)
    expect(f.move).toHaveBeenCalledWith(160, 150)
  })
  it('does not scroll or open another chat when a human draft is present', async () => {
    await expect(listed('人工草稿')).rejects.toThrow('human_input')
    expect(f.scroll).not.toHaveBeenCalled()
    expect(f.click).not.toHaveBeenCalled()
  })
  it('rejects a changed list before navigation', async () => {
    const t = await listed(),
      image = await Jimp.read(f.png)
    image.setPixelColor(0x000000ff, 160, 150)
    f.png = await image.getBuffer('image/png')
    await expect(advance(t.driver.listScroll(false, t.signal))).rejects.toThrow('list_changed')
    expect(f.scroll).not.toHaveBeenCalled()
  })
  it('waits for exact list pixels to settle before navigation without accepting a changed row', async () => {
    const t = await listed(),
      original = Buffer.from(f.png)
    changeScreen(400, 470)
    setTimeout(() => {
      f.png = original
    }, 300)
    await advance(t.driver.listScroll(false, t.signal))
    expect(f.scroll).toHaveBeenCalledTimes(1)
    expect(f.move).toHaveBeenLastCalledWith(20, 20)
  })
  it('does not navigate after cancellation during the final native check', async () => {
    const t = await listed(),
      ctl = controller()
    f.inspectEffect = () => queueMicrotask(() => ctl.abort())
    await expect(advance(t.driver.listOpen(t.page.rows[0], ctl.signal))).rejects.toThrow(
      'cancelled'
    )
    expect(f.click).not.toHaveBeenCalled()
  })
  it('binds a selected batch chat without stealing focus from another app', async () => {
    const focus = vi.spyOn(windows, 'focus')
    try {
      f.active = 99
      const driver = new ForegroundWechatDriver(
        () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
        windows
      )
      await expect(
        advance(driver.connect('Q', controller().signal, 'current_chat', false))
      ).rejects.toThrow('foreground_lost')
      expect(focus).not.toHaveBeenCalled()
      expect(f.click).not.toHaveBeenCalled()
    } finally {
      focus.mockRestore()
    }
  })
  it('returns from an image overlay to ordinary chat navigation without sending', async () => {
    const driver = new ForegroundWechatDriver(
      () => ({ vision: model, reply: model, rules: '回复', revision: f.revision }),
      windows
    )
    const signal = controller().signal
    await advance(driver.connect('Q', signal, 'current_chat'))
    f.fetch
      .mockResolvedValueOnce(response({ loggedIn: true, overlay: true, chatTab: [0.04, 0.2] }))
      .mockResolvedValueOnce(response({ loggedIn: true, overlay: false, chatTab: [0.04, 0.2] }))
    await advance(driver.showChatList(signal))
    expect(f.tap.mock.calls).toEqual([['escape']])
    expect(f.click).toHaveBeenCalledTimes(1)
    expect(f.type).not.toHaveBeenCalled()
  })
})
