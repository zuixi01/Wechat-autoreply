import type { DraftReview, ReplyDraft, ReplyTask } from '../../shared/contracts/task'
import { sameIdentity, type Identity } from '../../shared/contracts/identity'
import { hashConversationContext, Ledger, type SendRecord } from '../persistence/ledger'
import {
  validateAutomaticSend,
  validateHumanConfirmedSend,
  type CurrentSendState,
  type SendValidation
} from './validation'
import type { HumanConfirmation } from '../../shared/contracts/human-confirmation'
import { NotSentDeliverySchema } from '../../shared/contracts/delivery'
export type { DeliveryResult } from '../../shared/contracts/delivery'
import type { DeliveryResult } from '../../shared/contracts/delivery'

export interface SendCommand {
  executionId: string
  task: ReplyTask
  draft: ReplyDraft
  review?: DraftReview
  purpose?: 'automatic' | 'human'
  confirmation?: HumanConfirmation
  authorization?: { permitId: string; leaseVersion: number; remainingMs: number }
}

export interface VerifiedSendAdapter {
  readCurrent(task: ReplyTask, signal: AbortSignal): Promise<CurrentSendState>
  /** Must recheck bound identity, human conflicts and signal at the actual action boundary.
   * Resolve only after the operation cannot produce any further input/side effects.
   * A bridge timeout is unknown, never proof that the underlying operation stopped. */
  dispatch(command: SendCommand, signal: AbortSignal): Promise<DeliveryResult>
}

export type SenderResult =
  | { status: 'rejected'; reason: string }
  | { status: 'duplicate' | 'recorded'; record: SendRecord }

/** One executor for a local agent. UI code must not call a device send method directly. */
export class Sender {
  private paused = true
  private pauseEpoch = 0
  private tail: Promise<unknown> = Promise.resolve()
  private readonly controllers = new Map<AbortController, ReplyTask>()
  private readonly inFlight = new Map<Promise<unknown>, ReplyTask>()

  constructor(
    private readonly ledger: Ledger,
    private readonly adapter: VerifiedSendAdapter,
    private readonly now: () => number = Date.now
  ) {}

  resume(): void {
    this.paused = false
  }
  isPaused(): boolean {
    return this.paused
  }
  isQuiescent(): boolean {
    return this.inFlight.size === 0
  }
  conversationQuiescent(identity: Identity, conversationId: string): boolean {
    return ![...this.inFlight.values()].some((task) =>
      this.inConversation(task, identity, conversationId)
    )
  }
  async cancelConversation(
    identity: Identity,
    conversationId: string,
    waitMs = 1000
  ): Promise<boolean> {
    for (const [controller, task] of this.controllers)
      if (this.inConversation(task, identity, conversationId)) controller.abort()
    const pending = [...this.inFlight]
      .filter(([, task]) => this.inConversation(task, identity, conversationId))
      .map(([p]) => p)
    if (!pending.length) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
    return this.conversationQuiescent(identity, conversationId)
  }
  private inConversation(task: ReplyTask, identity: Identity, conversationId: string): boolean {
    return (
      task.conversationId === conversationId &&
      (['tenantId', 'employeeId', 'accountId', 'agentId', 'platform'] as const).every(
        (key) => task.identity[key] === identity[key]
      )
    )
  }

  async revalidate(command: SendCommand, signal: AbortSignal): Promise<boolean> {
    if (this.paused || signal.aborted) return false
    const state = await this.adapter.readCurrent(command.task, signal)
    return (
      !this.paused &&
      !signal.aborted &&
      this.validate(command, state).allowed &&
      this.localCurrent(command)
    )
  }

  localCurrent(command: SendCommand): boolean {
    const snapshot = this.ledger.snapshot(command.task.identity, command.task.conversationId)
    const range = snapshot.messages.filter(
      (message) =>
        message.direction === 'inbound' &&
        message.sequence >= command.task.inboundRange.from &&
        message.sequence <= command.task.inboundRange.to
    )
    return (
      !this.paused &&
      !snapshot.hasGap &&
      this.ledger.collection.ready(command.task.identity, command.task.conversationId) &&
      snapshot.humanOwned === (command.purpose === 'human') &&
      snapshot.revision === command.task.conversationRevision &&
      hashConversationContext(snapshot) === command.task.contextHash &&
      !this.ledger.hasUnknown(
        command.task.identity,
        command.task.conversationId,
        command.executionId
      ) &&
      range.length > 0 &&
      range.every(
        (message) =>
          message.handledBy === null &&
          message.kind === 'text' &&
          message.identityVerified &&
          message.messageIdVerified
      )
    )
  }

  async pause(waitMs = 1000): Promise<{ status: 'acknowledged' | 'pending'; epoch: number }> {
    this.paused = true
    const epoch = ++this.pauseEpoch
    for (const controller of this.controllers.keys()) controller.abort()
    if (this.inFlight.size === 0) return { status: 'acknowledged', epoch }
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled([...this.inFlight.keys()]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs)
      })
    ])
    if (timer) clearTimeout(timer)
    return { status: this.inFlight.size === 0 ? 'acknowledged' : 'pending', epoch }
  }

  sendAutomatic(task: ReplyTask, draft: ReplyDraft, review: DraftReview): Promise<SenderResult> {
    // Capture immutable inputs and the run epoch before waiting in the queue.
    const command = structuredClone({ task, draft, review })
    const epoch = this.pauseEpoch
    const operation = this.tail.then(() => this.execute(command, epoch))
    this.tail = operation.catch(() => undefined)
    return operation
  }

  sendHumanConfirmed(
    task: ReplyTask,
    draft: ReplyDraft,
    confirmation: HumanConfirmation
  ): Promise<SenderResult> {
    const command = structuredClone({ task, draft, confirmation, purpose: 'human' as const })
    const epoch = this.pauseEpoch
    const operation = this.tail.then(() => this.execute(command, epoch))
    this.tail = operation.catch(() => undefined)
    return operation
  }

  private validate(
    command: Omit<SendCommand, 'executionId'>,
    state: CurrentSendState
  ): SendValidation {
    if (command.purpose === 'human' && command.confirmation && !command.review)
      return validateHumanConfirmedSend(
        command.task,
        command.draft,
        command.confirmation,
        state,
        this.now()
      )
    if (
      (!command.purpose || command.purpose === 'automatic') &&
      command.review &&
      !command.confirmation
    )
      return validateAutomaticSend(command.task, command.draft, command.review, state, this.now())
    return { allowed: false, reason: 'send_authority_invalid' }
  }

  private async execute(
    command: Omit<SendCommand, 'executionId'>,
    epoch: number
  ): Promise<SenderResult> {
    const reject = (reason: string): SenderResult => ({ status: 'rejected', reason })
    if (this.paused || epoch !== this.pauseEpoch) return reject('paused_or_obsolete_run')
    const controller = new AbortController()
    this.controllers.set(controller, command.task)
    try {
      const state = await this.adapter.readCurrent(command.task, controller.signal)
      if (this.paused || epoch !== this.pauseEpoch || controller.signal.aborted)
        return reject('paused_or_obsolete_run')
      const validation = this.validate(command, state)
      if (!validation.allowed) return reject(validation.reason)
      const snapshot = this.ledger.snapshot(command.task.identity, command.task.conversationId)
      if (
        snapshot.hasGap ||
        snapshot.humanOwned !== (command.purpose === 'human') ||
        snapshot.revision !== command.task.conversationRevision ||
        hashConversationContext(snapshot) !== command.task.contextHash
      )
        return reject('ledger_context_changed')
      const existing = this.ledger.findTask(command.task.identity, command.task.taskId)
      if (existing) return { status: 'duplicate', record: existing }
      if (this.ledger.hasUnknown(command.task.identity, command.task.conversationId))
        return reject('unresolved_delivery')
      const range = snapshot.messages.filter(
        (message) =>
          message.direction === 'inbound' &&
          message.sequence >= command.task.inboundRange.from &&
          message.sequence <= command.task.inboundRange.to
      )
      if (
        range.length === 0 ||
        range.some(
          (message) =>
            message.handledBy !== null ||
            message.kind !== 'text' ||
            !message.identityVerified ||
            !message.messageIdVerified
        )
      )
        return reject('inbound_range_unavailable')
      const prepared = this.ledger.prepare(command.task, command.draft.draftHash, this.now())
      if (!prepared.created) return { status: 'duplicate', record: prepared.record }
      const executionId = prepared.record.executionId
      // No await between the final gate, durable intent and the action call.
      if (!this.ledger.transition(executionId, 'prepared', 'dispatching', this.now()))
        return reject('dispatch_conflict')
      let settle!: () => void
      const quiescent = new Promise<void>((resolve) => {
        settle = resolve
      })
      this.inFlight.set(quiescent, command.task)
      let operation: Promise<DeliveryResult>
      try {
        operation = this.adapter.dispatch({ ...command, executionId }, controller.signal)
      } catch {
        operation = Promise.resolve({ status: 'unknown' })
      }
      try {
        const delivery = await operation
        const confirmed =
          delivery.status === 'confirmed' &&
          delivery.executionId === executionId &&
          sameIdentity(delivery.identity, command.task.identity) &&
          delivery.conversationId === command.task.conversationId &&
          delivery.draftHash === command.draft.draftHash &&
          delivery.evidence.trim().length > 0
        const notSent = NotSentDeliverySchema.safeParse(delivery)
        const cancelled =
          notSent.success &&
          notSent.data.executionId === executionId &&
          sameIdentity(notSent.data.identity, command.task.identity) &&
          notSent.data.conversationId === command.task.conversationId &&
          notSent.data.draftHash === command.draft.draftHash
        // The central outbox may already have committed the receipt and inbound watermark.
        if (this.ledger.getSend(executionId)?.status === 'dispatching')
          this.ledger.transition(
            executionId,
            'dispatching',
            confirmed ? 'confirmed' : cancelled ? 'cancelled' : 'unknown',
            this.now(),
            confirmed ? null : cancelled ? 'verified_not_sent' : 'unverified_delivery',
            confirmed ? delivery.evidence : null
          )
      } catch {
        this.ledger.transition(executionId, 'dispatching', 'unknown', this.now(), 'adapter_failed')
      } finally {
        this.inFlight.delete(quiescent)
        settle()
      }
      return { status: 'recorded', record: this.ledger.getSend(executionId)! }
    } catch {
      return reject('preparation_failed')
    } finally {
      this.controllers.delete(controller)
    }
  }
}
