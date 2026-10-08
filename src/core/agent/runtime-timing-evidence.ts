import { z } from 'zod'
import {
  Hash,
  Id,
  IdentitySchema,
  ConversationBindingSchema
} from '../../shared/contracts/identity'
import { ReplyTaskSchema, type ReplyTask } from '../../shared/contracts/task'
import { hashContext } from '../reply/hashes'
import type {
  RuntimePresentationReceipt,
  RuntimeTimingEvent,
  RuntimeTimingSource
} from './runtime-timing'
import type {
  PrivateRuntimeTimingJournal,
  TimingJournalHealth
} from '../persistence/runtime-timing-journal'

const at = z.number().finite().nonnegative()
const source = z.strictObject({
  sourceMessageId: Id,
  sequence: z.number().int().positive().safe(),
  verified: z.boolean()
})
const taskStage = z.enum([
  'generation_started',
  'prepared',
  'generation_completed',
  'generation_failed',
  'candidate_ready',
  'obsolete',
  'send_started',
  'send_finished'
])
const EventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    runtimeInstanceId: z.uuid(),
    kind: z.literal('collection'),
    event: z.strictObject({
      stage: z.enum([
        'read_started',
        'read_completed',
        'read_failed',
        'read_cancelled',
        'read_stale'
      ]),
      readId: z.uuid(),
      binding: ConversationBindingSchema.transform((binding) => ({
        identity: binding.identity,
        conversationId: binding.conversationId,
        bindingVersion: binding.bindingVersion,
        identityVerified: binding.identityVerified
      })),
      startedAtMs: at,
      atMs: at,
      sourceMessageIds: z.array(Id).max(1000),
      complete: z.boolean()
    })
  }),
  z.strictObject({
    runtimeInstanceId: z.uuid(),
    kind: z.literal('agent'),
    event: z.union([
      z.strictObject({
        stage: z.literal('observed'),
        identity: IdentitySchema,
        conversationId: Id,
        sourceMessageId: Id,
        atMs: at
      }),
      z.strictObject({
        stage: taskStage,
        task: ReplyTaskSchema,
        atMs: at,
        outcome: z
          .enum([
            'prepared',
            'dispatching',
            'confirmed',
            'unknown',
            'cancelled',
            'rejected',
            'duplicate'
          ])
          .optional()
      })
    ]),
    sources: z.array(source).max(1000).optional(),
    modelResolved: Id.optional()
  }),
  z.strictObject({
    runtimeInstanceId: z.uuid(),
    kind: z.literal('presentation'),
    event: z.strictObject({
      task: ReplyTaskSchema,
      rowVersion: Hash,
      receiptId: z.uuid(),
      webContentsId: z.number().int().positive(),
      atMs: at
    })
  })
])
const BindingSchema = z.strictObject({
  batchId: Id,
  assignmentId: z.uuid(),
  caseId: Id,
  arm: z.enum(['none', 'baseline', 'learned']),
  expectedTaskHash: Hash,
  sharedConfigurationHash: Hash,
  memoryManifestHash: Hash,
  policyVersion: Id,
  retrievalVersion: Id,
  modelVersion: Id,
  knowledgeVersion: Id,
  modelResolved: Id
})
// Stored collection records have already had private adapter proofs removed.
const StoredCollection = EventSchema.options[0].extend({
  event: EventSchema.options[0].shape.event.extend({
    binding: ConversationBindingSchema.pick({
      identity: true,
      conversationId: true,
      bindingVersion: true,
      identityVerified: true
    })
  })
})
export const TimingJournalRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('event'),
    value: z.discriminatedUnion('kind', [
      StoredCollection,
      EventSchema.options[1],
      EventSchema.options[2]
    ])
  }),
  z.strictObject({ kind: z.literal('binding'), task: ReplyTaskSchema, binding: BindingSchema })
])
export type HostRuntimeEvaluationBinding = z.infer<typeof BindingSchema>
interface ReadEvidence {
  readId: string
  scopeHash: string
  startedAtMs: number
  atMs: number
  state: string
  sourceMessageIds: string[]
  complete: boolean
}
interface TaskEvidence {
  task: ReplyTask
  sources?: RuntimeTimingSource[]
  modelResolved?: string
  generationAtMs?: number
  generationCompletedAtMs?: number
  candidateAtMs?: number
  sendStartedAtMs?: number
  confirmedSentAtMs?: number
  presentation?: RuntimePresentationReceipt
  obsoleteAtMs?: number
  binding?: HostRuntimeEvaluationBinding
  reasons: Set<string>
}
export interface RuntimeTimingObservation {
  task: ReplyTask
  sources: RuntimeTimingSource[]
  modelResolved: string | null
  binding: HostRuntimeEvaluationBinding | null
  presentation: Omit<RuntimePresentationReceipt, 'task'> | null
  readIds: string[]
  startedAtMs: number | null
  generationAtMs: number | null
  candidateAtMs: number | null
  endedAtMs: number | null
  latencyMs: number | null
  latencyComplete: boolean
  status: 'captured' | 'insufficient'
  reasons: string[]
}
export interface RuntimeTimingEvidenceReport {
  schema: 'autoreply-runtime-timing-evidence-v1'
  runtimeInstanceId: string | null
  sessionId: string
  endpoint: 'reviewable' | 'confirmed_sent'
  events: number
  status: 'captured' | 'insufficient'
  reasons: string[]
  health: TimingJournalHealth
  reads: ReadEvidence[]
  tasks: RuntimeTimingObservation[]
  businessVerified: false
}
type Journal = Pick<
  PrivateRuntimeTimingJournal,
  'offer' | 'health' | 'sessionId' | 'close' | 'export'
>
const scopeHash = (
  identity: ReplyTask['identity'],
  conversationId: string,
  bindingVersion: number
): string => hashContext({ identity, conversationId, bindingVersion })
const key = (task: ReplyTask): string =>
  hashContext({ identity: task.identity, taskId: task.taskId })
const stableTask = (task: ReplyTask): string =>
  hashContext({
    ...task,
    contextHash: undefined,
    memorySnapshotHash: undefined,
    learningContextVersion: undefined,
    memoryCorpusVersion: undefined
  })

/** Trusted host input only. Captures evidence; cannot authorize a reply, learning or a send. */
export class RuntimeTimingEvidence {
  private runtimeInstanceId?: string
  private lastAt = -1
  private readonly reads = new Map<string, ReadEvidence>()
  private readonly sources = new Map<string, ReadEvidence>()
  private readonly tasks = new Map<string, TaskEvidence>()
  private readonly reasons = new Set<string>()
  private events = 0
  constructor(private readonly journal: Journal) {}
  record(raw: RuntimeTimingEvent): void {
    try {
      const parsed = EventSchema.safeParse(raw)
      if (!parsed.success) {
        this.reasons.add('invalid_timing_event')
        return
      }
      this.recordEvent(parsed.data)
    } catch {
      this.reasons.add('timing_listener_failed')
    }
  }
  /** Replay only the original stored schema; redacted adapter proofs stay redacted. */
  recordStored(raw: unknown): void {
    try {
      const parsed = TimingJournalRecordSchema.safeParse(raw)
      if (!parsed.success) {
        this.reasons.add('invalid_timing_event')
        return
      }
      if (parsed.data.kind === 'binding') this.bind(parsed.data.task, parsed.data.binding)
      else this.recordEvent(parsed.data.value)
    } catch {
      this.reasons.add('timing_listener_failed')
    }
  }
  private recordEvent(value: z.infer<typeof EventSchema>): void {
    if (this.runtimeInstanceId && this.runtimeInstanceId !== value.runtimeInstanceId) {
      this.reasons.add('mixed_runtime_instances')
      return
    }
    this.runtimeInstanceId = value.runtimeInstanceId
    if (value.event.atMs < this.lastAt) {
      this.reasons.add('nonmonotonic_event')
      return
    }
    this.lastAt = value.event.atMs
    if (!this.journal.offer({ kind: 'event', value })) {
      this.reasons.add('journal_incomplete')
      return
    }
    this.events++
    if (value.kind === 'collection') {
      const event = value.event,
        scoped = scopeHash(
          event.binding.identity,
          event.binding.conversationId,
          event.binding.bindingVersion
        )
      const previous = this.reads.get(event.readId)
      if (event.stage === 'read_started') {
        if (previous || event.startedAtMs !== event.atMs || event.sourceMessageIds.length) {
          this.reasons.add('read_start_conflict')
          return
        }
        if (this.reads.size >= 1024) {
          this.reasons.add('evidence_capacity_exceeded')
          return
        }
        this.reads.set(event.readId, {
          readId: event.readId,
          scopeHash: scoped,
          startedAtMs: event.startedAtMs,
          atMs: event.atMs,
          state: event.stage,
          sourceMessageIds: [],
          complete: false
        })
        return
      }
      if (!previous) {
        this.reasons.add('missing_read_start')
        return
      }
      if (
        previous.scopeHash !== scoped ||
        previous.startedAtMs !== event.startedAtMs ||
        previous.state !== 'read_started' ||
        event.atMs < event.startedAtMs
      ) {
        this.reasons.add('read_receipt_conflict')
        return
      }
      previous.state = event.stage
      previous.atMs = event.atMs
      previous.complete = event.complete
      previous.sourceMessageIds = [...event.sourceMessageIds]
      if (!event.binding.identityVerified) {
        previous.state = 'identity_unverified'
        return
      }
      if (event.stage === 'read_completed')
        for (const id of new Set(event.sourceMessageIds)) {
          const idKey = hashContext({ scope: scoped, id })
          if (!this.sources.has(idKey)) {
            if (this.sources.size >= 8192) {
              this.reasons.add('evidence_capacity_exceeded')
              return
            }
            this.sources.set(idKey, previous)
          }
        }
      return
    }
    if (value.kind === 'presentation') {
      const event = value.event,
        current = this.tasks.get(key(event.task))
      if (!current) {
        this.reasons.add('unbound_presentation')
        return
      }
      if (
        hashContext(current.task) !== hashContext(event.task) ||
        current.candidateAtMs === undefined ||
        current.generationCompletedAtMs === undefined ||
        event.atMs < current.candidateAtMs ||
        current.obsoleteAtMs !== undefined
      ) {
        current.reasons.add('invalid_presentation')
        return
      }
      // Repeated background snapshots must never move the first displayed endpoint.
      current.presentation ??= structuredClone(event)
      return
    }
    const event = value.event
    if (!('task' in event)) return
    const id = key(event.task)
    let current = this.tasks.get(id)
    if (!current) {
      if (this.tasks.size >= 1000) {
        this.reasons.add('evidence_capacity_exceeded')
        return
      }
      current = { task: event.task, reasons: new Set() }
      this.tasks.set(id, current)
    }
    if (stableTask(current.task) !== stableTask(event.task))
      current.reasons.add('task_versions_changed')
    if (current.binding && current.binding.expectedTaskHash !== hashContext(event.task))
      current.reasons.add('frozen_task_changed')
    current.task = event.task
    if (value.sources) {
      if (current.sources && hashContext(current.sources) !== hashContext(value.sources))
        current.reasons.add('source_range_changed')
      current.sources = value.sources
    }
    if (value.modelResolved) {
      if (current.modelResolved && current.modelResolved !== value.modelResolved)
        current.reasons.add('model_changed')
      current.modelResolved = value.modelResolved
    }
    if (event.stage === 'generation_started') {
      if (current.generationAtMs !== undefined) current.reasons.add('duplicate_generation_start')
      current.generationAtMs = event.atMs
    }
    if (event.stage === 'candidate_ready') current.candidateAtMs = event.atMs
    if (event.stage === 'generation_completed') current.generationCompletedAtMs = event.atMs
    if (event.stage === 'send_started') current.sendStartedAtMs = event.atMs
    if (event.stage === 'send_finished') {
      if (event.outcome === 'confirmed') current.confirmedSentAtMs = event.atMs
      else current.reasons.add('send_not_confirmed')
    }
    if (event.stage === 'generation_failed' || event.stage === 'obsolete')
      current.reasons.add(event.stage)
    if (event.stage === 'obsolete') current.obsoleteAtMs ??= event.atMs
  }
  hasUnpresentedCandidate(task: ReplyTask): boolean {
    const current = this.tasks.get(key(task))
    return Boolean(
      current &&
      hashContext(current.task) === hashContext(task) &&
      current.candidateAtMs !== undefined &&
      current.generationCompletedAtMs !== undefined &&
      !current.presentation &&
      current.obsoleteAtMs === undefined
    )
  }
  bind(task: ReplyTask, raw: HostRuntimeEvaluationBinding): void {
    const binding = BindingSchema.parse(raw),
      current = this.tasks.get(key(task))
    if (
      !current ||
      hashContext(task) !== hashContext(current.task) ||
      binding.expectedTaskHash !== hashContext(task)
    )
      throw new Error('runtime_evaluation_binding_conflict')
    if (current.binding && hashContext(current.binding) !== hashContext(binding))
      throw new Error('runtime_evaluation_binding_conflict')
    current.binding = structuredClone(binding)
    try {
      if (!this.journal.offer({ kind: 'binding', task, binding }))
        this.reasons.add('journal_incomplete')
    } catch {
      this.reasons.add('journal_incomplete')
      throw new Error('runtime_evaluation_binding_unavailable')
    }
  }
  snapshot(endpoint: 'reviewable' | 'confirmed_sent' = 'reviewable'): RuntimeTimingEvidenceReport {
    const health = this.journal.health(),
      global = new Set(this.reasons)
    if (health.reason || health.dropped || health.pending) global.add('journal_incomplete')
    if (!this.tasks.size) global.add('no_foreground_tasks')
    if ([...this.reads.values()].some((read) => read.state === 'read_started'))
      global.add('unfinished_reads')
    if (
      [...this.reads.values()].some(
        (read) => !['read_started', 'read_completed'].includes(read.state)
      )
    )
      global.add('collection_attempts_incomplete')
    const tasks = [...this.tasks.values()].map((item): RuntimeTimingObservation => {
      const reasons = new Set(item.reasons),
        task = item.task,
        scoped = scopeHash(task.identity, task.conversationId, task.bindingVersion)
      const refs = item.sources ?? [],
        matched = refs.map((ref) =>
          this.sources.get(hashContext({ scope: scoped, id: ref.sourceMessageId }))
        )
      if (
        !refs.length ||
        refs[0]?.sequence !== task.inboundRange.from ||
        refs.at(-1)?.sequence !== task.inboundRange.to ||
        new Set(refs.map((ref) => ref.sourceMessageId)).size !== refs.length ||
        refs.some(
          (ref, index) => !ref.verified || (index > 0 && ref.sequence <= refs[index - 1].sequence)
        )
      )
        reasons.add('source_range_unverified')
      if (
        matched.some(
          (read) =>
            !read ||
            read.state !== 'read_completed' ||
            item.generationAtMs === undefined ||
            read.atMs > item.generationAtMs
        )
      )
        reasons.add('missing_trusted_read')
      const actual = matched.filter((read): read is ReadEvidence => Boolean(read))
      const startedAtMs =
        actual.length === refs.length && actual.length
          ? Math.min(...actual.map((read) => read.startedAtMs))
          : null
      if (item.generationAtMs === undefined) reasons.add('missing_generation_start')
      if (item.generationCompletedAtMs === undefined) reasons.add('missing_generation_completion')
      if (item.candidateAtMs === undefined) reasons.add('missing_candidate')
      if (
        item.generationAtMs !== undefined &&
        item.generationCompletedAtMs !== undefined &&
        item.candidateAtMs !== undefined &&
        !(
          item.generationAtMs <= item.generationCompletedAtMs &&
          item.generationCompletedAtMs <= item.candidateAtMs
        )
      )
        reasons.add('invalid_stage_order')
      if (
        !actual.some((read) => read.complete) &&
        ![...this.reads.values()].some(
          (read) =>
            read.scopeHash === scoped &&
            read.complete &&
            read.atMs <= (item.generationAtMs ?? -1) &&
            read.atMs >= Math.max(0, ...actual.map((value) => value.atMs))
        )
      )
        reasons.add('incomplete_collection')
      if (!item.binding) reasons.add('missing_frozen_assignment')
      else if (
        item.binding.modelResolved !== item.modelResolved ||
        item.binding.knowledgeVersion !== task.knowledgeVersion
      )
        reasons.add('frozen_configuration_conflict')
      if (!item.modelResolved) reasons.add('missing_model_version')
      // A later shutdown obsoletes the task, not an already completed displayed interval.
      if (
        endpoint === 'reviewable' &&
        item.presentation &&
        item.obsoleteAtMs !== undefined &&
        item.presentation.atMs <= item.obsoleteAtMs
      )
        reasons.delete('obsolete')
      const endedAtMs =
        endpoint === 'confirmed_sent'
          ? (item.confirmedSentAtMs ?? null)
          : (item.presentation?.atMs ?? null)
      if (endpoint === 'confirmed_sent' && item.sendStartedAtMs === undefined)
        reasons.add('missing_send_start')
      if (
        endpoint === 'confirmed_sent' &&
        item.candidateAtMs !== undefined &&
        item.sendStartedAtMs !== undefined &&
        endedAtMs !== null &&
        !(item.candidateAtMs <= item.sendStartedAtMs && item.sendStartedAtMs <= endedAtMs)
      )
        reasons.add('invalid_send_order')
      if (endedAtMs === null)
        reasons.add(
          endpoint === 'confirmed_sent' ? 'missing_confirmed_send' : 'missing_reviewable_endpoint'
        )
      if (startedAtMs !== null && endedAtMs !== null && endedAtMs < startedAtMs)
        reasons.add('negative_duration')
      const complete = reasons.size === 0 && global.size === 0
      return {
        task: structuredClone(task),
        sources: structuredClone(refs),
        modelResolved: item.modelResolved ?? null,
        binding: item.binding ? structuredClone(item.binding) : null,
        presentation: item.presentation
          ? {
              rowVersion: item.presentation.rowVersion,
              receiptId: item.presentation.receiptId,
              webContentsId: item.presentation.webContentsId,
              atMs: item.presentation.atMs
            }
          : null,
        readIds: [...new Set(actual.map((read) => read.readId))],
        startedAtMs,
        generationAtMs: item.generationAtMs ?? null,
        candidateAtMs: item.candidateAtMs ?? null,
        endedAtMs,
        latencyMs:
          complete && startedAtMs !== null && endedAtMs !== null ? endedAtMs - startedAtMs : null,
        latencyComplete: complete,
        status: complete ? 'captured' : 'insufficient',
        reasons: [...reasons].sort()
      }
    })
    return {
      schema: 'autoreply-runtime-timing-evidence-v1',
      runtimeInstanceId: this.runtimeInstanceId ?? null,
      sessionId: this.journal.sessionId,
      endpoint,
      events: this.events,
      status:
        global.size || tasks.some((task) => !task.latencyComplete) ? 'insufficient' : 'captured',
      reasons: [...global].sort(),
      health,
      reads: structuredClone([...this.reads.values()]),
      tasks,
      businessVerified: false
    }
  }
  async export(endpoint: 'reviewable' | 'confirmed_sent' = 'reviewable'): Promise<string> {
    await this.journal.close()
    return this.journal.export(this.snapshot(endpoint))
  }
}
