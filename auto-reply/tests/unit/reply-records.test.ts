import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Ledger, hashConversationContext } from '../../src/core/persistence/ledger'
import { taskFixture } from '../fixtures/task'

function recorded(ledger: Ledger, id = 'source-A') {
  const f = taskFixture()
  ledger.observe({
    identity: f.task.identity,
    conversationId: f.task.conversationId,
    sourceMessageId: id,
    direction: 'inbound',
    kind: 'text',
    text: '合成问题',
    observedAt: 9000,
    identityVerified: true,
    messageIdVerified: true
  })
  const snapshot = ledger.snapshot(f.task.identity, f.task.conversationId)
  f.task = {
    ...f.task,
    conversationRevision: snapshot.revision,
    contextHash: hashConversationContext(snapshot),
    inboundRange: { from: 1, to: 1 }
  }
  ledger.replies.begin(f.task, ['合成问题'], 10000)
  return f
}
describe('durable reply catalogue and exact-range skip', () => {
  it('isolates tenant, employee, account, device and platform but retains login history', () => {
    const ledger = new Ledger(':memory:')
    try {
      const f = recorded(ledger)
      for (const patch of [
        { tenantId: 'other' },
        { employeeId: 'other' },
        { accountId: 'other' },
        { agentId: 'other' },
        { platform: 'wechat' as const }
      ])
        expect(ledger.replies.list({ ...f.task.identity, ...patch })).toEqual([])
      const nextLogin = { ...f.task.identity, loginEpoch: 2, clientInstanceId: 'new' }
      expect(ledger.replies.list(nextLogin)).toHaveLength(1)
      expect(ledger.replies.list(f.task.identity)[0]).toMatchObject({
        status: 'generating',
        inboundPreview: '合成问题'
      })
    } finally {
      ledger.close()
    }
  })
  it('recovers old suggestions as obsolete without losing drafts or replaying sends', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autoreply-records-')),
      path = join(directory, 'ledger.sqlite')
    const ledger = new Ledger(path)
    const f = recorded(ledger)
    ledger.replies.update(
      f.task.identity,
      f.task.taskId,
      { status: 'needs_human', draft: f.draft, review: f.review },
      10001
    )
    ledger.close()
    const recovered = new Ledger(path, 11000)
    try {
      expect(recovered.replies.list(f.task.identity)).toMatchObject([
        { status: 'obsolete', draft: f.draft }
      ])
      expect(recovered.findTask(f.task.identity, f.task.taskId)).toBeUndefined()
      expect(
        recovered.snapshot(f.task.identity, f.task.conversationId).messages[0].handledBy
      ).toBeNull()
    } finally {
      recovered.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('commits skip and handled range together and rejects duplicate or changed tasks', () => {
    const ledger = new Ledger(':memory:')
    try {
      const f = recorded(ledger)
      expect(ledger.skipReply(f.task, 10001)).toBe(true)
      expect(ledger.skipReply(f.task, 10002)).toBe(false)
      expect(ledger.replies.get(f.task.identity, f.task.taskId)?.status).toBe('skipped')
      expect(ledger.snapshot(f.task.identity, f.task.conversationId).messages[0].handledBy).toBe(
        `skip:${f.task.taskId}`
      )
      ledger.observe({
        identity: f.task.identity,
        conversationId: f.task.conversationId,
        sourceMessageId: 'later',
        direction: 'inbound',
        kind: 'text',
        text: '后续合成问题',
        observedAt: 11000,
        identityVerified: true,
        messageIdVerified: true
      })
      expect(
        ledger.snapshot(f.task.identity, f.task.conversationId).messages[1].handledBy
      ).toBeNull()
    } finally {
      ledger.close()
    }
  })
  it('never hides an in-flight or unknown delivery by skipping', () => {
    const ledger = new Ledger(':memory:')
    try {
      const f = recorded(ledger),
        send = ledger.prepare(f.task, f.draft.draftHash, 10001)
      ledger.transition(send.record.executionId, 'prepared', 'dispatching', 10002)
      expect(ledger.skipReply(f.task, 10003)).toBe(false)
      ledger.transition(send.record.executionId, 'dispatching', 'unknown', 10004)
      expect(ledger.skipReply(f.task, 10005)).toBe(false)
      expect(
        ledger.snapshot(f.task.identity, f.task.conversationId).messages[0].handledBy
      ).toBeNull()
    } finally {
      ledger.close()
    }
  })
  it('rolls back both skip state and watermark when message storage fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autoreply-skip-')),
      path = join(directory, 'ledger.sqlite')
    const ledger = new Ledger(path),
      f = recorded(ledger),
      fault = new DatabaseSync(path)
    fault.exec(
      "CREATE TRIGGER fail_skip BEFORE UPDATE OF handled_execution ON messages BEGIN SELECT RAISE(ABORT,'synthetic_fault'); END"
    )
    try {
      expect(() => ledger.skipReply(f.task, 10001)).toThrow('synthetic_fault')
      expect(ledger.replies.get(f.task.identity, f.task.taskId)?.status).toBe('generating')
      expect(
        ledger.snapshot(f.task.identity, f.task.conversationId).messages[0].handledBy
      ).toBeNull()
      fault.exec('DROP TRIGGER fail_skip')
      expect(ledger.skipReply(f.task, 10002)).toBe(true)
    } finally {
      fault.close()
      ledger.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
