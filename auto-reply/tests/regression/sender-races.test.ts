import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashConversationContext, Ledger } from '../../src/core/persistence/ledger'
import {
  Sender,
  type DeliveryResult,
  type SendCommand,
  type VerifiedSendAdapter
} from '../../src/core/sending/sender'
import { taskFixture } from '../fixtures/task'
import { hashContext } from '../../src/core/reply/hashes'
import { randomUUID } from 'node:crypto'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((r) => {
      resolve = r
    }),
    resolve
  }
}
const ledgers: Ledger[] = []
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close()
})
function fixture() {
  const f = taskFixture()
  const ledger = new Ledger(':memory:')
  ledgers.push(ledger)
  for (let i = 1; i <= 2; i++)
    ledger.observe({
      identity: f.task.identity,
      conversationId: f.task.conversationId,
      sourceMessageId: `message-${i}`,
      direction: 'inbound',
      kind: 'text',
      text: `问题 ${i}`,
      observedAt: 9000,
      identityVerified: true,
      messageIdVerified: true
    })
  f.task.contextHash = hashConversationContext(
    ledger.snapshot(f.task.identity, f.task.conversationId)
  )
  f.review.contextHash = f.task.contextHash
  f.current.contextHash = f.task.contextHash
  const confirmed = (c: SendCommand): DeliveryResult => ({
    status: 'confirmed',
    executionId: c.executionId,
    identity: c.task.identity,
    conversationId: c.task.conversationId,
    draftHash: c.draft.draftHash,
    evidence: 'native-outbound-7'
  })
  const adapter: VerifiedSendAdapter = {
    readCurrent: vi.fn(async () => structuredClone(f.current)),
    dispatch: vi.fn(async (c) => confirmed(c))
  }
  const sender = new Sender(ledger, adapter, () => f.now)
  sender.resume()
  return { ...f, ledger, sender, adapter, confirmed }
}
describe('sender cancellation, target binding and duplicate races', () => {
  function humanFixture() {
    const f = fixture()
    f.ledger.setHumanOwned(f.task.identity, f.task.conversationId, true)
    f.task.conversationRevision = f.ledger.snapshot(f.task.identity, f.task.conversationId).revision
    Object.assign(f.current, {
      conversationRevision: f.task.conversationRevision,
      humanOwned: true,
      humanConfirmationValid: true,
      factsVerified: false,
      automaticEnabled: false
    })
    const confirmation = {
      confirmationId: randomUUID(),
      taskId: f.task.taskId,
      sourceTaskId: 'assessment',
      taskHash: hashContext(f.task),
      draftHash: f.draft.draftHash,
      draftRevision: f.draft.draftRevision,
      employeeId: f.task.identity.employeeId,
      modelResolved: f.current.modelResolved,
      confirmedAt: f.now,
      expiresAt: f.now + 5000
    }
    return { ...f, confirmation }
  }
  it('uses one executor for duplicate human confirms without a passed automatic review', async () => {
    const f = humanFixture()
    await Promise.all([
      f.sender.sendHumanConfirmed(f.task, f.draft, f.confirmation),
      f.sender.sendHumanConfirmed(f.task, f.draft, f.confirmation)
    ])
    expect(f.adapter.dispatch).toHaveBeenCalledOnce()
    const command = vi.mocked(f.adapter.dispatch).mock.calls[0][0]
    expect(command).toMatchObject({ purpose: 'human', confirmation: f.confirmation })
    expect(command.review).toBeUndefined()
  })
  it('keeps human execution pending until physical quiescence and preserves an unknown outcome', async () => {
    const f = humanFixture(),
      gate = deferred<DeliveryResult>(),
      entered = deferred<void>()
    f.adapter.dispatch = vi.fn(async () => {
      entered.resolve()
      return gate.promise
    })
    const sending = f.sender.sendHumanConfirmed(f.task, f.draft, f.confirmation)
    await entered.promise
    expect(await f.sender.pause(1)).toMatchObject({ status: 'pending' })
    expect(f.sender.isQuiescent()).toBe(false)
    gate.resolve({ status: 'unknown' })
    expect(await sending).toMatchObject({ record: { status: 'unknown' } })
    expect(f.ledger.snapshot(f.task.identity, f.task.conversationId).humanOwned).toBe(true)
    expect(
      f.ledger
        .snapshot(f.task.identity, f.task.conversationId)
        .messages.every((m) => m.handledBy === null)
    ).toBe(true)
  })
  it('dispatches once even with two simultaneous requests for the same task', async () => {
    const f = fixture()
    const results = await Promise.all([
      f.sender.sendAutomatic(f.task, f.draft, f.review),
      f.sender.sendAutomatic(f.task, f.draft, f.review)
    ])
    expect(results.map((r) => r.status)).toEqual(['recorded', 'duplicate'])
    expect(f.adapter.dispatch).toHaveBeenCalledTimes(1)
    expect(
      f.ledger
        .snapshot(f.task.identity, f.task.conversationId)
        .messages.every((message) => message.handledBy !== null)
    ).toBe(true)
  })
  it('does not dispatch when pause is acknowledged during a slow preparation, even after resume', async () => {
    const f = fixture()
    const state = deferred<typeof f.current>()
    const entered = deferred<void>()
    f.adapter.readCurrent = vi.fn(async () => {
      entered.resolve()
      return state.promise
    })
    const sending = f.sender.sendAutomatic(f.task, f.draft, f.review)
    await entered.promise
    expect((await f.sender.pause()).status).toBe('acknowledged')
    f.sender.resume()
    state.resolve(f.current)
    expect(await sending).toMatchObject({ status: 'rejected', reason: 'paused_or_obsolete_run' })
    expect(f.adapter.dispatch).not.toHaveBeenCalled()
  })
  it('reports pause pending while an already dispatched operation can still have effects', async () => {
    const f = fixture()
    const gate = deferred<DeliveryResult>()
    const entered = deferred<SendCommand>()
    f.adapter.dispatch = vi.fn(async (c) => {
      entered.resolve(c)
      return gate.promise
    })
    const sending = f.sender.sendAutomatic(f.task, f.draft, f.review)
    const command = await entered.promise
    expect(await f.sender.pause(1)).toMatchObject({ status: 'pending' })
    gate.resolve(f.confirmed(command))
    await sending
    expect((await f.sender.pause()).status).toBe('acknowledged')
  })
  it('records uncertainty and refuses a second task rather than resending', async () => {
    const f = fixture()
    f.adapter.dispatch = vi.fn(async () => {
      throw new Error('bridge disconnected')
    })
    const result = await f.sender.sendAutomatic(f.task, f.draft, f.review)
    expect(result).toMatchObject({ status: 'recorded', record: { status: 'unknown' } })
    expect(
      await f.sender.sendAutomatic(
        { ...f.task, taskId: 'new-task' },
        { ...f.draft, taskId: 'new-task' },
        { ...f.review, taskId: 'new-task' }
      )
    ).toMatchObject({ status: 'rejected', reason: 'unresolved_delivery' })
    expect(f.adapter.dispatch).toHaveBeenCalledTimes(1)
  })
  it('refuses a stale draft when new inbound arrives during model generation', async () => {
    const f = fixture()
    f.ledger.observe({
      identity: f.task.identity,
      conversationId: f.task.conversationId,
      sourceMessageId: 'new-inbound',
      direction: 'inbound',
      kind: 'text',
      text: '先不要发货',
      observedAt: f.now,
      identityVerified: true,
      messageIdVerified: true
    })
    expect(await f.sender.sendAutomatic(f.task, f.draft, f.review)).toMatchObject({
      status: 'rejected',
      reason: 'ledger_context_changed'
    })
    expect(f.adapter.dispatch).not.toHaveBeenCalled()
  })
  it('does not accept delivery evidence from another customer', async () => {
    const f = fixture()
    f.adapter.dispatch = vi.fn(
      async (c) => ({ ...f.confirmed(c), conversationId: 'customer-B' }) as DeliveryResult
    )
    expect(await f.sender.sendAutomatic(f.task, f.draft, f.review)).toMatchObject({
      status: 'recorded',
      record: { status: 'unknown' }
    })
  })
  it('captures the immutable final draft while waiting in the queue', async () => {
    const f = fixture()
    const gate = deferred<typeof f.current>()
    const entered = deferred<void>()
    f.adapter.readCurrent = vi.fn(async () => {
      entered.resolve()
      return gate.promise
    })
    const sending = f.sender.sendAutomatic(f.task, f.draft, f.review)
    await entered.promise
    f.draft.text = '篡改后的退款承诺'
    gate.resolve(f.current)
    expect(await sending).toMatchObject({ status: 'recorded', record: { status: 'confirmed' } })
    expect(vi.mocked(f.adapter.dispatch).mock.calls[0][0].draft.text).toBe('请提供订单号。')
  })
  it('checks target changes before action and never forwards a reply to the active customer', async () => {
    const f = fixture()
    f.adapter.readCurrent = vi.fn(async () => ({ ...f.current, conversationId: 'customer-B' }))
    expect(await f.sender.sendAutomatic(f.task, f.draft, f.review)).toMatchObject({
      status: 'rejected',
      reason: 'target_changed'
    })
    expect(f.adapter.dispatch).not.toHaveBeenCalled()
  })
})
