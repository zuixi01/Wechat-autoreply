import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import type { ForegroundMessageSchema } from '../../src/shared/contracts/foreground-wechat'
import type { z } from 'zod'

const desktop = vi.hoisted(() => ({
  input: '',
  messages: [] as { direction: 'inbound' | 'outbound' | 'system'; text: string }[],
  active: '71',
  sends: 0,
  echo: true,
  beforeSend: undefined as undefined | (() => void)
}))
vi.mock('electron', () => ({ app: {} }))
vi.mock('../../src/core/rpa/util', () => ({
  getRobot: () => ({
    getScreenSize: () => ({ width: 1920, height: 1080 }),
    moveMouse: () => {},
    mouseClick: () => {},
    typeString: () => {
      throw new Error('RobotJS Unicode input must not be used')
    },
    keyTap: (key: string) => {
      if (key !== 'enter') throw new Error('unexpected_key')
      desktop.beforeSend?.()
      desktop.sends++
      if (desktop.echo) desktop.messages.push({ direction: 'outbound', text: desktop.input })
      desktop.input = ''
    },
    screen: {
      capture: () => {
        const image = new PNG({ width: 800, height: 600 })
        image.data.fill(255)
        // The framebuffer changes when messages/draft change, allowing the actual
        // driver's pixel evidence checks to catch stale observations.
        image.data[(200 * 800 + 400) * 4] = desktop.messages.length
        image.data[(470 * 800 + 400) * 4] = desktop.input.length
        return { width: 800, height: 600, bytesPerPixel: 4, byteWidth: 3200, image: image.data }
      }
    }
  })
}))
import { ForegroundWechatDriver } from '../../src/main/services/foreground-wechat-driver'
import { ForegroundWechatRuntime } from '../../src/core/agent/foreground-wechat'
import { SqliteForegroundJournal } from '../../src/core/persistence/foreground-journal'

const binding = {
  id: '71',
  pid: 123,
  path: 'C:\\Tencent\\Weixin.exe',
  startTicks: '123456',
  bounds: { x: 0, y: 0, width: 800, height: 600 }
}
const windows = {
  inspect: async () => ({
    id: '00000000-0000-4000-8000-000000000000',
    ok: true as const,
    windows: [binding],
    foreground: desktop.active
  }),
  focus: async () => {
    desktop.active = '71'
  },
  typeText: async (window: typeof binding, text: string, signal: AbortSignal) => {
    if (signal.aborted || desktop.active !== window.id) throw new Error('foreground_lost')
    desktop.input = text
  }
}
let server: Server, baseURL: string, directory: string, journal: SqliteForegroundJournal
let runtime: ForegroundWechatRuntime | undefined
let requests: { model: string; messages: { role: string; content: unknown }[] }[]
let replyFailures = 0
let replyContents: string[] = []
beforeEach(async () => {
  desktop.input = ''
  desktop.messages = [{ direction: 'inbound', text: '历史消息' }]
  desktop.active = '71'
  desktop.sends = 0
  desktop.echo = true
  desktop.beforeSend = undefined
  runtime = undefined
  requests = []
  replyFailures = 0
  replyContents = []
  directory = mkdtempSync(join(tmpdir(), 'personal-wechat-flow-'))
  journal = new SqliteForegroundJournal(join(directory, 'journal.sqlite'))
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    if (body.model === 'reply-fixture' && replyFailures > 0) {
      replyFailures--
      response.writeHead(503)
      response.end()
      return
    }
    const content =
      body.model === 'vision-fixture'
        ? JSON.stringify({
            contact: 'Q',
            privateChat: true,
            inputText: desktop.input,
            messages: desktop.messages,
            header: [0.4, 0.1, 0.5, 0.1],
            history: [0.4, 0.2, 0.5, 0.4],
            input: [0.4, 0.7, 0.5, 0.2]
          })
        : (replyContents.shift() ?? '已收到你的问题，我会尽快处理。')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content } }] }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture_address_invalid')
  baseURL = `http://127.0.0.1:${address.port}/v1`
})
afterEach(async () => {
  await runtime?.pause()
  journal.close()
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
  rmSync(directory, { recursive: true, force: true })
})
function createRuntime(): ForegroundWechatRuntime {
  const model = {
    apiKey: 'fixture-key',
    modelName: 'vision-fixture',
    baseURL,
    capabilities: ['text', 'vision']
  }
  return new ForegroundWechatRuntime(
    new ForegroundWechatDriver(
      () => ({
        vision: model,
        reply: { ...model, modelName: 'reply-fixture' },
        rules: '专业、简洁地回复。',
        revision: 'rules-v1'
      }),
      windows
    ),
    journal,
    false,
    (value) => journal.saveSingle(value)
  )
}
const inbound = (text: string): z.infer<typeof ForegroundMessageSchema> => ({
  direction: 'inbound',
  text
})
describe('personal WeChat complete flow with synthetic desktop and loopback model API', () => {
  it('rewrites a nonhuman draft before any typing and sends only the account owner reply', async () => {
    runtime = createRuntime()
    await runtime.start('Q', 'current_chat')
    desktop.messages.push(inbound('今天太阳很好，出去打球吗？'))
    replyContents = ['我没有现实中的身体，今天没法真的出去运动呀。', '想去哪儿打？']
    await runtime.tick()
    expect(runtime.status().state).toBe('running')
    expect(desktop.sends).toBe(1)
    expect(journal.list().map((row) => row.reply)).toEqual(['想去哪儿打？'])
    const generated = requests.filter((row) => row.model === 'reply-fixture')
    expect(generated).toHaveLength(2)
    expect(generated[0].messages[0].content).toContain('“我”始终指账号本人')
    expect(generated[1].messages[0].content).toContain('上一版草稿')
    expect(desktop.messages.at(-1)?.text).toBe('想去哪儿打？')
  }, 15000)

  it('pauses before drafting or creating a send record when both replies leak a virtual identity', async () => {
    runtime = createRuntime()
    await runtime.start('Q', 'current_chat')
    desktop.messages.push(inbound('你今天在哪里？'))
    replyContents = ['我是一个虚拟助手，没有真实的所在地。', '作为一个 AI，我没有真实的身体。']
    await runtime.tick()
    expect(runtime.status().state).toBe('paused')
    expect(runtime.status().reason).toBe('reply_identity_invalid')
    expect(desktop.sends).toBe(0)
    expect(desktop.input).toBe('')
    expect(journal.list()).toHaveLength(0)
    expect(requests.filter((row) => row.model === 'reply-fixture')).toHaveLength(2)
  })

  it('sends five consecutive replies, recovers a provider outage and foreground switch, and performs no idle model polling', async () => {
    runtime = createRuntime()
    await runtime.start('Q', 'current_chat')
    const initialRequests = requests.length
    for (let idle = 0; idle < 20; idle++) await runtime.tick()
    expect(requests).toHaveLength(initialRequests)
    for (let round = 0; round < 5; round++) {
      desktop.messages.push(inbound(`连续验收第${round + 1}条`))
      if (round === 1) {
        replyFailures = 1
        await runtime.tick()
        expect(runtime.status().state).toBe('recovering')
        expect(desktop.sends).toBe(round)
      }
      if (round === 2) {
        desktop.active = '99'
        await runtime.tick()
        expect(runtime.status().state).toBe('waiting_foreground')
        desktop.active = '71'
      }
      await runtime.tick()
      await runtime.tick()
      expect(runtime.status().state).toBe('running')
      expect(desktop.sends).toBe(round + 1)
      expect(journal.unresolved()).toHaveLength(0)
    }
    expect(journal.list().map((row) => row.state)).toEqual(Array(5).fill('sent'))
    expect(new Set(journal.list().map((row) => row.id)).size).toBe(5)
    const beforeIdle = requests.length
    for (let idle = 0; idle < 20; idle++) await runtime.tick()
    expect(requests).toHaveLength(beforeIdle)
    expect(requests.filter((row) => row.model === 'vision-fixture').length).toBeLessThanOrEqual(18)
    expect(runtime.status().lastReplyDurationMs).toBeGreaterThan(0)
  }, 30000)
  it('reads, generates, validates, journals before Enter, confirms echo, and resumes after restart without duplicate send', async () => {
    runtime = createRuntime()
    expect((await runtime.start('Q', 'current_chat')).state).toBe('running')
    expect(desktop.sends).toBe(0)
    desktop.messages.push(inbound('什么时候可以处理？'))
    desktop.beforeSend = () => expect(journal.unresolved()).toHaveLength(1)
    await runtime.tick()
    expect(journal.list().map((row) => row.state)).toEqual(['sent'])
    expect(desktop.sends).toBe(1)
    expect(requests.find((row) => row.model === 'reply-fixture')?.messages[0].content).toContain(
      '专业、简洁地回复。'
    )
    await runtime.tick()
    await runtime.pause()
    journal.close()
    journal = new SqliteForegroundJournal(join(directory, 'journal.sqlite'))
    desktop.messages.push(inbound('谢谢，请再确认一次。'))
    runtime = createRuntime()
    expect(
      (await runtime.start('Q', 'current_chat', undefined, journal.loadSingle('Q'))).state
    ).toBe('running')
    await runtime.tick()
    await runtime.tick()
    expect(desktop.sends).toBe(2)
    expect(journal.list().map((row) => row.state)).toEqual(['sent', 'sent'])
  }, 15000)
  it('blocks an uncertain receipt across restart until explicit human reconciliation, then never replays that message', async () => {
    runtime = createRuntime()
    await runtime.start('Q', 'current_chat')
    desktop.messages.push(inbound('这个问题需要核对。'))
    desktop.echo = false
    await runtime.tick()
    expect(runtime.status().reason).toBe('send_verifying')
    await runtime.tick()
    expect(desktop.sends).toBe(1)
    await runtime.pause()
    const row = journal.unresolved()[0]
    runtime = createRuntime()
    expect(
      (await runtime.start('Q', 'current_chat', undefined, journal.loadSingle('Q'))).reason
    ).toBe('send_unknown')
    expect(() =>
      journal.resolve({ id: row.id, state: 'not_sent', verifiedInWechat: false })
    ).toThrow()
    journal.resolve({ id: row.id, state: 'not_sent', verifiedInWechat: true })
    expect(journal.loadSingle('Q')?.baseline.messages.at(-1)?.text).toBe('这个问题需要核对。')
    await runtime.start('Q', 'current_chat', undefined, journal.loadSingle('Q'))
    await runtime.tick()
    expect(desktop.sends).toBe(1)
    expect(journal.list()[0].state).toBe('not_sent')
  }, 15000)
})
