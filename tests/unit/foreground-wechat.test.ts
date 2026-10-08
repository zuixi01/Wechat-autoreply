import { describe, it, expect, vi } from 'vitest'
import {
  ForegroundWechatRuntime,
  type ForegroundDriver,
  type ForegroundJournal
} from '../../src/core/agent/foreground-wechat'
import { ForegroundStartSchema } from '../../src/shared/contracts/foreground-wechat'
import type {
  ForegroundObservation,
  ForegroundRecord
} from '../../src/shared/contracts/foreground-wechat'

const msg = (text: string, direction: 'inbound' | 'outbound' = 'inbound') => ({ text, direction })
const observation = (texts = [msg('历史消息')]): ForegroundObservation => ({
  windowToken: 'instance-1',
  contact: 'Q',
  privateChat: true,
  inputText: '',
  messages: texts,
  revision: 'rules-1'
})
function fixture(polling = false) {
  let current = observation()
  const records: ForegroundRecord[] = []
  const journal: ForegroundJournal = {
    list: () => records,
    save: (row) => {
      const i = records.findIndex((r) => r.id === row.id)
      if (i < 0) records.push(row)
      else records[i] = row
    }
  }
  const driver: ForegroundDriver = {
    connect: vi.fn(async () => {}),
    read: vi.fn(async () => structuredClone(current)),
    generate: vi.fn(async () => '你好，已收到'),
    dispatch: vi.fn(async () => 'sent' as const)
  }
  const runtime = new ForegroundWechatRuntime(driver, journal, polling)
  return {
    runtime,
    driver,
    records,
    set: (value: ForegroundObservation) => {
      current = value
    }
  }
}
describe('project-owned foreground WeChat runtime', () => {
  it('requires explicit human selection for the current-chat IPC input', () => {
    expect(
      ForegroundStartSchema.safeParse({
        target: 'Q',
        foregroundConsent: true,
        connectionMode: 'current_chat'
      }).success
    ).toBe(false)
    expect(
      ForegroundStartSchema.safeParse({
        target: 'Q',
        foregroundConsent: true,
        connectionMode: 'current_chat',
        currentChatSelected: true
      }).success
    ).toBe(true)
  })
  it.each(['contact', 'private', 'input'])(
    'refuses an incorrectly selected current chat: %s',
    async (kind) => {
      const f = fixture(),
        current = observation()
      if (kind === 'contact') current.contact = '另一个联系人'
      if (kind === 'private') current.privateChat = false
      if (kind === 'input') current.inputText = '人工草稿'
      f.set(current)
      await f.runtime.start('Q', 'current_chat')
      expect(f.driver.connect).toHaveBeenCalledWith('Q', expect.any(AbortSignal), 'current_chat')
      expect(f.runtime.status().state).toBe('paused')
      expect(f.driver.generate).not.toHaveBeenCalled()
      expect(f.driver.dispatch).not.toHaveBeenCalled()
    }
  )
  it('takes a startup baseline and replies to a new incoming message only once', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    await f.runtime.tick()
    expect(f.driver.generate).not.toHaveBeenCalled()
    f.set(observation([msg('历史消息'), msg('新问题')]))
    await f.runtime.tick()
    await f.runtime.tick()
    expect(f.driver.dispatch).toHaveBeenCalledTimes(1)
    expect(f.records[0].state).toBe('sent')
    await f.runtime.pause()
  })
  it('processes only the batch-authorized unread tail, excluding old history', async () => {
    const f = fixture()
    f.set(observation([msg('旧问题'), msg('历史回复', 'outbound'), msg('当前未读')]))
    await f.runtime.start('Q', 'current_chat', { count: 1, preview: '当前未读' })
    await f.runtime.tick()
    expect(f.records[0].question).toBe('当前未读')
    expect(f.runtime.hasPending()).toBe(false)
  })
  it.each([0, 81, 2])('refuses an unverified unread count %s', async (count) => {
    const f = fixture()
    f.set(observation([msg('历史回复', 'outbound'), msg('当前未读')]))
    await f.runtime.start('Q', 'current_chat', { count, preview: '当前未读' })
    await f.runtime.tick()
    expect(f.runtime.status().reason).toBe('unread_message_unverified')
    expect(f.records).toHaveLength(0)
  })
  it('refuses a changed unread preview rather than guessing which history to reply to', async () => {
    const f = fixture()
    await f.runtime.start('Q', 'current_chat', { count: 1, preview: '截图中另一个问题' })
    await f.runtime.tick()
    expect(f.runtime.status().reason).toBe('unread_message_unverified')
    expect(f.driver.dispatch).not.toHaveBeenCalled()
  })
  it('waits for foreground and preserves pending messages without reconnecting', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    vi.mocked(f.driver.read).mockRejectedValueOnce(new Error('foreground_lost'))
    await f.runtime.tick()
    expect(f.runtime.status().state).toBe('waiting_foreground')
    expect(f.driver.dispatch).not.toHaveBeenCalled()
    await f.runtime.start('B')
    expect(f.runtime.status().target).toBe('Q')
    f.set(observation([msg('历史消息'), msg('离开期间的新问题')]))
    await f.runtime.tick()
    await f.runtime.tick()
    expect(f.driver.connect).toHaveBeenCalledTimes(1)
    expect(f.driver.dispatch).toHaveBeenCalledTimes(1)
    expect(f.records[0].question).toBe('离开期间的新问题')
    expect(f.runtime.status().reason).toBe('none')
  })
  it('discards a draft when foreground is lost before dispatch and regenerates on return', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    f.set(observation([msg('历史消息'), msg('新问题')]))
    vi.mocked(f.driver.generate).mockImplementationOnce(async () => {
      vi.mocked(f.driver.read).mockRejectedValueOnce(new Error('foreground_lost'))
      return '废弃草稿'
    })
    await f.runtime.tick()
    expect(f.runtime.status().state).toBe('waiting_foreground')
    expect(f.records).toHaveLength(0)
    expect(f.driver.dispatch).not.toHaveBeenCalled()
    await f.runtime.tick()
    expect(f.driver.generate).toHaveBeenCalledTimes(2)
    expect(f.records[0].reply).toBe('你好，已收到')
  })
  it.each(['contact', 'input', 'window', 'rules', 'gap', 'outbound'])(
    'revalidates %s after returning to foreground',
    async (kind) => {
      const f = fixture()
      await f.runtime.start('Q')
      vi.mocked(f.driver.read).mockRejectedValueOnce(new Error('foreground_lost'))
      await f.runtime.tick()
      const next = observation([msg('历史消息'), msg('新问题')])
      if (kind === 'contact') next.contact = '别的客户'
      if (kind === 'input') next.inputText = '人工草稿'
      if (kind === 'window') next.windowToken = 'instance-2'
      if (kind === 'rules') next.revision = 'rules-2'
      if (kind === 'gap') next.messages = [msg('无法连续读取')]
      if (kind === 'outbound') next.messages.push(msg('人工回复', 'outbound'))
      f.set(next)
      await f.runtime.tick()
      expect(f.runtime.status().state).toBe('paused')
      expect(f.driver.dispatch).not.toHaveBeenCalled()
    }
  )
  it('honors manual pause while waiting for foreground', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    vi.mocked(f.driver.read).mockRejectedValueOnce(new Error('foreground_lost'))
    await f.runtime.tick()
    await f.runtime.pause()
    f.set(observation([msg('历史消息'), msg('新问题')]))
    await f.runtime.tick()
    expect(f.runtime.status().reason).toBe('user_pause')
    expect(f.driver.dispatch).not.toHaveBeenCalled()
  })
  it('continues scheduled polling while waiting and stops polling on manual pause', async () => {
    vi.useFakeTimers()
    const f = fixture(true)
    try {
      await f.runtime.start('Q')
      vi.mocked(f.driver.read).mockRejectedValueOnce(new Error('foreground_lost'))
      await vi.advanceTimersByTimeAsync(4000)
      expect(f.runtime.status().state).toBe('waiting_foreground')
      f.set(observation([msg('历史消息'), msg('新问题')]))
      await vi.advanceTimersByTimeAsync(4000)
      expect(f.driver.dispatch).toHaveBeenCalledTimes(1)
      await f.runtime.pause()
      const reads = vi.mocked(f.driver.read).mock.calls.length
      await vi.advanceTimersByTimeAsync(12000)
      expect(f.driver.read).toHaveBeenCalledTimes(reads)
    } finally {
      await f.runtime.pause()
      vi.useRealTimers()
    }
  })
  it.each(['contact', 'input', 'window', 'gap', 'rules', 'outbound'])(
    'stops without sending on %s conflict',
    async (kind) => {
      const f = fixture()
      await f.runtime.start('Q')
      const next = observation([msg('历史消息'), msg('新问题')])
      if (kind === 'contact') next.contact = '别的客户'
      if (kind === 'input') next.inputText = '人工草稿'
      if (kind === 'window') next.windowToken = 'instance-2'
      if (kind === 'gap') next.messages = [msg('无法连续读取')]
      if (kind === 'rules') next.revision = 'rules-2'
      if (kind === 'outbound') next.messages.push(msg('人工回复', 'outbound'))
      f.set(next)
      await f.runtime.tick()
      expect(f.driver.dispatch).not.toHaveBeenCalled()
      expect(f.runtime.status().state).toBe('paused')
    }
  )
  it('invalidates a generated draft when another new message arrives', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    f.set(observation([msg('历史消息'), msg('第一问')]))
    vi.mocked(f.driver.generate).mockImplementationOnce(async () => {
      f.set(observation([msg('历史消息'), msg('第一问'), msg('补充问题')]))
      return '迟到回复'
    })
    await f.runtime.tick()
    expect(f.driver.dispatch).not.toHaveBeenCalled()
    await f.runtime.tick()
    expect(f.driver.dispatch).toHaveBeenCalledTimes(1)
  })
  it('cancels sending after pause during generation', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    f.set(observation([msg('历史消息'), msg('新问题')]))
    let finish!: (s: string) => void
    vi.mocked(f.driver.generate).mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r
        })
    )
    const work = f.runtime.tick()
    await Promise.resolve()
    await Promise.resolve()
    const pause = f.runtime.pause()
    finish('迟到回复')
    await work
    await pause
    expect(f.driver.dispatch).not.toHaveBeenCalled()
  })
  it('writes an unknown execution before dispatch and prevents restart replay', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    f.set(observation([msg('历史消息'), msg('新问题')]))
    vi.mocked(f.driver.dispatch).mockImplementationOnce(async () => {
      expect(f.records[0].state).toBe('unknown')
      throw new Error('echo_failed')
    })
    await f.runtime.tick()
    expect(f.records[0].state).toBe('unknown')
    await f.runtime.start('Q')
    expect(f.runtime.status().state).toBe('paused')
    expect(f.driver.connect).toHaveBeenCalledTimes(1)
  })
  it('serializes simultaneous polling', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    f.set(observation([msg('历史消息'), msg('新问题')]))
    await Promise.all([f.runtime.tick(), f.runtime.tick(), f.runtime.tick()])
    expect(f.driver.dispatch).toHaveBeenCalledTimes(1)
  })
  it('rejects switching to a different test target while active', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    await f.runtime.start('B')
    expect(f.runtime.status().target).toBe('Q')
    expect(f.driver.connect).toHaveBeenCalledTimes(1)
    await f.runtime.pause()
  })
})
