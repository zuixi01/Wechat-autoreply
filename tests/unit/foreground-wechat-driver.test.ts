import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Jimp } from 'jimp'
import { PNG } from 'pngjs'

const f = vi.hoisted(() => ({
  active: 71,
  revision: 'rules-1',
  png: Buffer.alloc(0) as Buffer<ArrayBufferLike>,
  tap: vi.fn(),
  type: vi.fn(),
  move: vi.fn(),
  click: vi.fn(),
  scroll: vi.fn(),
  fetch: vi.fn(),
  inspectEffect: undefined as undefined | (() => void)
}))
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
      windows: [nativeWindow],
      foreground: String(f.active)
    }
  },
  focus: async () => {
    f.active = 71
  },
  typeText: async (binding: typeof nativeWindow, text: string, signal: AbortSignal) => {
    if (signal.aborted || String(f.active) !== binding.id) throw new Error('foreground_lost')
    f.type(text)
  }
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
  f.revision = 'rules-1'
  f.inspectEffect = undefined
  f.png = await new Jimp({ width: 800, height: 600, color: 0xffffffff }).getBuffer('image/png')
  vi.stubGlobal('fetch', f.fetch)
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
  it('rereads a malformed visual response once without desktop input and requests JSON output', async () => {
    const t = await connected()
    f.fetch.mockResolvedValueOnce(response('not-json')).mockResolvedValueOnce(response(visual()))
    expect((await t.driver.read(t.signal)).contact).toBe('Q')
    const request = JSON.parse(f.fetch.mock.calls.at(-1)![1].body)
    expect(request.response_format).toEqual({ type: 'json_object' })
    expect(f.type).not.toHaveBeenCalled()
    expect(f.tap).not.toHaveBeenCalled()
  })
  it('stops after two invalid visual responses rather than inferring chat data', async () => {
    const t = await connected()
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
  it('reports a network connection failure without exposing request data', async () => {
    const t = await connected()
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
  it('scrolls inside the verified left list with one Windows wheel notch', async () => {
    const t = await listed()
    await advance(t.driver.listScroll(false, t.signal))
    expect(f.scroll).toHaveBeenCalledWith(0, -120)
    expect(f.move).toHaveBeenCalledWith(220, 300)
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
