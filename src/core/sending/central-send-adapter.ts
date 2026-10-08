import { performance } from 'node:perf_hooks'
import { sameIdentity, type Identity } from '../../shared/contracts/identity'
import {
  ExecutionPermitSchema,
  type ExecutionPermit,
  type ExecutionReceipt,
  type PermitRequest
} from '../../shared/contracts/execution'
import {
  ConfirmedDeliverySchema,
  NotSentDeliverySchema,
  type DeliveryResult
} from '../../shared/contracts/delivery'
import type { ReplyDraft, ReplyTask } from '../../shared/contracts/task'
import type { LeaseGrant } from '../../shared/contracts/lease'
import type { SendCommand, VerifiedSendAdapter } from './sender'
import { Ledger } from '../persistence/ledger'
import { hashContext } from '../reply/hashes'
import type { HumanConfirmation } from '../../shared/contracts/human-confirmation'

export interface ExecutionTransport {
  issueHumanExecution?(
    task: ReplyTask,
    draft: ReplyDraft,
    confirmation: HumanConfirmation,
    leaseVersion: number,
    signal?: AbortSignal
  ): Promise<ExecutionPermit>
  issueExecution(
    task: ReplyTask,
    draft: ReplyDraft,
    leaseVersion: number,
    signal?: AbortSignal
  ): Promise<ExecutionPermit>
  settleExecution(
    identity: Identity,
    receipt: ExecutionReceipt,
    signal?: AbortSignal
  ): Promise<{ status: ExecutionReceipt['status'] }>
}
interface DispatchGates {
  lease(): LeaseGrant | undefined
  revalidate(command: SendCommand, signal: AbortSignal): Promise<boolean>
  current(command: SendCommand): boolean
  scope?(): Omit<Identity, 'loginEpoch' | 'clientInstanceId'> | undefined
}

/** All permit intent/receipt state is durable before its corresponding side effect.
 * Retrying settlement never invokes physical dispatch or asks for another permit. */
export class CentralSendAdapter implements VerifiedSendAdapter {
  private flushing?: Promise<{ acknowledged: number; pending: number }>
  constructor(
    private readonly ledger: Ledger,
    private readonly transport: ExecutionTransport,
    private readonly physical: VerifiedSendAdapter,
    private readonly gates: DispatchGates,
    private readonly now: () => number = Date.now,
    private readonly clock: () => number = () => performance.now()
  ) {}

  readCurrent(
    task: ReplyTask,
    signal: AbortSignal
  ): ReturnType<VerifiedSendAdapter['readCurrent']> {
    return this.physical.readCurrent(task, signal)
  }

  async dispatch(input: SendCommand, signal: AbortSignal): Promise<DeliveryResult> {
    const command = structuredClone(input)
    if (
      command.purpose === 'human' &&
      (!command.confirmation || !this.transport.issueHumanExecution)
    )
      return this.beforePermit(command, 'human_permit_unavailable')
    await this.flushReceipts(signal)
    if (this.barrier().requiresReconciliation)
      return this.beforePermit(command, 'central_reconciliation_required')
    if (this.pending().length > 0) return this.beforePermit(command, 'settlement_pending')
    const lease = this.gates.lease()
    if (
      signal.aborted ||
      !lease ||
      !sameIdentity(lease.identity, command.task.identity) ||
      !this.gates.current(command)
    )
      return this.beforePermit(command, 'local_authority_unavailable')
    const request: PermitRequest = {
      taskId: command.task.taskId,
      taskHash: hashContext(command.task),
      draftHash: command.draft.draftHash,
      draftRevision: command.draft.draftRevision,
      leaseVersion: lease.version,
      loginEpoch: command.task.identity.loginEpoch,
      clientInstanceId: command.task.identity.clientInstanceId,
      ...(command.purpose === 'human'
        ? { purpose: 'human' as const, confirmationId: command.confirmation!.confirmationId }
        : {})
    }
    if (!this.ledger.central.begin(command.executionId, request, this.now()))
      return { status: 'unknown' }
    const started = this.clock()
    let permit: ExecutionPermit
    try {
      permit = ExecutionPermitSchema.parse(
        await this.bounded(
          (limit) =>
            command.purpose === 'human'
              ? this.transport.issueHumanExecution!(
                  command.task,
                  command.draft,
                  command.confirmation!,
                  lease.version,
                  limit
                )
              : this.transport.issueExecution(command.task, command.draft, lease.version, limit),
          signal
        )
      )
      if (permit.expiresAt <= permit.issuedAt || permit.expiresAt - permit.issuedAt > 5000)
        throw new Error('invalid_permit_lifetime')
      if (!this.ledger.central.issued(command.executionId, permit, this.now()))
        return { status: 'unknown' }
    } catch {
      this.ledger.central.unresolved(command.executionId, this.now())
      return this.beforePermit(command, 'permit_result_unresolved')
    }
    // Charge all network transit time. Never trust the server/client wall clocks to align.
    const deadline = started + permit.expiresAt - permit.issuedAt - 250
    const current = (): boolean => {
      const grant = this.gates.lease()
      return (
        !signal.aborted &&
        Boolean(
          grant &&
          grant.version === lease.version &&
          sameIdentity(grant.identity, command.task.identity)
        ) &&
        this.gates.current(command) &&
        this.clock() < deadline &&
        !signal.aborted
      )
    }
    try {
      if (
        !current() ||
        !(await this.bounded((limit) => this.gates.revalidate(command, limit), signal)) ||
        !current()
      )
        return this.notDispatched(command, permit)
    } catch {
      return this.notDispatched(command, permit)
    }
    // No await between the final gate, durable dispatch marker and single physical call.
    if (!this.ledger.central.dispatching(command.executionId, this.now()))
      return { status: 'unknown' }
    if (!current()) return this.notDispatched(command, permit)
    let result: DeliveryResult
    try {
      result = await this.physical.dispatch(
        {
          ...command,
          authorization: {
            permitId: permit.permitId,
            leaseVersion: permit.leaseVersion,
            remainingMs: Math.max(0, deadline - this.clock())
          }
        },
        signal
      )
    } catch {
      result = { status: 'unknown' }
    }
    const parsed = ConfirmedDeliverySchema.safeParse(result)
    const noAction = NotSentDeliverySchema.safeParse(result)
    const receipt: ExecutionReceipt =
      parsed.success && parsed.data.proof
        ? {
            status: 'confirmed',
            permitId: permit.permitId,
            draftHash: command.draft.draftHash,
            sourceMessageId: parsed.data.proof.sourceMessageId,
            verificationProofHash: parsed.data.proof.verificationProofHash
          }
        : noAction.success
          ? {
              status: 'not_sent',
              permitId: permit.permitId,
              draftHash: command.draft.draftHash,
              dispatchStarted: false,
              quiescent: true,
              verificationProofHash: noAction.data.verificationProofHash
            }
          : { status: 'unknown', permitId: permit.permitId, draftHash: command.draft.draftHash }
    try {
      this.ledger.central.recordReceipt(command.executionId, receipt, this.now(), result)
    } catch {
      this.ledger.central.recordReceipt(
        command.executionId,
        { status: 'unknown', permitId: permit.permitId, draftHash: command.draft.draftHash },
        this.now()
      )
      result = { status: 'unknown' }
    }
    await this.settle(command.executionId)
    return (receipt.status === 'confirmed' &&
      this.ledger.getSend(command.executionId)?.status === 'confirmed') ||
      (receipt.status === 'not_sent' &&
        this.ledger.getSend(command.executionId)?.status === 'cancelled')
      ? result
      : { status: 'unknown' }
  }

  flushReceipts(signal?: AbortSignal): Promise<{ acknowledged: number; pending: number }> {
    if (this.flushing) return this.flushing
    const work = this.flush(signal)
    this.flushing = work
    const settled = (): void => {
      if (this.flushing === work) this.flushing = undefined
    }
    void work.then(settled, settled)
    return work
  }
  async quiescent(): Promise<void> {
    if (this.flushing) await this.flushing.catch(() => undefined)
  }
  isQuiescent(): boolean {
    return this.flushing === undefined
  }
  barrier(): { pending: number; requiresReconciliation: boolean } {
    const scope = this.gates.scope?.()
    if (this.gates.scope && !scope) return { pending: 0, requiresReconciliation: false }
    return {
      pending: this.pending().length,
      requiresReconciliation: this.ledger.central.requiresReconciliation(scope)
    }
  }
  private async flush(signal?: AbortSignal): Promise<{ acknowledged: number; pending: number }> {
    let acknowledged = 0
    for (const attempt of this.pending()) {
      if (signal?.aborted) break
      if (await this.settle(attempt.executionId, signal)) acknowledged++
      else break // A failed server/credential should not produce a burst of retries.
    }
    return { acknowledged, pending: this.pending().length }
  }

  private pending(): ReturnType<Ledger['central']['pending']> {
    const scope = this.gates.scope?.()
    if (this.gates.scope && !scope) return []
    return this.ledger.central.pending(scope)
  }

  private beforePermit(command: SendCommand, reason: string): DeliveryResult {
    return {
      status: 'not_sent',
      executionId: command.executionId,
      identity: command.task.identity,
      conversationId: command.task.conversationId,
      draftHash: command.draft.draftHash,
      dispatchStarted: false,
      quiescent: true,
      verificationProofHash: hashContext({
        kind: reason,
        executionId: command.executionId,
        taskHash: hashContext(command.task)
      })
    }
  }

  private async settle(executionId: string, parent?: AbortSignal): Promise<boolean> {
    const row = this.ledger.central.get(executionId)
    if (!row?.receipt || row.phase !== 'receipt_pending') return false
    try {
      const response = await this.bounded(
        (signal) => this.transport.settleExecution(row.send.task.identity, row.receipt!, signal),
        parent
      )
      if (response.status !== row.receipt.status) return false
      this.ledger.central.acknowledge(executionId, row.receipt, this.now())
      return true
    } catch {
      return false
    }
  }

  private async notDispatched(
    command: SendCommand,
    permit: ExecutionPermit
  ): Promise<DeliveryResult> {
    const proof = hashContext({
      kind: 'central_gate_closed_before_physical_call',
      executionId: command.executionId,
      permitId: permit.permitId,
      taskHash: permit.taskHash
    })
    const result: DeliveryResult = {
      status: 'not_sent',
      executionId: command.executionId,
      identity: command.task.identity,
      conversationId: command.task.conversationId,
      draftHash: command.draft.draftHash,
      dispatchStarted: false,
      quiescent: true,
      verificationProofHash: proof
    }
    this.ledger.central.recordReceipt(
      command.executionId,
      {
        status: 'not_sent',
        permitId: permit.permitId,
        draftHash: command.draft.draftHash,
        dispatchStarted: false,
        quiescent: true,
        verificationProofHash: proof
      },
      this.now(),
      result
    )
    await this.settle(command.executionId)
    return result
  }

  private async bounded<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    parent?: AbortSignal
  ): Promise<T> {
    if (parent?.aborted) throw new Error('execution_cancelled')
    const controller = new AbortController()
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
    const timer = setTimeout(() => controller.abort(), 2500)
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('execution_unavailable'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      return await Promise.race([operation(signal), cancelled])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
}
