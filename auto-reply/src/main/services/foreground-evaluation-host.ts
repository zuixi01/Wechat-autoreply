import { randomUUID } from 'node:crypto'
import { mkdir, readdir, lstat, unlink, rmdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { DesktopAgentRuntime, type RuntimePlatform } from './desktop-agent-runtime'
import type { AgentRegistration } from './agent-registration'
import { Ledger } from '../../core/persistence/ledger'
import {
  protectPrivateDirectory,
  verifyPrivatePaths
} from '../../core/persistence/private-backup-directory'
import { PrivateRuntimeTimingVault } from '../../core/persistence/runtime-timing-vault'
import type { PrivateRuntimeTimingJournal } from '../../core/persistence/runtime-timing-journal'
import type {
  RuntimeTimingEvidenceReport,
  RuntimeTimingObservation
} from '../../core/agent/runtime-timing-evidence'
import type { RuntimeTimingEvent } from '../../core/agent/runtime-timing'
import { parseGenerationInput, parseGenerationResult } from '../../core/reply/generation-validation'
import { hashContext } from '../../core/reply/hashes'
import {
  AgentConfigurationSchema,
  type GenerationInput,
  type GenerationResult
} from '../../shared/contracts/generation'
import { DeviceScopeSchema } from '../../shared/contracts/registration'
import { RuntimeStatusSchema, type RuntimeStatus } from '../../shared/contracts/runtime'
import {
  ForegroundEvaluationAssignmentSchema,
  type ForegroundEvaluationAssignment
} from '../../shared/contracts/foreground-evaluation'
import type { PipelineResult } from '../../../server/src/reply/jev-pipeline'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: Error): void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  // Some arms are cancelled before generation reaches the response rendezvous.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
async function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('evaluation_cancelled')
  let abort!: () => void
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('evaluation_cancelled'))
        signal.addEventListener('abort', abort, { once: true })
      })
    ])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
const denied = async (): Promise<never> => {
  throw new Error('evaluation_read_only_required')
}
const basisKey = ({
  runId,
  scope,
  assignment,
  frozen,
  item
}: ForegroundEvaluationAssignment): string =>
  hashContext({ runId, scope, assignment, frozen, item })
interface ActiveArm {
  assignment: ForegroundEvaluationAssignment
  controller: AbortController
  signal: AbortSignal
  timer: ReturnType<typeof setTimeout>
  abort: () => void
  input: Deferred<GenerationInput>
  response: Deferred<GenerationResult>
  presented: Deferred<void>
  runtime?: DesktopAgentRuntime
  ledger?: Ledger
  directory?: string
  generation?: GenerationInput
  resultDelivered: boolean
  releasing?: Promise<void>
}
export interface ForegroundEvaluationObservation {
  runId: string
  assignmentId: string
  caseId: string
  arm: 'none' | 'baseline' | 'learned'
  executionTaskHash: string
  runtimeInstanceId: string
  observation: RuntimeTimingObservation
}
export interface ForegroundEvaluationHostOptions {
  /** Actual private host path; never accepted through renderer IPC. */
  directory: string
  client: Pick<AgentRegistration, 'status' | 'acquireLease'>
  configuration: z.infer<typeof AgentConfigurationSchema>
  /** Original trusted source adapter. This bridge never attests or fabricates native capabilities. */
  platform(assignment: ForegroundEvaluationAssignment): RuntimePlatform | Promise<RuntimePlatform>
  /** Connect the existing workbench and presentation IPC to currentRuntime(). */
  onRuntime?(runtime: DesktopAgentRuntime | undefined): void | Promise<void>
}

/** Bodyless diagnostics preserve the failed start state before cleanup closes the runtime. */
export class ForegroundEvaluationRuntimeError extends Error {
  readonly runtimeStatus: Pick<RuntimeStatus, 'state' | 'reason' | 'lease'>
  constructor(status: RuntimeStatus) {
    super('evaluation_foreground_runtime_unavailable')
    this.name = 'ForegroundEvaluationRuntimeError'
    this.runtimeStatus = RuntimeStatusSchema.pick({ state: true, reason: true, lease: true }).parse(
      { state: status.state, reason: status.reason, lease: status.lease }
    )
  }
}

/** One private batch session, separate real runtimes, original source.read and workbench endpoints.
 * Bind these two callbacks to the same authenticated EnterpriseMemoryReplayCollector instance.
 * No exported hash, renderer request or parsed assignment authenticates the server by itself. */
export class ForegroundEvaluationHost {
  private active?: ActiveArm
  private idleRuntime?: DesktopAgentRuntime
  private opening?: Promise<void>
  private vault?: PrivateRuntimeTimingVault
  private journal?: PrivateRuntimeTimingJournal
  private terminal = false
  private finished = false
  private revoked = false
  private runId?: string
  private readonly reports: RuntimeTimingEvidenceReport[] = []
  private readonly observations: ForegroundEvaluationObservation[] = []
  private readonly seen = new Set<string>()
  private readonly configuration: z.infer<typeof AgentConfigurationSchema>
  private readonly scope: z.infer<typeof DeviceScopeSchema>
  constructor(private readonly options: ForegroundEvaluationHostOptions) {
    if (!isAbsolute(options.directory)) throw new Error('evaluation_private_directory_required')
    this.configuration = AgentConfigurationSchema.parse(options.configuration)
    this.scope = DeviceScopeSchema.parse(options.client.status().scope)
  }
  currentRuntime(): DesktopAgentRuntime | undefined {
    return this.active?.runtime ?? this.idleRuntime
  }
  private open(): Promise<void> {
    this.opening ??= (async () => {
      try {
        await mkdir(this.options.directory, { mode: 0o700 })
        await protectPrivateDirectory(this.options.directory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      await verifyPrivatePaths(this.options.directory, [])
      this.vault = await PrivateRuntimeTimingVault.open(
        join(this.options.directory, 'timing-vault')
      )
      this.journal = await this.vault.createSession(() => {
        this.revoked = true
        this.active?.controller.abort()
      })
      this.vault.startRetention()
    })()
    return this.opening
  }
  private checkAssignment(raw: unknown): ForegroundEvaluationAssignment {
    const value = ForegroundEvaluationAssignmentSchema.parse(raw)
    const task = value.task
    if (
      this.terminal ||
      this.revoked ||
      hashContext(value.scope) !== hashContext(this.scope) ||
      hashContext(DeviceScopeSchema.parse(this.options.client.status().scope)) !==
        hashContext(this.scope) ||
      value.assignment.caseId !== value.item.caseId ||
      task.conversationId !== value.item.conversationId ||
      task.identity.tenantId !== this.scope.tenant_id ||
      task.identity.employeeId !== this.scope.employee_id ||
      task.identity.accountId !== this.scope.account_id ||
      task.identity.agentId !== this.scope.agent_id ||
      task.identity.platform !== this.scope.platform ||
      task.configVersion !== this.configuration.configVersion ||
      task.knowledgeVersion !== this.configuration.knowledgeVersion ||
      task.decisionPolicyVersion !== this.configuration.decisionPolicyVersion ||
      task.questionSetVersion !== this.configuration.questionSetVersion ||
      value.frozen.knowledgeVersion !== this.configuration.knowledgeVersion ||
      !value.frozen.policyVersion ||
      !value.frozen.retrievalVersion ||
      !value.frozen.noMemoryManifestHash ||
      task.createdAt > Date.now() ||
      task.expiresAt <= Date.now() ||
      (this.runId !== undefined && value.runId !== this.runId)
    )
      throw new Error('evaluation_foreground_assignment_conflict')
    return value
  }
  readonly foregroundTask = async (
    raw: unknown,
    external: AbortSignal
  ): Promise<GenerationInput> => {
    if (this.active || external.aborted) throw new Error('evaluation_foreground_unavailable')
    const assignment = this.checkAssignment(raw)
    if (this.seen.has(assignment.assignment.assignmentId) || this.seen.size >= 6000)
      throw new Error('evaluation_foreground_assignment_conflict')
    const controller = new AbortController(),
      signal = AbortSignal.any([external, controller.signal])
    const arm: ActiveArm = {
      assignment,
      controller,
      signal,
      timer: setTimeout(
        () => controller.abort(),
        Math.min(30000, assignment.task.expiresAt - Date.now())
      ),
      input: deferred(),
      response: deferred(),
      presented: deferred(),
      resultDelivered: false,
      abort: () => {}
    }
    arm.abort = () => {
      const error = new Error('evaluation_cancelled')
      arm.input.reject(error)
      arm.response.reject(error)
      arm.presented.reject(error)
    }
    signal.addEventListener('abort', arm.abort, { once: true })
    this.active = arm
    this.runId = assignment.runId
    this.seen.add(assignment.assignment.assignmentId)
    try {
      await untilAbort(this.open(), signal)
      arm.directory = join(resolve(this.options.directory), `ledger-${randomUUID()}`)
      await mkdir(arm.directory, { mode: 0o700 })
      await protectPrivateDirectory(arm.directory)
      arm.ledger = new Ledger(join(arm.directory, 'ledger.sqlite'))
      const platform = await untilAbort(
        Promise.resolve(this.options.platform(structuredClone(assignment))),
        signal
      )
      if (!platform.collectionSource) throw new Error('evaluation_trusted_collection_required')
      const client: ConstructorParameters<typeof DesktopAgentRuntime>[1] = {
        status: () => this.options.client.status(),
        configuration: async () => {
          const configuration = { ...this.configuration, automaticEnabled: false }
          delete configuration.memoryCorpusVersion
          return configuration
        },
        acquireLease: (identity, requestSignal) =>
          this.options.client.acquireLease(identity, requestSignal),
        generateCandidate: async (rawInput, requestSignal) => {
          if (arm.generation || signal.aborted)
            throw new Error('evaluation_foreground_task_conflict')
          const input = parseGenerationInput(rawInput)
          this.assertInput(assignment, input)
          arm.generation = input
          arm.input.resolve(structuredClone(input))
          return untilAbort(
            arm.response.promise,
            AbortSignal.any([signal, requestSignal ?? signal])
          )
        },
        reviewEdited: denied,
        issueExecution: denied,
        issueHumanExecution: denied,
        settleExecution: denied
      }
      arm.runtime = new DesktopAgentRuntime(
        arm.ledger,
        client,
        {
          ...platform,
          collectionSource: platform.collectionSource,
          capabilities: () => platform.capabilities(),
          binding: (requestSignal) => platform.binding(requestSignal),
          observe: (onMessage, onFailure, requestSignal) =>
            platform.observe(onMessage, onFailure, requestSignal),
          stop: () => platform.stop(),
          readCurrent: denied,
          dispatch: denied
        },
        (event) => this.record(arm, event),
        true
      )
      this.idleRuntime = arm.runtime
      arm.runtime.configureEvaluationTimingCapture(this.journal!)
      await untilAbort(Promise.resolve(this.options.onRuntime?.(arm.runtime)), signal)
      const started = await untilAbort(arm.runtime.start(), signal)
      if (started.state !== 'running') throw new ForegroundEvaluationRuntimeError(started)
      return await untilAbort(arm.input.promise, signal)
    } catch (error) {
      controller.abort()
      await this.release(arm)
      throw error
    }
  }
  private assertInput(assignment: ForegroundEvaluationAssignment, input: GenerationInput): void {
    const task = input.task,
      expected = assignment.task
    if (
      hashContext(input.inbound) !== hashContext(assignment.item.inbound) ||
      task.identity.tenantId !== this.scope.tenant_id ||
      task.identity.employeeId !== this.scope.employee_id ||
      task.identity.accountId !== this.scope.account_id ||
      task.identity.agentId !== this.scope.agent_id ||
      task.identity.platform !== this.scope.platform ||
      task.conversationId !== expected.conversationId ||
      task.configVersion !== expected.configVersion ||
      task.knowledgeVersion !== expected.knowledgeVersion ||
      task.decisionPolicyVersion !== expected.decisionPolicyVersion ||
      task.questionSetVersion !== expected.questionSetVersion ||
      task.memorySnapshotHash !== undefined ||
      task.learningContextVersion !== undefined ||
      task.memoryCorpusVersion !== undefined ||
      (assignment.item.context
        ? hashContext(input.context) !== hashContext(assignment.item.context)
        : input.context.length !== input.inbound.length ||
          input.context.some(
            (message, index) =>
              message.direction !== 'inbound' ||
              message.kind !== 'text' ||
              message.text !== input.inbound[index]
          ))
    )
      throw new Error('evaluation_foreground_input_conflict')
  }
  private record(arm: ActiveArm, event: RuntimeTimingEvent): void {
    if (
      !arm.generation ||
      hashContext(arm.generation.task) !==
        hashContext('task' in event.event ? event.event.task : null)
    )
      return
    if (event.kind === 'agent' && event.event.stage === 'candidate_ready' && arm.resultDelivered) {
      const { assignment, frozen } = arm.assignment
      arm.runtime!.bindTimingEvaluation(arm.generation.task, {
        batchId: arm.assignment.runId,
        assignmentId: assignment.assignmentId,
        caseId: assignment.caseId,
        arm: assignment.arm,
        expectedTaskHash: hashContext(arm.generation.task),
        sharedConfigurationHash: frozen.sharedConfigurationHash,
        memoryManifestHash:
          assignment.arm === 'none'
            ? frozen.noMemoryManifestHash!
            : assignment.arm === 'baseline'
              ? frozen.staticMemoryManifestHash
              : frozen.learnedMemoryManifestHash,
        policyVersion: frozen.policyVersion!,
        retrievalVersion: frozen.retrievalVersion!,
        modelVersion: frozen.modelVersion,
        knowledgeVersion: frozen.knowledgeVersion,
        modelResolved: this.configuration.modelResolved
      })
    }
    if (event.kind === 'presentation' && arm.resultDelivered) arm.presented.resolve()
    if (
      event.kind === 'agent' &&
      ['generation_failed', 'obsolete'].includes(event.event.stage) &&
      !arm.resultDelivered
    )
      arm.controller.abort()
  }
  readonly foregroundResult = async (
    raw: ForegroundEvaluationAssignment & { result: PipelineResult },
    external: AbortSignal
  ): Promise<void> => {
    const { result, ...rawAssignment } = raw
    const assignment = this.checkAssignment(rawAssignment),
      arm = this.active
    if (
      !arm?.generation ||
      arm.resultDelivered ||
      external.aborted ||
      (result.modelResolved !== undefined &&
        result.modelResolved !== this.configuration.modelResolved) ||
      basisKey(assignment) !== basisKey(arm.assignment) ||
      hashContext(assignment.task) !== hashContext(arm.generation.task)
    )
      throw new Error('evaluation_foreground_result_conflict')
    try {
      const response = parseGenerationResult(
        {
          task: assignment.task,
          status: result.status,
          automaticAllowed: result.automaticAllowed,
          factsVerified: result.factsVerified === true,
          reasons: result.reasons,
          intents: result.intents,
          ...(result.draft ? { draft: result.draft } : {}),
          ...(result.review ? { review: result.review } : {}),
          usage: result.usage
        },
        assignment.task
      )
      arm.resultDelivered = true
      arm.response.resolve(response)
      await untilAbort(arm.presented.promise, AbortSignal.any([external, arm.signal]))
      const stopped = await arm.runtime!.close()
      if (!stopped.pauseAcknowledged || stopped.state !== 'closed')
        throw new Error('evaluation_foreground_not_quiescent')
      await this.journal!.drain()
      const report = arm.runtime!.evaluationTimingSnapshot()
      const observations = report.tasks.filter(
        (item) => hashContext(item.task) === hashContext(assignment.task)
      )
      if (
        report.status !== 'captured' ||
        !report.runtimeInstanceId ||
        observations.length !== 1 ||
        !observations[0].latencyComplete ||
        observations[0].status !== 'captured'
      )
        throw new Error('evaluation_foreground_evidence_incomplete')
      this.reports.push(report)
      this.observations.push({
        runId: assignment.runId,
        assignmentId: assignment.assignment.assignmentId,
        caseId: assignment.assignment.caseId,
        arm: assignment.assignment.arm,
        executionTaskHash: hashContext(assignment.task),
        runtimeInstanceId: report.runtimeInstanceId,
        observation: observations[0]
      })
    } catch (error) {
      arm.controller.abort()
      throw error
    } finally {
      await this.release(arm)
    }
  }
  private async release(arm: ActiveArm): Promise<void> {
    arm.releasing ??= this.releaseOnce(arm)
    return arm.releasing
  }
  private async releaseOnce(arm: ActiveArm): Promise<void> {
    clearTimeout(arm.timer)
    arm.signal.removeEventListener('abort', arm.abort)
    arm.controller.abort()
    if (arm.runtime) {
      const stopped = await arm.runtime.close()
      if (!stopped.pauseAcknowledged || stopped.state !== 'closed') {
        this.terminal = true
        throw new Error('evaluation_foreground_not_quiescent')
      }
    } else arm.ledger?.close()
    if (arm.directory) {
      const names = await readdir(arm.directory)
      const allowed = new Set([
        'ledger.sqlite',
        'ledger.sqlite-wal',
        'ledger.sqlite-shm',
        'ledger.sqlite-journal'
      ])
      if (names.some((name) => !allowed.has(name)))
        throw new Error('evaluation_private_ledger_invalid')
      const files = names.map((name) => join(arm.directory!, name))
      await verifyPrivatePaths(arm.directory, files)
      for (const file of files) {
        const item = await lstat(file)
        if (!item.isFile() || item.nlink !== 1) throw new Error('evaluation_private_ledger_invalid')
      }
      for (const file of files) await unlink(file)
      await rmdir(arm.directory)
    }
    if (this.active === arm) this.active = undefined
  }
  /** Seal only after the caller has completed and online-verified the original server packet. */
  async finish(): Promise<{ path: string; sessionId: string; observations: number }> {
    if (
      this.active ||
      this.terminal ||
      this.revoked ||
      !this.journal ||
      !this.vault ||
      !this.observations.length ||
      this.observations.length !== this.seen.size
    )
      throw new Error('evaluation_foreground_evidence_incomplete')
    this.terminal = true
    const report = {
      schema: 'autoreply-foreground-evaluation-evidence-v1',
      runId: this.runId,
      sessionId: this.journal.sessionId,
      endpoint: 'reviewable',
      observations: this.observations,
      reports: this.reports,
      businessVerified: false,
      serverFrozenBatchVerified: false
    }
    try {
      const path = await this.vault.finishSession(this.journal, () => this.journal!.export(report))
      if (!path) throw new Error('evaluation_foreground_evidence_incomplete')
      await this.vault.assertReadable(this.journal.sessionId)
      return { path, sessionId: this.journal.sessionId, observations: this.observations.length }
    } finally {
      await this.vault.shutdown()
      this.finished = true
      this.idleRuntime = undefined
      await this.options.onRuntime?.(undefined)
    }
  }
  async close(): Promise<void> {
    if (this.finished) return
    this.terminal = true
    if (this.active) await this.release(this.active)
    await this.opening?.catch(() => {})
    if (this.vault && this.journal) await this.vault.finishSession(this.journal)
    await this.vault?.shutdown()
    this.finished = true
    this.idleRuntime = undefined
    await this.options.onRuntime?.(undefined)
  }
}
