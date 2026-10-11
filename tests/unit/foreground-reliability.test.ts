import { describe, expect, it } from 'vitest'
import {
  ForegroundWechatRuntime,
  type ForegroundDriver
} from '../../src/core/agent/foreground-wechat'
import { SqliteForegroundJournal } from '../../src/core/persistence/foreground-journal'
import type { ForegroundObservation } from '../../src/shared/contracts/foreground-wechat'

const msg = (text: string, direction: 'inbound' | 'outbound' = 'inbound') => ({ direction, text })
function fixture() {
  const db = new SqliteForegroundJournal(':memory:')
  const view: ForegroundObservation = {
    contact: 'test',
    privateChat: true,
    inputText: '',
    windowToken: 'w1',
    revision: 'r1',
    messages: [msg('old', 'outbound')]
  }
  let generations = 0
  const driver: ForegroundDriver = {
    connect: async () => {},
    read: async () => structuredClone(view),
    generate: async () => {
      generations++
      return 'reply'
    },
    dispatch: async (_before, text) => {
      view.messages.push(msg(text, 'outbound'))
      return 'sent'
    }
  }
  const runtime = new ForegroundWechatRuntime(driver, db, false, (checkpoint) =>
    db.saveSingle(checkpoint)
  )
  return { db, view, driver, runtime, generations: () => generations }
}
describe('durable foreground progress regressions', () => {
  it('retains a first unread media preview as a durable handoff and continues later text', async () => {
    const f = fixture()
    try {
      f.view.messages.push({ direction: 'system', text: '[非文本消息]' })
      await f.runtime.start('test', 'current_chat', { count: 1, preview: '[图片]' })
      await f.runtime.tick()
      expect(
        f.db.list().filter((record) => record.failureReason === 'media_requires_owner')
      ).toHaveLength(1)
      f.view.messages.push(msg('later normal question'))
      await f.runtime.tick()
      expect(
        f.db
          .list()
          .filter((record) => record.state === 'sent')
          .map((record) => record.question)
      ).toEqual(['later normal question'])
    } finally {
      await f.runtime.pause()
      f.db.close()
    }
  })
  it('keeps outstanding owner handoffs visible after fifty newer successful replies', async () => {
    const f = fixture()
    try {
      f.driver.generate = async () => null
      await f.runtime.start('test', 'current_chat')
      f.view.messages.push(msg('owner question'))
      await f.runtime.tick()
      const handoff = f.db.list()[0]
      for (let n = 0; n < 51; n++)
        f.db.save({
          ...handoff,
          id: crypto.randomUUID(),
          state: 'sent',
          reply: 'done',
          createdAt: handoff.createdAt + n + 1
        })
      expect(f.runtime.status().records.some((record) => record.id === handoff.id)).toBe(true)
      f.db.acknowledgeHandoff(handoff.id)
      expect(f.runtime.status().records.some((record) => record.id === handoff.id)).toBe(false)
      f.db.save(handoff)
      expect(f.db.handoffs()).toEqual([])
    } finally {
      await f.runtime.pause()
      f.db.close()
    }
  })
  it('does not duplicate a media handoff when generation is retried', async () => {
    const f = fixture()
    let attempts = 0
    f.driver.generate = async () => {
      if (++attempts === 1) throw new Error('model_network_failed')
      return 'reply'
    }
    try {
      await f.runtime.start('test', 'current_chat')
      f.view.messages.push({ direction: 'system', text: '[非文本消息]' }, msg('new text'))
      await f.runtime.tick()
      await f.runtime.tick()
      expect(
        f.db.list().filter((row) => row.failureReason === 'media_requires_owner')
      ).toHaveLength(1)
      expect(f.db.list().filter((row) => row.state === 'sent')).toHaveLength(1)
    } finally {
      await f.runtime.pause()
      f.db.close()
    }
  })
  it('commits skipped-question handoff and consumed boundary together', async () => {
    const f = fixture()
    f.driver.generate = async () => null
    let atomic = 0
    const complete = f.db.complete.bind(f.db)
    f.db.complete = (record, checkpoint) => {
      atomic++
      complete(record, checkpoint)
    }
    try {
      await f.runtime.start('test', 'current_chat')
      f.view.messages.push(msg('owner question'))
      await f.runtime.tick()
      expect(atomic).toBe(1)
      expect(f.db.loadSingle('test')?.baseline.messages.at(-1)?.text).toBe('owner question')
    } finally {
      await f.runtime.pause()
      f.db.close()
    }
  })
  it('does not turn an initial red dot into permission to auto-answer old read history', async () => {
    const f = fixture()
    try {
      f.view.messages.push(msg('old read but unanswered'), msg('actually unread'))
      await f.runtime.start('test', 'current_chat', { count: null, preview: 'actually unread' })
      await f.runtime.tick()
      expect(
        f.db
          .list()
          .filter((record) => record.state === 'sent')
          .map((record) => record.question)
      ).toEqual(['actually unread'])
      expect(f.db.list().find((record) => record.state === 'handoff')?.question).toBe(
        'old read but unanswered'
      )
    } finally {
      await f.runtime.pause()
      f.db.close()
    }
  })
  it('waits out a human draft and continues after it is cleared without reconnecting', async () => {
    const f = fixture()
    try {
      await f.runtime.start('test', 'current_chat')
      f.view.messages.push(msg('new while owner is typing'))
      f.view.inputText = 'draft'
      await f.runtime.tick()
      expect(f.generations()).toBe(0)
      f.view.inputText = ''
      await f.runtime.tick()
      expect(f.db.list().filter((record) => record.state === 'sent')).toHaveLength(1)
      expect(f.runtime.status().state).toBe('running')
    } finally {
      await f.runtime.pause()
      f.db.close()
    }
  })
  it('records an owner handoff when the model skips instead of silently losing the question', async () => {
    const f = fixture()
    f.driver.generate = async () => null
    try {
      await f.runtime.start('test', 'current_chat')
      f.view.messages.push(msg('Can you decide whether to attend?'))
      await f.runtime.tick()
      await f.runtime.tick()
      expect(f.db.list()).toHaveLength(1)
      expect(f.db.list()[0]).toMatchObject({
        state: 'handoff',
        question: 'Can you decide whether to attend?',
        failureReason: 'owner_decision_required'
      })
      expect(f.db.hasUnknown()).toBe(false)
      expect(f.runtime.status().state).toBe('running')
    } finally {
      await f.runtime.pause()
      f.db.close()
    }
  })
  it('persists all five allowed long messages and still sends the reply', async () => {
    const f = fixture()
    try {
      await f.runtime.start('test', 'current_chat')
      f.view.messages.push(...Array.from({ length: 5 }, () => msg('字'.repeat(3500))))
      await f.runtime.tick()
      expect(f.db.list()).toHaveLength(1)
      expect(f.db.list()[0].question.length).toBe(17504)
      expect(f.db.list()[0].state).toBe('sent')
      expect(f.runtime.status().state).toBe('running')
    } finally {
      await f.runtime.pause()
      f.db.close()
    }
  })
  it('reconciles only the uncertain send and replies to a later message after restart', async () => {
    const f = fixture()
    let restarted: ForegroundWechatRuntime | undefined
    f.driver.dispatch = async (_before, text) => {
      f.view.messages.push(msg(text, 'outbound'))
      return 'unknown'
    }
    try {
      await f.runtime.start('test', 'current_chat')
      f.view.messages.push(msg('first question'))
      await f.runtime.tick()
      expect(f.runtime.status().reason).toBe('send_unknown')
      f.view.messages.push(msg('later question while paused'))
      f.db.resolve({ id: f.db.unresolved()[0].id, state: 'sent', verifiedInWechat: true })
      f.driver.dispatch = async (_before, text) => {
        f.view.messages.push(msg(text, 'outbound'))
        return 'sent'
      }
      restarted = new ForegroundWechatRuntime(f.driver, f.db, false, (checkpoint) =>
        f.db.saveSingle(checkpoint)
      )
      await restarted.start('test', 'current_chat', undefined, f.db.loadSingle('test'))
      await restarted.tick()
      expect(f.generations()).toBe(2)
      expect(f.db.list().map((row) => row.question)).toEqual([
        'first question',
        'later question while paused'
      ])
      expect(f.db.list().map((row) => row.state)).toEqual(['sent', 'sent'])
    } finally {
      await f.runtime.pause()
      await restarted?.pause()
      f.db.close()
    }
  })
})
