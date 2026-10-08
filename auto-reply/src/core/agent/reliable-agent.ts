import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import {
  ConversationBindingSchema,
  sameIdentity,
  type ConversationBinding
} from '../../shared/contracts/identity'
import { ObservedMessageSchema, type ObservedMessage } from '../../shared/contracts/message'
import {
  ReplyTaskSchema,
  type ReplyTask,
  type ReplyDraft,
  type DraftReview
} from '../../shared/contracts/task'
import {
  conversationKey,
  hashConversationContext,
  selectConversationContext,
  Ledger,
  type SendRecord
} from '../persistence/ledger'
import type { ContextMessage } from '../../shared/contracts/context'
import { ConversationScheduler, type JobContext } from '../reply/scheduler'
import { Sender, type SenderResult, type VerifiedSendAdapter } from '../sending/sender'
import { hashContext, hashDraft } from '../reply/hashes'
import type { EditedReviewInput } from '../../shared/contracts/edited-review'
import { parseEditedReviewInput } from '../reply/edited-review-validation'
import {
  HumanConfirmationSchema,
  type HumanConfirmation
} from '../../shared/contracts/human-confirmation'
import type { Identity } from '../../shared/contracts/identity'
import type { AssessmentExplanation } from '../../shared/contracts/assessment-explanation'
import {
  stripLearningBinding,
  EMPTY_ENTERPRISE_MEMORY_VERSION,
  sameMemoryCorpus
} from '../../shared/contracts/learning-task'
import { parsePreparedGenerationTask } from '../reply/learning-task-binding'

export interface AgentConfiguration {
  configVersion: string
  knowledgeVersion: string
  decisionPolicyVersion: string
  questionSetVersion: string
  modelResolved: string
  automaticEnabled: boolean
  memoryCorpusVersion?: string
}
export interface ReplyCandidate {
  task: ReplyTask
  draft?: ReplyDraft
  review?: DraftReview
  automaticAllowed: boolean
  factsVerified: boolean
  reasons: string[]
  explanation?: AssessmentExplanation
}
export interface ReplyService {
  prepare?(
    task: ReplyTask,
    inbound: string[],
    isCurrent: () => boolean,
    signal: AbortSignal,
    context?: ContextMessage[]
  ): Promise<ReplyTask>
  generate(
    task: ReplyTask,
    inbound: string[],
    isCurrent: () => boolean,
    signal: AbortSignal,
    context?: ContextMessage[]
  ): Promise<ReplyCandidate>
}
type AgentProgress =
  | { stage: 'observed'; identity: Identity; conversationId: string; sourceMessageId: string }
  | {
      stage:
        | 'generation_started'
        | 'prepared'
        | 'generation_completed'
        | 'generation_failed'
        | 'candidate_ready'
        | 'obsolete'
        | 'send_started'
        | 'send_finished'
      task: ReplyTask
      outcome?: 'rejected' | 'duplicate' | SendRecord['status']
    }
export type AgentProgressEvent = AgentProgress & { atMs: number }
interface AgentEvents {
  onCandidate?: (candidate: ReplyCandidate) => void
  onSend?: (result: SenderResult) => void
  onHandoff?: (conversationId: string, reason: string) => void
  onStorageFailure?: () => void
  /** Trusted host diagnostics only; never a decision or permission input. */
  onProgress?: (event: AgentProgressEvent) => void | Promise<void>
}

export class RunEpochPersistenceError extends Error {
  constructor() {
    super('run_epoch_persistence_failed')
    this.name = 'RunEpochPersistenceError'
  }
}

/** Reliable observation→generation→review→ledger→send coordination, independently testable.
 * A real observer and a verified send adapter are required before desktop automation can start. */
export class ReliableAgent {
  private configuration?: AgentConfiguration
  private paused = true
  private runEpoch = 0
  private readonly bindings = new Map<string, ConversationBinding>()
  private readonly candidates = new Map<string, ReplyCandidate>()
  private readonly humanTasks = new Map<
    string,
    { task: ReplyTask; confirmation: HumanConfirmation }
  >()
  private readonly scheduler: ConversationScheduler<ReplyCandidate>
  readonly sender: Sender

  constructor(
    private readonly ledger: Ledger,
    adapter: VerifiedSendAdapter,
    private readonly reply: ReplyService,
    private readonly events: AgentEvents = {},
    schedulerOptions: { quietMs?: number; maximumWaitMs?: number } = {},
    private readonly now: () => number = Date.now,
    private readonly monotonicNow: () => number = () => performance.now()
  ) {
    this.runEpoch = this.nextRunEpoch()
    this.scheduler = new ConversationScheduler(
      {
        ...schedulerOptions,
        onError: (key, reason) => this.recordHandoff(key, reason)
      },
      now
    )
    this.sender = new Sender(
      ledger,
      {
        readCurrent: async (task, signal) => {
          const physical = await adapter.readCurrent(task, signal)
          const config = this.configuration
          const key = conversationKey(task.identity, task.conversationId)
          const binding = this.bindings.get(key)
          const snapshot = ledger.snapshot(task.identity, task.conversationId)
          return {
            ...physical,
            runEpoch: this.runEpoch,
            paused: this.paused,
            automaticEnabled: config?.automaticEnabled ?? false,
            bindingVersion: binding?.bindingVersion ?? -1,
            identityVerified: physical.identityVerified && binding?.identityVerified === true,
            conversationRevision: snapshot.revision,
            contextHash: hashConversationContext(snapshot),
            hasMessageGap:
              physical.hasMessageGap ||
              snapshot.hasGap ||
              !ledger.collection.ready(task.identity, task.conversationId),
            humanActive: physical.humanActive,
            humanOwned: snapshot.humanOwned,
            humanConfirmationValid: this.humanTasks.has(task.taskId),
            configVersion: config?.configVersion ?? '',
            knowledgeVersion: config?.knowledgeVersion ?? '',
            decisionPolicyVersion: config?.decisionPolicyVersion ?? '',
            questionSetVersion: config?.questionSetVersion ?? '',
            modelResolved: config?.modelResolved ?? '',
            memoryCorpusVersion: config?.memoryCorpusVersion,
            factsVerified:
              physical.factsVerified && this.candidates.get(task.taskId)?.factsVerified === true
          }
        },
        dispatch: (command, signal) => adapter.dispatch(command, signal)
      },
      now
    )
  }

  private progress(event: AgentProgress, atMs = this.monotonicNow()): void {
    if (!this.events.onProgress) return
    try {
      const pending = this.events.onProgress(structuredClone({ ...event, atMs }))
      if (pending) void Promise.resolve(pending).catch(() => undefined)
    } catch {
      // Diagnostics cannot change a task, suppress a candidate or grant send rights.
    }
  }

  async configure(input: AgentConfiguration): Promise<void> {
    const config = z
      .strictObject({
        configVersion: z.string().min(1),
        knowledgeVersion: z.string().min(1),
        decisionPolicyVersion: z.string().min(1),
        questionSetVersion: z.string().min(1),
        modelResolved: z.string().min(1),
        automaticEnabled: z.boolean(),
        memoryCorpusVersion: z.string().min(1).max(128).optional()
      })
      .parse(structuredClone(input))
    // Publishing settings never implicitly starts or resumes automation.
    await this.pause()
    this.configuration = config
  }

  bind(input: ConversationBinding): void {
    const binding = ConversationBindingSchema.parse(structuredClone(input))
    const key = conversationKey(binding.identity, binding.conversationId)
    const previous = this.bindings.get(key)
    if (previous && binding.bindingVersion <= previous.bindingVersion)
      throw new Error('binding_version_not_increased')
    this.runEpoch = this.nextRunEpoch()
    this.scheduler.pause()
    for (const [oldKey, old] of this.bindings) {
      if (
        old.identity.tenantId === binding.identity.tenantId &&
        old.identity.accountId === binding.identity.accountId &&
        old.identity.platform === binding.identity.platform &&
        !sameIdentity(old.identity, binding.identity)
      ) {
        this.bindings.delete(oldKey)
      }
    }
    this.bindings.set(key, binding)
    if (!this.paused) {
      this.scheduler.resume()
      for (const existingKey of this.bindings.keys()) this.schedule(existingKey)
    }
  }

  /** A stopped observer supplies a fresh, complete binding set on explicit restart. */
  replaceBindings(inputs: ConversationBinding[]): void {
    if (!this.paused) throw new Error('binding_replace_requires_pause')
    if (inputs.length > 100000) throw new Error('too_many_bindings')
    const replacement = new Map<string, ConversationBinding>()
    for (const input of inputs) {
      const binding = ConversationBindingSchema.parse(structuredClone(input))
      const key = conversationKey(binding.identity, binding.conversationId)
      if (replacement.has(key)) throw new Error('duplicate_conversation_binding')
      replacement.set(key, binding)
    }
    this.runEpoch = this.nextRunEpoch()
    this.scheduler.pause()
    this.candidates.clear()
    this.humanTasks.clear()
    this.bindings.clear()
    for (const [key, binding] of replacement) this.bindings.set(key, binding)
  }

  /** Trusted discovery may add conversations without invalidating other customers' tasks. */
  discoverBindings(inputs: ConversationBinding[]): void {
    for (const input of inputs) {
      const binding = ConversationBindingSchema.parse(structuredClone(input))
      const key = conversationKey(binding.identity, binding.conversationId)
      const old = this.bindings.get(key)
      if (old && hashContext(old) === hashContext(binding)) continue
      if (old && binding.bindingVersion <= old.bindingVersion)
        throw new Error('binding_version_not_increased')
      if (this.bindings.size >= 100000 && !old) throw new Error('too_many_bindings')
      const first = this.bindings.values().next().value
      if (first && !sameIdentity(first.identity, binding.identity))
        throw new Error('collection_identity_changed')
      this.collectionPending(binding)
      this.scheduler.cancel(key)
      this.bindings.set(key, binding)
    }
  }
  collectionPending(binding: ConversationBinding): void {
    this.invalidateHumanTasks(binding.identity, binding.conversationId)
    void this.sender.cancelConversation(binding.identity, binding.conversationId)
  }
  /** Invoked only after message/cursor persistence committed successfully. */
  collected(binding: ConversationBinding, messages: ObservedMessage[], complete: boolean): void {
    this.discoverBindings([binding])
    const key = conversationKey(binding.identity, binding.conversationId)
    for (const message of messages) {
      if (
        !sameIdentity(message.identity, binding.identity) ||
        message.conversationId !== binding.conversationId
      )
        throw new Error('unbound_message_identity')
      if (message.direction === 'inbound')
        this.progress({
          stage: 'observed',
          identity: message.identity,
          conversationId: message.conversationId,
          sourceMessageId: message.sourceMessageId
        })
      if (message.direction !== 'automation_outbound') {
        if (message.direction === 'inbound') this.scheduler.interrupt(key)
        else this.scheduler.cancel(key)
        this.collectionPending(binding)
      }
    }
    const snapshot = this.ledger.snapshot(binding.identity, binding.conversationId)
    if (snapshot.hasGap) {
      this.recordHandoff(key, 'message_gap')
      return
    }
    if (snapshot.humanOwned) {
      this.events.onHandoff?.(binding.conversationId, 'human_takeover')
      return
    }
    if (complete && !this.scheduler.pending(key)) this.schedule(key)
  }

  private recordHandoff(key: string, reason: string): void {
    this.scheduler.cancel(key)
    const binding = this.bindings.get(key),
      config = this.configuration
    if (!binding || !config) return
    try {
      this.ledger.setHumanOwned(binding.identity, binding.conversationId, true)
      const snapshot = this.ledger.snapshot(binding.identity, binding.conversationId)
      const pending = snapshot.messages.filter(
        (m) => m.direction === 'inbound' && m.handledBy === null
      )
      if (pending.length) {
        const task = ReplyTaskSchema.parse({
          taskId: randomUUID(),
          identity: binding.identity,
          conversationId: binding.conversationId,
          bindingVersion: binding.bindingVersion,
          conversationRevision: snapshot.revision,
          runEpoch: this.runEpoch,
          inboundRange: { from: pending[0].sequence, to: pending.at(-1)!.sequence },
          contextHash: hashConversationContext(snapshot),
          configVersion: config.configVersion,
          knowledgeVersion: config.knowledgeVersion,
          decisionPolicyVersion: config.decisionPolicyVersion,
          questionSetVersion: config.questionSetVersion,
          createdAt: this.now(),
          expiresAt: this.now() + 60000
        })
        this.ledger.replies.begin(
          task,
          pending.map((m) => m.text),
          this.now()
        )
        this.ledger.replies.update(
          task.identity,
          task.taskId,
          { status: 'needs_human', reasons: [reason] },
          this.now()
        )
      }
      this.events.onHandoff?.(binding.conversationId, reason)
    } catch {
      void this.pause().catch(() => undefined)
      this.events.onStorageFailure?.()
    }
  }

  resume(): void {
    if (!this.configuration) throw new Error('agent_not_configured')
    this.runEpoch = this.nextRunEpoch()
    this.paused = false
    this.scheduler.resume()
    this.sender.resume()
    for (const key of this.bindings.keys()) this.schedule(key)
  }

  async pause(): Promise<{ status: 'acknowledged' | 'pending'; epoch: number }> {
    this.paused = true
    this.scheduler.pause()
    this.candidates.clear()
    this.humanTasks.clear()
    // Close memory gates and abort work before any fallible storage operation.
    const stopped = this.sender.pause()
    try {
      this.runEpoch = this.nextRunEpoch()
      this.ledger.replies.invalidate(this.now())
    } catch (error) {
      await stopped
      throw error
    }
    return stopped
  }

  private nextRunEpoch(): number {
    try {
      return this.ledger.nextRunEpoch()
    } catch {
      throw new RunEpochPersistenceError()
    }
  }

  observe(input: ObservedMessage): void {
    const message = ObservedMessageSchema.parse(structuredClone(input))
    const key = conversationKey(message.identity, message.conversationId)
    const binding = this.bindings.get(key)
    if (!binding || !sameIdentity(binding.identity, message.identity))
      throw new Error('unbound_message_identity')
    const startedAtMs = this.monotonicNow()
    const inserted = this.ledger.observe(message)
    if (inserted.historical) return
    if (!inserted.inserted && !inserted.hasGap) return
    if (inserted.inserted && message.direction === 'inbound')
      this.progress(
        {
          stage: 'observed',
          identity: message.identity,
          conversationId: message.conversationId,
          sourceMessageId: message.sourceMessageId
        },
        startedAtMs
      )
    if (message.direction === 'inbound' || message.direction === 'human_outbound') {
      this.invalidateHumanTasks(message.identity, message.conversationId)
      void this.sender.cancelConversation(message.identity, message.conversationId)
    }
    if (message.direction === 'human_outbound') {
      this.scheduler.cancel(key)
      void this.sender.cancelConversation(message.identity, message.conversationId)
      this.events.onHandoff?.(message.conversationId, 'human_takeover')
      return
    }
    if (inserted.hasGap || message.kind !== 'text') {
      this.scheduler.cancel(key)
      this.events.onHandoff?.(
        message.conversationId,
        inserted.hasGap ? 'message_gap' : 'unsupported_message'
      )
      return
    }
    this.schedule(key)
  }

  takeOver(binding: ConversationBinding): void {
    this.invalidateHumanTasks(binding.identity, binding.conversationId)
    const key = conversationKey(binding.identity, binding.conversationId)
    this.scheduler.cancel(key)
    void this.sender.cancelConversation(binding.identity, binding.conversationId)
    try {
      this.ledger.setHumanOwned(binding.identity, binding.conversationId, true)
    } catch (error) {
      void this.pause().catch(() => undefined)
      throw error
    }
  }

  releaseToAutomation(binding: ConversationBinding): void {
    const key = conversationKey(binding.identity, binding.conversationId)
    if (
      !this.sender.conversationQuiescent(binding.identity, binding.conversationId) ||
      this.ledger.hasUnknown(binding.identity, binding.conversationId)
    )
      throw new Error('execution_pending')
    this.ledger.setHumanOwned(binding.identity, binding.conversationId, false)
    this.invalidateHumanTasks(binding.identity, binding.conversationId)
    this.schedule(key)
  }
  currentBinding(conversationId: string): ConversationBinding | undefined {
    const binding = [...this.bindings.values()].find(
      (binding) => binding.conversationId === conversationId
    )
    return binding ? structuredClone(binding) : undefined
  }
  skipTask(task: ReplyTask): boolean {
    const key = conversationKey(task.identity, task.conversationId)
    const binding = this.bindings.get(key)
    if (
      !binding ||
      !sameIdentity(binding.identity, task.identity) ||
      !this.ledger.skipReply(task, this.now())
    )
      return false
    this.scheduler.cancel(key)
    this.candidates.delete(task.taskId)
    this.schedule(key)
    return true
  }

  matchesCurrentTask(task: ReplyTask): boolean {
    const configuration = this.configuration
    const binding = this.bindings.get(conversationKey(task.identity, task.conversationId))
    if (configuration && !sameMemoryCorpus(task, configuration)) return false
    return (
      !this.paused &&
      Boolean(configuration?.automaticEnabled) &&
      task.runEpoch === this.runEpoch &&
      this.now() < task.expiresAt &&
      Boolean(
        binding?.identityVerified &&
        sameIdentity(binding.identity, task.identity) &&
        binding.bindingVersion === task.bindingVersion
      ) &&
      ['configVersion', 'knowledgeVersion', 'decisionPolicyVersion', 'questionSetVersion'].every(
        (version) =>
          task[version as keyof ReplyTask] === configuration?.[version as keyof AgentConfiguration]
      )
    )
  }

  /** A fresh task is assembled from trusted local observation after takeover, not UI fields. */
  async prepareEditedReview(
    original: ReplyTask,
    text: string,
    signal = new AbortController().signal
  ): Promise<EditedReviewInput> {
    const config = this.configuration,
      binding = this.bindings.get(conversationKey(original.identity, original.conversationId)),
      old = this.ledger.replies.get(original.identity, original.taskId),
      snapshot = this.ledger.snapshot(original.identity, original.conversationId)
    if (
      !config ||
      this.paused ||
      !this.ledger.collection.ready(original.identity, original.conversationId) ||
      !binding?.identityVerified ||
      !sameIdentity(binding.identity, original.identity) ||
      !old ||
      (!['ready', 'needs_human'].includes(old.status) &&
        !(
          old.edited &&
          old.status === 'obsolete' &&
          snapshot.revision === original.conversationRevision
        )) ||
      !snapshot.humanOwned ||
      snapshot.hasGap ||
      !this.sender.conversationQuiescent(original.identity, original.conversationId) ||
      this.ledger.findTask(original.identity, original.taskId) ||
      this.ledger.hasUnknown(original.identity, original.conversationId) ||
      hashConversationContext(snapshot) !== original.contextHash ||
      (
        [
          'configVersion',
          'knowledgeVersion',
          'decisionPolicyVersion',
          'questionSetVersion'
        ] as const
      ).some((k) => original[k] !== config[k])
    )
      throw new Error('edit_task_unavailable')
    const pending = snapshot.messages.filter(
      (m) => m.direction === 'inbound' && m.handledBy === null
    )
    if (
      !pending.length ||
      pending.some((m) => m.kind !== 'text' || !m.identityVerified || !m.messageIdVerified) ||
      pending[0].sequence !== original.inboundRange.from ||
      pending.at(-1)!.sequence !== original.inboundRange.to
    )
      throw new Error('edit_task_unavailable')
    const now = this.now()
    const request = parseEditedReviewInput({
      generation: {
        task: {
          ...stripLearningBinding(original),
          taskId: randomUUID(),
          bindingVersion: binding.bindingVersion,
          conversationRevision: snapshot.revision,
          runEpoch: this.runEpoch,
          createdAt: now,
          expiresAt: now + 60000
        },
        context: selectConversationContext(snapshot),
        inbound: pending.map((m) => m.text)
      },
      edit: {
        text,
        draftRevision: Math.max(2, (old.draft?.draftRevision ?? 0) + 1),
        evidenceIds: old.draft?.evidenceIds ?? []
      }
    })
    if (this.reply.prepare) {
      try {
        const originalTask = request.generation.task
        const prepared = await this.reply.prepare(
          structuredClone(originalTask),
          request.generation.inbound,
          () => this.editedReviewCurrent(originalTask, true),
          signal,
          request.generation.context
        )
        if (prepared.memoryCorpusVersion === undefined) {
          if (
            hashContext(ReplyTaskSchema.parse(prepared)) !== hashContext(originalTask) ||
            config.memoryCorpusVersion !== undefined
          )
            throw new Error('prepared_task_binding_missing')
          request.generation.task = ReplyTaskSchema.parse(prepared)
        } else request.generation.task = parsePreparedGenerationTask(prepared, originalTask)
      } catch {
        // Preparation touches the remote service only; its failure is not local ledger corruption.
        throw new Error('edit_task_unavailable')
      }
    }
    const task = request.generation.task
    if (
      !this.editedReviewCurrent(task) ||
      hashContext(this.ledger.replies.get(original.identity, original.taskId)) !== hashContext(old)
    )
      throw new Error('edit_task_unavailable')
    this.ledger.replies.begin(task, request.generation.inbound, now)
    this.ledger.replies.update(
      task.identity,
      task.taskId,
      {
        status: 'needs_human',
        edited: true,
        reasons: ['edited_review_pending'],
        draft: {
          taskId: task.taskId,
          draftRevision: request.edit.draftRevision,
          draftHash: hashDraft(request.edit.text),
          text: request.edit.text,
          action: 'reply',
          evidenceIds: request.edit.evidenceIds
        }
      },
      now
    )
    this.ledger.replies.update(original.identity, original.taskId, { status: 'obsolete' }, now)
    return request
  }

  editedReviewCurrent(task: ReplyTask, preparing = false): boolean {
    const configuration = this.configuration,
      binding = this.bindings.get(conversationKey(task.identity, task.conversationId)),
      snapshot = this.ledger.snapshot(task.identity, task.conversationId)
    if (!preparing && configuration && !sameMemoryCorpus(task, configuration)) return false
    return (
      !this.paused &&
      !!configuration &&
      task.runEpoch === this.runEpoch &&
      this.now() < task.expiresAt &&
      !!binding?.identityVerified &&
      sameIdentity(binding.identity, task.identity) &&
      binding.bindingVersion === task.bindingVersion &&
      snapshot.humanOwned &&
      !snapshot.hasGap &&
      snapshot.revision === task.conversationRevision &&
      hashConversationContext(snapshot) === task.contextHash &&
      !this.ledger.hasUnknown(task.identity, task.conversationId) &&
      this.sender.conversationQuiescent(task.identity, task.conversationId) &&
      (
        [
          'configVersion',
          'knowledgeVersion',
          'decisionPolicyVersion',
          'questionSetVersion'
        ] as const
      ).every((k) => task[k] === configuration[k])
    )
  }

  private invalidateHumanTasks(identity: Identity, conversationId: string): void {
    for (const [id, entry] of this.humanTasks)
      if (
        entry.task.conversationId === conversationId &&
        entry.task.identity.tenantId === identity.tenantId &&
        entry.task.identity.accountId === identity.accountId &&
        entry.task.identity.platform === identity.platform
      )
        this.humanTasks.delete(id)
  }

  prepareHumanSend(original: ReplyTask): {
    task: ReplyTask
    draft: ReplyDraft
    confirmation: HumanConfirmation
  } {
    const config = this.configuration,
      old = this.ledger.replies.get(original.identity, original.taskId),
      binding = this.bindings.get(conversationKey(original.identity, original.conversationId)),
      snapshot = this.ledger.snapshot(original.identity, original.conversationId)
    if (
      !config ||
      this.paused ||
      !old?.draft ||
      !sameMemoryCorpus(original, config) ||
      !this.ledger.collection.ready(original.identity, original.conversationId) ||
      old.assessmentComplete !== true ||
      !['ready', 'needs_human'].includes(old.status) ||
      !binding?.identityVerified ||
      !sameIdentity(binding.identity, original.identity) ||
      !snapshot.humanOwned ||
      snapshot.hasGap ||
      hashConversationContext(snapshot) !== original.contextHash ||
      !this.sender.conversationQuiescent(original.identity, original.conversationId) ||
      this.ledger.findTask(original.identity, original.taskId) ||
      this.ledger.hasUnknown(original.identity, original.conversationId) ||
      (
        [
          'configVersion',
          'knowledgeVersion',
          'decisionPolicyVersion',
          'questionSetVersion'
        ] as const
      ).some((k) => original[k] !== config[k])
    )
      throw new Error('human_task_unavailable')
    const pending = snapshot.messages.filter(
      (m) => m.direction === 'inbound' && m.handledBy === null
    )
    if (
      !pending.length ||
      pending.some((m) => m.kind !== 'text' || !m.identityVerified || !m.messageIdVerified) ||
      pending[0].sequence !== original.inboundRange.from ||
      pending.at(-1)!.sequence !== original.inboundRange.to
    )
      throw new Error('human_task_unavailable')
    const now = this.now()
    const task = ReplyTaskSchema.parse({
      ...original,
      taskId: randomUUID(),
      bindingVersion: binding.bindingVersion,
      conversationRevision: snapshot.revision,
      runEpoch: this.runEpoch,
      createdAt: now,
      expiresAt: now + 60000
    })
    const draft = { ...old.draft, taskId: task.taskId }
    const confirmation = HumanConfirmationSchema.parse({
      confirmationId: randomUUID(),
      taskId: task.taskId,
      sourceTaskId: original.taskId,
      taskHash: hashContext(task),
      draftHash: draft.draftHash,
      draftRevision: draft.draftRevision,
      employeeId: task.identity.employeeId,
      modelResolved: config.modelResolved,
      confirmedAt: now,
      expiresAt: now + 5000
    })
    this.ledger.replies.begin(
      task,
      pending.map((m) => m.text),
      now
    )
    this.ledger.replies.update(
      task.identity,
      task.taskId,
      {
        status: 'needs_human',
        draft,
        humanConfirmation: confirmation,
        ...(old.explanation ? { explanation: old.explanation } : {})
      },
      now
    )
    this.ledger.replies.update(original.identity, original.taskId, { status: 'obsolete' }, now)
    this.humanTasks.set(task.taskId, { task, confirmation })
    return { task, draft, confirmation }
  }

  matchesHumanTask(task: ReplyTask, confirmation?: HumanConfirmation): boolean {
    const entry = this.humanTasks.get(task.taskId),
      config = this.configuration,
      binding = this.bindings.get(conversationKey(task.identity, task.conversationId))
    return (
      !!entry &&
      !!confirmation &&
      hashContext(entry.confirmation) === hashContext(confirmation) &&
      !this.paused &&
      !!config &&
      sameMemoryCorpus(task, config) &&
      this.now() < confirmation.expiresAt &&
      this.now() < task.expiresAt &&
      task.runEpoch === this.runEpoch &&
      !!binding?.identityVerified &&
      sameIdentity(binding.identity, task.identity) &&
      binding.bindingVersion === task.bindingVersion &&
      (
        [
          'configVersion',
          'knowledgeVersion',
          'decisionPolicyVersion',
          'questionSetVersion'
        ] as const
      ).every((k) => task[k] === config[k])
    )
  }

  async sendHumanConfirmed(prepared: {
    task: ReplyTask
    draft: ReplyDraft
    confirmation: HumanConfirmation
  }): Promise<SenderResult> {
    try {
      const result = await this.sender.sendHumanConfirmed(
        prepared.task,
        prepared.draft,
        prepared.confirmation
      )
      this.events.onSend?.(result)
      this.ledger.replies.update(
        prepared.task.identity,
        prepared.task.taskId,
        {
          status:
            result.status === 'rejected'
              ? 'not_sent'
              : result.record.status === 'confirmed'
                ? 'sent'
                : result.record.status === 'unknown'
                  ? 'unknown'
                  : 'not_sent'
        },
        this.now()
      )
      return result
    } finally {
      this.humanTasks.delete(prepared.task.taskId)
    }
  }

  private schedule(key: string): void {
    const binding = this.bindings.get(key)
    if (
      !binding ||
      this.paused ||
      !this.configuration ||
      !this.ledger.collection.ready(binding.identity, binding.conversationId)
    )
      return
    if (
      this.ledger.replies.hasAssessment(
        binding.identity,
        binding.conversationId,
        this.ledger.conversationState(binding.identity, binding.conversationId).revision,
        this.configuration
      )
    )
      return
    if (this.ledger.snapshot(binding.identity, binding.conversationId).humanOwned) return
    if (
      !this.ledger
        .snapshot(binding.identity, binding.conversationId)
        .messages.some((message) => message.direction === 'inbound' && message.handledBy === null)
    )
      return
    this.scheduler.submit(
      key,
      async (job) => {
        const config = this.configuration!
        const snapshot = this.ledger.snapshot(binding.identity, binding.conversationId)
        const pending = snapshot.messages.filter(
          (message) => message.direction === 'inbound' && message.handledBy === null
        )
        if (
          snapshot.hasGap ||
          !binding.identityVerified ||
          pending.length === 0 ||
          pending.some(
            (message) =>
              message.kind !== 'text' || !message.identityVerified || !message.messageIdVerified
          )
        ) {
          throw new Error('conversation_unavailable')
        }
        const context = selectConversationContext(snapshot)
        if (
          pending.length > 30 ||
          pending.some(
            (message) => !context.some((m) => m.sourceMessageId === message.sourceMessageId)
          )
        )
          throw new Error('pending_context_incomplete')
        const epoch = this.runEpoch
        let task: ReplyTask = ReplyTaskSchema.parse({
          taskId: randomUUID(),
          identity: binding.identity,
          conversationId: binding.conversationId,
          bindingVersion: binding.bindingVersion,
          conversationRevision: snapshot.revision,
          runEpoch: epoch,
          inboundRange: { from: pending[0].sequence, to: pending[pending.length - 1].sequence },
          contextHash: hashConversationContext(snapshot),
          configVersion: config.configVersion,
          knowledgeVersion: config.knowledgeVersion,
          decisionPolicyVersion: config.decisionPolicyVersion,
          questionSetVersion: config.questionSetVersion,
          createdAt: this.now(),
          expiresAt: this.now() + 60000
        })
        this.progress({ stage: 'generation_started', task })
        const isCurrent = (): boolean =>
          job.isCurrent() &&
          !this.paused &&
          this.runEpoch === epoch &&
          !this.ledger.snapshot(binding.identity, binding.conversationId).humanOwned &&
          this.bindings.get(key) === binding &&
          this.now() < task.expiresAt &&
          this.ledger.snapshot(binding.identity, binding.conversationId).revision ===
            task.conversationRevision
        if (this.reply.prepare) {
          const prepared = await this.reply.prepare(
            structuredClone(task),
            pending.map((message) => message.text),
            isCurrent,
            job.signal,
            context
          )
          if (prepared.memoryCorpusVersion === undefined) {
            if (
              hashContext(ReplyTaskSchema.parse(prepared)) !== hashContext(task) ||
              config.memoryCorpusVersion !== undefined
            )
              throw new Error('prepared_task_binding_missing')
          } else task = parsePreparedGenerationTask(prepared, task)
          if (
            !isCurrent() ||
            (task.memoryCorpusVersion ?? EMPTY_ENTERPRISE_MEMORY_VERSION) !==
              (config.memoryCorpusVersion ?? EMPTY_ENTERPRISE_MEMORY_VERSION)
          )
            throw new Error('reply_task_obsolete')
          this.progress({ stage: 'prepared', task })
        }
        const expectedTaskHash = hashContext(task)
        this.ledger.replies.begin(
          task,
          pending.map((message) => message.text),
          this.now()
        )
        let result: ReplyCandidate
        try {
          result = await this.reply.generate(
            structuredClone(task),
            pending.map((message) => message.text),
            isCurrent,
            job.signal,
            context
          )
          // Invalid output must finish the timing attempt as failed, never as a completed candidate.
          if (hashContext(ReplyTaskSchema.parse(result.task)) !== expectedTaskHash)
            throw new Error('reply_task_changed')
        } catch (error) {
          this.ledger.replies.update(
            task.identity,
            task.taskId,
            { status: job.isCurrent() ? 'needs_human' : 'obsolete' },
            this.now()
          )
          this.progress({ stage: job.isCurrent() ? 'generation_failed' : 'obsolete', task })
          throw error
        }
        this.progress({ stage: 'generation_completed', task })
        if (!isCurrent()) {
          this.ledger.replies.update(task.identity, task.taskId, { status: 'obsolete' }, this.now())
          this.progress({ stage: 'obsolete', task })
        }
        return structuredClone(result)
      },
      async (candidate, job) => {
        await this.waitForCollection(candidate.task, job, binding)
        if (!this.candidateCurrent(candidate.task, job, binding)) {
          this.progress({ stage: 'obsolete', task: candidate.task })
          this.ledger.replies.update(
            candidate.task.identity,
            candidate.task.taskId,
            { status: 'obsolete' },
            this.now()
          )
          return
        }
        this.ledger.replies.update(
          candidate.task.identity,
          candidate.task.taskId,
          {
            assessmentComplete: true,
            reasons: candidate.reasons,
            ...(candidate.explanation ? { explanation: candidate.explanation } : {}),
            status:
              this.configuration?.automaticEnabled &&
              candidate.automaticAllowed &&
              candidate.draft &&
              candidate.review
                ? 'ready'
                : 'needs_human',
            ...(candidate.draft ? { draft: candidate.draft } : {}),
            ...(candidate.review ? { review: candidate.review } : {})
          },
          this.now()
        )
        this.candidates.set(candidate.task.taskId, candidate)
        this.progress({ stage: 'candidate_ready', task: candidate.task })
        this.events.onCandidate?.(structuredClone(candidate))
        try {
          if (
            this.configuration?.automaticEnabled &&
            candidate.automaticAllowed &&
            candidate.draft &&
            candidate.review &&
            job.isCurrent()
          ) {
            let result: SenderResult
            for (;;) {
              await this.waitForCollection(candidate.task, job, binding)
              if (!this.candidateCurrent(candidate.task, job, binding)) {
                this.ledger.replies.update(
                  candidate.task.identity,
                  candidate.task.taskId,
                  { status: 'obsolete' },
                  this.now()
                )
                return
              }
              const collectionRevision = this.ledger.collection.request(
                candidate.task.identity,
                candidate.task.conversationId
              )?.revision
              this.progress({ stage: 'send_started', task: candidate.task })
              result = await this.sender.sendAutomatic(
                candidate.task,
                candidate.draft,
                candidate.review
              )
              // Only retry a pre-action rejection caused by temporary collection.
              // Any durable execution (including not_sent or unknown) is never replayed.
              if (
                !(
                  result.status === 'rejected' &&
                  ['paused_or_obsolete_run', 'identity_or_messages_uncertain'].includes(
                    result.reason
                  ) &&
                  (!this.ledger.collection.ready(
                    candidate.task.identity,
                    candidate.task.conversationId
                  ) ||
                    collectionRevision !==
                      this.ledger.collection.request(
                        candidate.task.identity,
                        candidate.task.conversationId
                      )?.revision) &&
                  this.candidateCurrent(candidate.task, job, binding) &&
                  !this.ledger.findTask(candidate.task.identity, candidate.task.taskId)
                )
              )
                break
            }
            this.progress({
              stage: 'send_finished',
              task: candidate.task,
              outcome:
                result.status === 'rejected'
                  ? 'rejected'
                  : result.status === 'duplicate'
                    ? 'duplicate'
                    : result.record.status
            })
            this.events.onSend?.(result)
            this.ledger.replies.update(
              candidate.task.identity,
              candidate.task.taskId,
              {
                status:
                  result.status === 'rejected'
                    ? 'not_sent'
                    : result.record.status === 'confirmed'
                      ? 'sent'
                      : result.record.status === 'unknown'
                        ? 'unknown'
                        : 'not_sent'
              },
              this.now()
            )
            if (result.status === 'recorded' && result.record.status === 'confirmed')
              this.schedule(key)
            if (result.status === 'recorded' && result.record.status === 'unknown')
              this.events.onHandoff?.(candidate.task.conversationId, 'delivery_unknown')
          }
        } finally {
          this.candidates.delete(candidate.task.taskId)
        }
      }
    )
  }

  private candidateCurrent(
    task: ReplyTask,
    job: JobContext,
    binding: ConversationBinding
  ): boolean {
    const snapshot = this.ledger.snapshot(task.identity, task.conversationId)
    return (
      job.isCurrent() &&
      !this.paused &&
      this.now() < task.expiresAt &&
      task.runEpoch === this.runEpoch &&
      this.bindings.get(conversationKey(task.identity, task.conversationId)) === binding &&
      !snapshot.hasGap &&
      !snapshot.humanOwned &&
      snapshot.revision === task.conversationRevision
    )
  }

  private async waitForCollection(
    task: ReplyTask,
    job: JobContext,
    binding: ConversationBinding
  ): Promise<void> {
    while (
      this.candidateCurrent(task, job, binding) &&
      !this.ledger.collection.ready(task.identity, task.conversationId)
    ) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          job.signal.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, 50)
        job.signal.addEventListener('abort', done, { once: true })
        if (job.signal.aborted) done()
      })
    }
    if (job.isCurrent() && this.now() >= task.expiresAt) throw new Error('collection_wait_expired')
  }
}
