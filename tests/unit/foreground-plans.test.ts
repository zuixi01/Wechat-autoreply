import { expect, it } from 'vitest'
import {
  ForegroundWechatRuntime,
  type ForegroundDriver
} from '../../src/core/agent/foreground-wechat'
import { SqliteForegroundJournal } from '../../src/core/persistence/foreground-journal'
import type { ForegroundObservation } from '../../src/shared/contracts/foreground-wechat'

function fixture() {
  const db = new SqliteForegroundJournal(':memory:')
  const view: ForegroundObservation = {
    contact: 'test',
    privateChat: true,
    inputText: '',
    windowToken: 'w',
    revision: 'r',
    messages: [{ direction: 'outbound', text: 'old' }]
  }
  const sent: string[] = []
  const driver: ForegroundDriver = {
    connect: async () => {},
    read: async () => structuredClone(view),
    generate: async () => 'legacy',
    generatePlan: async () => ({
      parts: [
        { kind: 'text', text: '知道啦' },
        { kind: 'text', text: '你先忙 我晚点看😄' }
      ]
    }),
    dispatch: async (_view, text) => {
      sent.push(text)
      view.messages.push({ direction: 'outbound', text })
      return 'sent'
    }
  }
  const make = () => new ForegroundWechatRuntime(driver, db, false, (value) => db.saveSingle(value))
  return { db, view, driver, sent, make }
}
it('persists the confirmed first bubble and resumes only the second after restart', async () => {
  const f = fixture(),
    first = f.make(),
    second = f.make()
  try {
    await first.start('test', 'current_chat')
    f.view.messages.push({ direction: 'inbound', text: '下午给你看照片 你先忙' })
    await first.tick()
    expect(f.sent).toEqual(['知道啦'])
    await first.pause()
    await second.start('test', 'current_chat', undefined, f.db.loadSingle('test'))
    await second.tick()
    await second.tick()
    expect(f.sent).toEqual(['知道啦', '你先忙 我晚点看😄'])
    expect(f.db.list().map((record) => record.partIndex)).toEqual([0, 1])
  } finally {
    await first.pause()
    await second.pause()
    f.db.close()
  }
})
it('cancels the remaining old bubble when a new incoming message changes the turn', async () => {
  const f = fixture(),
    runtime = f.make()
  try {
    await runtime.start('test', 'current_chat')
    f.view.messages.push({ direction: 'inbound', text: '第一轮' })
    await runtime.tick()
    f.driver.generatePlan = async () => ({ parts: [{ kind: 'text', text: '好 那就按新的来' }] })
    f.view.messages.push({ direction: 'inbound', text: '等等 改一下' })
    await runtime.tick()
    await runtime.tick()
    expect(f.sent).toEqual(['知道啦', '好 那就按新的来'])
  } finally {
    await runtime.pause()
    f.db.close()
  }
})
it('does not continue or replay a plan when the first bubble receipt is unknown', async () => {
  const f = fixture(),
    runtime = f.make()
  f.driver.dispatch = async (_before, text) => {
    f.sent.push(text)
    return 'unknown'
  }
  try {
    await runtime.start('test', 'current_chat')
    f.view.messages.push({ direction: 'inbound', text: '新消息' })
    for (let i = 0; i < 4; i++) await runtime.tick()
    expect(f.sent).toEqual(['知道啦'])
    expect(f.db.unresolved()).toHaveLength(1)
    expect(runtime.status().reason).toBe('send_unknown')
  } finally {
    await runtime.pause()
    f.db.close()
  }
})
it('cancels remaining bubbles when the owner answers manually', async () => {
  const f = fixture(),
    runtime = f.make()
  try {
    await runtime.start('test', 'current_chat')
    f.view.messages.push({ direction: 'inbound', text: '新消息' })
    await runtime.tick()
    f.view.messages.push({ direction: 'outbound', text: '我自己补充一下' })
    await runtime.tick()
    await runtime.tick()
    expect(f.sent).toEqual(['知道啦'])
    expect(runtime.hasPending()).toBe(false)
  } finally {
    await runtime.pause()
    f.db.close()
  }
})
