import {
  sameIdentity,
  type Identity,
  type ConversationBinding
} from '../../shared/contracts/identity'
import type { ObservedMessage } from '../../shared/contracts/message'
import type { RuntimeStatus } from '../../shared/contracts/runtime'
import type { AgentConfiguration } from '../../core/agent/reliable-agent'
import { ReliableAgent, RunEpochPersistenceError } from '../../core/agent/reliable-agent'
import { RemoteReplyService } from '../../core/agent/remote-reply-service'
import { LeaseSession } from '../../core/agent/lease-session'
import type { VerifiedSendAdapter } from '../../core/sending/sender'
import { Ledger } from '../../core/persistence/ledger'
import { CentralSendAdapter } from '../../core/sending/central-send-adapter'
import { hashContext } from '../../core/reply/hashes'
import type { AgentRegistration } from './agent-registration'
import { LearningOutboxSync } from './learning-outbox-sync'
import { LearningSubmissionSync, type LearningSubmissionBinding } from './learning-submission-sync'
import type { LearningService } from './learning-service'
import type { LearningSubmissionReceipt } from '../../shared/contracts/learning-submissions'
import { accountMemoryScope } from '../../core/memory/learning-scope'
import {
  EnterpriseLearningDesktopAdapter,
  enterpriseLearningDesktopMethods,
  type EnterpriseLearningDesktopClient
} from './enterprise-learning-desktop-adapter'
import type { LearningMemoryDesktopApi } from '../../shared/contracts/learning-desktop'
import { learningHash } from '../../core/memory/learning-scope'
import { MemoryScopeSchema, type MemoryScope } from '../../shared/contracts/learning-memory'
import {
  createRestoreInventorySnapshot,
  RestoreInventorySnapshotError
} from './restore-inventory-snapshot'
import {
  RestoreInventoryStartAckSchema,
  RestoreInventoryPageAckSchema,
  RestoreInventoryCompleteAckSchema,
  type RestorationInventorySubmitResult
} from '../../shared/contracts/restore-inventory'
import {
  RestoreApplicationDecisionSchema,
  RestoreApplicationAckSchema
} from '../../shared/contracts/restore-application'
import type { RestorationApplyResult } from '../../shared/contracts/restoration'
import {
  RestoreRecoveryPackageSchema,
  type RestorationBoundaryApplyResult
} from '../../shared/contracts/restore-recovery'
import { parseRestoreResolutionPackage } from '../../shared/contracts/restore-resolution'
import { parseRestoreObservationGrant } from '../../shared/contracts/restore-observation'
import {
  parseRestoreRecoveryCompletionReceipt,
  type RestoreRecoveryCompletionInput
} from '../../shared/contracts/restore-completion'
import {
  WorkbenchActionSchema,
  WorkbenchLearningInputSchema,
  type WorkbenchLearningResult,
  WorkbenchEditSchema,
  WorkbenchConfirmSchema,
  WorkbenchEvidenceInputSchema,
  type WorkbenchEvidenceResult,
  WorkbenchScopeSchema,
  workbenchScopeOf,
  type WorkbenchScope,
  type WorkbenchRow,
  type WorkbenchSnapshot,
  type WorkbenchResult,
  type LocalReplyRecord
} from '../../shared/contracts/workbench'
import type { WorkbenchReconciliationResult } from '../../shared/contracts/workbench'
import {
  parseDeviceReconciliationReport,
  parseReconciliationChallenge,
  type ReconciliationChallenge,
  type ReconciliationObservation
} from '../../shared/contracts/reconciliation'
import { parseEditedReviewResult } from '../../core/reply/edited-review-validation'
import type { EditedReviewInput } from '../../shared/contracts/edited-review'
import { z } from 'zod'
import { parseAssessmentEvidencePage } from '../../shared/contracts/assessment-evidence'
import { ConversationCollector } from '../../core/agent/conversation-collector'
import type { RuntimeTimingEvent } from '../../core/agent/runtime-timing'
import type { RuntimePresentationReceipt } from '../../core/agent/runtime-timing'
export type { RuntimeTimingEvent } from '../../core/agent/runtime-timing'
import {
  RuntimeTimingEvidence,
  type HostRuntimeEvaluationBinding
} from '../../core/agent/runtime-timing-evidence'
import { PrivateRuntimeTimingJournal } from '../../core/persistence/runtime-timing-journal'
import { PrivateRuntimeTimingVault } from '../../core/persistence/runtime-timing-vault'
import type { ReplyTask } from '../../shared/contracts/task'
import { randomUUID } from 'node:crypto'
import { RuntimeStatusReporter } from './runtime-status-reporter'
import { AccountPauseCoordinator } from './account-pause-coordinator'
import {
  RestorePauseChallengeSchema,
  RestorePauseAckSchema,
  RestoreLookupResultSchema,
  type RestorationStatus,
  type RestorationSubmitResult,
  type RestorePauseAck
} from '../../shared/contracts/restoration'
import type { CollectionSource } from '../../shared/contracts/collection'

/** A main-process implementation must supply actual verified platform/execution capabilities.
 * No renderer may provide identity, capability claims or observation callbacks. */
export interface RuntimePlatform extends VerifiedSendAdapter {
  /** Optional durable paged collector, supplied exclusively by a trusted platform adapter. */
  collectionSource?: CollectionSource
  capabilities(): {
    backgroundRead: boolean
    nonInterferingSend: boolean
  }
  binding(
    signal: AbortSignal
  ): Promise<{ identity: Identity; conversations: ConversationBinding[] }>
  observe(
    onMessage: (message: ObservedMessage) => void,
    onFailure: () => void,
    signal: AbortSignal
  ): Promise<void>
  stop(): Promise<void>
  /** Read-only verified journal/echo inspection, never a send or an absence heuristic. */
  inspectExecution?(
    input: { executionId: string; challenge: ReconciliationChallenge },
    signal: AbortSignal
  ): Promise<ReconciliationObservation | { status: 'unknown' }>
}
type Client = Pick<
  AgentRegistration,
  | 'status'
  | 'configuration'
  | 'generateCandidate'
  | 'reviewEdited'
  | 'acquireLease'
  | 'issueExecution'
  | 'issueHumanExecution'
  | 'settleExecution'
> &
  Partial<
    Pick<
      AgentRegistration,
      | 'assessmentEvidence'
      | 'reportRuntimeStatus'
      | 'accountPauseChallenge'
      | 'confirmAccountPause'
      | 'prepareGeneration'
      | 'reconciliationChallenge'
      | 'reportReconciliation'
      | 'reconciliationDecision'
      | 'reconciliationApplied'
      | 'sealExecutionRequest'
      | 'requestSealApplied'
      | 'restorePauseChallenge'
      | 'reportRestorePause'
      | 'lookupRestoration'
      | 'startRestoreInventory'
      | 'submitRestoreInventoryPage'
      | 'completeRestoreInventory'
      | 'restoreLatestApplicationDecision'
      | 'restoreLatestRecoveryBoundary'
      | 'restoreExecutionResolutions'
      | 'restoreObservationGrant'
      | 'acknowledgeRestoreRecovery'
      | 'acknowledgeRestoreApplication'
      | 'recordLearningCorrection'
      | 'recordLearningResult'
      | 'recordLearningFeedback'
      | 'learningSettings'
      | 'learningForgetScope'
      | (typeof enterpriseLearningDesktopMethods)[number]
    >
  >

/** Owns the new core's lifetime. Construction and status never inspect any chat window. */
export class DesktopAgentRuntime {
  private state: RuntimeStatus['state'] = 'paused'
  private reason: RuntimeStatus['reason'] = 'none'
  private generation = 0
  private controller?: AbortController
  private configuration?: AgentConfiguration
  private identity?: Identity
  private readonly agent: ReliableAgent
  private readonly lease: LeaseSession
  private readonly central: CentralSendAdapter
  private pauseWork?: Promise<RuntimeStatus>
  private observerStopped = true
  private observerStopping?: Promise<boolean>
  private closed = false
  private closing?: Promise<RuntimeStatus>
  private readonly learningSync: LearningOutboxSync
  private submissionSync?: LearningSubmissionSync
  private learningDesktop?: EnterpriseLearningDesktopAdapter
  private learningGeneration = 0
  private learningForgetting?: Promise<void>
  private learningForgetController?: AbortController
  private synchronizing?: Promise<RuntimeStatus>
  private starting?: Promise<RuntimeStatus>
  private readonly editing = new Map<string, AbortController>()
  private readonly confirming = new Set<string>()
  private evidenceReads = 0
  private reconciling?: Promise<WorkbenchReconciliationResult>
  private collector?: ConversationCollector
  private collectionIdentity?: Identity
  private readonly restoreInstanceId = randomUUID()
  private monitoring?: RuntimeStatusReporter
  private pauseConfirmation?: AccountPauseCoordinator
  private readonly runtimeInstanceId = randomUUID()
  private timingCapture?: { journal: PrivateRuntimeTimingJournal; evidence: RuntimeTimingEvidence }
  private timingCaptureOpening?: Promise<{ sessionId: string }>
  private timingCaptureAttempted = false
  private timingCaptureRetired = false
  private sharedEvaluationCapture = false
  private timingVault?: PrivateRuntimeTimingVault
  private timingVaultRoot?: string
  private managedTimingEndpoint: 'reviewable' | 'confirmed_sent' = 'reviewable'
  private managedTimingReport?: string
  private restorationPausedGeneration?: number
  private restorationReporting = false
  private restorationDiscovering = false
  private restorationAttempt?: {
    caseId: string
    requestId: string
    scopeHash: string
    contextHash: string
    generation: number
    expiresAt?: number
  }
  private restorationReceipt?: { scopeHash: string; contextHash: string }
  private restorationUploading = false
  private restorationApplying = false
  private restorationSnapshotCleanup?: () => void
  private restorationInventoryReceipt?: { scopeHash: string; contextHash: string }

  constructor(
    private readonly ledger: Ledger,
    private readonly client: Client,
    private readonly platform?: RuntimePlatform,
    private readonly onTiming?: (event: RuntimeTimingEvent) => void | Promise<void>,
    /** Trusted host evaluation only; never configured by renderer input. */
    private readonly evaluationReadOnly = false
  ) {
    this.lease = new LeaseSession(client, () => this.pause('lease_lost').then(() => {}))
    const adapter: VerifiedSendAdapter = {
      readCurrent: async (task, signal) => {
        if (!this.platform) throw new Error('capability_unverified')
        const state = await this.platform.readCurrent(task, signal)
        const grant = this.lease.current()
        return {
          ...state,
          leaseValid: Boolean(grant && sameIdentity(grant.identity, task.identity))
        }
      },
      dispatch: (command, signal) => {
        const grant = this.lease.current()
        if (
          !this.platform ||
          this.state !== 'running' ||
          signal.aborted ||
          !grant ||
          !sameIdentity(grant.identity, command.task.identity)
        )
          return Promise.resolve({
            status: 'not_sent',
            executionId: command.executionId,
            identity: command.task.identity,
            conversationId: command.task.conversationId,
            draftHash: command.draft.draftHash,
            dispatchStarted: false,
            quiescent: true,
            verificationProofHash: hashContext({
              kind: 'runtime_closed_before_verified_driver',
              executionId: command.executionId
            })
          })
        return this.platform.dispatch(command, signal)
      }
    }
    this.central = new CentralSendAdapter(ledger, client, adapter, {
      scope: () => {
        const scope = this.client.status().scope
        return scope
          ? {
              tenantId: scope.tenant_id,
              employeeId: scope.employee_id,
              accountId: scope.account_id,
              agentId: scope.agent_id,
              platform: scope.platform
            }
          : undefined
      },
      lease: () => this.lease.current(),
      revalidate: (command, signal) => this.agent.sender.revalidate(command, signal),
      current: (command) =>
        this.state === 'running' &&
        (command.purpose === 'human'
          ? this.agent.matchesHumanTask(command.task, command.confirmation)
          : this.agent.matchesCurrentTask(command.task)) &&
        this.agent.sender.localCurrent(command)
    })
    this.agent = new ReliableAgent(ledger, this.central, new RemoteReplyService(client), {
      onProgress: (event) => {
        if (!this.onTiming && (!this.timingCapture || this.timingCaptureRetired)) return
        let sources: import('../../core/agent/runtime-timing').RuntimeTimingSource[] | undefined
        if ('task' in event) {
          try {
            sources = this.ledger.inboundReferences(event.task)
          } catch {
            /* Missing metadata stays insufficient; diagnostics never block a reply. */
          }
        }
        this.emitTiming({
          runtimeInstanceId: this.runtimeInstanceId,
          kind: 'agent',
          event,
          ...(sources ? { sources } : {}),
          ...(this.configuration?.modelResolved
            ? { modelResolved: this.configuration.modelResolved }
            : {})
        })
      },
      onStorageFailure: () => {
        void this.pause('local_storage_unavailable')
      },
      onSend: () => {
        const barrier = this.central.barrier()
        if (barrier.requiresReconciliation) void this.pause('execution_reconciliation_required')
        else if (barrier.pending > 0) void this.pause('settlement_pending')
      }
    })
    if (ledger.requiresRestoreReview()) {
      this.state = 'blocked'
      this.reason = 'execution_reconciliation_required'
    }
    this.learningSync = new LearningOutboxSync(
      ledger,
      client,
      () => this.workbenchScope(),
      () => {
        void this.pause('local_storage_unavailable')
      }
    )
    this.learningSync.start()
  }

  /** Trusted main-process configuration only, before the first runtime operation. No IPC exposure. */
  configureTimingCapture(directory: string): Promise<{ sessionId: string }> {
    return this.installTimingCapture(async () => ({
      journal: await PrivateRuntimeTimingJournal.open(directory)
    }))
  }

  configureManagedTimingCapture(
    directory: string,
    endpoint: 'reviewable' | 'confirmed_sent' = 'reviewable'
  ): Promise<{ sessionId: string }> {
    const parsedEndpoint = z.enum(['reviewable', 'confirmed_sent']).parse(endpoint)
    return this.installTimingCapture(async () => {
      this.timingVaultRoot = directory
      this.managedTimingEndpoint = parsedEndpoint
      const vault = await PrivateRuntimeTimingVault.open(directory)
      try {
        const journal = await vault.createSession(() => {
          this.timingCaptureRetired = true
        })
        return { journal, vault }
      } catch (error) {
        await vault.shutdown()
        throw error
      }
    })
  }

  /** A single host-owned batch journal keeps the original ID of every isolated runtime. */
  configureEvaluationTimingCapture(journal: PrivateRuntimeTimingJournal): void {
    if (
      !this.evaluationReadOnly ||
      this.timingCaptureAttempted ||
      this.generation !== 0 ||
      this.closed ||
      this.closing ||
      journal.health().closed ||
      journal.health().reason
    )
      throw new Error('runtime_timing_capture_unavailable')
    this.timingCaptureAttempted = true
    this.sharedEvaluationCapture = true
    this.timingCapture = { journal, evidence: new RuntimeTimingEvidence(journal) }
  }

  /** The owning host must drain the shared journal before taking a closed-runtime snapshot. */
  evaluationTimingSnapshot(): import('../../core/agent/runtime-timing-evidence').RuntimeTimingEvidenceReport {
    if (
      !this.evaluationReadOnly ||
      !this.sharedEvaluationCapture ||
      !this.timingCapture ||
      this.timingCaptureRetired ||
      !this.closed ||
      !this.observerStopped
    )
      throw new Error('runtime_timing_not_quiescent')
    return this.timingCapture.evidence.snapshot('reviewable')
  }

  private installTimingCapture(
    open: () => Promise<{ journal: PrivateRuntimeTimingJournal; vault?: PrivateRuntimeTimingVault }>
  ): Promise<{ sessionId: string }> {
    if (
      this.timingCaptureAttempted ||
      this.timingCaptureRetired ||
      this.generation !== 0 ||
      this.closed ||
      this.closing ||
      this.starting ||
      this.synchronizing
    )
      return Promise.reject(new Error('runtime_timing_capture_unavailable'))
    this.timingCaptureAttempted = true
    const work = (async () => {
      const { journal, vault } = await open()
      if (this.closed || this.closing || this.timingCaptureRetired || this.generation !== 0) {
        if (vault) {
          try {
            await vault.discardSession(journal)
          } finally {
            await vault.shutdown()
          }
        } else await journal.forget()
        throw new Error('runtime_timing_capture_unavailable')
      }
      this.timingCapture = { journal, evidence: new RuntimeTimingEvidence(journal) }
      this.timingVault = vault
      vault?.startRetention()
      return { sessionId: journal.sessionId }
    })()
    this.timingCaptureOpening = work
    const settled = (): void => {
      if (this.timingCaptureOpening === work) this.timingCaptureOpening = undefined
    }
    void work.then(settled, settled)
    return work
  }

  bindTimingEvaluation(task: ReplyTask, binding: HostRuntimeEvaluationBinding): void {
    if (!this.timingCapture || this.timingCaptureRetired || this.closed || this.closing)
      throw new Error('runtime_timing_capture_unavailable')
    this.timingCapture.evidence.bind(task, binding)
  }

  async exportTimingEvidence(
    endpoint: 'reviewable' | 'confirmed_sent' = 'reviewable'
  ): Promise<string> {
    if (!this.timingCapture || this.timingCaptureRetired || this.sharedEvaluationCapture)
      throw new Error('runtime_timing_capture_unavailable')
    if (!this.closed || !this.observerStopped || this.observerStopping)
      throw new Error('runtime_timing_not_quiescent')
    if (this.timingVault) {
      if (endpoint !== this.managedTimingEndpoint)
        throw new Error('runtime_timing_endpoint_conflict')
      if (!this.managedTimingReport) throw new Error('runtime_evidence_incomplete')
      await this.timingVault.assertReadable(this.timingCapture.journal.sessionId)
      return this.managedTimingReport
    }
    return this.timingCapture.evidence.export(endpoint)
  }

  private emitTiming(event: RuntimeTimingEvent): void {
    if (!this.timingCaptureRetired) this.timingCapture?.evidence.record(event)
    try {
      const work = this.onTiming?.(event)
      if (work) void work.catch(() => {})
    } catch {
      /* Diagnostics never change a reply's outcome or permissions. */
    }
  }

  /** Main process only. The renderer supplies neither identity nor a timestamp. */
  presentationTarget(raw: unknown): { task: ReplyTask; row: WorkbenchRow } | undefined {
    const parsed = WorkbenchConfirmSchema.safeParse(raw),
      scope = this.workbenchScope()
    if (
      !parsed.success ||
      !scope ||
      this.closed ||
      this.closing ||
      this.learningForgetting ||
      this.state !== 'running' ||
      !this.timingCapture ||
      this.timingCaptureRetired
    )
      return undefined
    try {
      const record = this.ledger.replies.get(scope, parsed.data.taskId)
      if (
        !record ||
        record.edited ||
        record.task.expiresAt <= Date.now() ||
        !['ready', 'needs_human'].includes(record.status) ||
        !this.identity ||
        !sameIdentity(this.identity, record.task.identity) ||
        this.ledger.requiresRestoreReview() ||
        !this.timingCapture.evidence.hasUnpresentedCandidate(record.task)
      )
        return undefined
      const row = this.workbenchRow(record)
      if (
        row.version !== parsed.data.expectedVersion ||
        row.status !== record.status ||
        this.ledger.conversationState(record.task.identity, record.task.conversationId).revision !==
          record.task.conversationRevision
      )
        return undefined
      return { task: structuredClone(record.task), row: structuredClone(row) }
    } catch {
      return undefined
    }
  }

  recordPresentation(receipt: RuntimePresentationReceipt): boolean {
    const current = this.presentationTarget({
      taskId: receipt.task.taskId,
      expectedVersion: receipt.rowVersion
    })
    if (!current || hashContext(current.task) !== hashContext(receipt.task)) return false
    this.emitTiming({
      runtimeInstanceId: this.runtimeInstanceId,
      kind: 'presentation',
      event: receipt
    })
    return !this.timingCapture!.evidence.hasUnpresentedCandidate(current.task)
  }

  private async forgetTimingCapture(scope?: MemoryScope): Promise<void> {
    const enterprise = !scope || Boolean(scope.tenantId && scope.accountId)
    if (enterprise) this.timingCaptureRetired = true
    await this.timingCaptureOpening?.catch(() => {})
    if (this.timingVaultRoot) {
      const original = this.timingVault,
        vault =
          original && !original.isStopped()
            ? original
            : await PrivateRuntimeTimingVault.open(this.timingVaultRoot)
      try {
        if (scope) await vault.forgetScope(scope)
        if (enterprise && this.timingCapture) {
          // Preserve unrelated account/conversation metadata in a mixed historical session.
          await vault.finishSession(this.timingCapture.journal)
          if (!vault.hasSessionScopes(this.timingCapture.journal.sessionId))
            await vault.discardSession(this.timingCapture.journal)
        }
      } finally {
        if (vault !== original) await vault.shutdown()
      }
    } else if (enterprise) await this.timingCapture?.journal.forget()
  }

  configureLearningSubmissions(service: LearningService): void {
    if (this.evaluationReadOnly) throw new Error('learning_scope_unavailable')
    if (this.submissionSync || this.closed || this.closing)
      throw new Error('learning_scope_unavailable')
    this.submissionSync = new LearningSubmissionSync(this.ledger.learningSubmissions, {
      resolve: (scope): LearningSubmissionBinding | undefined => {
        if (
          this.closed ||
          this.closing ||
          this.learningForgetting ||
          this.ledger.requiresRestoreReview()
        )
          return undefined
        const backend = this.learningBackend(scope)
        if (!backend) {
          service.assertScope(scope)
          if (scope.tenantId || scope.accountId || scope.workspaceId.startsWith('enterprise:'))
            return undefined
          return {
            scope: accountMemoryScope(scope),
            authorityId: learningHash({ local: accountMemoryScope(scope) }),
            settings: async (selected) => service.store.settings(service.assertScope(selected)),
            episode: async (selected, id) =>
              service.store.episode(service.assertScope(selected), id),
            apply: async (request) => {
              service.assertScope(request.input.scope)
              switch (request.kind) {
                case 'manual': {
                  const { scope: owned, ...value } = request.input
                  return service.store.teach(service.assertScope(owned), value)
                }
                case 'correct': {
                  const { scope: owned, episodeId, ...value } = request.input
                  return service.correct(owned, episodeId, value)
                }
                case 'result': {
                  const { scope: owned, episodeId, ...value } = request.input
                  return service.confirmResult(owned, episodeId, value)
                }
                case 'feedback': {
                  const { scope: owned, episodeId, ...value } = request.input
                  return service.humanFeedback(owned, episodeId, value)
                }
              }
            }
          }
        }
        const status = this.client.status()
        const client = this.client as EnterpriseLearningDesktopClient
        return {
          scope: accountMemoryScope(scope),
          authorityId: learningHash({ serverUrl: status.serverUrl, scope: status.scope }),
          settings: (selected, signal) => client.learningSettings(selected, {}, signal),
          episode: (selected, id, signal) => client.learningEpisode(selected, id, signal),
          apply: (request, signal) => {
            switch (request.kind) {
              case 'manual': {
                const { scope: selected, ...value } = request.input
                return client.learningManual(selected, value, signal)
              }
              case 'correct':
                return client.learningEpisodeCorrection(request.input, signal)
              case 'result':
                return client.learningEpisodeResult(request.input, signal)
              case 'feedback':
                return client.learningEpisodeFeedback(request.input, signal)
            }
          }
        }
      }
    })
    this.submissionSync.start()
    void this.submissionSync.flush().catch(() => {})
  }

  submitLearning(raw: unknown): Promise<LearningSubmissionReceipt> {
    if (this.evaluationReadOnly) return Promise.reject(new Error('learning_scope_unavailable'))
    if (!this.submissionSync || this.closed || this.closing)
      return Promise.reject(new Error('learning_scope_unavailable'))
    return this.submissionSync.submit(raw)
  }
  learningSubmissions(scope: MemoryScope): LearningSubmissionReceipt[] {
    if (!this.submissionSync) throw new Error('learning_scope_unavailable')
    return this.submissionSync.receipts(scope)
  }
  observeLearningEpisode(raw: unknown): void {
    if (this.evaluationReadOnly) return
    // Restoration permits authoritative read-only management, but not new replay metadata.
    if (this.closed || this.closing || this.ledger.requiresRestoreReview()) return
    this.submissionSync?.observeEpisode(raw)
  }
  async forgetLocalLearning(
    scope: MemoryScope,
    authoritative: () => void | Promise<void>
  ): Promise<void> {
    if (!this.submissionSync) throw new Error('learning_scope_unavailable')
    await this.submissionSync.forget(scope, async () => {
      await this.forgetTimingCapture(scope)
      await authoritative()
    })
  }
  learningBackend(raw?: MemoryScope): LearningMemoryDesktopApi | null {
    if (this.evaluationReadOnly) return null
    if (this.closed || this.closing) throw new Error('learning_scope_unavailable')
    const requested = raw === undefined ? undefined : MemoryScopeSchema.parse(raw)
    if (
      requested &&
      !requested.tenantId &&
      !requested.accountId &&
      !requested.workspaceId.startsWith('enterprise:')
    )
      return null
    if (!requested && !this.client.status().scope) return null
    if (!enterpriseLearningDesktopMethods.every((key) => typeof this.client[key] === 'function'))
      throw new Error('learning_management_unavailable')
    this.learningDesktop ??= new EnterpriseLearningDesktopAdapter(
      this.client as EnterpriseLearningDesktopClient,
      (scope) => this.forgetLearningScope(scope),
      () => !this.closed && !this.closing
    )
    this.learningDesktop.scope(requested)
    return this.learningDesktop
  }

  status(): RuntimeStatus {
    const lease = this.lease.status()
    let scope: ReturnType<Client['status']>['scope']
    let capabilities: ReturnType<RuntimePlatform['capabilities']> | undefined
    try {
      scope = this.client.status().scope
    } catch {
      /* Unavailable registration cannot authorize a start. */
    }
    try {
      if (!this.closed) capabilities = this.platform?.capabilities()
    } catch {
      /* Failed evidence is not readiness. */
    }
    if (
      this.state === 'pausing' &&
      this.observerStopped &&
      this.agent.sender.isQuiescent() &&
      this.central.isQuiescent()
    )
      this.state = 'paused'
    return {
      state: this.state,
      reason: this.reason,
      lease,
      configurationVersion: this.configuration?.configVersion,
      readiness: {
        registered: Boolean(scope),
        backgroundRead: capabilities?.backgroundRead === true,
        nonInterferingSend: capabilities?.nonInterferingSend === true
      },
      pauseAcknowledged:
        this.state === 'paused' || this.state === 'blocked' || this.state === 'closed',
      ...(!this.closed &&
      this.collector &&
      this.collectionIdentity &&
      scope?.account_id === this.collectionIdentity.accountId &&
      scope?.tenant_id === this.collectionIdentity.tenantId &&
      scope?.agent_id === this.collectionIdentity.agentId &&
      scope?.employee_id === this.collectionIdentity.employeeId &&
      scope?.platform === this.collectionIdentity.platform
        ? { collection: this.collector.status() }
        : {})
    }
  }

  configureMonitoring(): void {
    if (this.monitoring || this.closed || !this.client.reportRuntimeStatus) return
    if (this.client.accountPauseChallenge && this.client.confirmAccountPause) {
      this.pauseConfirmation = new AccountPauseCoordinator(
        {
          status: () => this.client.status(),
          accountPauseChallenge: (input, signal) =>
            this.client.accountPauseChallenge!(input, signal),
          confirmAccountPause: (input, signal) => this.client.confirmAccountPause!(input, signal)
        },
        () => this.pause('user_pause'),
        () => ({ instanceId: this.runtimeInstanceId, generation: this.generation }),
        () => {
          const status = this.status()
          if (
            !status.pauseAcknowledged ||
            status.reason === 'local_storage_unavailable' ||
            !this.observerStopped ||
            !this.agent.sender.isQuiescent() ||
            !this.central.isQuiescent() ||
            this.lease.status() !== 'stopped'
          )
            return undefined
          return {
            observerStopped: true,
            senderQuiescent: true,
            settlementQuiescent: true,
            leaseStopped: true,
            platform: this.platform ? 'stop_returned' : 'absent'
          }
        },
        () => this.ledger.nextRunEpoch(),
        () => this.monitoring?.wake()
      )
    }
    this.monitoring = new RuntimeStatusReporter(
      {
        status: () => this.client.status(),
        reportRuntimeStatus: (input, signal) => this.client.reportRuntimeStatus!(input, signal)
      },
      () => this.status(),
      () => this.ledger.nextRunEpoch(),
      (receipt) => {
        if (receipt.pauseRequestId && this.pauseConfirmation) {
          this.pauseConfirmation.observe(receipt.pauseRequestId)
          return
        }
        return this.pause('user_pause')
      },
      () => ({ instanceId: this.runtimeInstanceId, generation: this.generation })
    )
    this.monitoring.start()
  }

  workbench(): WorkbenchSnapshot {
    if (this.closed) return { state: 'closed', rows: [] }
    const scope = this.workbenchScope()
    if (!scope) return { state: 'not_registered', rows: [] }
    try {
      const pendingLearning = new Set(
        this.ledger.learning.pendingForDisplay(scope).map((event) => event.task.taskId)
      )
      return {
        state: 'available',
        rows: this.ledger.replies
          .list(scope)
          .map((record) => this.workbenchRow(record, pendingLearning.has(record.task.taskId)))
      }
    } catch {
      void this.pause('local_storage_unavailable')
      return { state: 'unavailable', rows: [] }
    }
  }

  async workbenchLearn(input: unknown): Promise<WorkbenchLearningResult> {
    if (this.evaluationReadOnly) return { success: false, code: 'unavailable' }
    const parsed = WorkbenchLearningInputSchema.safeParse(input),
      scope = this.workbenchScope()
    const learningGeneration = this.learningGeneration
    if (!parsed.success) return { success: false, code: 'invalid_input' }
    if (!scope || this.closed || this.learningForgetting || !this.learningSync.available())
      return { success: false, code: 'unavailable' }
    try {
      const record = this.ledger.replies.get(scope, parsed.data.taskId)
      if (
        !record ||
        !record.draft ||
        !this.workbenchRow(record).canLearn ||
        this.workbenchRow(record).version !== parsed.data.expectedVersion
      )
        return { success: false, code: 'task_changed' }
      const actual = { task: record.task, draft: record.draft, at: Date.now() }
      const event =
        parsed.data.kind === 'correction'
          ? { ...actual, kind: 'correction' as const, input: parsed.data.input }
          : parsed.data.kind === 'result'
            ? { ...actual, kind: 'result' as const, input: parsed.data.input }
            : { ...actual, kind: 'feedback' as const, input: parsed.data.input }
      this.ledger.learning.enqueue(event)
      this.learningSync.start()
      await this.learningSync.flush()
      if (
        this.closed ||
        learningGeneration !== this.learningGeneration ||
        hashContext(this.workbenchScope() ?? {}) !== hashContext(scope)
      )
        return { success: false, code: 'unavailable' }
      const state = this.ledger.learning.state(scope, parsed.data.input.sourceId)
      if (state === 'forgotten') return { success: false, code: 'event_unavailable' }
      return {
        success: true,
        state: state === 'saved' ? 'saved' : 'pending',
        sourceId: parsed.data.input.sourceId
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'learning_event_conflict')
        return { success: false, code: 'event_conflict' }
      if (error instanceof Error && error.message === 'learning_event_forgotten')
        return { success: false, code: 'event_unavailable' }
      await this.pause('local_storage_unavailable')
      return { success: false, code: 'storage_unavailable' }
    }
  }

  flushLearning(): Promise<void> {
    if (this.learningForgetting) return Promise.resolve()
    this.learningSync.start()
    return this.learningSync.flush()
  }

  async forgetLearningScope(raw: MemoryScope): Promise<void> {
    const memory = MemoryScopeSchema.parse(raw),
      scope = this.workbenchScope()
    if (
      !scope ||
      this.closed ||
      this.closing ||
      this.learningForgetting ||
      !this.client.learningForgetScope ||
      memory.workspaceId !==
        `enterprise:${learningHash({ tenant: scope.tenantId, account: scope.accountId })}` ||
      memory.tenantId !== scope.tenantId ||
      memory.accountId !== scope.accountId ||
      memory.platform !== scope.platform
    )
      throw new Error('learning_scope_unavailable')
    const controller = new AbortController()
    this.learningForgetController = controller
    const generation = ++this.learningGeneration
    const work = (async () => {
      await this.learningSync.cancel()
      await this.submissionSync?.cancel()
      await this.step(
        (signal) => this.client.learningForgetScope!(memory, signal),
        controller.signal
      )
      if (
        this.closed ||
        generation !== this.learningGeneration ||
        hashContext(this.workbenchScope() ?? {}) !== hashContext(scope)
      )
        throw new Error('learning_scope_unavailable')
      try {
        await this.forgetTimingCapture(memory)
        this.ledger.learning.forgetAccount(scope, memory.conversationId)
        this.ledger.learningSubmissions.forget(memory)
      } catch {
        await this.pause('local_storage_unavailable')
        throw new Error('learning_storage_unavailable')
      }
    })()
    this.learningForgetting = work
    try {
      await work
    } finally {
      if (this.learningForgetting === work) this.learningForgetting = undefined
      if (this.learningForgetController === controller) this.learningForgetController = undefined
      if (!controller.signal.aborted && !this.closed && !this.closing) this.learningSync.start()
    }
  }

  workbenchReconcile(input: unknown): Promise<WorkbenchReconciliationResult> {
    if (this.evaluationReadOnly) return Promise.resolve({ success: false, code: 'unavailable' })
    if (this.reconciling) return Promise.resolve({ success: false, code: 'execution_pending' })
    const work = this.reconcileCore(input)
    this.reconciling = work
    const settled = (): void => {
      if (this.reconciling === work) this.reconciling = undefined
    }
    void work.then(settled, settled)
    return work
  }
  private async reconcileCore(input: unknown): Promise<WorkbenchReconciliationResult> {
    const parsed = WorkbenchConfirmSchema.safeParse(input),
      scope = this.workbenchScope()
    if (!parsed.success) return { success: false, code: 'invalid_input' }
    if (!scope || this.closed) return { success: false, code: 'unavailable' }
    let controller: AbortController | undefined
    try {
      const record = this.ledger.replies.get(scope, parsed.data.taskId)
      if (!record || this.workbenchRow(record).version !== parsed.data.expectedVersion)
        return { success: false, code: 'task_changed' }
      const send = this.ledger.findTask(record.task.identity, record.task.taskId)
      const attempt = send && this.ledger.central.get(send.executionId)
      if (!attempt || !(attempt.phase === 'unresolved' || attempt.receipt?.status === 'unknown'))
        return { success: false, code: 'unavailable' }
      const stopping = this.pause('execution_reconciliation_required'),
        generation = this.generation
      const paused = await stopping
      const stopped = (): boolean =>
        this.state === 'paused' &&
        this.observerStopped &&
        this.agent.sender.isPaused() &&
        this.agent.sender.isQuiescent() &&
        this.central.isQuiescent() &&
        this.lease.status() === 'stopped'
      if (!paused.pauseAcknowledged || paused.reason === 'local_storage_unavailable' || !stopped())
        return { success: false, code: 'execution_pending' }
      controller = this.controller = new AbortController()
      const current = (): boolean => {
        if (
          this.closed ||
          generation !== this.generation ||
          controller!.signal.aborted ||
          !stopped() ||
          hashContext(this.workbenchScope() ?? {}) !== hashContext(scope)
        )
          return false
        const fresh = this.ledger.replies.get(scope, record.task.taskId)
        return !!fresh && this.workbenchRow(fresh).version === parsed.data.expectedVersion
      }
      if (!current()) return { success: false, code: 'task_changed' }
      const storedSeal = this.ledger.central.requestSeal(attempt.executionId)
      if (
        storedSeal?.result?.status === 'request_sealed' ||
        this.ledger.central.canSealRequest(attempt.executionId)
      ) {
        if (!this.client.sealExecutionRequest || !this.client.requestSealApplied)
          return { success: false, code: 'unavailable' }
        let result = storedSeal?.result
        if (!result) {
          const sealInput = this.ledger.central.prepareRequestSeal(
            attempt.executionId,
            {
              stoppedAt: Date.now(),
              observerStopped: true,
              senderQuiescent: true,
              settlementQuiescent: true,
              leaseStopped: true,
              verifiedDriverStopped: true
            },
            Date.now()
          )
          result = await this.step(
            (s) => this.client.sealExecutionRequest!(sealInput, s),
            controller.signal
          )
          if (!current()) return { success: false, code: 'task_changed' }
          try {
            result = this.ledger.central.applyRequestSeal(attempt.executionId, result, Date.now())
          } catch (error) {
            await this.pause('local_storage_unavailable')
            throw error
          }
        }
        if (result.status === 'request_sealed') {
          const applicationAcknowledged = await this.flushRequestSealApplications(controller.signal)
          return {
            success: true,
            status: 'request_sealed',
            sealId: result.seal.sealId,
            sealHash: hashContext(result.seal),
            resolution: 'not_sent',
            applicationAcknowledged
          }
        }
        // A prior permit stays unresolved; only the existing independent
        // administrator/inspection flow can resolve it. This never dispatches.
        return { success: false, code: 'unavailable' }
      }
      if (!this.client.reconciliationChallenge || !this.client.reportReconciliation)
        return { success: false, code: 'unavailable' }
      const savedDecision = this.ledger.central.reconciliationDecision(attempt.executionId)
      if (savedDecision) {
        const savedReport = this.ledger.central.reconciliationReport(attempt.executionId)!
        const applicationAcknowledged = await this.flushReconciliationApplications(
          controller.signal
        )
        return {
          success: true,
          caseId: savedReport.caseId,
          reportHash: hashContext(savedReport),
          status: 'evidence_recorded',
          resolution: savedDecision.outcome,
          applicationAcknowledged
        }
      }
      const challenge = parseReconciliationChallenge(
        await this.step(
          (signal) =>
            this.client.reconciliationChallenge!(record.task.identity, attempt.request, signal),
          controller.signal
        ),
        attempt.request,
        record.task.identity
      )
      if (!current()) return { success: false, code: 'task_changed' }
      let report = this.ledger.central.reconciliationReport(attempt.executionId)
      if (report) report = parseDeviceReconciliationReport(report, challenge)
      else {
        if (!this.platform?.inspectExecution || !this.platform.capabilities().backgroundRead)
          return { success: false, code: 'unavailable' }
        const stoppedAt = Date.now()
        const observation = await this.step(
          (signal) =>
            this.platform!.inspectExecution!(
              structuredClone({ executionId: attempt.executionId, challenge }),
              signal
            ),
          controller.signal
        )
        if (!current()) return { success: false, code: 'task_changed' }
        if (observation.status === 'unknown') return { success: false, code: 'unavailable' }
        report = parseDeviceReconciliationReport(
          {
            caseId: challenge.caseId,
            snapshotHash: challenge.snapshotHash,
            request: attempt.request,
            stopped: {
              stoppedAt,
              observerStopped: true,
              senderQuiescent: true,
              settlementQuiescent: true,
              leaseStopped: true,
              verifiedDriverStopped: true
            },
            observation
          },
          challenge
        )
        try {
          this.ledger.central.saveReconciliationReport(
            attempt.executionId,
            challenge,
            report,
            Date.now()
          )
        } catch (error) {
          await this.pause('local_storage_unavailable')
          throw error
        }
      }
      if (!current()) return { success: false, code: 'task_changed' }
      const acknowledgment = await this.step(
        (signal) => this.client.reportReconciliation!(report!, signal),
        controller.signal
      )
      if (!current()) return { success: false, code: 'task_changed' }
      this.ledger.central.acknowledgeReconciliation(attempt.executionId, acknowledgment, Date.now())
      if (this.client.reconciliationDecision && this.client.reconciliationApplied) {
        const decision = await this.step(
          (signal) => this.client.reconciliationDecision!(report!, signal),
          controller.signal
        )
        if (!current()) return { success: false, code: 'task_changed' }
        if (decision) {
          try {
            this.ledger.central.applyReconciliation(attempt.executionId, decision, Date.now())
          } catch (error) {
            await this.pause('local_storage_unavailable')
            throw error
          }
          // Persistence changes the row version. From this point, cancellation
          // may defer acknowledgment, but must never undo the durable decision.
          const results = await this.flushReconciliationApplications(controller.signal)
          return {
            success: true,
            ...acknowledgment,
            resolution: decision.outcome,
            applicationAcknowledged: results
          }
        }
      }
      return { success: true, ...acknowledgment }
    } catch {
      return { success: false, code: 'unavailable' }
    } finally {
      controller?.abort()
    }
  }
  private async flushReconciliationApplications(signal: AbortSignal): Promise<boolean> {
    const scope = this.workbenchScope()
    if (!scope || !this.client.reconciliationApplied) return false
    for (const attempt of this.ledger.central.pendingReconciliationApplications(scope)) {
      if (
        signal.aborted ||
        this.closed ||
        hashContext(this.workbenchScope() ?? {}) !== hashContext(scope)
      )
        return false
      const report = this.ledger.central.reconciliationReport(attempt.executionId)!,
        decision = this.ledger.central.reconciliationDecision(attempt.executionId)!
      try {
        const ack = await this.step(
          (s) => this.client.reconciliationApplied!(report, decision, s),
          signal
        )
        if (
          signal.aborted ||
          this.closed ||
          hashContext(this.workbenchScope() ?? {}) !== hashContext(scope)
        )
          return false
        this.ledger.central.acknowledgeReconciliationApplied(attempt.executionId, ack, Date.now())
      } catch {
        return false
      }
    }
    return true
  }
  private async flushRequestSealApplications(signal: AbortSignal): Promise<boolean> {
    const scope = this.workbenchScope()
    if (!scope || !this.client.requestSealApplied) return false
    for (const attempt of this.ledger.central.pendingRequestSealApplications(scope)) {
      if (
        signal.aborted ||
        this.closed ||
        hashContext(this.workbenchScope() ?? {}) !== hashContext(scope)
      )
        return false
      const result = this.ledger.central.requestSeal(attempt.executionId)!.result!
      if (result.status !== 'request_sealed') return false
      try {
        const ack = await this.step((s) => this.client.requestSealApplied!(result.seal, s), signal)
        if (
          signal.aborted ||
          this.closed ||
          hashContext(this.workbenchScope() ?? {}) !== hashContext(scope)
        )
          return false
        this.ledger.central.acknowledgeRequestSeal(attempt.executionId, ack, Date.now())
      } catch {
        return false
      }
    }
    return true
  }
  async workbenchAction(input: unknown): Promise<WorkbenchResult> {
    if (this.evaluationReadOnly) return { success: false, code: 'unavailable' }
    const parsed = WorkbenchActionSchema.safeParse(input)
    if (!parsed.success) return { success: false, code: 'invalid_input' }
    const scope = this.workbenchScope()
    if (!scope || this.closed) return { success: false, code: 'unavailable' }
    try {
      const record = this.ledger.replies.get(scope, parsed.data.taskId)
      if (!record || this.workbenchRow(record).version !== parsed.data.expectedVersion)
        return { success: false, code: 'task_changed' }
      const task = record.task,
        binding = this.agent.currentBinding(task.conversationId)
      if (!binding || hashContext(workbenchScopeOf(binding.identity)) !== hashContext(scope))
        return { success: false, code: 'unavailable' }
      let stopAcknowledged = true
      if (parsed.data.action === 'takeover') {
        this.editing.get(task.conversationId)?.abort()
        this.agent.takeOver(binding)
        stopAcknowledged = await this.agent.sender.cancelConversation(
          binding.identity,
          binding.conversationId
        )
      } else if (parsed.data.action === 'release') {
        if (!this.workbenchRow(record).canRelease)
          return { success: false, code: 'execution_pending' }
        this.agent.releaseToAutomation(binding)
        this.editing.get(task.conversationId)?.abort()
      } else {
        if (!this.workbenchRow(record).canSkip || !this.agent.skipTask(task))
          return { success: false, code: 'task_changed' }
      }
      // A device re-registration/pause can happen while takeover waits for quiescence.
      const currentScope = this.workbenchScope()
      if (!currentScope || hashContext(currentScope) !== hashContext(scope))
        return { success: false, code: 'unavailable' }
      return { success: true, snapshot: this.workbench(), stopAcknowledged }
    } catch {
      await this.pause('local_storage_unavailable')
      return { success: false, code: 'storage_unavailable' }
    }
  }
  async workbenchReviewEdited(input: unknown): Promise<WorkbenchResult> {
    if (this.evaluationReadOnly) return { success: false, code: 'unavailable' }
    const parsed = WorkbenchEditSchema.safeParse(input)
    if (!parsed.success) return { success: false, code: 'invalid_input' }
    const scope = this.workbenchScope()
    if (
      !scope ||
      this.closed ||
      this.state !== 'running' ||
      !this.controller ||
      this.controller.signal.aborted
    )
      return { success: false, code: 'unavailable' }
    let request: EditedReviewInput
    try {
      const record = this.ledger.replies.get(scope, parsed.data.taskId)
      if (
        !record ||
        this.workbenchRow(record).version !== parsed.data.expectedVersion ||
        !this.workbenchRow(record).canReview
      )
        return { success: false, code: 'task_changed' }
      request = await this.agent.prepareEditedReview(
        record.task,
        parsed.data.text,
        this.controller.signal
      )
    } catch (error) {
      if (
        error instanceof z.ZodError ||
        (error instanceof Error && error.message === 'edit_task_unavailable')
      )
        return { success: false, code: 'task_changed' }
      await this.pause('local_storage_unavailable')
      return { success: false, code: 'storage_unavailable' }
    }
    const task = request.generation.task,
      generation = this.generation,
      controller = new AbortController(),
      signal = AbortSignal.any([this.controller.signal, controller.signal])
    this.editing.set(task.conversationId, controller)
    try {
      const result = parseEditedReviewResult(
        await this.step(
          (s) => this.client.reviewEdited(request, s),
          signal,
          Math.min(55000, task.expiresAt - Date.now())
        ),
        request
      )
      const currentScope = this.workbenchScope()
      if (result.review && result.review.modelResolved !== this.configuration?.modelResolved)
        throw new Error('edited_review_model_changed')
      if (
        signal.aborted ||
        this.state !== 'running' ||
        generation !== this.generation ||
        !currentScope ||
        hashContext(currentScope) !== hashContext(scope) ||
        !this.agent.editedReviewCurrent(task)
      ) {
        this.ledger.replies.update(task.identity, task.taskId, { status: 'obsolete' }, Date.now())
        return { success: false, code: 'task_changed' }
      }
      this.ledger.replies.update(
        task.identity,
        task.taskId,
        {
          status: 'needs_human',
          assessmentComplete: true,
          reasons: result.reasons,
          ...(result.explanation ? { explanation: result.explanation } : {}),
          ...(result.review ? { review: result.review } : {})
        },
        Date.now()
      )
      return { success: true, snapshot: this.workbench(), stopAcknowledged: true }
    } catch {
      if (this.closed) return { success: false, code: 'unavailable' }
      try {
        this.ledger.replies.update(task.identity, task.taskId, { status: 'obsolete' }, Date.now())
      } catch {
        await this.pause('local_storage_unavailable')
        return { success: false, code: 'storage_unavailable' }
      }
      return { success: false, code: 'review_unavailable' }
    } finally {
      if (this.editing.get(task.conversationId) === controller)
        this.editing.delete(task.conversationId)
    }
  }
  private workbenchScope(): WorkbenchScope | undefined {
    const scope = this.client.status().scope
    return scope
      ? WorkbenchScopeSchema.parse({
          tenantId: scope.tenant_id,
          employeeId: scope.employee_id,
          accountId: scope.account_id,
          agentId: scope.agent_id,
          platform: scope.platform
        })
      : undefined
  }
  restorationStatus(): RestorationStatus {
    if (this.closed) return { state: 'context_unavailable' }
    try {
      if (!this.ledger.requiresRestoreReview()) return { state: 'not_required' }
      const context = this.ledger.restoreContext()
      if (!context) return { state: 'context_unavailable' }
      const scopeHash = hashContext(this.client.status().scope ?? {})
      const scope = this.client.status().scope
      if (scope && this.ledger.hasRestoreApplicationAck(scope))
        return { state: 'quarantine_recorded' }
      if (
        this.restorationInventoryReceipt?.contextHash === context.contextHash &&
        this.restorationInventoryReceipt.scopeHash === scopeHash
      )
        return { state: 'inventory_received' }
      return {
        state:
          this.restorationReceipt?.contextHash === context.contextHash &&
          this.restorationReceipt.scopeHash === scopeHash
            ? 'pause_report_recorded'
            : 'review_required'
      }
    } catch {
      return { state: 'context_unavailable' }
    }
  }
  async submitRestorePause(input: unknown): Promise<RestorationSubmitResult> {
    if (!z.strictObject({}).safeParse(input).success)
      return { success: false, code: 'invalid_input' }
    if (
      this.closed ||
      this.restorationApplying ||
      this.restorationDiscovering ||
      this.restorationReporting ||
      !this.client.lookupRestoration
    )
      return { success: false, code: 'unavailable' }
    this.restorationDiscovering = true
    let controller: AbortController | undefined
    let localOperation = true
    try {
      const context = this.ledger.restoreContext(),
        scope = this.client.status().scope
      if (!context || !scope || !this.ledger.requiresRestoreReview())
        return { success: false, code: 'unavailable' }
      const scopeHash = hashContext(scope),
        generation = this.generation
      controller = this.controller = new AbortController()
      localOperation = false
      const found = RestoreLookupResultSchema.parse(
        await this.step(
          (signal) =>
            this.client.lookupRestoration!(
              { restoreId: context.restoreId, contextHash: context.contextHash },
              signal
            ),
          controller.signal
        )
      )
      localOperation = true
      if (
        this.closed ||
        controller.signal.aborted ||
        generation !== this.generation ||
        hashContext(this.client.status().scope ?? {}) !== scopeHash ||
        hashContext(this.ledger.restoreContext()) !== hashContext(context)
      )
        return { success: false, code: 'device_changed' }
      if (
        hashContext(found.scope) !== scopeHash ||
        found.restoreId !== context.restoreId ||
        found.contextHash !== context.contextHash
      )
        return { success: false, code: 'unavailable' }
      let attempt = this.restorationAttempt
      if (
        !attempt ||
        attempt.caseId !== found.caseId ||
        attempt.scopeHash !== scopeHash ||
        attempt.contextHash !== context.contextHash ||
        attempt.generation !== generation ||
        (attempt.expiresAt !== undefined && Date.now() >= attempt.expiresAt)
      ) {
        attempt = this.restorationAttempt = {
          caseId: found.caseId,
          requestId: randomUUID(),
          scopeHash,
          contextHash: context.contextHash,
          generation,
          expiresAt: Date.now() + 30000
        }
      }
      localOperation = false
      const result = await this.reportRestorePause({
        caseId: attempt.caseId,
        requestId: attempt.requestId
      })
      if (!result.success && result.code === 'device_changed') this.restorationAttempt = undefined
      else if (this.restorationAttempt === attempt) attempt.generation = this.generation
      if (!result.success) return result
      this.restorationReceipt = { scopeHash, contextHash: context.contextHash }
      return { ...result, caseId: found.caseId }
    } catch {
      if (controller?.signal.aborted) return { success: false, code: 'device_changed' }
      return { success: false, code: localOperation ? 'local_storage_unavailable' : 'unavailable' }
    } finally {
      controller?.abort()
      if (this.controller === controller) this.controller = undefined
      this.restorationDiscovering = false
    }
  }
  async submitRestoreInventory(input: unknown): Promise<RestorationInventorySubmitResult> {
    if (!z.strictObject({}).safeParse(input).success)
      return { success: false, code: 'invalid_input' }
    if (
      this.closed ||
      this.restorationApplying ||
      this.restorationUploading ||
      !this.client.startRestoreInventory ||
      !this.client.submitRestoreInventoryPage ||
      !this.client.completeRestoreInventory
    )
      return { success: false, code: 'unavailable' }
    this.restorationUploading = true
    let controller: AbortController | undefined,
      snapshot: ReturnType<typeof createRestoreInventorySnapshot> | undefined,
      localOperation = true
    try {
      this.restorationSnapshotCleanup?.()
      this.restorationSnapshotCleanup = undefined
      const paused = await this.submitRestorePause({})
      if (!paused.success) return paused
      const context = this.ledger.restoreContext(),
        status = this.client.status(),
        scope = status.scope,
        serverUrl = status.serverUrl
      if (!context || !scope || !serverUrl || !this.ledger.requiresRestoreReview())
        return { success: false, code: 'unavailable' }
      const generation = this.generation,
        scopeHash = hashContext(scope)
      controller = this.controller = new AbortController()
      const current = (): boolean =>
        !this.closed &&
        !controller!.signal.aborted &&
        generation === this.generation &&
        this.state === 'paused' &&
        this.observerStopped &&
        this.agent.sender.isPaused() &&
        this.agent.sender.isQuiescent() &&
        this.central.isQuiescent() &&
        this.lease.status() === 'stopped' &&
        hashContext(this.client.status().scope ?? {}) === scopeHash &&
        this.client.status().serverUrl === serverUrl &&
        hashContext(this.ledger.restoreContext()) === hashContext(context)
      if (!current()) return { success: false, code: 'device_changed' }
      snapshot = createRestoreInventorySnapshot(this.ledger, scope)
      const manifest = snapshot.manifest,
        sourceKey = hashContext({
          serverUrl,
          caseId: paused.caseId,
          manifestHash: hashContext(manifest)
        })
      const request =
        this.ledger.restoreInventoryAttempt(sourceKey, Date.now()) ??
        this.ledger.saveRestoreInventoryAttempt(
          sourceKey,
          {
            caseId: paused.caseId,
            requestId: randomUUID(),
            challengeId: paused.challengeId,
            manifest
          },
          Date.now()
        )
      if (
        request.caseId !== paused.caseId ||
        hashContext(request.manifest) !== hashContext(manifest) ||
        !current()
      )
        return { success: false, code: 'device_changed' }
      localOperation = false
      const start = RestoreInventoryStartAckSchema.parse(
        await this.step(
          (signal) => this.client.startRestoreInventory!(request, signal),
          controller.signal
        )
      )
      if (!current()) return { success: false, code: 'device_changed' }
      if (start.manifestHash !== hashContext(manifest) || Date.now() >= start.expiresAt)
        return { success: false, code: 'unavailable' }
      let pageCount = 0,
        itemCount = 0
      for await (const items of snapshot.pages()) {
        if (!current()) return { success: false, code: 'device_changed' }
        const page = { uploadId: start.uploadId, index: pageCount, items }
        const ack = RestoreInventoryPageAckSchema.parse(
          await this.step(
            (signal) => this.client.submitRestoreInventoryPage!(page, signal),
            controller.signal
          )
        )
        if (!current()) return { success: false, code: 'device_changed' }
        if (
          ack.uploadId !== start.uploadId ||
          ack.index !== pageCount ||
          ack.pageHash !== hashContext(page) ||
          ack.itemCount !== items.length
        )
          return { success: false, code: 'unavailable' }
        pageCount++
        itemCount += items.length
      }
      if (itemCount !== manifest.summary.messages + manifest.summary.executions)
        return { success: false, code: 'local_storage_unavailable' }
      const receipt = RestoreInventoryCompleteAckSchema.parse(
        await this.step(
          (signal) =>
            this.client.completeRestoreInventory!({ uploadId: start.uploadId, pageCount }, signal),
          controller.signal
        )
      )
      if (!current()) return { success: false, code: 'device_changed' }
      if (
        receipt.uploadId !== start.uploadId ||
        receipt.manifestHash !== hashContext(manifest) ||
        receipt.basisHash !== manifest.basisHash ||
        receipt.itemCount !== itemCount ||
        receipt.pageCount !== pageCount
      )
        return { success: false, code: 'unavailable' }
      this.restorationInventoryReceipt = { scopeHash, contextHash: context.contextHash }
      return { success: true, caseId: paused.caseId, ...receipt }
    } catch (error) {
      if (error instanceof RestoreInventorySnapshotError)
        this.restorationSnapshotCleanup = error.cleanup
      if (controller?.signal.aborted) return { success: false, code: 'device_changed' }
      return { success: false, code: localOperation ? 'local_storage_unavailable' : 'unavailable' }
    } finally {
      controller?.abort()
      if (this.controller === controller) this.controller = undefined
      try {
        snapshot?.dispose()
      } catch {
        this.restorationSnapshotCleanup = snapshot!.dispose
        this.reason = 'local_storage_unavailable'
      } finally {
        this.restorationUploading = false
      }
    }
  }
  /** Internal recovery preparation. All identity and approval data come from the host,
   * not renderer input; central completion and local resolution are separate stages. */
  async applyRestoreRecoveryBoundary(input: unknown): Promise<RestorationBoundaryApplyResult> {
    return this.prepareRestoreRecovery(input, false)
  }
  async applyRestoreRecoveryExecutions(input: unknown): Promise<RestorationBoundaryApplyResult> {
    return this.prepareRestoreRecovery(input, true)
  }
  async prepareRestoreRecoveryReads(input: unknown): Promise<RestorationBoundaryApplyResult> {
    return this.prepareRestoreRecovery(input, true, true)
  }
  async acknowledgeRestoreRecovery(input: unknown): Promise<RestorationBoundaryApplyResult> {
    return this.prepareRestoreRecovery(input, true, true, true)
  }
  private async prepareRestoreRecovery(
    input: unknown,
    resolveExecutions: boolean,
    prepareReads = false,
    confirmCompletion = false
  ): Promise<RestorationBoundaryApplyResult> {
    if (!z.strictObject({}).safeParse(input).success)
      return { success: false, code: 'invalid_input' }
    if (
      this.closed ||
      this.restorationApplying ||
      this.restorationUploading ||
      this.restorationDiscovering ||
      this.restorationReporting ||
      !this.client.lookupRestoration ||
      !this.client.restoreLatestRecoveryBoundary ||
      (resolveExecutions && !this.client.restoreExecutionResolutions) ||
      (prepareReads && !this.client.restoreObservationGrant) ||
      (confirmCompletion && !this.client.acknowledgeRestoreRecovery)
    )
      return { success: false, code: 'unavailable' }
    this.restorationApplying = true
    let controller: AbortController | undefined,
      local = true
    try {
      const context = this.ledger.restoreContext(),
        status = this.client.status(),
        scope = status.scope,
        serverUrl = status.serverUrl
      if (!context || !scope || !serverUrl || !this.ledger.requiresRestoreReview())
        return { success: false, code: 'unavailable' }
      const stopping = this.pause('execution_reconciliation_required'),
        stoppingGeneration = this.generation,
        paused = await stopping
      const stopped = (): boolean =>
        this.state === 'paused' &&
        this.observerStopped &&
        this.agent.sender.isPaused() &&
        this.agent.sender.isQuiescent() &&
        this.central.isQuiescent() &&
        this.lease.status() === 'stopped'
      if (
        this.closed ||
        this.generation !== stoppingGeneration ||
        hashContext(this.client.status().scope ?? {}) !== hashContext(scope) ||
        this.client.status().serverUrl !== serverUrl ||
        hashContext(this.ledger.restoreContext()) !== hashContext(context)
      )
        return { success: false, code: 'device_changed' }
      if (!paused.pauseAcknowledged || !stopped())
        return { success: false, code: 'execution_pending' }
      controller = this.controller = new AbortController()
      const current = (): boolean =>
        !this.closed &&
        !controller!.signal.aborted &&
        this.generation === stoppingGeneration &&
        stopped() &&
        hashContext(this.client.status().scope ?? {}) === hashContext(scope) &&
        this.client.status().serverUrl === serverUrl &&
        hashContext(this.ledger.restoreContext()) === hashContext(context)
      const confirm = async (
        intent: RestoreRecoveryCompletionInput
      ): Promise<RestorationBoundaryApplyResult> => {
        local = false
        const ack = parseRestoreRecoveryCompletionReceipt(
          await this.step(
            (signal) => this.client.acknowledgeRestoreRecovery!(intent, scope, signal),
            controller!.signal
          ),
          intent
        )
        if (!current()) return { success: false, code: 'device_changed' }
        local = true
        this.ledger.saveRestoreCompletionAck(scope, ack)
        if (!current()) return { success: false, code: 'device_changed' }
        return { success: true, status: 'completion_recorded', canRelease: false }
      }
      if (confirmCompletion) {
        const intent = this.ledger.restoreCompletionIntent(scope)
        if (intent) return await confirm(intent)
      }
      local = false
      const found = RestoreLookupResultSchema.parse(
        await this.step(
          (signal) =>
            this.client.lookupRestoration!(
              { restoreId: context.restoreId, contextHash: context.contextHash },
              signal
            ),
          controller.signal
        )
      )
      if (!current()) return { success: false, code: 'device_changed' }
      if (
        hashContext(found.scope) !== hashContext(scope) ||
        found.restoreId !== context.restoreId ||
        found.contextHash !== context.contextHash
      )
        return { success: false, code: 'unavailable' }
      const approved = RestoreRecoveryPackageSchema.parse(
        await this.step(
          (signal) =>
            this.client.restoreLatestRecoveryBoundary!(
              {
                caseId: found.caseId,
                restoreId: context.restoreId,
                contextHash: context.contextHash
              },
              scope,
              signal
            ),
          controller.signal
        )
      )
      if (!current()) return { success: false, code: 'device_changed' }
      if (
        hashContext(approved.authorization.scope) !== hashContext(scope) ||
        approved.authorization.caseId !== found.caseId ||
        hashContext(approved.boundary.manifest.context) !== hashContext(context)
      )
        return { success: false, code: 'unavailable' }
      local = true
      this.ledger.applyRestoreRecoveryBoundary(scope, approved, Date.now())
      if (!current()) return { success: false, code: 'device_changed' }
      if (resolveExecutions) {
        local = false
        const resolutions = parseRestoreResolutionPackage(
          await this.step(
            (signal) =>
              this.client.restoreExecutionResolutions!(
                {
                  caseId: approved.authorization.caseId,
                  restoreId: context.restoreId,
                  contextHash: context.contextHash,
                  authorizationId: approved.authorization.authorizationId
                },
                approved,
                signal
              ),
            controller.signal
          ),
          approved
        )
        if (!current()) return { success: false, code: 'device_changed' }
        local = true
        this.ledger.applyRestoreExecutionResolutions(scope, resolutions, Date.now())
        if (!current()) return { success: false, code: 'device_changed' }
        if (prepareReads) {
          local = false
          const grant = parseRestoreObservationGrant(
            await this.step(
              (signal) =>
                this.client.restoreObservationGrant!(
                  {
                    caseId: approved.authorization.caseId,
                    restoreId: context.restoreId,
                    contextHash: context.contextHash,
                    authorizationId: approved.authorization.authorizationId
                  },
                  approved,
                  signal
                ),
              controller.signal
            ),
            approved
          )
          if (!current()) return { success: false, code: 'device_changed' }
          local = true
          this.ledger.installRestoreObservationGrant(scope, grant, Date.now())
          if (!current()) return { success: false, code: 'device_changed' }
          if (confirmCompletion)
            return await confirm(
              this.ledger.prepareRestoreCompletion(
                scope,
                approved.authorization.authorizationId,
                grant,
                Date.now()
              )
            )
          return { success: true, status: 'reads_prepared', canRelease: false }
        }
        return { success: true, status: 'executions_recorded', canRelease: false }
      }
      return { success: true, status: 'boundary_recorded', canRelease: false }
    } catch {
      if (controller?.signal.aborted) return { success: false, code: 'device_changed' }
      return { success: false, code: local ? 'local_storage_unavailable' : 'unavailable' }
    } finally {
      controller?.abort()
      if (this.controller === controller) this.controller = undefined
      this.restorationApplying = false
    }
  }
  async applyRestoreDecision(input: unknown): Promise<RestorationApplyResult> {
    if (!z.strictObject({}).safeParse(input).success)
      return { success: false, code: 'invalid_input' }
    if (
      this.closed ||
      this.restorationApplying ||
      this.restorationUploading ||
      this.restorationDiscovering ||
      this.restorationReporting ||
      !this.client.lookupRestoration ||
      !this.client.restoreLatestApplicationDecision ||
      !this.client.acknowledgeRestoreApplication
    )
      return { success: false, code: 'unavailable' }
    this.restorationApplying = true
    let controller: AbortController | undefined,
      local = true
    try {
      const context = this.ledger.restoreContext(),
        status = this.client.status(),
        scope = status.scope,
        serverUrl = status.serverUrl
      if (!context || !scope || !serverUrl || !this.ledger.requiresRestoreReview())
        return { success: false, code: 'unavailable' }
      const stopping = this.pause('execution_reconciliation_required'),
        stoppingGeneration = this.generation
      const paused = await stopping
      const stopped = (): boolean =>
        this.state === 'paused' &&
        this.observerStopped &&
        this.agent.sender.isPaused() &&
        this.agent.sender.isQuiescent() &&
        this.central.isQuiescent() &&
        this.lease.status() === 'stopped'
      if (
        this.closed ||
        this.generation !== stoppingGeneration ||
        hashContext(this.client.status().scope ?? {}) !== hashContext(scope) ||
        this.client.status().serverUrl !== serverUrl ||
        hashContext(this.ledger.restoreContext()) !== hashContext(context)
      )
        return { success: false, code: 'device_changed' }
      if (!paused.pauseAcknowledged || !stopped())
        return { success: false, code: 'execution_pending' }
      controller = this.controller = new AbortController()
      const current = (): boolean =>
        !this.closed &&
        !controller!.signal.aborted &&
        this.generation === stoppingGeneration &&
        stopped() &&
        hashContext(this.client.status().scope ?? {}) === hashContext(scope) &&
        this.client.status().serverUrl === serverUrl &&
        hashContext(this.ledger.restoreContext()) === hashContext(context)
      local = false
      const found = RestoreLookupResultSchema.parse(
        await this.step(
          (signal) =>
            this.client.lookupRestoration!(
              { restoreId: context.restoreId, contextHash: context.contextHash },
              signal
            ),
          controller.signal
        )
      )
      if (!current()) return { success: false, code: 'device_changed' }
      if (
        hashContext(found.scope) !== hashContext(scope) ||
        found.restoreId !== context.restoreId ||
        found.contextHash !== context.contextHash
      )
        return { success: false, code: 'unavailable' }
      const decision = RestoreApplicationDecisionSchema.parse(
        await this.step(
          (signal) =>
            this.client.restoreLatestApplicationDecision!(
              {
                caseId: found.caseId,
                restoreId: context.restoreId,
                contextHash: context.contextHash
              },
              scope,
              signal
            ),
          controller.signal
        )
      )
      if (!current()) return { success: false, code: 'device_changed' }
      if (
        hashContext(decision.scope) !== hashContext(scope) ||
        decision.decision.caseId !== found.caseId ||
        hashContext(decision.manifest.context) !== hashContext(context)
      )
        return { success: false, code: 'unavailable' }
      local = true
      const receipt = this.ledger.applyRestoreDecision(scope, decision, Date.now())
      if (!current()) return { success: false, code: 'device_changed' }
      local = false
      const ack = RestoreApplicationAckSchema.parse(
        await this.step(
          (signal) => this.client.acknowledgeRestoreApplication!(receipt, signal),
          controller.signal
        )
      )
      if (!current()) return { success: false, code: 'device_changed' }
      local = true
      this.ledger.saveRestoreApplicationAck(receipt, ack)
      return { success: true, status: 'quarantine_recorded', canRelease: false }
    } catch {
      if (controller?.signal.aborted) return { success: false, code: 'device_changed' }
      return { success: false, code: local ? 'local_storage_unavailable' : 'unavailable' }
    } finally {
      controller?.abort()
      if (this.controller === controller) this.controller = undefined
      this.restorationApplying = false
    }
  }
  async reportRestorePause(input: unknown): Promise<
    | ({ success: true } & RestorePauseAck)
    | {
        success: false
        code:
          | 'invalid_input'
          | 'unavailable'
          | 'execution_pending'
          | 'device_changed'
          | 'local_storage_unavailable'
      }
  > {
    const request = z.strictObject({ caseId: z.uuid(), requestId: z.uuid() }).safeParse(input)
    if (!request.success) return { success: false, code: 'invalid_input' }
    if (
      this.closed ||
      this.restorationApplying ||
      this.restorationReporting ||
      !this.client.restorePauseChallenge ||
      !this.client.reportRestorePause
    )
      return { success: false, code: 'unavailable' }
    const scope = this.client.status().scope
    if (!scope) return { success: false, code: 'unavailable' }
    this.restorationReporting = true
    let controller: AbortController | undefined
    let localOperation = true
    try {
      const context = this.ledger.restoreContext()
      if (!context || !this.ledger.requiresRestoreReview())
        return { success: false, code: 'unavailable' }
      const stopped = (): boolean =>
        this.state === 'paused' &&
        this.observerStopped &&
        this.agent.sender.isPaused() &&
        this.agent.sender.isQuiescent() &&
        this.central.isQuiescent() &&
        this.lease.status() === 'stopped'
      if (!stopped() || this.restorationPausedGeneration !== this.generation) {
        const stopping = this.pause('execution_reconciliation_required'),
          stoppingGeneration = this.generation
        const paused = await stopping
        if (
          this.closed ||
          this.generation !== stoppingGeneration ||
          hashContext(this.client.status().scope ?? {}) !== hashContext(scope) ||
          hashContext(this.ledger.restoreContext()) !== hashContext(context)
        )
          return { success: false, code: 'device_changed' }
        if (
          !paused.pauseAcknowledged ||
          paused.reason === 'local_storage_unavailable' ||
          !stopped()
        )
          return { success: false, code: 'execution_pending' }
        this.restorationPausedGeneration = stoppingGeneration
      }
      const generation = this.generation
      controller = this.controller = new AbortController()
      const current = (): boolean =>
        !this.closed &&
        generation === this.generation &&
        !controller!.signal.aborted &&
        stopped() &&
        hashContext(this.client.status().scope ?? {}) === hashContext(scope) &&
        hashContext(this.ledger.restoreContext()) === hashContext(context)
      localOperation = false
      const c = RestorePauseChallengeSchema.parse(
        await this.step(
          (signal) =>
            this.client.restorePauseChallenge!(
              { ...request.data, restoreId: context.restoreId, contextHash: context.contextHash },
              signal
            ),
          controller.signal
        )
      )
      if (!current()) return { success: false, code: 'device_changed' }
      if (
        c.caseId !== request.data.caseId ||
        c.requestId !== request.data.requestId ||
        hashContext(c.scope) !== hashContext(scope) ||
        hashContext(c.context) !== hashContext(context) ||
        Date.now() >= c.expiresAt
      )
        return { success: false, code: 'unavailable' }
      localOperation = true
      if (
        this.restorationAttempt?.requestId === c.requestId &&
        this.restorationAttempt.caseId === c.caseId
      )
        this.restorationAttempt.expiresAt = c.expiresAt
      let report = this.ledger.restorePauseReport(c.challengeId)
      if (report) {
        if (
          report.instanceId !== this.restoreInstanceId ||
          report.runtimeGeneration !== generation ||
          hashContext(report.challenge) !== hashContext(c)
        )
          return { success: false, code: 'unavailable' }
      } else {
        const now = Date.now()
        report = this.ledger.saveRestorePauseReport({
          challenge: c,
          instanceId: this.restoreInstanceId,
          runtimeGeneration: generation,
          stoppedAt: now,
          observedAt: now,
          stopped: {
            observerStopped: true,
            senderQuiescent: true,
            settlementQuiescent: true,
            leaseStopped: true,
            platformStopped: true
          }
        })
      }
      if (!current()) return { success: false, code: 'device_changed' }
      localOperation = false
      const ack = RestorePauseAckSchema.parse(
        await this.step(
          (signal) => this.client.reportRestorePause!(report!, signal),
          controller.signal
        )
      )
      if (!current()) return { success: false, code: 'device_changed' }
      if (ack.challengeId !== c.challengeId || ack.reportHash !== hashContext(report))
        return { success: false, code: 'unavailable' }
      return { success: true, ...ack }
    } catch {
      if (controller?.signal.aborted) return { success: false, code: 'device_changed' }
      return { success: false, code: localOperation ? 'local_storage_unavailable' : 'unavailable' }
    } finally {
      if (this.controller === controller) this.controller = undefined
      this.restorationReporting = false
    }
  }
  async workbenchEvidence(input: unknown): Promise<WorkbenchEvidenceResult> {
    const parsed = WorkbenchEvidenceInputSchema.safeParse(input),
      scope = this.workbenchScope()
    if (!parsed.success) return { success: false, code: 'invalid_input' }
    if (!scope || this.closed || !this.client.assessmentEvidence || this.evidenceReads >= 2)
      return { success: false, code: 'unavailable' }
    this.evidenceReads++
    try {
      const record = this.ledger.replies.get(scope, parsed.data.taskId)
      if (
        !record?.draft ||
        !this.workbenchRow(record).canReadEvidence ||
        this.workbenchRow(record).version !== parsed.data.expectedVersion
      )
        return { success: false, code: 'task_changed' }
      const task = {
        ...record.task,
        taskId: record.humanConfirmation?.sourceTaskId ?? record.task.taskId
      }
      const request = {
        taskId: task.taskId,
        contextHash: task.contextHash,
        knowledgeVersion: task.knowledgeVersion,
        draftHash: record.draft.draftHash,
        draftRevision: record.draft.draftRevision,
        offset: parsed.data.offset
      }
      const page = parseAssessmentEvidencePage(
        await this.step(
          (signal) => this.client.assessmentEvidence!(task, record.draft!, request.offset, signal),
          new AbortController().signal
        ),
        request
      )
      if (this.closed || hashContext(this.workbenchScope() ?? {}) !== hashContext(scope))
        return { success: false, code: 'task_changed' }
      const current = this.ledger.replies.get(scope, parsed.data.taskId)
      if (!current || this.workbenchRow(current).version !== parsed.data.expectedVersion)
        return { success: false, code: 'task_changed' }
      if (
        page.totalAvailable + page.unavailableReferences !== record.draft.evidenceIds.length ||
        page.evidence.some((e) => !record.draft!.evidenceIds.includes(e.evidenceId))
      )
        return { success: false, code: 'unavailable' }
      return { success: true, page }
    } catch {
      return { success: false, code: 'unavailable' }
    } finally {
      this.evidenceReads--
    }
  }

  async workbenchConfirmSend(input: unknown): Promise<WorkbenchResult> {
    if (this.evaluationReadOnly) return { success: false, code: 'unavailable' }
    const parsed = WorkbenchConfirmSchema.safeParse(input),
      scope = this.workbenchScope()
    if (!parsed.success) return { success: false, code: 'invalid_input' }
    if (!scope || this.closed || this.state !== 'running')
      return { success: false, code: 'unavailable' }
    let prepared: ReturnType<ReliableAgent['prepareHumanSend']>
    try {
      const record = this.ledger.replies.get(scope, parsed.data.taskId)
      if (
        !record ||
        this.workbenchRow(record).version !== parsed.data.expectedVersion ||
        !this.workbenchRow(record).canConfirm
      )
        return { success: false, code: 'task_changed' }
      prepared = this.agent.prepareHumanSend(record.task)
    } catch (error) {
      if (
        error instanceof z.ZodError ||
        (error instanceof Error && error.message === 'human_task_unavailable')
      )
        return { success: false, code: 'task_changed' }
      await this.pause('local_storage_unavailable')
      return { success: false, code: 'storage_unavailable' }
    }
    const task = prepared.task
    this.confirming.add(task.conversationId)
    try {
      // No wall-clock timeout pretends a physical operation has stopped. UI can
      // show an unconfirmed result while the sender continues tracking quiescence.
      const result = await this.agent.sendHumanConfirmed(prepared)
      if (this.closed || hashContext(this.workbenchScope() ?? {}) !== hashContext(scope))
        return { success: false, code: 'unavailable' }
      if (result.status === 'rejected') return { success: false, code: 'send_rejected' }
      return {
        success: true,
        snapshot: this.workbench(),
        stopAcknowledged: this.agent.sender.conversationQuiescent(
          task.identity,
          task.conversationId
        )
      }
    } catch {
      await this.pause('local_storage_unavailable')
      return { success: false, code: 'storage_unavailable' }
    } finally {
      this.confirming.delete(task.conversationId)
    }
  }
  private workbenchRow(record: LocalReplyRecord, learningPending = false): WorkbenchRow {
    const task = record.task,
      snapshot = this.ledger.conversationState(task.identity, task.conversationId),
      send = this.ledger.findTask(task.identity, task.taskId)
    const stopAcknowledged = this.agent.sender.conversationQuiescent(
      task.identity,
      task.conversationId
    )
    const unknown = this.ledger.hasUnknown(task.identity, task.conversationId)
    const reconciliationRequired =
      !!send && this.ledger.central.reconciliationRequired(send.executionId)
    const status = send
      ? send.status === 'confirmed'
        ? 'sent'
        : send.status === 'dispatching'
          ? 'sending'
          : send.status === 'unknown'
            ? 'unknown'
            : 'not_sent'
      : record.status
    return {
      taskId: task.taskId,
      canLearn:
        !this.evaluationReadOnly &&
        !!record.draft &&
        record.edited !== true &&
        this.learningSync.available(),
      learningPending,
      conversationId: task.conversationId,
      status,
      version: hashContext({
        scope: workbenchScopeOf(task.identity),
        revision: record.revision,
        conversationRevision: snapshot.revision,
        humanOwned: snapshot.humanOwned,
        status,
        reconciliationRequired,
        stopAcknowledged
      }),
      inboundPreview: record.inboundPreview,
      ...(record.draft ? { replyText: record.draft.text } : {}),
      createdAt: task.createdAt,
      updatedAt: record.updatedAt,
      ...(record.explanation ? { explanation: record.explanation } : {}),
      humanOwned: snapshot.humanOwned,
      stopAcknowledged,
      reconciliationRequired,
      canReconcile:
        !this.evaluationReadOnly &&
        reconciliationRequired &&
        ((!!this.client.sealExecutionRequest &&
          !!this.client.requestSealApplied &&
          (this.ledger.central.canSealRequest(send!.executionId) ||
            this.ledger.central.requestSeal(send!.executionId)?.result?.status ===
              'request_sealed')) ||
          (!!this.client.reconciliationChallenge &&
            !!this.client.reportReconciliation &&
            (!!this.ledger.central.reconciliationReport(send!.executionId) ||
              (!!this.platform?.inspectExecution && this.platform.capabilities().backgroundRead)))),
      canSkip:
        !this.evaluationReadOnly &&
        ['generating', 'ready', 'needs_human'].includes(record.status) &&
        !send &&
        !unknown &&
        stopAcknowledged &&
        !snapshot.hasGap &&
        snapshot.revision === task.conversationRevision,
      canRelease:
        !this.evaluationReadOnly &&
        snapshot.humanOwned &&
        stopAcknowledged &&
        !unknown &&
        !reconciliationRequired,
      canReview:
        !this.evaluationReadOnly &&
        this.state === 'running' &&
        this.ledger.collection.ready(task.identity, task.conversationId) &&
        !!this.identity &&
        sameIdentity(this.identity, task.identity) &&
        (['ready', 'needs_human'].includes(record.status) ||
          (record.edited === true &&
            record.status === 'obsolete' &&
            snapshot.revision === task.conversationRevision)) &&
        snapshot.humanOwned &&
        stopAcknowledged &&
        !send &&
        !unknown &&
        !snapshot.hasGap &&
        !this.editing.has(task.conversationId) &&
        !this.confirming.has(task.conversationId),
      canConfirm:
        !this.evaluationReadOnly &&
        this.state === 'running' &&
        this.ledger.collection.ready(task.identity, task.conversationId) &&
        !!this.identity &&
        sameIdentity(this.identity, task.identity) &&
        ['ready', 'needs_human'].includes(record.status) &&
        !!record.draft &&
        record.assessmentComplete === true &&
        snapshot.humanOwned &&
        stopAcknowledged &&
        !send &&
        !unknown &&
        !snapshot.hasGap &&
        !this.editing.has(task.conversationId) &&
        !this.confirming.has(task.conversationId),
      canReadEvidence:
        !!this.client.assessmentEvidence &&
        (record.assessmentComplete === true || !!record.humanConfirmation) &&
        !!record.draft?.evidenceIds.length,
      ...(record.reasons ? { reviewReasons: record.reasons } : {}),
      ...(record.review
        ? {
            reviewStatus:
              ['ready', 'needs_human'].includes(record.status) &&
              record.review.expiresAt > Date.now() &&
              record.review.contextHash === task.contextHash &&
              snapshot.revision === task.conversationRevision
                ? record.review.status
                : 'invalid',
            reviewReasons: [...new Set([...(record.reasons ?? []), ...record.review.reasons])]
          }
        : {})
    }
  }

  synchronize(): Promise<RuntimeStatus> {
    if (this.reconciling) return Promise.resolve(this.status())
    if (this.closed) return Promise.resolve(this.status())
    if (this.synchronizing) return this.synchronizing
    const work = this.synchronizeConfiguration()
    this.synchronizing = work
    const settled = (): void => {
      if (this.synchronizing === work) this.synchronizing = undefined
    }
    void work.then(settled, settled)
    return work
  }

  private async synchronizeConfiguration(): Promise<RuntimeStatus> {
    const stopping = this.pause('user_pause')
    const generation = this.generation
    const paused = await stopping
    if (
      this.closed ||
      generation !== this.generation ||
      !paused.pauseAcknowledged ||
      paused.reason === 'local_storage_unavailable'
    )
      return this.status()
    try {
      if (this.ledger.requiresRestoreReview())
        return this.block('execution_reconciliation_required')
    } catch {
      return this.block('local_storage_unavailable')
    }
    if (!this.client.status().scope) {
      this.state = 'blocked'
      this.reason = 'not_registered'
      return this.status()
    }
    const controller = (this.controller = new AbortController())
    try {
      await this.step((signal) => this.central.flushReceipts(signal), controller.signal)
      await this.flushReconciliationApplications(controller.signal)
      await this.flushRequestSealApplications(controller.signal)
      if (!this.current(generation, controller)) return this.status()
      const configuration = await this.step(
        (signal) => this.client.configuration(signal),
        controller.signal
      )
      if (controller.signal.aborted || this.closed || generation !== this.generation)
        return this.status()
      if (this.evaluationReadOnly && configuration.automaticEnabled)
        throw new Error('evaluation_read_only_required')
      await this.agent.configure(configuration)
      if (this.closed || generation !== this.generation) return this.status()
      this.configuration = configuration
      const barrier = this.central.barrier()
      this.state = barrier.requiresReconciliation || barrier.pending > 0 ? 'blocked' : 'paused'
      this.reason = barrier.requiresReconciliation
        ? 'execution_reconciliation_required'
        : barrier.pending > 0
          ? 'settlement_pending'
          : 'none'
    } catch (error) {
      if (!this.closed && generation === this.generation) {
        this.configuration = undefined
        this.state = 'blocked'
        this.reason =
          error instanceof RunEpochPersistenceError
            ? 'local_storage_unavailable'
            : 'configuration_unavailable'
      } else if (this.pauseWork) await this.pauseWork
    }
    return this.status()
  }

  start(): Promise<RuntimeStatus> {
    if (this.reconciling) return Promise.resolve(this.status())
    if (this.starting) return this.starting
    const work = this.startCore()
    this.starting = work
    const settled = (): void => {
      if (this.starting === work) this.starting = undefined
    }
    void work.then(settled, settled)
    return work
  }

  private async startCore(): Promise<RuntimeStatus> {
    if (this.timingCaptureOpening) {
      const installingGeneration = this.generation
      await this.timingCaptureOpening.catch(() => {})
      if (this.closed || this.generation !== installingGeneration) return this.status()
    }
    if (this.closed || this.state === 'running' || this.state === 'starting') return this.status()
    const stopping = this.pause('user_pause')
    const generation = this.generation
    const paused = await stopping
    if (
      this.closed ||
      generation !== this.generation ||
      !paused.pauseAcknowledged ||
      paused.reason === 'local_storage_unavailable'
    )
      return this.status()
    try {
      if (this.ledger.requiresRestoreReview())
        return this.block('execution_reconciliation_required')
    } catch {
      return this.block('local_storage_unavailable')
    }
    if (!this.client.status().scope) return this.block('not_registered')
    const capabilities = this.platform?.capabilities()
    if (!capabilities?.backgroundRead || !capabilities.nonInterferingSend)
      return this.block('capability_unverified')
    const controller = (this.controller = new AbortController())
    this.state = 'starting'
    this.reason = 'none'
    let failure: RuntimeStatus['reason'] = 'identity_unverified'
    try {
      await this.step((signal) => this.central.flushReceipts(signal), controller.signal)
      await this.flushReconciliationApplications(controller.signal)
      await this.flushRequestSealApplications(controller.signal)
      if (!this.current(generation, controller)) return this.status()
      const barrier = this.central.barrier()
      if (barrier.requiresReconciliation) return this.block('execution_reconciliation_required')
      if (barrier.pending > 0) return this.block('settlement_pending')
      const binding = await this.step((signal) => this.platform!.binding(signal), controller.signal)
      if (!this.current(generation, controller)) return this.status()
      const scope = this.client.status().scope
      if (
        !scope ||
        binding.identity.tenantId !== scope.tenant_id ||
        binding.identity.employeeId !== scope.employee_id ||
        binding.identity.accountId !== scope.account_id ||
        binding.identity.agentId !== scope.agent_id ||
        binding.identity.platform !== scope.platform ||
        (binding.conversations.length === 0 && !this.platform?.collectionSource) ||
        binding.conversations.some(
          (b) => !b.identityVerified || !sameIdentity(b.identity, binding.identity)
        )
      )
        return this.block('identity_unverified')
      this.identity = structuredClone(binding.identity)
      failure = 'lease_lost'
      await this.lease.start(this.identity)
      if (!this.current(generation, controller)) return this.status()
      failure = 'configuration_unavailable'
      const configuration = await this.step(
        (signal) => this.client.configuration(signal),
        controller.signal
      )
      if (!this.current(generation, controller)) return this.status()
      if (this.evaluationReadOnly && configuration.automaticEnabled)
        throw new Error('evaluation_read_only_required')
      await this.agent.configure(configuration)
      if (!this.current(generation, controller)) return this.status()
      this.configuration = configuration
      this.agent.replaceBindings(this.platform!.collectionSource ? [] : binding.conversations)
      failure = 'observer_failed'
      this.observerStopped = false
      if (this.platform!.collectionSource) {
        this.collectionIdentity = structuredClone(binding.identity)
        this.collector = new ConversationCollector(
          this.ledger,
          binding.identity,
          this.platform!.collectionSource,
          {
            onTiming:
              this.onTiming || (this.timingCapture && !this.timingCaptureRetired)
                ? (event) =>
                    this.emitTiming({
                      runtimeInstanceId: this.runtimeInstanceId,
                      kind: 'collection',
                      event
                    })
                : undefined,
            onBindings: (bindings) => {
              if (!this.current(generation, controller)) return
              if (bindings.some((b) => !sameIdentity(b.identity, binding.identity)))
                throw new Error('collection_identity_changed')
              this.agent.discoverBindings(bindings)
            },
            onPending: (b) => {
              if (!this.current(generation, controller)) return
              this.agent.collectionPending(b)
              this.editing.get(b.conversationId)?.abort()
            },
            onRead: (b, messages, complete) => {
              if (this.current(generation, controller)) this.agent.collected(b, messages, complete)
            },
            onFailure: () => {
              if (this.current(generation, controller)) void this.pause('observer_failed')
            }
          }
        )
        // Collector has its own cancellable per-operation deadline. A large initial
        // page set is drained incrementally rather than extending startup indefinitely.
        await this.collector.start(controller.signal)
      } else
        await this.step(
          (signal) =>
            this.platform!.observe(
              (message) => {
                if (
                  !this.current(generation, controller) ||
                  !['starting', 'running'].includes(this.state)
                )
                  return
                try {
                  this.agent.observe(message)
                  this.editing.get(message.conversationId)?.abort()
                } catch {
                  void this.pause('observer_failed')
                }
              },
              () => {
                if (this.current(generation, controller)) void this.pause('observer_failed')
              },
              signal
            ),
          controller.signal
        )
      if (!this.current(generation, controller)) return this.status()
      if (!this.lease.current()) {
        await this.pause('lease_lost')
        return this.status()
      }
      this.state = 'running'
      this.agent.resume()
      return this.status()
    } catch (error) {
      if (this.current(generation, controller))
        await this.pause(
          error instanceof RunEpochPersistenceError
            ? 'local_storage_unavailable'
            : this.lease.status() === 'lost'
              ? 'lease_lost'
              : failure
        )
      else if (this.pauseWork) await this.pauseWork
      return this.status()
    }
  }

  pause(reason: RuntimeStatus['reason'] = 'user_pause'): Promise<RuntimeStatus> {
    if (this.closed) return Promise.resolve(this.status())
    this.generation++
    this.controller?.abort()
    for (const controller of this.editing.values()) controller.abort()
    this.lease.stop()
    this.identity = undefined
    this.reason = reason
    this.state = 'pausing'
    if (this.pauseWork) return this.pauseWork
    this.observerStopped = false
    const work = this.pauseCore()
    this.pauseWork = work
    const settled = (): void => {
      if (this.pauseWork === work) this.pauseWork = undefined
    }
    void work.then(settled, settled)
    return work
  }

  private async pauseCore(): Promise<RuntimeStatus> {
    // Invoke pause synchronously so sender cancellation precedes platform shutdown.
    // Always stop the observer, including when persisting the new epoch fails.
    const paused = this.agent.pause().catch(() => {
      this.reason = 'local_storage_unavailable'
    })
    if (!this.observerStopping) {
      const work = Promise.resolve()
        .then(async () => {
          await Promise.all([this.collector?.stop(), this.platform?.stop()])
        })
        .then(
          () => {
            this.observerStopped = true
            return true
          },
          () => false
        )
      this.observerStopping = work
      void work.then(() => {
        if (this.observerStopping === work) this.observerStopping = undefined
      })
    }
    await paused
    await this.central.quiescent()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.observerStopping,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1000)
        })
      ])
    } catch {
      /* Failed stop is not an acknowledgment. */
    } finally {
      if (timer) clearTimeout(timer)
    }
    return this.status()
  }

  close(): Promise<RuntimeStatus> {
    if (this.closed) return Promise.resolve(this.status())
    if (this.closing) return this.closing
    const work = this.closeCore()
    this.closing = work
    const settled = (): void => {
      if (this.closing === work) this.closing = undefined
    }
    void work.then(settled, settled)
    return work
  }

  private async closeCore(): Promise<RuntimeStatus> {
    this.learningGeneration++
    const stopping = this.pause('shutdown')
    await this.monitoring?.stop()
    await this.pauseConfirmation?.stop()
    this.learningForgetController?.abort()
    await this.learningDesktop?.stop()
    await this.submissionSync?.stop()
    await this.learningSync.stop()
    await this.learningForgetting?.catch(() => {})
    const status = await stopping
    if (status.pauseAcknowledged) {
      await this.timingCaptureOpening?.catch(() => {})
      // The observer and sender have acknowledged shutdown before sealing their evidence.
      // A journal fault remains insufficient; it must not prevent closing the reply ledger.
      if (!this.sharedEvaluationCapture) await this.timingCapture?.journal.close().catch(() => {})
      if (this.timingVault && this.timingCapture) {
        try {
          this.managedTimingReport = await this.timingVault.finishSession(
            this.timingCapture.journal,
            this.timingCaptureRetired
              ? undefined
              : () => this.timingCapture!.evidence.export(this.managedTimingEndpoint)
          )
        } catch {
          /* Missing or revoked evidence never becomes a successful measurement. */
        }
        await this.timingVault.shutdown().catch(() => {})
      }
      this.closed = true
      this.state = 'closed'
      this.ledger.close()
    }
    return this.status()
  }

  private block(reason: RuntimeStatus['reason']): RuntimeStatus {
    this.controller?.abort()
    this.lease.stop()
    this.state = 'blocked'
    this.reason = reason
    return this.status()
  }
  async deviceChanged(): Promise<RuntimeStatus> {
    this.learningGeneration++
    this.configuration = undefined
    const stopping = this.pause('user_pause')
    this.learningForgetController?.abort()
    await this.learningDesktop?.stop()
    await this.submissionSync?.cancel()
    await this.learningSync.cancel()
    await this.learningForgetting?.catch(() => {})
    return stopping
  }
  private current(generation: number, controller: AbortController): boolean {
    return !this.closed && generation === this.generation && !controller.signal.aborted
  }

  private async step<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    parent: AbortSignal,
    maximumMs = 5000
  ): Promise<T> {
    if (parent.aborted) throw new Error('runtime_cancelled')
    const controller = new AbortController()
    const signal = AbortSignal.any([parent, controller.signal])
    const timer = setTimeout(() => controller.abort(), Math.max(1, maximumMs))
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('runtime_cancelled'))
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
