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
