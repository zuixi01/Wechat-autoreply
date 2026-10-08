import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger, hashConversationContext } from '../../src/core/persistence/ledger'
import {
  CentralSendAdapter,
  type ExecutionTransport
} from '../../src/core/sending/central-send-adapter'
import { Sender, type SendCommand, type VerifiedSendAdapter } from '../../src/core/sending/sender'
import { hashContext } from '../../src/core/reply/hashes'
import { taskFixture } from '../fixtures/task'
import { DatabaseSync } from 'node:sqlite'
import type { ExecutionPermit } from '../../src/shared/contracts/execution'
import { randomUUID } from 'node:crypto'
import type {
  DeviceReconciliationReport,
  ReconciliationChallenge
} from '../../src/shared/contracts/reconciliation'
import type { ReconciliationDecision } from '../../src/shared/contracts/reconciliation'
import type { RequestSealInput, RequestSealResult } from '../../src/shared/contracts/request-seal'

const directories: string[] = [],
  ledgers: Ledger[] = []
afterEach(() => {
  for (const ledger of ledgers.splice(0)) {
    try {
      ledger.close()
    } catch {
      /* already reopened */
    }
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.useRealTimers()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((r) => {
      resolve = r
    }),
    resolve
  }
}
function pathFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'central-send-'))
  directories.push(directory)
  return join(directory, 'ledger.sqlite')
}
function fixture(path = ':memory:') {
  const f = taskFixture(),
    ledger = new Ledger(path, f.now)
  ledgers.push(ledger)
  for (const sourceMessageId of ['m1', 'm2'])
    ledger.observe({
      identity: f.task.identity,
      conversationId: f.task.conversationId,
      sourceMessageId,
      direction: 'inbound',
      kind: 'text',
      text: '合成问题',
      observedAt: 9500,
      identityVerified: true,
      messageIdVerified: true
    })
  const task = {
    ...f.task,
    contextHash: hashConversationContext(ledger.snapshot(f.task.identity, f.task.conversationId))
  }
  const review = { ...f.review, contextHash: task.contextHash },
    current = { ...f.current, contextHash: task.contextHash }
  let clock = 0,
    allowed = true,
    scope = { ...task.identity }
  const lease = {
    identity: task.identity,
    leaseId: 'lease-A',
    version: 1,
    serverIssuedAt: 100000,
    expiresAt: 110000
  }
  const permit: ExecutionPermit = {
    identity: task.identity,
    permitId: 'permit-A',
    taskId: task.taskId,
    conversationId: task.conversationId,
    taskHash: hashContext(task),
    draftHash: f.draft.draftHash,
    draftRevision: f.draft.draftRevision,
    leaseVersion: 1,
    issuedAt: 100000,
    expiresAt: 105000,
    status: 'issued',
    newlyIssued: true
  }
  const transport = {
    issueExecution: vi.fn<ExecutionTransport['issueExecution']>(async () => permit),
    settleExecution: vi.fn<ExecutionTransport['settleExecution']>(async (_identity, receipt) => ({
      status: receipt.status
    }))
  }
  const physical = {
    readCurrent: vi.fn<VerifiedSendAdapter['readCurrent']>(async () => current),
    dispatch: vi.fn<VerifiedSendAdapter['dispatch']>(async (command) => ({
      status: 'confirmed',
      executionId: command.executionId,
      identity: command.task.identity,
      conversationId: command.task.conversationId,
      draftHash: command.draft.draftHash,
      evidence: 'synthetic-new-echo',
      proof: {
        sourceMessageId: 'new-outbound-A',
        verificationProofHash: hashContext('synthetic-boundary-proof')
      }
    }))
  }
  const adapter: CentralSendAdapter = new CentralSendAdapter(
    ledger,
    transport,
    physical,
    {
      scope: () => scope,
      lease: () => lease,
      revalidate: (command, signal) => sender.revalidate(command, signal),
      current: (command) => allowed && sender.localCurrent(command)
    },
    () => f.now,
    () => clock
  )
  const sender: Sender = new Sender(ledger, adapter, () => f.now)
  sender.resume()
  const command = (): SendCommand => {
    const prepared = ledger.prepare(task, f.draft.draftHash, f.now).record
    ledger.transition(prepared.executionId, 'prepared', 'dispatching', f.now)
    return { task, draft: f.draft, review, executionId: prepared.executionId }
  }
  return {
    ledger,
    task,
    draft: f.draft,
    review,
    current,
    lease,
    permit,
    transport,
    physical,
    adapter,
    sender,
    command,
    time: (value: number) => {
      clock = value
    },
    closeGate: () => {
      allowed = false
    },
    scope: (value: typeof scope) => {
      scope = value
    }
  }
}
describe('permanent never-dispatched request journal recovery', () => {
  const stopped: RequestSealInput['stopped'] = {
    stoppedAt: 108000,
    observerStopped: true,
    senderQuiescent: true,
    settlementQuiescent: true,
    leaseStopped: true,
    verifiedDriverStopped: true
  }
  async function lost(path = ':memory:') {
    const f = fixture(path)
    f.transport.issueExecution.mockRejectedValueOnce(new Error('synthetic_lost_response'))
    await f.sender.sendAutomatic(f.task, f.draft, f.review)
    const send = f.ledger.findTask(f.task.identity, f.task.taskId)!
    const input = f.ledger.central.prepareRequestSeal(send.executionId, stopped, 108000)
    const result: RequestSealResult = {
      status: 'request_sealed',
      seal: { sealId: randomUUID(), input, requestHash: hashContext(input), sealedAt: 108001 }
    }
    return { f, send, input, result }
  }
  it('persists original proof before HTTP and applies no-replay/human ownership atomically across restart and exact acknowledgments', async () => {
    const path = pathFixture(),
      { f, send, input, result } = await lost(path)
    f.ledger.close()
    const reopened = fixture(path)
    expect(
      reopened.ledger.central.prepareRequestSeal(
        send.executionId,
        { ...stopped, stoppedAt: 109000 },
        109000
      )
    ).toEqual(input)
    reopened.ledger.observe({
      identity: f.task.identity,
      conversationId: f.task.conversationId,
      sourceMessageId: 'm3',
      direction: 'inbound',
      kind: 'text',
      text: '新问题',
      observedAt: 108002,
      identityVerified: true,
      messageIdVerified: true
    })
    reopened.ledger.central.applyRequestSeal(send.executionId, result, 108003)
    reopened.ledger.central.applyRequestSeal(send.executionId, result, 108004)
    expect(
      reopened.ledger
        .snapshot(f.task.identity, f.task.conversationId)
        .messages.map((m) => m.handledBy)
    ).toEqual([send.executionId, send.executionId, null])
    expect(reopened.ledger.snapshot(f.task.identity, f.task.conversationId).humanOwned).toBe(true)
    expect(reopened.ledger.central.requiresReconciliation()).toBe(true)
    expect(reopened.ledger.central.pendingRequestSealApplications()).toHaveLength(1)
    reopened.ledger.close()
    const restarted = fixture(path)
    expect(restarted.ledger.central.requestSeal(send.executionId)).toMatchObject({
      input,
      result,
      acknowledged: false
    })
    expect(restarted.ledger.central.requiresReconciliation()).toBe(true)
    if (result.status !== 'request_sealed') throw new Error('missing_seal')
    const ack = {
      sealId: result.seal.sealId,
      sealHash: hashContext(result.seal),
      requestHash: hashContext(input),
      executionId: send.executionId,
      status: 'request_seal_applied' as const
    }
    for (const invalid of [
      { ...ack, executionId: 'other-execution' },
      { ...ack, sealHash: hashContext('wrong') },
      { ...ack, requestHash: hashContext('wrong') },
      { ...ack, sealId: randomUUID() }
    ])
      expect(() =>
        restarted.ledger.central.acknowledgeRequestSeal(send.executionId, invalid, 109000)
      ).toThrow('request_seal_ack_mismatch')
    expect(restarted.ledger.central.requiresReconciliation()).toBe(true)
    restarted.ledger.central.acknowledgeRequestSeal(send.executionId, ack, 109000)
    expect(restarted.ledger.central.requiresReconciliation()).toBe(false)
    expect(await restarted.sender.sendAutomatic(f.task, f.draft, f.review)).toMatchObject({
      status: 'rejected'
    })
    expect(restarted.physical.dispatch).not.toHaveBeenCalled()
    expect(restarted.transport.issueExecution).not.toHaveBeenCalled()
  })
  it('rolls back local result, watermarks and controls when any part of the atomic application fails', async () => {
    const path = pathFixture(),
      { f, send, result } = await lost(path)
    const db = new DatabaseSync(path)
    db.exec(
      "CREATE TRIGGER synthetic_seal_failure BEFORE UPDATE OF handled_execution ON messages BEGIN SELECT RAISE(ABORT,'synthetic_seal_rollback'); END"
    )
    try {
      expect(() => f.ledger.central.applyRequestSeal(send.executionId, result, 108003)).toThrow(
        'synthetic_seal_rollback'
      )
      expect(f.ledger.central.requestSeal(send.executionId)?.result).toBeUndefined()
      expect(
        f.ledger
          .snapshot(f.task.identity, f.task.conversationId)
          .messages.every((m) => m.handledBy === null)
      ).toBe(true)
      expect(f.ledger.snapshot(f.task.identity, f.task.conversationId).humanOwned).toBe(false)
      expect(f.ledger.getSend(send.executionId)?.reason).not.toBe('request_sealed_not_dispatched')
      expect(f.ledger.central.requiresReconciliation()).toBe(true)
    } finally {
      db.exec('DROP TRIGGER synthetic_seal_failure')
      db.close()
    }
    f.ledger.central.applyRequestSeal(send.executionId, result, 108004)
  })
  it('attaches an original permit only as read-only history, never issuing or dispatching it', async () => {
    const { f, send } = await lost()
    const result: RequestSealResult = {
      status: 'existing_permit',
      permit: { ...f.permit, newlyIssued: false, status: 'unknown' }
    }
    f.ledger.central.applyRequestSeal(send.executionId, result, 108001)
    expect(f.ledger.central.get(send.executionId)).toMatchObject({
      phase: 'unresolved',
      permit: result.permit
    })
    expect(f.ledger.central.canSealRequest(send.executionId)).toBe(false)
    expect(() => f.ledger.central.issued(send.executionId, f.permit, 108002)).toThrow(
      'central_permit_mismatch'
    )
    expect(f.ledger.central.dispatching(send.executionId, 108002)).toBe(false)
    expect(f.ledger.central.requiresReconciliation()).toBe(true)
    expect(
      f.ledger
        .snapshot(f.task.identity, f.task.conversationId)
        .messages.every((m) => m.handledBy === null)
    ).toBe(true)
    expect(f.physical.dispatch).not.toHaveBeenCalled()
  })
  it('rejects another conversation, executable lookup response, changed proof and changed identity before saving any result', async () => {
    const { f, send, result } = await lost()
    const invalid: unknown[] = [
      { status: 'existing_permit', permit: f.permit },
      {
        status: 'existing_permit',
        permit: { ...f.permit, newlyIssued: false, conversationId: 'other-customer' }
      },
      { status: 'existing_permit', permit: { ...f.permit, newlyIssued: false, leaseVersion: 99 } },
      {
        status: 'existing_permit',
        permit: {
          ...f.permit,
          newlyIssued: false,
          identity: { ...f.task.identity, accountId: 'other-account' }
        }
      }
    ]
    if (result.status === 'request_sealed') {
      invalid.push({
        ...result,
        seal: {
          ...result.seal,
          input: { ...result.seal.input, verificationProofHash: hashContext('forged') }
        }
      })
      invalid.push({ ...result, seal: { ...result.seal, requestHash: hashContext('wrong') } })
    }
    for (const value of invalid) {
      expect(() =>
        f.ledger.central.applyRequestSeal(send.executionId, value as RequestSealResult, 108002)
      ).toThrow()
      expect(f.ledger.central.requestSeal(send.executionId)?.result).toBeUndefined()
    }
    f.ledger.central.applyRequestSeal(send.executionId, result, 108002)
    if (result.status === 'request_sealed')
      expect(() =>
        f.ledger.central.applyRequestSeal(
          send.executionId,
          { ...result, seal: { ...result.seal, sealId: randomUUID() } },
          108003
        )
      ).toThrow('request_seal_changed')
  })
  it('refuses negative evidence once any permit or physical-dispatch marker exists', async () => {
    for (const phase of ['issued', 'dispatching'] as const) {
      const f = fixture(),
        command = f.command()
      f.ledger.central.begin(
        command.executionId,
        {
          taskId: f.task.taskId,
          taskHash: hashContext(f.task),
          draftHash: f.draft.draftHash,
          draftRevision: f.draft.draftRevision,
          loginEpoch: f.task.identity.loginEpoch,
          clientInstanceId: f.task.identity.clientInstanceId,
          leaseVersion: 1
        },
        10000
      )
      f.ledger.central.issued(command.executionId, f.permit, 10000)
      if (phase === 'dispatching') f.ledger.central.dispatching(command.executionId, 10000)
      expect(f.ledger.central.canSealRequest(command.executionId)).toBe(false)
      expect(() =>
        f.ledger.central.prepareRequestSeal(command.executionId, stopped, 108000)
      ).toThrow('request_seal_non_dispatch_unproven')
    }
  })
})

describe('durable central permit to physical send', () => {
  async function resolutionFixture(path: string, outcome: 'confirmed' | 'not_sent') {
    const f = fixture(path),
      command = f.command()
    f.physical.dispatch.mockResolvedValueOnce({ status: 'unknown' })
    await f.adapter.dispatch(command, new AbortController().signal)
    const attempt = f.ledger.central.get(command.executionId)!
    const challenge: ReconciliationChallenge = {
      caseId: randomUUID(),
      snapshotHash: hashContext('synthetic-case'),
      openedAt: 106000,
      permit: { ...f.permit, status: 'unknown', newlyIssued: false }
    }
    const base = {
      executionId: command.executionId,
      identity: f.task.identity,
      conversationId: f.task.conversationId,
      permitId: f.permit.permitId,
      taskHash: f.permit.taskHash,
      draftHash: f.draft.draftHash,
      draftRevision: 1,
      leaseVersion: 1,
      observedAt: 107000,
      verificationProofHash: hashContext('synthetic-journal')
    }
    const report: DeviceReconciliationReport = {
      caseId: challenge.caseId,
      snapshotHash: challenge.snapshotHash,
      request: attempt.request,
      stopped: {
        stoppedAt: 107000,
        observerStopped: true,
        senderQuiescent: true,
        settlementQuiescent: true,
        leaseStopped: true,
        verifiedDriverStopped: true
      },
      observation:
        outcome === 'confirmed'
          ? { ...base, status: 'confirmed', sourceMessageId: 'synthetic-new-echo' }
          : { ...base, status: 'not_sent', dispatchStarted: false, quiescent: true }
    }
    f.ledger.central.saveReconciliationReport(command.executionId, challenge, report, 107000)
    const decision: ReconciliationDecision = {
      decisionId: randomUUID(),
      caseId: challenge.caseId,
      snapshotHash: challenge.snapshotHash,
      reportHash: hashContext(report),
      noteId: randomUUID(),
      outcome,
      decidedBy: 'admin-A',
      decidedAt: 108000
    }
    return { f, command, attempt, report, decision }
  }
  it('atomically applies reviewed outcomes, consumes only original inbound, and keeps unsent customer work owned by the employee', async () => {
    for (const outcome of ['confirmed', 'not_sent'] as const) {
      const { f, command, attempt, decision } = await resolutionFixture(':memory:', outcome)
      f.ledger.observe({
        identity: f.task.identity,
        conversationId: f.task.conversationId,
        sourceMessageId: 'm3',
        direction: 'inbound',
        kind: 'text',
        text: '下一条问题',
        observedAt: 107001,
        identityVerified: true,
        messageIdVerified: true
      })
      f.ledger.central.applyReconciliation(command.executionId, decision, 108000)
      expect(f.ledger.central.get(command.executionId)?.receipt).toEqual(attempt.receipt)
      const snapshot = f.ledger.snapshot(f.task.identity, f.task.conversationId)
      expect(snapshot.messages.map((m) => m.handledBy)).toEqual([
        command.executionId,
        command.executionId,
        null
      ])
      expect(snapshot.humanOwned).toBe(outcome === 'not_sent')
      expect(f.ledger.getSend(command.executionId)?.status).toBe(
        outcome === 'confirmed' ? 'confirmed' : 'cancelled'
      )
      // No remote acknowledgment yet: account must remain blocked.
      expect(f.ledger.central.requiresReconciliation()).toBe(true)
      expect(f.ledger.central.pendingReconciliationApplications()).toHaveLength(1)
      expect(await f.sender.sendAutomatic(f.task, f.draft, f.review)).toMatchObject({
        status: 'rejected'
      })
      expect(f.physical.dispatch).toHaveBeenCalledOnce()
    }
  })
  it('persists final decision across restart and clears the barrier only on the exact applied acknowledgment', async () => {
    const path = pathFixture(),
      { f, command, decision } = await resolutionFixture(path, 'confirmed')
    f.ledger.central.applyReconciliation(command.executionId, decision, 108000)
    f.ledger.close()
    const restarted = fixture(path)
    expect(restarted.ledger.central.reconciliationDecision(command.executionId)).toEqual(decision)
    expect(restarted.ledger.central.requiresReconciliation()).toBe(true)
    expect(() =>
      restarted.ledger.central.applyReconciliation(
        command.executionId,
        { ...decision, outcome: 'not_sent' },
        108000
      )
    ).toThrow()
    expect(() =>
      restarted.ledger.central.acknowledgeReconciliationApplied(
        command.executionId,
        {
          decisionId: decision.decisionId,
          decisionHash: 'f'.repeat(64),
          status: 'resolution_applied'
        },
        109000
      )
    ).toThrow('reconciliation_applied_ack_mismatch')
    const ack = {
      decisionId: decision.decisionId,
      decisionHash: hashContext(decision),
      status: 'resolution_applied' as const
    }
    restarted.ledger.central.acknowledgeReconciliationApplied(command.executionId, ack, 109000)
    restarted.ledger.central.acknowledgeReconciliationApplied(command.executionId, ack, 109000)
    expect(restarted.ledger.central.requiresReconciliation()).toBe(false)
    expect(restarted.ledger.central.get(command.executionId)?.receipt?.status).toBe('unknown')
    expect(restarted.physical.dispatch).not.toHaveBeenCalled()
    expect(restarted.transport.issueExecution).not.toHaveBeenCalled()
    restarted.ledger.close()
    const again = fixture(path)
    expect(again.ledger.central.requiresReconciliation()).toBe(false)
    expect(again.ledger.getSend(command.executionId)?.status).toBe('confirmed')
  })
  it('rolls back the decision, send state and watermark together if local storage fails', async () => {
    const path = pathFixture(),
      { f, command, decision } = await resolutionFixture(path, 'not_sent'),
      db = new DatabaseSync(path)
    db.exec(
      "CREATE TRIGGER fail_resolution_watermark BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT,'synthetic_storage_failure'); END"
    )
    try {
      expect(() =>
        f.ledger.central.applyReconciliation(command.executionId, decision, 108000)
      ).toThrow('synthetic_storage_failure')
      expect(f.ledger.central.reconciliationDecision(command.executionId)).toBeUndefined()
      expect(f.ledger.getSend(command.executionId)?.status).toBe('unknown')
      expect(
        f.ledger
          .snapshot(f.task.identity, f.task.conversationId)
          .messages.every((m) => m.handledBy === null)
      ).toBe(true)
      expect(f.ledger.snapshot(f.task.identity, f.task.conversationId).humanOwned).toBe(false)
    } finally {
      db.close()
    }
  })
  it('retains one exact reconciliation report across restart without replacing receipt, watermark or send state', async () => {
    const path = pathFixture(),
      f = fixture(path),
      command = f.command()
    f.physical.dispatch.mockResolvedValueOnce({ status: 'unknown' })
    await f.adapter.dispatch(command, new AbortController().signal)
    const original = f.ledger.central.get(command.executionId)!
    const challenge: ReconciliationChallenge = {
      caseId: randomUUID(),
      snapshotHash: hashContext('synthetic-case'),
      openedAt: 106000,
      permit: { ...f.permit, newlyIssued: false, status: 'unknown' }
    }
    const report: DeviceReconciliationReport = {
      caseId: challenge.caseId,
      snapshotHash: challenge.snapshotHash,
      request: original.request,
      stopped: {
        stoppedAt: 106000,
        observerStopped: true,
        senderQuiescent: true,
        settlementQuiescent: true,
        leaseStopped: true,
        verifiedDriverStopped: true
      },
      observation: {
        executionId: command.executionId,
        identity: f.task.identity,
        conversationId: f.task.conversationId,
        permitId: f.permit.permitId,
        taskHash: f.permit.taskHash,
        draftHash: f.permit.draftHash,
        draftRevision: f.permit.draftRevision,
        leaseVersion: 1,
        observedAt: 106001,
        verificationProofHash: hashContext('synthetic-no-action-journal'),
        status: 'not_sent',
        dispatchStarted: false,
        quiescent: true
      }
    }
    f.ledger.central.saveReconciliationReport(command.executionId, challenge, report, 106001)
    f.ledger.close()
    const restarted = new Ledger(path, 106010)
    ledgers.push(restarted)
    expect(restarted.central.reconciliationReport(command.executionId)).toEqual(report)
    expect(restarted.central.get(command.executionId)?.receipt).toEqual(original.receipt)
    expect(restarted.getSend(command.executionId)?.status).toBe('unknown')
    expect(
      restarted
        .snapshot(f.task.identity, f.task.conversationId)
        .messages.every((m) => m.handledBy === null)
    ).toBe(true)
    expect(() =>
      restarted.central.saveReconciliationReport(
        command.executionId,
        challenge,
        {
          ...report,
          observation: { ...report.observation, verificationProofHash: 'f'.repeat(64) }
        },
        106011
      )
    ).toThrow('reconciliation_report_changed')
    expect(() =>
      restarted.central.acknowledgeReconciliation(
        command.executionId,
        { caseId: report.caseId, reportHash: 'f'.repeat(64), status: 'evidence_recorded' },
        106012
      )
    ).toThrow('reconciliation_acknowledgment_mismatch')
    restarted.central.acknowledgeReconciliation(
      command.executionId,
      { caseId: report.caseId, reportHash: hashContext(report), status: 'evidence_recorded' },
      106013
    )
    expect(restarted.central.requiresReconciliation()).toBe(true)
    expect(f.physical.dispatch).toHaveBeenCalledTimes(1)
    expect(f.transport.issueExecution).toHaveBeenCalledTimes(1)
  })
  it('rejects an automatic permit substituted for a human command before touching the driver', async () => {
    const f = fixture()
    f.ledger.setHumanOwned(f.task.identity, f.task.conversationId, true)
    f.task.conversationRevision = f.ledger.snapshot(f.task.identity, f.task.conversationId).revision
    Object.assign(f.current, {
      conversationRevision: f.task.conversationRevision,
      humanOwned: true,
      humanConfirmationValid: true,
      automaticEnabled: false,
      factsVerified: false
    })
    f.permit.taskHash = hashContext(f.task)
    const confirmation = {
      confirmationId: randomUUID(),
      taskId: f.task.taskId,
      sourceTaskId: 'original',
      taskHash: hashContext(f.task),
      draftHash: f.draft.draftHash,
      draftRevision: f.draft.draftRevision,
      employeeId: f.task.identity.employeeId,
      modelResolved: f.current.modelResolved,
      confirmedAt: 10000,
      expiresAt: 15000
    }
    const issueHumanExecution = vi.fn(async () => f.permit)
    Object.assign(f.transport, { issueHumanExecution })
    await f.sender.sendHumanConfirmed(f.task, f.draft, confirmation)
    expect(issueHumanExecution).toHaveBeenCalledOnce()
    expect(f.transport.issueExecution).not.toHaveBeenCalled()
    expect(f.physical.dispatch).not.toHaveBeenCalled()
    expect(f.adapter.barrier().requiresReconciliation).toBe(true)
  })
  it('recovers a stored human permit by settling no-action without issuing or replaying a command', async () => {
    const path = pathFixture(),
      f = fixture(path),
      confirmationId = randomUUID()
    const command = f.command()
    f.ledger.central.begin(
      command.executionId,
      {
        taskId: f.task.taskId,
        taskHash: hashContext(f.task),
        draftHash: f.draft.draftHash,
        draftRevision: 1,
        leaseVersion: 1,
        loginEpoch: 1,
        clientInstanceId: 'process-A',
        purpose: 'human',
        confirmationId
      },
      10000
    )
    f.ledger.central.issued(
      command.executionId,
      { ...f.permit, purpose: 'human', confirmationId },
      10000
    )
    f.ledger.close()
    const restarted = fixture(path)
    const recovered = restarted.ledger.central.get(command.executionId)!
    expect(recovered.request).toMatchObject({ purpose: 'human', confirmationId })
    expect(recovered.receipt).toMatchObject({
      status: 'not_sent',
      dispatchStarted: false,
      quiescent: true
    })
    await restarted.adapter.flushReceipts()
    expect(restarted.transport.issueExecution).not.toHaveBeenCalled()
    expect(restarted.physical.dispatch).not.toHaveBeenCalled()
    expect(restarted.transport.settleExecution).toHaveBeenCalledOnce()
  })
  it('does not invoke the driver when a database commit consumes the remaining permit budget', async () => {
    const f = fixture(),
      commit = f.ledger.central.dispatching.bind(f.ledger.central)
    vi.spyOn(f.ledger.central, 'dispatching').mockImplementation((id, time) => {
      const result = commit(id, time)
      f.time(5000)
      return result
    })
    expect(await f.sender.sendAutomatic(f.task, f.draft, f.review)).toMatchObject({
      record: { status: 'cancelled' }
    })
    expect(f.physical.dispatch).not.toHaveBeenCalled()
    expect(f.transport.settleExecution.mock.calls[0][1].status).toBe('not_sent')
  })
  it('accepts a verified no-action result while retaining unhandled inbound for employee processing', async () => {
    const f = fixture()
    f.physical.dispatch.mockImplementationOnce(async (command) => ({
      status: 'not_sent',
      executionId: command.executionId,
      identity: command.task.identity,
      conversationId: command.task.conversationId,
      draftHash: command.draft.draftHash,
      dispatchStarted: false,
      quiescent: true,
      verificationProofHash: hashContext('verified-no-input')
    }))
    expect(await f.sender.sendAutomatic(f.task, f.draft, f.review)).toMatchObject({
      record: { status: 'cancelled' }
    })
    expect(f.transport.settleExecution.mock.calls[0][1].status).toBe('not_sent')
    expect(
      f.ledger
        .snapshot(f.task.identity, f.task.conversationId)
        .messages.every((m) => m.handledBy === null)
    ).toBe(true)
  })
  it('rolls back a receipt and send confirmation together when advancing handled inbound fails', async () => {
    const path = pathFixture(),
      f = fixture(path)
    const fault = new DatabaseSync(path)
    fault.exec(
      "CREATE TRIGGER fail_handling BEFORE UPDATE OF handled_execution ON messages BEGIN SELECT RAISE(ABORT,'synthetic_storage_fault'); END"
    )
    fault.close()
    expect(await f.sender.sendAutomatic(f.task, f.draft, f.review)).toMatchObject({
      record: { status: 'unknown' }
    })
    const record = f.ledger.findTask(f.task.identity, f.task.taskId)!
    expect(f.ledger.central.get(record.executionId)?.receipt?.status).toBe('unknown')
    expect(
      f.ledger
        .snapshot(f.task.identity, f.task.conversationId)
        .messages.every((m) => m.handledBy === null)
    ).toBe(true)
    expect(f.physical.dispatch).toHaveBeenCalledOnce()
  })
  it('flushes only the current device scope, including earlier login epochs of that same device', async () => {
    const f = fixture()
    f.transport.settleExecution.mockRejectedValueOnce(new Error('offline'))
    await f.sender.sendAutomatic(f.task, f.draft, f.review)
    f.scope({ ...f.task.identity, accountId: 'other-account' })
    expect(await f.adapter.flushReceipts()).toEqual({ acknowledged: 0, pending: 0 })
    expect(f.transport.settleExecution).toHaveBeenCalledOnce()
    f.scope({ ...f.task.identity, loginEpoch: 2, clientInstanceId: 'restarted-process' })
    expect(await f.adapter.flushReceipts()).toEqual({ acknowledged: 1, pending: 0 })
    expect(f.transport.settleExecution.mock.calls[1][0]).toEqual(f.task.identity)
    expect(f.transport.issueExecution).toHaveBeenCalledOnce()
  })
  it('keeps an unresolved permission as an account barrier without asking for it again', async () => {
    const path = pathFixture(),
      f = fixture(path)
    f.transport.issueExecution.mockRejectedValueOnce(new Error('permission response lost'))
    expect(await f.sender.sendAutomatic(f.task, f.draft, f.review)).toMatchObject({
      record: { status: 'cancelled' }
    })
    expect(f.adapter.barrier()).toEqual({ pending: 0, requiresReconciliation: true })
    f.ledger.close()
    const restarted = fixture(path)
    expect(restarted.adapter.barrier().requiresReconciliation).toBe(true)
    await restarted.adapter.flushReceipts()
    expect(restarted.transport.issueExecution).not.toHaveBeenCalled()
    expect(restarted.physical.dispatch).not.toHaveBeenCalled()
  })
  it('commits intent before requesting permission, then commits dispatch and the echo receipt in order', async () => {
    const f = fixture()
    f.transport.issueExecution.mockImplementationOnce(async () => {
      const attempt = f.ledger.central.get(
        f.ledger.findTask(f.task.identity, f.task.taskId)!.executionId
      )
      expect(attempt?.phase).toBe('requesting')
      return f.permit
    })
    f.physical.dispatch.mockImplementationOnce(async (command) => {
      expect(f.ledger.central.get(command.executionId)?.phase).toBe('dispatching')
      expect(command.authorization).toMatchObject({
        permitId: 'permit-A',
        leaseVersion: 1,
        remainingMs: 4750
      })
      return {
        status: 'confirmed',
        executionId: command.executionId,
        identity: command.task.identity,
        conversationId: command.task.conversationId,
        draftHash: command.draft.draftHash,
        evidence: 'new-echo',
        proof: { sourceMessageId: 'new-outbound-A', verificationProofHash: hashContext('proof') }
      }
    })
    f.transport.settleExecution.mockImplementationOnce(async (_identity, receipt) => {
      const record = f.ledger.findTask(f.task.identity, f.task.taskId)!
      expect(record.status).toBe('confirmed')
      expect(f.ledger.central.get(record.executionId)?.phase).toBe('receipt_pending')
      expect(
        f.ledger.snapshot(f.task.identity, f.task.conversationId).messages.every((m) => m.handledBy)
      ).toBe(true)
      return { status: receipt.status }
    })
    const result = await f.sender.sendAutomatic(f.task, f.draft, f.review)
    expect(result).toMatchObject({ status: 'recorded', record: { status: 'confirmed' } })
    expect(f.physical.dispatch).toHaveBeenCalledOnce()
    expect(f.ledger.central.pending()).toHaveLength(0)
    expect(await f.sender.sendAutomatic(f.task, f.draft, f.review)).toMatchObject({
      status: 'duplicate'
    })
    expect(f.transport.issueExecution).toHaveBeenCalledOnce()
  })
  it('never treats a duplicate central permit as a fresh right to dispatch', async () => {
    const f = fixture()
    f.transport.issueExecution.mockResolvedValueOnce({ ...f.permit, newlyIssued: false })
    expect(await f.sender.sendAutomatic(f.task, f.draft, f.review)).toMatchObject({
      record: { status: 'unknown' }
    })
    expect(f.physical.dispatch).not.toHaveBeenCalled()
    expect(f.transport.settleExecution).not.toHaveBeenCalled()
  })
  it('charges transit time and rejects an expired permission before any physical call', async () => {
    const f = fixture()
    f.transport.issueExecution.mockImplementationOnce(async () => {
      f.time(4750)
      return f.permit
    })
    expect(await f.sender.sendAutomatic(f.task, f.draft, f.review)).toMatchObject({
      record: { status: 'cancelled' }
    })
    expect(f.physical.dispatch).not.toHaveBeenCalled()
    expect(f.transport.settleExecution.mock.calls[0][1]).toMatchObject({
      status: 'not_sent',
      dispatchStarted: false,
      quiescent: true
    })
    expect(
      f.ledger
        .snapshot(f.task.identity, f.task.conversationId)
        .messages.every((m) => m.handledBy === null)
    ).toBe(true)
  })
  it('rechecks local message changes, human drafts and pause after permission acquisition', async () => {
    for (const change of ['new-message', 'human-draft', 'pause']) {
      const f = fixture()
      f.transport.issueExecution.mockImplementationOnce(async () => {
        if (change === 'new-message')
          f.ledger.observe({
            identity: f.task.identity,
            conversationId: f.task.conversationId,
            sourceMessageId: 'm3',
            direction: 'inbound',
            kind: 'text',
            text: '新追问',
            observedAt: 10000,
            identityVerified: true,
            messageIdVerified: true
          })
        if (change === 'human-draft') f.current.hasHumanDraft = true
        if (change === 'pause') f.closeGate()
        return f.permit
      })
      expect(await f.sender.sendAutomatic(f.task, f.draft, f.review)).toMatchObject({
        record: { status: 'cancelled' }
      })
      expect(f.physical.dispatch).not.toHaveBeenCalled()
    }
  })
  it('preserves confirmed delivery across restart when settlement fails, retrying only the exact receipt', async () => {
    const path = pathFixture(),
      f = fixture(path)
    f.transport.settleExecution.mockRejectedValueOnce(new Error('network response lost'))
    expect(await f.sender.sendAutomatic(f.task, f.draft, f.review)).toMatchObject({
      record: { status: 'confirmed' }
    })
    const receipt = f.ledger.central.pending()[0].receipt!
    f.ledger.close()
    const restarted = fixture(path)
    expect(restarted.ledger.central.pending()[0].receipt).toEqual(receipt)
    expect(await restarted.adapter.flushReceipts()).toEqual({ acknowledged: 1, pending: 0 })
    expect(restarted.transport.settleExecution.mock.calls[0][1]).toEqual(receipt)
    expect(restarted.physical.dispatch).not.toHaveBeenCalled()
    expect(restarted.transport.issueExecution).not.toHaveBeenCalled()
    expect(
      await restarted.sender.sendAutomatic(restarted.task, restarted.draft, restarted.review)
    ).toMatchObject({ status: 'duplicate', record: { status: 'confirmed' } })
  })
  it('restarts after permission persistence as definitely not sent, and after dispatch persistence as unknown', async () => {
    for (const phase of ['issued', 'dispatching']) {
      const path = pathFixture(),
        f = fixture(path),
        command = f.command()
      f.ledger.central.begin(
        command.executionId,
        {
          taskId: f.task.taskId,
          taskHash: hashContext(f.task),
          draftHash: f.draft.draftHash,
          draftRevision: 1,
          leaseVersion: 1,
          loginEpoch: 1,
          clientInstanceId: f.task.identity.clientInstanceId
        },
        10000
      )
      f.ledger.central.issued(command.executionId, f.permit, 10000)
      if (phase === 'dispatching') f.ledger.central.dispatching(command.executionId, 10000)
      f.ledger.close()
      const restarted = fixture(path),
        pending = restarted.ledger.central.pending()[0]
      expect(pending.receipt?.status).toBe(phase === 'issued' ? 'not_sent' : 'unknown')
      expect(pending.send.status).toBe(phase === 'issued' ? 'cancelled' : 'unknown')
      expect(await restarted.adapter.flushReceipts()).toEqual({ acknowledged: 1, pending: 0 })
      expect(restarted.physical.dispatch).not.toHaveBeenCalled()
      expect(restarted.transport.issueExecution).not.toHaveBeenCalled()
    }
  })
  it('cannot use an old observed message or a missing source proof as new echo evidence', async () => {
    for (const proof of [
      undefined,
      { sourceMessageId: 'm1', verificationProofHash: hashContext('old-echo') }
    ]) {
      const f = fixture()
      f.physical.dispatch.mockImplementationOnce(async (command) => ({
        status: 'confirmed',
        executionId: command.executionId,
        identity: command.task.identity,
        conversationId: command.task.conversationId,
        draftHash: command.draft.draftHash,
        evidence: 'synthetic',
        proof
      }))
      expect(await f.sender.sendAutomatic(f.task, f.draft, f.review)).toMatchObject({
        record: { status: 'unknown' }
      })
      expect(f.transport.settleExecution.mock.calls[0][1].status).toBe('unknown')
      expect(
        f.ledger
          .snapshot(f.task.identity, f.task.conversationId)
          .messages.every((m) => m.handledBy === null)
      ).toBe(true)
    }
  })
  it('does not rewrite a pending receipt from a changed settlement response or confirmed into unknown', async () => {
    const f = fixture()
    f.transport.settleExecution.mockResolvedValueOnce({ status: 'unknown' })
    await f.sender.sendAutomatic(f.task, f.draft, f.review)
    const attempt = f.ledger.central.pending()[0]
    expect(attempt.receipt?.status).toBe('confirmed')
    expect(() =>
      f.ledger.central.recordReceipt(
        attempt.executionId,
        { status: 'unknown', permitId: f.permit.permitId, draftHash: f.draft.draftHash },
        10000
      )
    ).toThrow('central_receipt_changed')
    expect(await f.adapter.flushReceipts()).toEqual({ acknowledged: 1, pending: 0 })
  })
  it('ignores a late permit response after cancellation without invoking or reissuing any physical action', async () => {
    const f = fixture(),
      gate = deferred<ExecutionPermit>()
    f.transport.issueExecution.mockReturnValueOnce(gate.promise)
    const sending = f.sender.sendAutomatic(f.task, f.draft, f.review)
    await vi.waitFor(() => expect(f.transport.issueExecution).toHaveBeenCalledOnce())
    expect(await f.sender.pause()).toMatchObject({ status: 'acknowledged' })
    expect(await sending).toMatchObject({ record: { status: 'cancelled' } })
    const record = f.ledger.findTask(f.task.identity, f.task.taskId)!
    expect(f.ledger.central.get(record.executionId)?.phase).toBe('unresolved')
    gate.resolve(f.permit)
    await Promise.resolve()
    expect(f.physical.dispatch).not.toHaveBeenCalled()
    expect(f.transport.issueExecution).toHaveBeenCalledOnce()
  })
  it('waits for physical quiescence, retaining pause-pending until an uncooperative dispatch settles', async () => {
    const f = fixture(),
      gate = deferred<{ status: 'unknown' }>()
    f.physical.dispatch.mockReturnValueOnce(gate.promise)
    const sending = f.sender.sendAutomatic(f.task, f.draft, f.review)
    await vi.waitFor(() => expect(f.physical.dispatch).toHaveBeenCalledOnce())
    expect(await f.sender.pause(5)).toMatchObject({ status: 'pending' })
    gate.resolve({ status: 'unknown' })
    expect(await sending).toMatchObject({ record: { status: 'unknown' } })
    expect(await f.sender.pause()).toMatchObject({ status: 'acknowledged' })
    expect(f.physical.dispatch).toHaveBeenCalledOnce()
  })
})
