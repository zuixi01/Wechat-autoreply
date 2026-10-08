import { describe, expect, it, vi } from 'vitest'
import { AgentRegistration } from '../../src/main/services/agent-registration'
import { taskFixture } from '../fixtures/task'
import { hashContext } from '../../src/core/reply/hashes'
import type { ExecutionPermit, ExecutionReceipt } from '../../src/shared/contracts/execution'
import type { LeaseGrant } from '../../src/shared/contracts/lease'
import { randomUUID } from 'node:crypto'
import type { DeviceReconciliationReport } from '../../src/shared/contracts/reconciliation'

function fixture() {
  const { task, draft } = taskFixture()
  const scope = {
    tenant_id: task.identity.tenantId,
    employee_id: task.identity.employeeId,
    account_id: task.identity.accountId,
    agent_id: task.identity.agentId,
    platform: task.identity.platform
  }
  const lease: LeaseGrant = {
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
    draftHash: draft.draftHash,
    draftRevision: draft.draftRevision,
    leaseVersion: 1,
    issuedAt: 100000,
    expiresAt: 105000,
    status: 'issued',
    newlyIssued: true
  }
  const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(lease))
  const registration = new AgentRegistration(
    {
      load: () => ({
        serverUrl: 'https://enterprise.example',
        scope,
        encryptedCredential: 'cipher'
      }),
      save: () => {}
    },
    { available: () => true, encrypt: () => '', decrypt: () => 'A'.repeat(43) },
    transport
  )
  return { task, draft, lease, permit, transport, registration }
}
describe('private lease and execution transport', () => {
  it('reads a strictly bound non-authorizing case and rejects a newly issued or substituted permit', async () => {
    const f = fixture(),
      request = {
        taskId: f.task.taskId,
        taskHash: hashContext(f.task),
        draftHash: f.draft.draftHash,
        draftRevision: f.draft.draftRevision,
        leaseVersion: 1,
        loginEpoch: f.task.identity.loginEpoch,
        clientInstanceId: f.task.identity.clientInstanceId
      }
    const challenge = {
      caseId: randomUUID(),
      snapshotHash: hashContext('synthetic-case'),
      openedAt: 106000,
      permit: { ...f.permit, status: 'unknown', newlyIssued: false }
    }
    f.transport.mockResolvedValueOnce(Response.json(challenge))
    expect(await f.registration.reconciliationChallenge(f.task.identity, request)).toEqual(
      challenge
    )
    expect(String(f.transport.mock.calls[0][0])).toBe(
      'https://enterprise.example/v1/reconciliation/challenge'
    )
    for (const permit of [
      f.permit,
      { ...challenge.permit, taskHash: 'f'.repeat(64) },
      { ...challenge.permit, identity: { ...f.task.identity, loginEpoch: 2 } },
      { ...challenge.permit, purpose: 'human', confirmationId: randomUUID() }
    ]) {
      f.transport.mockResolvedValueOnce(Response.json({ ...challenge, permit }))
      await expect(
        f.registration.reconciliationChallenge(f.task.identity, request)
      ).rejects.toThrow('INVALID_RESPONSE')
    }
    const calls = f.transport.mock.calls.length
    await expect(
      f.registration.reconciliationChallenge({ ...f.task.identity, accountId: 'other' }, request)
    ).rejects.toThrow('DEVICE_SCOPE_CHANGED')
    expect(f.transport).toHaveBeenCalledTimes(calls)
  })
  it('accepts only the exact immutable report acknowledgment, never a send result', async () => {
    const f = fixture(),
      report: DeviceReconciliationReport = {
        caseId: randomUUID(),
        snapshotHash: hashContext('synthetic-case'),
        request: {
          taskId: f.task.taskId,
          taskHash: hashContext(f.task),
          draftHash: f.draft.draftHash,
          draftRevision: f.draft.draftRevision,
          leaseVersion: 1,
          loginEpoch: f.task.identity.loginEpoch,
          clientInstanceId: f.task.identity.clientInstanceId
        },
        stopped: {
          stoppedAt: 106000,
          observerStopped: true,
          senderQuiescent: true,
          settlementQuiescent: true,
          leaseStopped: true,
          verifiedDriverStopped: true
        },
        observation: {
          executionId: randomUUID(),
          identity: f.task.identity,
          conversationId: f.task.conversationId,
          permitId: 'permit-A',
          taskHash: hashContext(f.task),
          draftHash: f.draft.draftHash,
          draftRevision: f.draft.draftRevision,
          leaseVersion: 1,
          observedAt: 106001,
          verificationProofHash: hashContext('synthetic-proof'),
          status: 'not_sent',
          dispatchStarted: false,
          quiescent: true
        }
      }
    const ack = {
      caseId: report.caseId,
      reportHash: hashContext(report),
      status: 'evidence_recorded'
    }
    f.transport.mockResolvedValueOnce(Response.json(ack))
    expect(await f.registration.reportReconciliation(report)).toEqual(ack)
    expect(String(f.transport.mock.calls[0][0])).toBe(
      'https://enterprise.example/v1/reconciliation/report'
    )
    for (const bad of [
      { ...ack, caseId: randomUUID() },
      { ...ack, reportHash: 'f'.repeat(64) },
      { ...ack, status: 'confirmed' }
    ]) {
      f.transport.mockResolvedValueOnce(Response.json(bad))
      await expect(f.registration.reportReconciliation(report)).rejects.toThrow('INVALID_RESPONSE')
    }
    const decision = {
      decisionId: randomUUID(),
      caseId: report.caseId,
      snapshotHash: report.snapshotHash,
      reportHash: hashContext(report),
      noteId: randomUUID(),
      outcome: 'not_sent' as const,
      decidedBy: 'admin-A',
      decidedAt: 106002
    }
    for (const bad of [
      { ...decision, caseId: randomUUID() },
      { ...decision, reportHash: 'f'.repeat(64) },
      { ...decision, outcome: 'confirmed' },
      { ...decision, decidedAt: 106000 },
      { ...decision, automaticAllowed: true }
    ]) {
      f.transport.mockResolvedValueOnce(Response.json({ decision: bad }))
      await expect(f.registration.reconciliationDecision(report)).rejects.toThrow(
        'INVALID_RESPONSE'
      )
    }
    f.transport.mockResolvedValueOnce(Response.json({ decision }))
    expect(await f.registration.reconciliationDecision(report)).toEqual(decision)
    const applied = {
      decisionId: decision.decisionId,
      decisionHash: hashContext(decision),
      status: 'resolution_applied' as const
    }
    f.transport.mockResolvedValueOnce(Response.json(applied))
    expect(await f.registration.reconciliationApplied(report, decision)).toEqual(applied)
    f.transport.mockResolvedValueOnce(Response.json({ ...applied, decisionHash: 'f'.repeat(64) }))
    await expect(f.registration.reconciliationApplied(report, decision)).rejects.toThrow(
      'INVALID_RESPONSE'
    )
  })
  it('requests a separately typed human permit and rejects automatic or mismatched confirmation responses', async () => {
    const f = fixture(),
      confirmation = {
        confirmationId: randomUUID(),
        taskId: f.task.taskId,
        sourceTaskId: 'source',
        taskHash: hashContext(f.task),
        draftHash: f.draft.draftHash,
        draftRevision: f.draft.draftRevision,
        employeeId: f.task.identity.employeeId,
        modelResolved: 'jev-test-version',
        confirmedAt: 10000,
        expiresAt: 15000
      }
    const permit = {
      ...f.permit,
      purpose: 'human' as const,
      confirmationId: confirmation.confirmationId
    }
    f.transport.mockResolvedValueOnce(Response.json(permit))
    expect(await f.registration.issueHumanExecution(f.task, f.draft, confirmation, 1)).toEqual(
      permit
    )
    expect(String(f.transport.mock.calls[0][0])).toBe(
      'https://enterprise.example/v1/executions/issue-human'
    )
    for (const bad of [f.permit, { ...permit, confirmationId: randomUUID() }]) {
      f.transport.mockResolvedValueOnce(Response.json(bad))
      await expect(
        f.registration.issueHumanExecution(f.task, f.draft, confirmation, 1)
      ).rejects.toThrow('INVALID_RESPONSE')
    }
    f.transport.mockResolvedValueOnce(Response.json(permit))
    await expect(f.registration.issueExecution(f.task, f.draft, 1)).rejects.toThrow(
      'INVALID_RESPONSE'
    )
  })
  it('renews only the registered account and validates full login identity', async () => {
    const f = fixture()
    expect(await f.registration.acquireLease(f.task.identity)).toEqual(f.lease)
    const [url, options] = f.transport.mock.calls[0]
    expect(String(url)).toBe('https://enterprise.example/v1/leases/acquire')
    expect(JSON.parse(String(options?.body))).toEqual({
      loginEpoch: f.task.identity.loginEpoch,
      clientInstanceId: f.task.identity.clientInstanceId
    })
    f.transport.mockResolvedValueOnce(
      Response.json({ ...f.lease, identity: { ...f.task.identity, loginEpoch: 2 } })
    )
    await expect(f.registration.acquireLease(f.task.identity)).rejects.toThrow('INVALID_RESPONSE')
    await expect(
      f.registration.acquireLease({ ...f.task.identity, accountId: 'other' })
    ).rejects.toThrow('DEVICE_SCOPE_CHANGED')
    expect(f.transport).toHaveBeenCalledTimes(2)
  })
  it('binds a permit to task, final text, revision and lease without automatic retries', async () => {
    const f = fixture()
    f.transport.mockResolvedValueOnce(Response.json(f.permit))
    expect(await f.registration.issueExecution(f.task, f.draft, 1)).toEqual(f.permit)
    expect(JSON.parse(String(f.transport.mock.calls[0][1]?.body))).toEqual({
      taskId: f.task.taskId,
      taskHash: hashContext(f.task),
      draftHash: f.draft.draftHash,
      draftRevision: f.draft.draftRevision,
      loginEpoch: f.task.identity.loginEpoch,
      clientInstanceId: f.task.identity.clientInstanceId,
      leaseVersion: 1
    })
    f.transport.mockRejectedValueOnce(new Error('lost reply private credential'))
    await expect(f.registration.issueExecution(f.task, f.draft, 1)).rejects.toThrow(/^UNAVAILABLE$/)
    expect(f.transport).toHaveBeenCalledTimes(2)
  })
  it('refuses mismatched permit identities, customers, text, lease and excessive lifetime', async () => {
    const f = fixture()
    for (const change of [
      { identity: { ...f.task.identity, clientInstanceId: 'other' } },
      { conversationId: 'other' },
      { taskHash: 'b'.repeat(64) },
      { draftHash: 'b'.repeat(64) },
      { leaseVersion: 2 },
      { expiresAt: 120000 },
      { status: 'confirmed' }
    ]) {
      f.transport.mockResolvedValueOnce(Response.json({ ...f.permit, ...change }))
      await expect(f.registration.issueExecution(f.task, f.draft, 1)).rejects.toThrow(
        'INVALID_RESPONSE'
      )
    }
  })
  it('rejects locally changed drafts before any request and preserves duplicate semantics', async () => {
    const f = fixture()
    await expect(
      f.registration.issueExecution(f.task, { ...f.draft, text: 'changed' }, 1)
    ).rejects.toThrow('TASK_INVALIDATED')
    await expect(
      f.registration.issueExecution(f.task, { ...f.draft, taskId: 'other' }, 1)
    ).rejects.toThrow('TASK_INVALIDATED')
    expect(f.transport).not.toHaveBeenCalled()
    f.transport.mockResolvedValueOnce(
      Response.json({ ...f.permit, newlyIssued: false, status: 'unknown' })
    )
    expect(await f.registration.issueExecution(f.task, f.draft, 1)).toMatchObject({
      newlyIssued: false,
      status: 'unknown'
    })
  })
  it('settles exact receipts and refuses a server changing their result', async () => {
    const f = fixture()
    const receipt: ExecutionReceipt = {
      permitId: 'permit-A',
      draftHash: f.draft.draftHash,
      status: 'unknown'
    }
    f.transport.mockResolvedValueOnce(Response.json({ status: 'unknown' }))
    expect(await f.registration.settleExecution(f.task.identity, receipt)).toEqual({
      status: 'unknown'
    })
    expect(String(f.transport.mock.calls[0][0])).toBe(
      'https://enterprise.example/v1/executions/settle'
    )
    f.transport.mockResolvedValueOnce(Response.json({ status: 'confirmed' }))
    await expect(f.registration.settleExecution(f.task.identity, receipt)).rejects.toThrow(
      'INVALID_RESPONSE'
    )
  })
})
