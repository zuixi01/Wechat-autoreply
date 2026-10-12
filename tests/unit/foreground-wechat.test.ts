import { describe, it, expect, vi } from 'vitest'
import {
  ForegroundWechatRuntime,
  type ForegroundDriver,
  type ForegroundJournal
} from '../../src/core/agent/foreground-wechat'
import {
  ForegroundStartSchema,
  sameForegroundMessages
} from '../../src/shared/contracts/foreground-wechat'
import type {
  ForegroundObservation,
  ForegroundRecord
} from '../../src/shared/contracts/foreground-wechat'

const msg = (text: string, direction: 'inbound' | 'outbound' = 'inbound') => ({ text, direction })
const observation = (
  texts: ForegroundObservation['messages'] = [msg('历史消息')]
): ForegroundObservation => ({
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
  const checkpoint = vi.fn()
  const runtime = new ForegroundWechatRuntime(driver, journal, polling, checkpoint)
  return {
    runtime,
    driver,
    records,
    checkpoint,
    set: (value: ForegroundObservation) => {
      current = value
    }
  }
}
describe('project-owned foreground WeChat runtime', () => {
  it('uses an independently proved media prefix without consuming later incoming', async () => {
    const f = fixture()
    const media = (c: string) => ({
      direction: 'system' as const,
      text: '[非文本消息]',
      pixelFingerprint: c.repeat(64)
    })
    f.set(observation([msg('已处理'), media('a')]))
    await f.runtime.start('Q', 'current_chat')
    f.driver.reconcileHistory = async (_before, next) => ({
      ...next,
      messages: next.messages.slice(0, -1)
    })
    f.set(observation([msg('已处理'), media('b'), msg('新问题')]))
    await f.runtime.tick()
    expect(f.records.filter((r) => r.state === 'sent').map((r) => r.question)).toEqual(['新问题'])
    const saved = f.checkpoint.mock.calls.at(-1)![0]
    expect(saved.baseline.messages[1].pixelFingerprint).toBe('b'.repeat(64))
    f.set(observation([...saved.baseline.messages, msg('你好，已收到', 'outbound')]))
    await f.runtime.tick()
    expect(f.driver.dispatch).toHaveBeenCalledTimes(1)
    await f.runtime.pause()
  })
  it('does not save a media reanchor completed after pause', async () => {
    const f = fixture()
    const media = (c: string) => ({
      direction: 'system' as const,
      text: '[非文本消息]',
      pixelFingerprint: c.repeat(64)
    })
    f.set(observation([msg('已处理'), media('a')]))
    await f.runtime.start('Q', 'current_chat')
    let release!: () => void
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    f.driver.reconcileHistory = async (_before, next) => {
      entered()
      await gate
      return { ...next, messages: next.messages.slice(0, 2) }
    }
    f.set(observation([msg('已处理'), media('b'), msg('新问题')]))
    const tick = f.runtime.tick()
    await ready
    const paused = f.runtime.pause()
    release()
    await Promise.all([tick, paused])
    expect(f.driver.dispatch).not.toHaveBeenCalled()
    expect(f.checkpoint.mock.calls.at(-1)![0].baseline.messages[1].pixelFingerprint).toBe(
      'a'.repeat(64)
    )
  })
  it.each(['verified', 'duplicate', 'old-pixels', 'wrong-text', 'no-pixels'] as const)(
    'refuses a media gap even when an old page contains an identical confirmed echo: %s',
    async (mode) => {
      const f = fixture()
      const fp = 'e'.repeat(64)
      const baseline = observation([
        {
          direction: 'system',
          text: '[非文本消息]',
          pixelFingerprint: mode === 'old-pixels' ? fp : 'a'.repeat(64)
        }
      ])
      const echo = {
        ...msg(mode === 'wrong-text' ? '另一条' : '已回复', 'outbound'),
        pixelFingerprint: fp
      }
      f.set(
        observation([
          { direction: 'system', text: '[非文本消息]', pixelFingerprint: 'b'.repeat(64) },
          echo,
          ...(mode === 'duplicate' ? [echo] : []),
          msg('接着问你')
        ])
      )
      await f.runtime.start('Q', 'current_chat', undefined, {
        baseline,
        ownEcho: '已回复',
        ownEchoFingerprint: mode === 'no-pixels' ? undefined : fp,
        pending: false
      })
      await f.runtime.tick()
      expect(f.records.filter((r) => r.state === 'sent')).toEqual([])
      await f.runtime.tick()
      expect(f.driver.dispatch).not.toHaveBeenCalled()
      await f.runtime.pause()
    }
  )
  it('persists verified receipt history and continues after new incoming and restart without replay', async () => {
    const f = fixture()
    const media = (c: string) => ({
      direction: 'system' as const,
      text: '[非文本消息]',
      pixelFingerprint: c.repeat(64)
    })
    const old = observation([msg('旧文字'), media('a'), media('b'), media('c')])
    const question = observation([...old.messages, msg('第一条')])
    const verified = observation([media('d'), media('e'), media('f'), msg('第一条')])
    f.driver.receiptBaseline = () => verified
    f.set(old)
    await f.runtime.start('Q', 'current_chat')
    f.set(question)
    await f.runtime.tick()
    const saved = f.checkpoint.mock.calls.at(-1)![0]
    expect(saved.baseline.messages).toEqual(verified.messages)
    await f.runtime.pause()
    const resumed = new ForegroundWechatRuntime(
      f.driver,
      { list: () => f.records, save: (row) => f.records.push(row) },
      false
    )
    const next = observation([...verified.messages, msg('你好，已收到', 'outbound'), msg('第二条')])
    f.driver.receiptBaseline = () => undefined
    f.set(next)
    await resumed.start('Q', 'current_chat', undefined, saved)
    await resumed.tick()
    await resumed.tick()
    expect(f.records.filter((r) => r.state === 'sent').map((r) => r.question)).toEqual([
      '第一条',
      '第二条'
    ])
    expect(f.driver.dispatch).toHaveBeenCalledTimes(2)
    await resumed.pause()
  })
  it('refuses an unproven boundary between different verified media pixels', async () => {
    const f = fixture()
    const media = (pixelFingerprint: string) => ({
      direction: 'system' as const,
      text: '[非文本消息]',
      pixelFingerprint
    })
    f.set(observation([media('b'.repeat(64)), msg('这个图片你看一下')]))
    await f.runtime.start('Q', 'current_chat', undefined, {
      baseline: observation([media('a'.repeat(64))]),
      pending: false
    })
    await f.runtime.tick()
    expect(f.runtime.status().reason).toBe('message_gap')
    expect(f.driver.dispatch).not.toHaveBeenCalled()
    expect(f.records).toEqual([])
    await f.runtime.pause()
  })
  it('resumes saved progress after an explicit reconnect to a new window with continuous history', async () => {
    const f = fixture()
    const saved = { baseline: observation([msg('已处理的问题')]), pending: false }
    const next = {
      ...observation([msg('已处理的问题'), msg('重登后新问题')]),
      windowToken: 'instance-2'
    }
    f.set(next)
    await f.runtime.start('Q', 'current_chat', undefined, saved)
    expect(f.runtime.status().state).toBe('running')
    await f.runtime.tick()
    expect(f.records.filter((row) => row.state === 'sent').map((row) => row.question)).toEqual([
      '重登后新问题'
    ])
    expect(f.checkpoint.mock.calls.at(-1)![0].baseline.windowToken).toBe('instance-2')
    await f.runtime.tick()
    expect(f.driver.dispatch).toHaveBeenCalledTimes(1)
    await f.runtime.pause()
  })
  it('refuses to rebind saved progress when the new window cannot prove history continuity', async () => {
    const f = fixture()
    f.set({ ...observation([msg('另一段历史')]), windowToken: 'instance-2' })
    await f.runtime.start('Q', 'current_chat', undefined, {
      baseline: observation(),
      pending: true
    })
    expect(f.runtime.status()).toMatchObject({ reason: 'message_gap' })
    expect(f.driver.generate).not.toHaveBeenCalled()
    expect(f.driver.dispatch).not.toHaveBeenCalled()
    expect(f.checkpoint).not.toHaveBeenCalled()
    await f.runtime.pause()
  })
  it('uses a verified dot for the latest preview and hands off older ambiguous incoming text', async () => {
    const f = fixture()
    f.set(observation([msg('旧问题'), msg('旧回复', 'outbound'), msg('新问题'), msg('补充新问题')]))
    await f.runtime.start('Q', 'current_chat', { count: null, preview: '补充新问题' })
    await f.runtime.tick()
    expect(f.records.filter((row) => row.state === 'sent').map((row) => row.question)).toEqual([
      '补充新问题'
    ])
    expect(f.records.find((row) => row.state === 'handoff')?.question).toBe('新问题')
  })
  it('refuses an unknown-count tail with an unverified preview or truncated maximum history', async () => {
    const f = fixture()
    f.set(observation(Array.from({ length: 80 }, () => msg('边界未知'))))
    await f.runtime.start('Q', 'current_chat', { count: null, preview: '边界未知' })
    expect(f.runtime.status().reason).toBe('unread_message_unverified')
    expect(f.driver.generate).not.toHaveBeenCalled()
    const g = fixture()
    g.set(observation([msg('实际消息')]))
    await g.runtime.start('Q', 'current_chat', { count: null, preview: '另一个消息' })
    expect(g.runtime.status().reason).toBe('unread_message_unverified')
  })
  it('retains progress through a long screen obstruction and continues when it clears', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    f.set(observation([msg('历史消息'), msg('遮挡期间收到的问题')]))
    vi.mocked(f.driver.read).mockRejectedValue(new Error('screen_obscured'))
    for (let i = 0; i < 12; i++) await f.runtime.tick()
    expect(f.runtime.status()).toMatchObject({
      state: 'waiting_foreground',
      reason: 'screen_obscured'
    })
    expect(f.records).toEqual([])
    expect(f.driver.dispatch).not.toHaveBeenCalled()
    vi.mocked(f.driver.read).mockResolvedValue(
      observation([msg('历史消息'), msg('遮挡期间收到的问题')])
    )
    await f.runtime.tick()
    expect(f.records).toHaveLength(1)
    expect(f.records[0]).toMatchObject({ state: 'sent', question: '遮挡期间收到的问题' })
    expect(f.runtime.status().state).toBe('running')
    await f.runtime.pause()
  })
  it('waits after an obstruction before input without losing the pending question', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    f.set(observation([msg('历史消息'), msg('新问题')]))
    f.driver.dispatchFailure = vi.fn(() => ({
      failureReason: 'screen_obscured',
      failureStage: 'before_input' as const
    }))
    vi.mocked(f.driver.dispatch).mockResolvedValueOnce('not_sent')
    await f.runtime.tick()
    expect(f.runtime.status()).toMatchObject({
      state: 'waiting_foreground',
      reason: 'screen_obscured'
    })
    await f.runtime.tick()
    expect(f.records.map((r) => r.state)).toEqual(['not_sent', 'sent'])
    expect(f.records[1].question).toBe('新问题')
    await f.runtime.pause()
  })
  it('revalidates a changed screen before input without consuming the pending message', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    f.set(observation([msg('历史消息'), msg('需要回复的新消息')]))
    f.driver.dispatchFailure = vi.fn(() => ({
      failureReason: 'send_screen_changed',
      failureStage: 'before_input' as const
    }))
    vi.mocked(f.driver.dispatch).mockResolvedValueOnce('not_sent')
    await f.runtime.tick()
    expect(f.runtime.status()).toMatchObject({ state: 'recovering', recoveryAttempts: 1 })
    expect(f.records[0]).toMatchObject({
      state: 'not_sent',
      failureReason: 'send_screen_changed',
      failureStage: 'before_input'
    })
    await f.runtime.tick()
    expect(f.runtime.status()).toMatchObject({ state: 'running', recoveryAttempts: 0 })
    expect(f.records[1]).toMatchObject({ state: 'sent', question: '需要回复的新消息' })
    expect(f.driver.generate).toHaveBeenLastCalledWith(expect.anything(), expect.any(AbortSignal), [
      msg('需要回复的新消息')
    ])
    await f.runtime.pause()
  })
  it('preserves input-stage failure details and never repeats input automatically', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    f.set(observation([msg('历史消息'), msg('新消息')]))
    f.driver.dispatchFailure = vi.fn(() => ({
      failureReason: 'send_draft_mismatch',
      failureStage: 'draft_validation' as const
    }))
    vi.mocked(f.driver.dispatch).mockResolvedValue('not_sent')
    await f.runtime.tick()
    await f.runtime.tick()
    expect(f.runtime.status()).toMatchObject({ state: 'paused', reason: 'send_draft_mismatch' })
    expect(f.driver.dispatch).toHaveBeenCalledTimes(1)
    expect(f.records[0]).toMatchObject({
      failureStage: 'draft_validation',
      failureReason: 'send_draft_mismatch'
    })
    await f.runtime.pause()
  })
  it('matches scrolling OCR punctuation variants while preserving changed words and word spaces', () => {
    expect(
      sameForegroundMessages([msg('平台：http://example.test')], [msg('平台: http://example.test')])
    ).toBe(true)
    expect(sameForegroundMessages([msg('你好？')], [msg('你好?')])).toBe(true)
    expect(sameForegroundMessages([msg('now here')], [msg('nowhere')])).toBe(false)
    expect(sameForegroundMessages([msg('你好')], [msg('您好')])).toBe(false)
    expect(sameForegroundMessages([msg('你好')], [msg('你好', 'outbound')])).toBe(false)
  })
  it('restores saved bubble text and recognizes the persisted own echo by exact pixels', async () => {
    const f = fixture(),
      fingerprint = 'a'.repeat(64),
      baseline = observation()
    f.driver.seed = vi.fn()
    f.set(
      observation([
        msg('历史消息'),
        { ...msg('你好~', 'outbound'), pixelFingerprint: fingerprint },
        msg('第二条问题')
      ])
    )
    await f.runtime.start('Q', 'current_chat', undefined, {
      baseline,
      ownEcho: '你好～',
      ownEchoFingerprint: fingerprint,
      pending: false
    })
    expect(f.driver.seed).toHaveBeenCalledWith([
      ...baseline.messages,
      { direction: 'outbound', text: '你好～', pixelFingerprint: fingerprint }
    ])
    await f.runtime.tick()
    expect(f.driver.dispatch).toHaveBeenCalledTimes(1)
    expect(f.records[0].question).toBe('第二条问题')
    expect(f.runtime.status().state).toBe('running')
    await f.runtime.pause()
  })
  it('continues after a fast next message when own echo OCR changes punctuation and pixel rendering', async () => {
    const f = fixture(),
      baseline = observation()
    f.set(
      observation([
        msg('历史消息'),
        { ...msg('你好~', 'outbound'), pixelFingerprint: 'b'.repeat(64) },
        msg('第三条问题')
      ])
    )
    await f.runtime.start('Q', 'current_chat', undefined, {
      baseline,
      ownEcho: '你好～',
      ownEchoFingerprint: 'a'.repeat(64),
      pending: false
    })
    await f.runtime.tick()
    expect(f.records[0].state).toBe('sent')
    expect(f.records[0].question).toBe('第三条问题')
    await f.runtime.pause()
  })
  it('accepts a verified pending preview only with an explicit current-chat baseline reset', () => {
    const request = {
      target: 'Q',
      foregroundConsent: true,
      connectionMode: 'current_chat',
      currentChatSelected: true,
      pendingPreview: '未回复的测试消息'
    }
    expect(ForegroundStartSchema.safeParse(request).success).toBe(false)
    expect(ForegroundStartSchema.safeParse({ ...request, resetBaseline: true }).success).toBe(true)
    expect(
      ForegroundStartSchema.safeParse({ ...request, resetBaseline: true, connectionMode: 'search' })
        .success
    ).toBe(false)
  })
  it('recovers transient generation failures without consuming the message or permitting a second session', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    f.set(observation([msg('历史消息'), msg('等待网络恢复')]))
    vi.mocked(f.driver.generate).mockRejectedValueOnce(new Error('model_network_failed'))
    await f.runtime.tick()
    expect(f.runtime.status()).toMatchObject({ state: 'recovering', recoveryAttempts: 1 })
    expect(f.records).toHaveLength(0)
    await f.runtime.start('B')
    expect(f.driver.connect).toHaveBeenCalledTimes(1)
    await f.runtime.tick()
    expect(f.driver.read).toHaveBeenCalledWith(expect.any(AbortSignal), true)
    expect(f.driver.dispatch).toHaveBeenCalledTimes(1)
    expect(f.records[0].question).toBe('等待网络恢复')
    expect(f.runtime.status()).toMatchObject({ state: 'running', recoveryAttempts: 0 })
    await f.runtime.pause()
  })
  it('keeps waiting through a long provider outage and honors pause during recovery', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    vi.mocked(f.driver.read).mockRejectedValue(new Error('model_busy'))
    for (let count = 0; count < 12; count++) await f.runtime.tick()
    expect(f.runtime.status()).toMatchObject({ state: 'recovering', recoveryAttempts: 6 })
    await f.runtime.tick()
    expect(f.runtime.status()).toMatchObject({ state: 'recovering', reason: 'model_busy' })
    expect(f.driver.dispatch).not.toHaveBeenCalled()
    await f.runtime.pause()
    await f.runtime.tick()
    expect(f.runtime.status().reason).toBe('user_pause')
  })
  it('recovers an initial connection failure without stealing focus again or consuming new messages', async () => {
    const f = fixture()
    const saved = { baseline: observation(), pending: false }
    vi.mocked(f.driver.read).mockRejectedValueOnce(new Error('model_busy'))
    expect(await f.runtime.start('Q', 'current_chat', undefined, saved)).toMatchObject({
      state: 'recovering'
    })
    f.set(observation([msg('历史消息'), msg('断网期间的新消息')]))
    await f.runtime.tick()
    expect(f.driver.connect).toHaveBeenLastCalledWith(
      'Q',
      expect.any(AbortSignal),
      'current_chat',
      false
    )
    await f.runtime.tick()
    expect(f.records).toHaveLength(1)
    expect(f.records[0]).toMatchObject({ question: '断网期间的新消息', state: 'sent' })
    await f.runtime.pause()
  })
  it('rechecks a pending receipt and continues the next round without redispatching the first reply', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    f.set(observation([msg('历史消息'), msg('第一问')]))
    f.driver.dispatchFailure = vi.fn(() => ({
      failureStage: 'receipt' as const,
      failureReason: 'send_echo_unverified'
    }))
    f.driver.verifyReceipt = vi.fn().mockResolvedValueOnce('unknown').mockResolvedValueOnce('sent')
    vi.mocked(f.driver.dispatch).mockResolvedValueOnce('unknown')
    await f.runtime.tick()
    expect(f.runtime.status()).toMatchObject({ state: 'recovering', reason: 'send_verifying' })
    const id = f.records[0].id
    await f.runtime.start('B')
    await f.runtime.tick()
    expect(f.driver.dispatch).toHaveBeenCalledTimes(1)
    expect(f.driver.generate).toHaveBeenCalledTimes(1)
    f.set(
      observation([msg('历史消息'), msg('第一问'), msg('你好，已收到', 'outbound'), msg('第二问')])
    )
    await f.runtime.tick()
    expect(f.records).toHaveLength(1)
    expect(f.records[0]).toMatchObject({ id, state: 'sent' })
    await f.runtime.tick()
    expect(f.records.map((row) => row.question)).toEqual(['第一问', '第二问'])
    expect(f.driver.dispatch).toHaveBeenCalledTimes(2)
    await f.runtime.pause()
  })
  it('retains an unresolved receipt across pause and does not verify or send after a manual stop', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    f.set(observation([msg('历史消息'), msg('第一问')]))
    f.driver.dispatchFailure = vi.fn(() => ({
      failureStage: 'receipt' as const,
      failureReason: 'send_echo_unverified'
    }))
    f.driver.verifyReceipt = vi.fn().mockResolvedValue('unknown')
    vi.mocked(f.driver.dispatch).mockResolvedValueOnce('unknown')
    await f.runtime.tick()
    await f.runtime.pause()
    await f.runtime.tick()
    expect(f.driver.verifyReceipt).not.toHaveBeenCalled()
    expect(f.records[0].state).toBe('unknown')
    expect(await f.runtime.start('Q')).toMatchObject({ state: 'paused', reason: 'send_unknown' })
    expect(f.driver.dispatch).toHaveBeenCalledTimes(1)
  })
  it('keeps the previous own echo durable if a new inbound generation fails', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    f.set(observation([msg('历史消息'), msg('第一问')]))
    await f.runtime.tick()
    f.set(
      observation([msg('历史消息'), msg('第一问'), msg('你好，已收到', 'outbound'), msg('第二问')])
    )
    vi.mocked(f.driver.generate).mockRejectedValueOnce(new Error('model_timeout'))
    await f.runtime.tick()
    const saved = f.checkpoint.mock.calls.at(-1)![0]
    expect(saved.ownEcho).toBe('你好，已收到')
    expect(saved.pending).toBe(true)
    await f.runtime.pause()
    await f.runtime.start('Q', 'current_chat', undefined, saved)
    await f.runtime.tick()
    expect(f.records.map((row) => row.question)).toEqual(['第一问', '第二问'])
    expect(f.driver.dispatch).toHaveBeenCalledTimes(2)
    expect(f.runtime.status().state).toBe('running')
    await f.runtime.pause()
  })
  it('automatically retries with increasing delay without overlapping reads or ignoring a pause', async () => {
    vi.useFakeTimers()
    const f = fixture(true)
    try {
      await f.runtime.start('Q')
      vi.mocked(f.driver.read).mockRejectedValue(new Error('model_busy'))
      await vi.advanceTimersByTimeAsync(750)
      expect(f.runtime.status().nextRetryAt).toBe(Date.now() + 1000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.runtime.status()).toMatchObject({ state: 'recovering', recoveryAttempts: 2 })
      expect(f.runtime.status().nextRetryAt).toBe(Date.now() + 2000)
      const reads = vi.mocked(f.driver.read).mock.calls.length
      await f.runtime.pause()
      await vi.advanceTimersByTimeAsync(30000)
      expect(f.driver.read).toHaveBeenCalledTimes(reads)
    } finally {
      await f.runtime.pause()
      vi.useRealTimers()
    }
  })
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
      expect(f.driver.connect).toHaveBeenCalledWith(
        'Q',
        expect.any(AbortSignal),
        'current_chat',
        true
      )
      expect(f.runtime.status().state).toBe(kind === 'input' ? 'waiting_owner' : 'paused')
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
      if (kind === 'gap') {
        await f.runtime.tick()
        await f.runtime.tick()
      }
      expect(f.runtime.status().state).toBe(
        ['input', 'outbound'].includes(kind) ? 'waiting_owner' : 'paused'
      )
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
      await vi.advanceTimersByTimeAsync(750)
      expect(f.runtime.status().state).toBe('waiting_foreground')
      f.set(observation([msg('历史消息'), msg('新问题')]))
      await vi.advanceTimersByTimeAsync(1000)
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
      if (kind === 'gap') {
        await f.runtime.tick()
        await f.runtime.tick()
      }
      expect(f.driver.dispatch).not.toHaveBeenCalled()
      expect(f.runtime.status().state).toBe(
        ['input', 'outbound'].includes(kind) ? 'waiting_owner' : 'paused'
      )
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
  it('persists a confirmed echo even when pause races the positive send receipt', async () => {
    const f = fixture()
    await f.runtime.start('Q')
    f.set(observation([msg('历史消息'), msg('新问题')]))
    vi.mocked(f.driver.dispatch).mockImplementationOnce(async () => {
      void f.runtime.pause()
      return 'sent'
    })
    await f.runtime.tick()
    expect(f.runtime.status().state).toBe('paused')
    const saved = f.checkpoint.mock.calls.at(-1)![0]
    expect(saved.pending).toBe(false)
    expect(saved.ownEcho).toBe('你好，已收到')
    f.set(observation([msg('历史消息'), msg('新问题'), msg('你好，已收到', 'outbound')]))
    await f.runtime.start('Q', 'current_chat', undefined, saved)
    await f.runtime.tick()
    expect(f.runtime.status().state).toBe('running')
    expect(f.driver.dispatch).toHaveBeenCalledTimes(1)
    await f.runtime.pause()
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
