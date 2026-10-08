import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Ledger } from '../../src/core/persistence/ledger'
import { taskFixture } from '../fixtures/task'
import type { ObservedMessage } from '../../src/shared/contracts/message'

const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function message(id = 'native-1'): ObservedMessage {
  const { task } = taskFixture()
  return {
    identity: task.identity,
    conversationId: task.conversationId,
    sourceMessageId: id,
    direction: 'inbound',
    kind: 'text',
    text: '请查询订单',
    observedAt: 9000,
    identityVerified: true,
    messageIdVerified: true
  }
}
describe('durable isolated ledger', () => {
  it('migrates a v4 ledger and never reuses a run epoch after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autoreply-epoch-'))
    directories.push(dir)
    const path = join(dir, 'ledger.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec('PRAGMA user_version=4')
    legacy.close()
    const first = new Ledger(path)
    const oldRun = first.nextRunEpoch()
    first.observe(message())
    const invalidatedRun = first.nextRunEpoch()
    first.close()
    const restarted = new Ledger(path)
    try {
      expect(restarted.nextRunEpoch()).toBeGreaterThan(invalidatedRun)
      expect(invalidatedRun).toBeGreaterThan(oldRun)
      expect(
        restarted.snapshot(message().identity, message().conversationId).messages
      ).toHaveLength(1)
    } finally {
      restarted.close()
    }
  })
  it('rereading is idempotent while identical text with a different native ID is new', () => {
    const ledger = new Ledger(':memory:')
    try {
      expect(ledger.observe(message()).revision).toBe(1)
      expect(ledger.observe({ ...message(), observedAt: 9999 })).toMatchObject({
        inserted: false,
        revision: 1
      })
      expect(ledger.observe(message('native-2')).revision).toBe(2)
      expect(ledger.snapshot(message().identity, 'customer-A').messages).toHaveLength(2)
    } finally {
      ledger.close()
    }
  })
  it('preserves new inbound during generation instead of absorbing it into a screenshot baseline', () => {
    const ledger = new Ledger(':memory:')
    try {
      ledger.observe(message())
      const original = ledger.snapshot(message().identity, 'customer-A')
      ledger.observe({ ...message('native-2'), text: '再问一下发货时间' })
      const current = ledger.snapshot(message().identity, 'customer-A')
      expect(original.messages).toHaveLength(1)
      expect(current.revision).toBe(original.revision + 1)
      expect(current.messages[1].text).toBe('再问一下发货时间')
    } finally {
      ledger.close()
    }
  })
  it('marks unverified or conflicting IDs as a gap without overwriting original content', () => {
    const ledger = new Ledger(':memory:')
    try {
      ledger.observe(message())
      expect(ledger.observe({ ...message(), text: '同一 ID 内容发生变化' }).hasGap).toBe(true)
      expect(ledger.snapshot(message().identity, 'customer-A').messages[0].text).toBe('请查询订单')
      expect(ledger.observe({ ...message('uncertain'), messageIdVerified: false }).hasGap).toBe(
        true
      )
    } finally {
      ledger.close()
    }
  })
  it('isolates identical native IDs by account, customer and login instance', () => {
    const ledger = new Ledger(':memory:')
    try {
      ledger.observe(message())
      const b = {
        ...message(),
        identity: { ...message().identity, accountId: 'account-B' },
        text: 'B 专属订单'
      }
      ledger.observe(b)
      expect(ledger.snapshot(b.identity, b.conversationId).messages.map((m) => m.text)).toEqual([
        'B 专属订单'
      ])
      expect(ledger.snapshot(message().identity, 'customer-B').messages).toEqual([])
      expect(
        ledger.snapshot({ ...message().identity, loginEpoch: 2 }, 'customer-A').messages
      ).toEqual([])
    } finally {
      ledger.close()
    }
  })
  it('recovers dispatch as unknown, cancels prepared work and never replays after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autoreply-ledger-'))
    directories.push(dir)
    const file = join(dir, 'ledger.sqlite')
    const { task, draft } = taskFixture()
    const ledger = new Ledger(file, 9000)
    ledger.observe(message())
    const sending = ledger.prepare(task, draft.draftHash, 10000)
    ledger.transition(sending.record.executionId, 'prepared', 'dispatching', 10001)
    const pending = ledger.prepare({ ...task, taskId: 'other' }, draft.draftHash, 10000)
    ledger.close()
    const recovered = new Ledger(file, 11000)
    try {
      expect(recovered.getSend(sending.record.executionId)?.status).toBe('unknown')
      expect(recovered.getSend(pending.record.executionId)?.status).toBe('cancelled')
      expect(recovered.prepare(task, draft.draftHash, 11000).created).toBe(false)
      expect(
        recovered.hasUnknown(
          { ...task.identity, loginEpoch: 2, clientInstanceId: 'new-process' },
          task.conversationId
        )
      ).toBe(true)
      expect(recovered.snapshot(task.identity, task.conversationId).messages).toHaveLength(1)
    } finally {
      recovered.close()
    }
  })
  it('forbids transitions out of terminal states and confirmation without evidence', () => {
    const ledger = new Ledger(':memory:')
    try {
      const { task, draft } = taskFixture()
      const { record } = ledger.prepare(task, draft.draftHash, 10000)
      ledger.transition(record.executionId, 'prepared', 'dispatching', 10000)
      expect(() =>
        ledger.transition(record.executionId, 'dispatching', 'confirmed', 10000)
      ).toThrow('confirmation_evidence_required')
      ledger.transition(record.executionId, 'dispatching', 'unknown', 10000)
      expect(() => ledger.transition(record.executionId, 'unknown', 'prepared', 10000)).toThrow(
        'invalid_send_transition'
      )
    } finally {
      ledger.close()
    }
  })
  it('refuses newer database versions instead of downgrading metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autoreply-version-'))
    directories.push(dir)
    const file = join(dir, 'ledger.sqlite')
    const db = new DatabaseSync(file)
    db.exec('PRAGMA user_version=99')
    db.close()
    expect(() => new Ledger(file)).toThrow('unsupported_ledger_version')
  })
  it('keeps manual takeover across process restart until explicitly released', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autoreply-takeover-'))
    directories.push(dir)
    const file = join(dir, 'ledger.sqlite')
    const incoming = message()
    const ledger = new Ledger(file)
    ledger.observe(incoming)
    ledger.observe({ ...message('human'), direction: 'human_outbound', text: '由我处理' })
    const revision = ledger.snapshot(incoming.identity, incoming.conversationId).revision
    ledger.close()
    const restarted = new Ledger(file)
    try {
      expect(restarted.snapshot(incoming.identity, incoming.conversationId).humanOwned).toBe(true)
      restarted.observe(message('next'))
      expect(restarted.snapshot(incoming.identity, incoming.conversationId).humanOwned).toBe(true)
      restarted.setHumanOwned(incoming.identity, incoming.conversationId, false)
      const released = restarted.snapshot(incoming.identity, incoming.conversationId)
      expect(released.humanOwned).toBe(false)
      expect(released.revision).toBeGreaterThan(revision)
    } finally {
      restarted.close()
    }
  })
  it('keeps takeover across login changes but isolates other accounts and customers', () => {
    const ledger = new Ledger(':memory:')
    const incoming = message(),
      next = { ...incoming.identity, loginEpoch: 2, clientInstanceId: 'new-instance' }
    try {
      ledger.setHumanOwned(incoming.identity, incoming.conversationId, true)
      expect(ledger.snapshot(next, incoming.conversationId).humanOwned).toBe(true)
      expect(ledger.snapshot({ ...next, accountId: 'B' }, incoming.conversationId).humanOwned).toBe(
        false
      )
      expect(ledger.snapshot(next, 'other-customer').humanOwned).toBe(false)
      const before = ledger.snapshot(incoming.identity, incoming.conversationId).revision
      ledger.setHumanOwned(next, incoming.conversationId, false)
      expect(ledger.snapshot(incoming.identity, incoming.conversationId).humanOwned).toBe(false)
      expect(ledger.snapshot(incoming.identity, incoming.conversationId).revision).toBeGreaterThan(
        before
      )
    } finally {
      ledger.close()
    }
  })
  it('does not reacquire ownership by rereading old human history after explicit release', () => {
    const ledger = new Ledger(':memory:'),
      human = { ...message('human'), direction: 'human_outbound' as const }
    try {
      ledger.observe(human)
      ledger.setHumanOwned(human.identity, human.conversationId, false)
      const revision = ledger.snapshot(human.identity, human.conversationId).revision
      ledger.observe({ ...human, observedAt: 10000 })
      expect(ledger.snapshot(human.identity, human.conversationId)).toMatchObject({
        humanOwned: false,
        revision
      })
      ledger.observe({ ...human, sourceMessageId: 'new-human' })
      expect(ledger.snapshot(human.identity, human.conversationId).humanOwned).toBe(true)
    } finally {
      ledger.close()
    }
  })
})
