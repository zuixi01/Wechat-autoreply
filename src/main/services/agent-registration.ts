import { randomUUID } from 'node:crypto'
import {
  RestoreRecoveryCompletionInputSchema,
  parseRestoreRecoveryCompletionReceipt,
  type RestoreRecoveryCompletionReceipt
} from '../../shared/contracts/restore-completion'
import {
  parseRestoreObservationGrant,
  type RestoreObservationGrant
} from '../../shared/contracts/restore-observation'
import {
  AccountPauseChallengeSchema,
  AccountPauseAckSchema,
  AccountPauseReportSchema,
  PauseChallengeInputSchema,
  type AccountPauseChallenge,
  type AccountPauseReport,
  type AccountPauseAck
} from '../../shared/contracts/runtime-pause'
import type { z as Zod } from 'zod'
import {
  RuntimeObservationSchema,
  RuntimeObservationReceiptSchema,
  type RuntimeObservation,
  type RuntimeObservationReceipt
} from '../../shared/contracts/runtime-monitoring'
import {
  RestoreApplicationLookupSchema,
  RestoreApplicationCurrentSchema,
  RestoreLocalApplicationReceiptSchema,
  RestoreApplicationAckSchema,
  type RestoreApplicationAck,
  RestoreApplicationDecisionSchema,
  type RestoreApplicationDecision
} from '../../shared/contracts/restore-application'
import {
  RestoreRecoveryCurrentSchema,
  RestoreRecoveryPackageSchema,
  type RestoreRecoveryPackage
} from '../../shared/contracts/restore-recovery'
import {
  RestoreResolutionLookupSchema,
  parseRestoreResolutionPackage,
  type RestoreResolutionPackage
} from '../../shared/contracts/restore-resolution'
import {
  RestoreChallengeInputSchema,
  RestoreLookupInputSchema,
  RestoreLookupResultSchema,
  type RestoreLookupResult,
  RestorePauseChallengeSchema,
  RestorePauseReportSchema,
  RestorePauseAckSchema,
  type RestorePauseChallenge,
  type RestorePauseReport,
  type RestorePauseAck
} from '../../shared/contracts/restoration'
import {
  RequestSealInputSchema,
  RequestSealSchema,
  RequestSealAckSchema,
  parseRequestSealResult,
  type RequestSealInput,
  type RequestSealResult,
  type RequestSeal,
  type RequestSealAck
} from '../../shared/contracts/request-seal'
import { z } from 'zod'
import {
  LearningModelDirectorySchema,
  type LearningModelDirectory
} from '../../shared/contracts/learning-model-directory'
import {
  RestoreInventoryStartSchema,
  RestoreInventoryPageSchema,
  RestoreInventoryCompleteSchema,
  RestoreInventoryStartAckSchema,
  RestoreInventoryPageAckSchema,
  RestoreInventoryCompleteAckSchema
} from '../../shared/contracts/restore-inventory'
import {
  DeviceScopeSchema,
  RegistrationInputSchema,
  type DeviceScope,
  type DeviceStatus,
  type RegistrationInput,
  type RegistrationResult
} from '../../shared/contracts/registration'
import {
  AgentConfigurationSchema,
  type GenerationInput,
  type GenerationResult
} from '../../shared/contracts/generation'
import { parseGenerationInput, parseGenerationResult } from '../../core/reply/generation-validation'
import { parsePreparedGenerationTask } from '../../core/reply/learning-task-binding'
import {
  LearningSettingsResponseSchema,
  LearningWorkbenchSnapshotSchema,
  LearningDesktopManagementRequests,
  LearningDetailResponseSchema,
  LearningMemoryRecordResponseSchema,
  LearningCalibrationResponseSchema,
  LearningReportsResponseSchema,
  LearningValidationResultResponseSchema,
  LearningCurationReportResponseSchema,
  type LearningReports
} from '../../shared/contracts/learning-management'
import {
  MemoryScopeSchema,
  LearningSettingsPatchSchema,
  type MemoryScope,
  type LearningSettings
} from '../../shared/contracts/learning-memory'
import {
  LearningActionSchema,
  type LearningAction,
  type LearningWorkbenchSnapshot
} from '../../shared/contracts/learning-desktop'
import type {
  MemoryRecord,
  MemoryRevision,
  MemoryContent,
  LearningCalibrationInput,
  LearningCalibrationSet,
  LearningValidationResult,
  LearningCurationReport
} from '../../shared/contracts/learning-memory'
import type { AgentConfiguration } from '../../core/agent/reliable-agent'
import { IdentitySchema, sameIdentity, type Identity } from '../../shared/contracts/identity'
import { LeaseGrantSchema, type LeaseGrant } from '../../shared/contracts/lease'
import {
  PermitRequestSchema,
  ExecutionPermitSchema,
  ExecutionReceiptSchema,
  type ExecutionPermit,
  type ExecutionReceipt
} from '../../shared/contracts/execution'
import type { PermitRequest } from '../../shared/contracts/execution'
import {
  parseReconciliationChallenge,
  DeviceReconciliationReportSchema,
  ReconciliationAcknowledgmentSchema,
  type DeviceReconciliationReport,
  type ReconciliationChallenge,
  type ReconciliationAcknowledgment
} from '../../shared/contracts/reconciliation'
import {
  parseReconciliationDecision,
  ReconciliationAppliedAckSchema,
  type ReconciliationDecision,
  type ReconciliationAppliedAck
} from '../../shared/contracts/reconciliation'
import {
  ReplyTaskSchema,
  ReplyDraftSchema,
  type ReplyTask,
  type ReplyDraft
} from '../../shared/contracts/task'
import { hashContext, hashDraft } from '../../core/reply/hashes'
import { learningHash } from '../../core/memory/learning-scope'
import {
  LearningDesktopRequests,
  type LearningMemoryDesktopApi
} from '../../shared/contracts/learning-desktop'
import {
  LearningEpisodeSchema,
  LearningCorrectionInputSchema,
  LearningResultInputSchema,
  LearningHumanFeedbackInputSchema,
  type LearningEpisode,
  type LearningCorrectionInput,
  type LearningResultInput,
  type LearningHumanFeedbackInput
} from '../../shared/contracts/learning-memory'
import type { EditedReviewInput, EditedReviewResult } from '../../shared/contracts/edited-review'
import {
  parseEditedReviewInput,
  parseEditedReviewResult
} from '../../core/reply/edited-review-validation'
import {
  HumanPermitRequestSchema,
  type HumanConfirmation
} from '../../shared/contracts/human-confirmation'
import {
  AssessmentEvidenceRequestSchema,
  parseAssessmentEvidencePage,
  type AssessmentEvidencePage
} from '../../shared/contracts/assessment-evidence'

export class DeviceRequestError extends Error {
  constructor(
    readonly code:
      | 'NOT_REGISTERED'
      | 'DEVICE_SCOPE_CHANGED'
      | 'UNAVAILABLE'
      | 'AUTHORIZATION_FAILED'
      | 'TASK_INVALIDATED'
      | 'OVERLOADED'
      | 'TIMEOUT'
      | 'CANCELLED'
      | 'INVALID_RESPONSE'
  ) {
    super(code)
    this.name = 'DeviceRequestError'
  }
}

export interface EncryptedDeviceRecord {
  serverUrl: string
  scope: DeviceScope
  encryptedCredential: string
}
export interface DeviceStore {
  load(): EncryptedDeviceRecord | undefined
  save(record: EncryptedDeviceRecord): void
}
export interface DeviceCredentialContext {
  serverUrl: string
  scope: DeviceScope
}
export interface SecretCipher {
  available(): boolean
  encrypt(value: string, context: DeviceCredentialContext): string
  decrypt(value: string, context: DeviceCredentialContext): string
}
const Registered = z.strictObject({
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  scope: DeviceScopeSchema
})

export function serverOrigin(input: string, allowLocalHttp: boolean): string {
  const url = new URL(input)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('invalid_server')
  if (
    url.protocol !== 'https:' &&
    !(allowLocalHttp && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))
  ) {
    throw new Error('insecure_server')
  }
  return url.origin
}

/** Main-process-only credential handling. Public methods never return plaintext or ciphertext. */
export class AgentRegistration {
  private registering = false
  constructor(
    private readonly store: DeviceStore,
    private readonly cipher: SecretCipher,
    private readonly transport: typeof fetch = fetch,
    private readonly allowLocalHttp = false
  ) {}

  status(): DeviceStatus {
    try {
      const record = this.store.load()
      return record
        ? {
            state: 'registered',
            serverUrl: record.serverUrl,
            scope: DeviceScopeSchema.parse(record.scope)
          }
        : { state: 'unregistered' }
    } catch {
      return { state: 'unavailable' }
    }
  }

  async register(input: RegistrationInput): Promise<RegistrationResult> {
    if (this.registering) return { success: false, code: 'already_registering' }
    const parsed = RegistrationInputSchema.safeParse(input)
    if (!parsed.success) return { success: false, code: 'invalid_input' }
    let origin: string
    try {
      origin = serverOrigin(parsed.data.serverUrl.trim(), this.allowLocalHttp)
    } catch {
      return { success: false, code: 'insecure_server' }
    }
    if (!this.cipher.available()) return { success: false, code: 'storage_unavailable' }
    this.registering = true
    try {
      const result = Registered.parse(
        await this.request(origin, '/v1/devices/register', {
          method: 'POST',
          body: JSON.stringify({
            enrollmentCode: parsed.data.enrollmentCode,
            agentId: randomUUID()
          }),
          headers: { 'Content-Type': 'application/json' }
        })
      )
      // Encryption/store failure is not retried: the server may already have consumed the code.
      const record = {
        serverUrl: origin,
        scope: result.scope,
        encryptedCredential: this.cipher.encrypt(result.credential, {
          serverUrl: origin,
          scope: result.scope
        })
      }
      this.store.save(record)
      return {
        success: true,
        status: { state: 'connected', serverUrl: origin, scope: result.scope }
      }
    } catch {
      return { success: false, code: 'registration_failed' }
    } finally {
      this.registering = false
    }
  }

  async refresh(): Promise<DeviceStatus> {
    let record: EncryptedDeviceRecord | undefined
    try {
      record = this.store.load()
      if (!record) return { state: 'unregistered' }
      if (!this.cipher.available()) return { ...this.status(), state: 'unavailable' }
      const origin = serverOrigin(record.serverUrl, this.allowLocalHttp)
      const credential = this.cipher.decrypt(record.encryptedCredential, {
        serverUrl: origin,
        scope: record.scope
      })
      if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error('invalid_credential')
      const scope = DeviceScopeSchema.parse(
        await this.request(origin, '/v1/device', {
          method: 'GET',
          headers: { Authorization: `Bearer ${credential}` }
        })
      )
      if (JSON.stringify(scope) !== JSON.stringify(DeviceScopeSchema.parse(record.scope)))
        throw new Error('device_scope_changed')
      return { state: 'connected', serverUrl: origin, scope }
    } catch {
      return { ...this.status(), state: 'unavailable' }
    }
  }

  /** Main-process methods only; never exposed as credential-bearing generic IPC. */
  async reportRuntimeStatus(
    input: RuntimeObservation,
    signal?: AbortSignal
  ): Promise<RuntimeObservationReceipt> {
    const observation = RuntimeObservationSchema.parse(structuredClone(input)),
      device = this.status()
    if (!device.scope || !device.serverUrl) throw new DeviceRequestError('NOT_REGISTERED')
    const expected = { serverUrl: device.serverUrl, scope: device.scope }
    const receipt = RuntimeObservationReceiptSchema.safeParse(
      await this.authorized('/v1/runtime/status', observation, signal, 2500, expected)
    )
    if (
      !receipt.success ||
      hashContext(receipt.data.scope) !== hashContext(expected.scope) ||
      receipt.data.reportHash !== hashContext(observation) ||
      receipt.data.runtimeEpoch !== observation.runtimeEpoch ||
      receipt.data.sequence !== observation.sequence
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return receipt.data
  }

  async configuration(signal?: AbortSignal): Promise<AgentConfiguration> {
    const result = await this.authorized('/v1/configuration', undefined, signal, 5000)
    try {
      return AgentConfigurationSchema.parse(result)
    } catch {
      throw new DeviceRequestError('INVALID_RESPONSE')
    }
  }

  async accountPauseChallenge(
    input: Zod.infer<typeof PauseChallengeInputSchema>,
    signal?: AbortSignal
  ): Promise<AccountPauseChallenge> {
    const request = PauseChallengeInputSchema.parse(structuredClone(input)),
      device = this.status()
    if (!device.scope || !device.serverUrl) throw new DeviceRequestError('NOT_REGISTERED')
    const expected = { scope: device.scope, serverUrl: device.serverUrl }
    const parsed = AccountPauseChallengeSchema.safeParse(
      await this.authorized('/v1/runtime/pause/challenge', request, signal, 2500, expected)
    )
    if (!parsed.success) throw new DeviceRequestError('INVALID_RESPONSE')
    const c = parsed.data
    if (
      hashContext(c.scope) !== hashContext(expected.scope) ||
      hashContext({
        requestId: c.requestId,
        attemptId: c.attemptId,
        runtime: c.runtime,
        instanceEpoch: c.instanceEpoch
      }) !== hashContext(request)
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return c
  }

  async confirmAccountPause(
    input: AccountPauseReport,
    signal?: AbortSignal
  ): Promise<AccountPauseAck> {
    const report = AccountPauseReportSchema.parse(structuredClone(input)),
      device = this.status()
    if (!device.scope || !device.serverUrl) throw new DeviceRequestError('NOT_REGISTERED')
    if (hashContext(report.challenge.scope) !== hashContext(device.scope))
      throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    const parsed = AccountPauseAckSchema.safeParse(
      await this.authorized('/v1/runtime/pause/report', report, signal, 2500, {
        scope: device.scope,
        serverUrl: device.serverUrl
      })
    )
    if (
      !parsed.success ||
      parsed.data.requestId !== report.challenge.requestId ||
      parsed.data.challengeId !== report.challenge.challengeId ||
      parsed.data.reportHash !== hashContext(report)
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return parsed.data
  }

  async acquireLease(input: Identity, signal?: AbortSignal): Promise<LeaseGrant> {
    const identity = IdentitySchema.parse(structuredClone(input))
    const expected = this.expectedScope(identity)
    const result = await this.authorized(
      '/v1/leases/acquire',
      {
        loginEpoch: identity.loginEpoch,
        clientInstanceId: identity.clientInstanceId
      },
      signal,
      2500,
      expected
    )
    const parsed = LeaseGrantSchema.safeParse(result)
    if (!parsed.success || !sameIdentity(parsed.data.identity, identity))
      throw new DeviceRequestError('INVALID_RESPONSE')
    return parsed.data
  }

  /** A duplicate permit is returned as metadata, never treated as permission to repeat an action. */
  async issueExecution(
    inputTask: ReplyTask,
    inputDraft: ReplyDraft,
    leaseVersion: number,
    signal?: AbortSignal
  ): Promise<ExecutionPermit> {
    const task = ReplyTaskSchema.parse(structuredClone(inputTask))
    const draft = ReplyDraftSchema.parse(structuredClone(inputDraft))
    if (draft.taskId !== task.taskId || hashDraft(draft.text) !== draft.draftHash)
      throw new DeviceRequestError('TASK_INVALIDATED')
    const expected = this.expectedScope(task.identity)
    const request = PermitRequestSchema.parse({
      taskId: task.taskId,
      taskHash: hashContext(task),
      draftHash: draft.draftHash,
      draftRevision: draft.draftRevision,
      loginEpoch: task.identity.loginEpoch,
      clientInstanceId: task.identity.clientInstanceId,
      leaseVersion
    })
    const result = await this.authorized('/v1/executions/issue', request, signal, 2500, expected)
    const parsed = ExecutionPermitSchema.safeParse(result)
    if (
      !parsed.success ||
      parsed.data.purpose === 'human' ||
      !sameIdentity(parsed.data.identity, task.identity) ||
      parsed.data.taskId !== task.taskId ||
      parsed.data.conversationId !== task.conversationId ||
      parsed.data.taskHash !== request.taskHash ||
      parsed.data.draftHash !== draft.draftHash ||
      parsed.data.draftRevision !== draft.draftRevision ||
      parsed.data.leaseVersion !== leaseVersion ||
      parsed.data.expiresAt <= parsed.data.issuedAt ||
      parsed.data.expiresAt - parsed.data.issuedAt > 5000 ||
      (parsed.data.newlyIssued && parsed.data.status !== 'issued')
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return parsed.data
  }

  async settleExecution(
    identity: Identity,
    input: ExecutionReceipt,
    signal?: AbortSignal
  ): Promise<{ status: ExecutionReceipt['status'] }> {
    const receipt = ExecutionReceiptSchema.parse(structuredClone(input))
    const expected = this.expectedScope(IdentitySchema.parse(structuredClone(identity)))
    const result = await this.authorized('/v1/executions/settle', receipt, signal, 2500, expected)
    const parsed = z.strictObject({ status: z.literal(receipt.status) }).safeParse(result)
    if (!parsed.success) throw new DeviceRequestError('INVALID_RESPONSE')
    return parsed.data
  }

  async reconciliationChallenge(
    inputIdentity: Identity,
    input: PermitRequest,
    signal?: AbortSignal
  ): Promise<ReconciliationChallenge> {
    const identity = IdentitySchema.parse(structuredClone(inputIdentity))
    const request = PermitRequestSchema.parse(structuredClone(input)),
      expected = this.expectedScope(identity)
    const result = await this.authorized(
      '/v1/reconciliation/challenge',
      request,
      signal,
      5000,
      expected
    )
    try {
      return parseReconciliationChallenge(result, request, identity)
    } catch {
      throw new DeviceRequestError('INVALID_RESPONSE')
    }
  }
  async sealExecutionRequest(
    value: RequestSealInput,
    signal?: AbortSignal
  ): Promise<RequestSealResult> {
    const input = RequestSealInputSchema.parse(structuredClone(value)),
      expected = this.expectedScope(input.identity)
    const result = await this.authorized('/v1/reconciliation/seal', input, signal, 5000, expected)
    try {
      const parsed = parseRequestSealResult(result, input, hashContext(input))
      if (
        parsed.status === 'request_sealed' &&
        hashContext(parsed.seal.input) !== hashContext(input)
      )
        throw new Error('request_changed')
      return parsed
    } catch {
      throw new DeviceRequestError('INVALID_RESPONSE')
    }
  }
  async requestSealApplied(value: RequestSeal, signal?: AbortSignal): Promise<RequestSealAck> {
    const seal = RequestSealSchema.parse(structuredClone(value))
    if (hashContext(seal.input) !== seal.requestHash)
      throw new DeviceRequestError('INVALID_RESPONSE')
    const lookup = {
      sealId: seal.sealId,
      sealHash: hashContext(seal),
      requestHash: seal.requestHash,
      executionId: seal.input.executionId
    }
    const ack = RequestSealAckSchema.safeParse(
      await this.authorized(
        '/v1/reconciliation/seal-applied',
        lookup,
        signal,
        5000,
        this.expectedScope(seal.input.identity)
      )
    )
    if (
      !ack.success ||
      hashContext(ack.data) !== hashContext({ ...lookup, status: 'request_seal_applied' })
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return ack.data
  }
  async reportReconciliation(
    input: DeviceReconciliationReport,
    signal?: AbortSignal
  ): Promise<ReconciliationAcknowledgment> {
    const report = DeviceReconciliationReportSchema.parse(structuredClone(input))
    const result = ReconciliationAcknowledgmentSchema.safeParse(
      await this.authorized(
        '/v1/reconciliation/report',
        report,
        signal,
        5000,
        this.expectedScope(report.observation.identity)
      )
    )
    if (
      !result.success ||
      result.data.caseId !== report.caseId ||
      result.data.reportHash !== hashContext(report)
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return result.data
  }

  async reconciliationDecision(
    input: DeviceReconciliationReport,
    signal?: AbortSignal
  ): Promise<ReconciliationDecision | null> {
    const report = DeviceReconciliationReportSchema.parse(structuredClone(input))
    const result = z.strictObject({ decision: z.unknown().nullable() }).parse(
      await this.authorized(
        '/v1/reconciliation/decision',
        {
          caseId: report.caseId,
          snapshotHash: report.snapshotHash,
          reportHash: hashContext(report),
          request: report.request
        },
        signal,
        5000,
        this.expectedScope(report.observation.identity)
      )
    )
    try {
      return result.decision === null
        ? null
        : parseReconciliationDecision(result.decision, report, hashContext(report))
    } catch {
      throw new DeviceRequestError('INVALID_RESPONSE')
    }
  }
  async reconciliationApplied(
    input: DeviceReconciliationReport,
    value: ReconciliationDecision,
    signal?: AbortSignal
  ): Promise<ReconciliationAppliedAck> {
    const report = DeviceReconciliationReportSchema.parse(structuredClone(input)),
      decision = parseReconciliationDecision(structuredClone(value), report, hashContext(report))
    const ack = ReconciliationAppliedAckSchema.safeParse(
      await this.authorized(
        '/v1/reconciliation/applied',
        {
          caseId: report.caseId,
          snapshotHash: report.snapshotHash,
          reportHash: hashContext(report),
          request: report.request,
          decisionId: decision.decisionId,
          decisionHash: hashContext(decision)
        },
        signal,
        5000,
        this.expectedScope(report.observation.identity)
      )
    )
    if (
      !ack.success ||
      ack.data.decisionId !== decision.decisionId ||
      ack.data.decisionHash !== hashContext(decision)
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return ack.data
  }

  async issueHumanExecution(
    task: ReplyTask,
    draft: ReplyDraft,
    confirmation: HumanConfirmation,
    leaseVersion: number,
    signal?: AbortSignal
  ): Promise<ExecutionPermit> {
    const input = HumanPermitRequestSchema.parse(
      structuredClone({ task, draft, confirmation, leaseVersion })
    )
    if (
      input.confirmation.taskId !== input.task.taskId ||
      input.confirmation.taskHash !== hashContext(input.task) ||
      input.confirmation.draftHash !== input.draft.draftHash ||
      input.confirmation.draftRevision !== input.draft.draftRevision ||
      input.draft.taskId !== input.task.taskId ||
      hashDraft(input.draft.text) !== input.draft.draftHash
    )
      throw new DeviceRequestError('TASK_INVALIDATED')
    const result = ExecutionPermitSchema.safeParse(
      await this.authorized(
        '/v1/executions/issue-human',
        input,
        signal,
        2500,
        this.expectedScope(input.task.identity)
      )
    )
    if (
      !result.success ||
      result.data.purpose !== 'human' ||
      result.data.confirmationId !== input.confirmation.confirmationId ||
      !sameIdentity(result.data.identity, input.task.identity) ||
      result.data.taskId !== input.task.taskId ||
      result.data.taskHash !== input.confirmation.taskHash ||
      result.data.conversationId !== input.task.conversationId ||
      result.data.draftHash !== input.draft.draftHash ||
      result.data.draftRevision !== input.draft.draftRevision ||
      result.data.leaseVersion !== leaseVersion ||
      result.data.expiresAt <= result.data.issuedAt ||
      result.data.expiresAt - result.data.issuedAt > 5000 ||
      (result.data.newlyIssued && result.data.status !== 'issued')
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return result.data
  }

  private expectedScope(identity: Identity): { serverUrl: string; scope: DeviceScope } {
    const status = this.status(),
      scope = status.scope
    if (
      !scope ||
      identity.tenantId !== scope.tenant_id ||
      identity.employeeId !== scope.employee_id ||
      identity.accountId !== scope.account_id ||
      identity.agentId !== scope.agent_id ||
      identity.platform !== scope.platform
    )
      throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    return { serverUrl: status.serverUrl!, scope }
  }
  async lookupRestoration(input: unknown, signal?: AbortSignal): Promise<RestoreLookupResult> {
    const request = RestoreLookupInputSchema.parse(input),
      status = this.status()
    if (!status.scope || !status.serverUrl) throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    const expected = { serverUrl: status.serverUrl, scope: status.scope }
    const result = RestoreLookupResultSchema.safeParse(
      await this.authorized('/v1/restorations/lookup', request, signal, 5000, expected)
    )
    if (
      !result.success ||
      hashContext(result.data.scope) !== hashContext(expected.scope) ||
      result.data.restoreId !== request.restoreId ||
      result.data.contextHash !== request.contextHash
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return result.data
  }
  async restoreLatestRecoveryBoundary(
    input: unknown,
    expectedScope: DeviceScope,
    signal?: AbortSignal
  ): Promise<RestoreRecoveryPackage> {
    const request = RestoreRecoveryCurrentSchema.parse(structuredClone(input)),
      status = this.status()
    if (
      !status.scope ||
      !status.serverUrl ||
      hashContext(status.scope) !== hashContext(DeviceScopeSchema.parse(expectedScope))
    )
      throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    const result = RestoreRecoveryPackageSchema.safeParse(
      await this.authorized('/v1/restorations/recovery/current', request, signal, 5000, {
        serverUrl: status.serverUrl,
        scope: status.scope
      })
    )
    if (
      !result.success ||
      hashContext(result.data.authorization.scope) !== hashContext(status.scope) ||
      result.data.authorization.caseId !== request.caseId ||
      result.data.authorization.restoreId !== request.restoreId ||
      result.data.authorization.contextHash !== request.contextHash
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return result.data
  }
  async restoreExecutionResolutions(
    input: unknown,
    expected: RestoreRecoveryPackage,
    signal?: AbortSignal
  ): Promise<RestoreResolutionPackage> {
    const request = RestoreResolutionLookupSchema.parse(structuredClone(input)),
      boundary = RestoreRecoveryPackageSchema.parse(expected),
      a = boundary.authorization,
      status = this.status()
    if (!status.scope || !status.serverUrl || hashContext(status.scope) !== hashContext(a.scope))
      throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    if (
      request.authorizationId !== a.authorizationId ||
      request.caseId !== a.caseId ||
      request.restoreId !== a.restoreId ||
      request.contextHash !== a.contextHash
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    try {
      return parseRestoreResolutionPackage(
        await this.authorized('/v1/restorations/recovery/resolutions', request, signal, 5000, {
          serverUrl: status.serverUrl,
          scope: status.scope
        }),
        boundary
      )
    } catch (error) {
      if (error instanceof DeviceRequestError) throw error
      throw new DeviceRequestError('INVALID_RESPONSE')
    }
  }
  async acknowledgeRestoreRecovery(
    input: unknown,
    expectedScope: DeviceScope,
    signal?: AbortSignal
  ): Promise<RestoreRecoveryCompletionReceipt> {
    if (Buffer.byteLength(JSON.stringify(input) ?? '') > 1048576)
      throw new DeviceRequestError('INVALID_RESPONSE')
    const request = RestoreRecoveryCompletionInputSchema.parse(structuredClone(input)),
      status = this.status()
    if (
      !status.scope ||
      !status.serverUrl ||
      hashContext(status.scope) !== hashContext(expectedScope) ||
      hashContext(request.boundaryApplication.scope) !== hashContext(expectedScope)
    )
      throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    try {
      return parseRestoreRecoveryCompletionReceipt(
        await this.authorized('/v1/restorations/recovery/acknowledge', request, signal, 5000, {
          serverUrl: status.serverUrl,
          scope: status.scope
        }),
        request
      )
    } catch (error) {
      if (error instanceof DeviceRequestError) throw error
      throw new DeviceRequestError('INVALID_RESPONSE')
    }
  }
  async restoreObservationGrant(
    input: unknown,
    expected: RestoreRecoveryPackage,
    signal?: AbortSignal
  ): Promise<RestoreObservationGrant> {
    const request = RestoreResolutionLookupSchema.parse(structuredClone(input)),
      boundary = RestoreRecoveryPackageSchema.parse(expected),
      a = boundary.authorization,
      status = this.status()
    if (!status.scope || !status.serverUrl || hashContext(status.scope) !== hashContext(a.scope))
      throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    if (
      request.authorizationId !== a.authorizationId ||
      request.caseId !== a.caseId ||
      request.restoreId !== a.restoreId ||
      request.contextHash !== a.contextHash
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    try {
      return parseRestoreObservationGrant(
        await this.authorized(
          '/v1/restorations/recovery/observation-grant',
          request,
          signal,
          5000,
          { serverUrl: status.serverUrl, scope: status.scope }
        ),
        boundary
      )
    } catch (error) {
      if (error instanceof DeviceRequestError) throw error
      throw new DeviceRequestError('INVALID_RESPONSE')
    }
  }
  async restoreApplicationDecision(
    input: unknown,
    expectedScope: DeviceScope,
    signal?: AbortSignal
  ): Promise<RestoreApplicationDecision> {
    const request = RestoreApplicationLookupSchema.parse(structuredClone(input)),
      status = this.status()
    if (
      !status.scope ||
      !status.serverUrl ||
      hashContext(status.scope) !== hashContext(DeviceScopeSchema.parse(expectedScope))
    )
      throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    const result = RestoreApplicationDecisionSchema.safeParse(
      await this.authorized('/v1/restorations/application/decision', request, signal, 5000, {
        serverUrl: status.serverUrl,
        scope: status.scope
      })
    )
    if (
      !result.success ||
      hashContext(result.data.scope) !== hashContext(status.scope) ||
      result.data.decision.caseId !== request.caseId ||
      result.data.decision.uploadId !== request.uploadId ||
      result.data.decision.decisionId !== request.decisionId ||
      result.data.decision.restoreId !== request.restoreId ||
      result.data.decision.contextHash !== request.contextHash ||
      result.data.decisionHash !== request.decisionHash
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return result.data
  }
  async restoreLatestApplicationDecision(
    input: unknown,
    expectedScope: DeviceScope,
    signal?: AbortSignal
  ): Promise<RestoreApplicationDecision> {
    const request = RestoreApplicationCurrentSchema.parse(structuredClone(input)),
      status = this.status()
    if (
      !status.scope ||
      !status.serverUrl ||
      hashContext(status.scope) !== hashContext(DeviceScopeSchema.parse(expectedScope))
    )
      throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    const result = RestoreApplicationDecisionSchema.safeParse(
      await this.authorized('/v1/restorations/application/current', request, signal, 5000, {
        serverUrl: status.serverUrl,
        scope: status.scope
      })
    )
    if (
      !result.success ||
      hashContext(result.data.scope) !== hashContext(status.scope) ||
      result.data.decision.caseId !== request.caseId ||
      result.data.decision.restoreId !== request.restoreId ||
      result.data.decision.contextHash !== request.contextHash
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return result.data
  }
  async acknowledgeRestoreApplication(
    input: unknown,
    signal?: AbortSignal
  ): Promise<RestoreApplicationAck> {
    const request = RestoreLocalApplicationReceiptSchema.parse(structuredClone(input)),
      status = this.status()
    if (
      !status.scope ||
      !status.serverUrl ||
      hashContext(status.scope) !== hashContext(request.scope)
    )
      throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    const result = RestoreApplicationAckSchema.safeParse(
      await this.authorized('/v1/restorations/application/acknowledge', request, signal, 5000, {
        serverUrl: status.serverUrl,
        scope: status.scope
      })
    )
    if (
      !result.success ||
      hashContext(result.data.scope) !== hashContext(request.scope) ||
      result.data.applicationId !== request.applicationId ||
      result.data.applicationHash !== hashContext(request) ||
      result.data.caseId !== request.caseId ||
      result.data.decisionId !== request.decisionId ||
      result.data.restoreId !== request.restoreId ||
      result.data.contextHash !== request.contextHash
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return result.data
  }
  async startRestoreInventory(
    input: unknown,
    signal?: AbortSignal
  ): Promise<z.infer<typeof RestoreInventoryStartAckSchema>> {
    const request = RestoreInventoryStartSchema.parse(structuredClone(input)),
      status = this.status()
    if (
      !status.scope ||
      !status.serverUrl ||
      hashContext(status.scope) !== hashContext(request.manifest.scope)
    )
      throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    const ack = RestoreInventoryStartAckSchema.parse(
      await this.authorized('/v1/restorations/inventory/start', request, signal, 5000, {
        serverUrl: status.serverUrl,
        scope: status.scope
      })
    )
    if (ack.manifestHash !== hashContext(request.manifest))
      throw new DeviceRequestError('INVALID_RESPONSE')
    return ack
  }
  async submitRestoreInventoryPage(
    input: unknown,
    signal?: AbortSignal
  ): Promise<z.infer<typeof RestoreInventoryPageAckSchema>> {
    const request = RestoreInventoryPageSchema.parse(structuredClone(input)),
      status = this.status()
    if (!status.scope || !status.serverUrl) throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    for (const item of request.items) this.expectedScope(item.identity)
    const ack = RestoreInventoryPageAckSchema.parse(
      await this.authorized('/v1/restorations/inventory/page', request, signal, 5000, {
        serverUrl: status.serverUrl,
        scope: status.scope
      })
    )
    if (
      ack.uploadId !== request.uploadId ||
      ack.index !== request.index ||
      ack.pageHash !== hashContext(request) ||
      ack.itemCount !== request.items.length
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return ack
  }
  async completeRestoreInventory(
    input: unknown,
    signal?: AbortSignal
  ): Promise<z.infer<typeof RestoreInventoryCompleteAckSchema>> {
    const request = RestoreInventoryCompleteSchema.parse(input),
      status = this.status()
    if (!status.scope || !status.serverUrl) throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    const ack = RestoreInventoryCompleteAckSchema.parse(
      await this.authorized('/v1/restorations/inventory/complete', request, signal, 5000, {
        serverUrl: status.serverUrl,
        scope: status.scope
      })
    )
    if (ack.uploadId !== request.uploadId || ack.pageCount !== request.pageCount)
      throw new DeviceRequestError('INVALID_RESPONSE')
    return ack
  }
  async restorePauseChallenge(
    input: unknown,
    signal?: AbortSignal
  ): Promise<RestorePauseChallenge> {
    const request = RestoreChallengeInputSchema.parse(input),
      status = this.status()
    if (!status.scope || !status.serverUrl) throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    const expected = { serverUrl: status.serverUrl, scope: status.scope }
    const result = RestorePauseChallengeSchema.safeParse(
      await this.authorized('/v1/restorations/challenge', request, signal, 5000, expected)
    )
    if (
      !result.success ||
      hashContext(result.data.scope) !== hashContext(expected.scope) ||
      result.data.caseId !== request.caseId ||
      result.data.requestId !== request.requestId ||
      result.data.context.restoreId !== request.restoreId ||
      result.data.context.contextHash !== request.contextHash
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return result.data
  }
  async reportRestorePause(
    input: RestorePauseReport,
    signal?: AbortSignal
  ): Promise<RestorePauseAck> {
    const report = RestorePauseReportSchema.parse(structuredClone(input)),
      status = this.status()
    if (
      !status.scope ||
      !status.serverUrl ||
      hashContext(status.scope) !== hashContext(report.challenge.scope)
    )
      throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    const ack = RestorePauseAckSchema.safeParse(
      await this.authorized('/v1/restorations/report', report, signal, 5000, {
        serverUrl: status.serverUrl,
        scope: status.scope
      })
    )
    if (
      !ack.success ||
      ack.data.challengeId !== report.challenge.challengeId ||
      ack.data.reportHash !== hashContext(report)
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return ack.data
  }

  async generateCandidate(input: GenerationInput, signal?: AbortSignal): Promise<GenerationResult> {
    const request = parseGenerationInput(structuredClone(input))
    const status = this.status(),
      scope = status.scope,
      i = request.task.identity
    if (
      !scope ||
      i.tenantId !== scope.tenant_id ||
      i.employeeId !== scope.employee_id ||
      i.accountId !== scope.account_id ||
      i.agentId !== scope.agent_id ||
      i.platform !== scope.platform
    )
      throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    const remaining = Math.min(55000, request.task.expiresAt - Date.now())
    if (remaining <= 0) throw new DeviceRequestError('TASK_INVALIDATED')
    const result = await this.authorized('/v1/replies/generate', request, signal, remaining, {
      serverUrl: status.serverUrl!,
      scope
    })
    try {
      return parseGenerationResult(result, request.task)
    } catch {
      throw new DeviceRequestError('INVALID_RESPONSE')
    }
  }
  async prepareGeneration(input: GenerationInput, signal?: AbortSignal): Promise<ReplyTask> {
    const request = parseGenerationInput(structuredClone(input)),
      expected = this.expectedScope(request.task.identity)
    const remaining = Math.min(10000, request.task.expiresAt - Date.now())
    if (remaining <= 0) throw new DeviceRequestError('TASK_INVALIDATED')
    const result = await this.authorized(
      '/v1/replies/prepare',
      request,
      signal,
      remaining,
      expected
    )
    try {
      return parsePreparedGenerationTask(result, request.task)
    } catch {
      throw new DeviceRequestError('INVALID_RESPONSE')
    }
  }

  async reviewEdited(input: EditedReviewInput, signal?: AbortSignal): Promise<EditedReviewResult> {
    const request = parseEditedReviewInput(structuredClone(input))
    const expected = this.expectedScope(request.generation.task.identity)
    const remaining = Math.min(55000, request.generation.task.expiresAt - Date.now())
    if (remaining <= 0) throw new DeviceRequestError('TASK_INVALIDATED')
    const result = await this.authorized(
      '/v1/replies/review-edited',
      request,
      signal,
      remaining,
      expected
    )
    try {
      return parseEditedReviewResult(result, request)
    } catch {
      throw new DeviceRequestError('INVALID_RESPONSE')
    }
  }

  async assessmentEvidence(
    task: ReplyTask,
    draft: ReplyDraft,
    offset: number,
    signal?: AbortSignal
  ): Promise<AssessmentEvidencePage> {
    const expected = this.expectedScope(task.identity)
    const request = AssessmentEvidenceRequestSchema.parse({
      taskId: task.taskId,
      contextHash: task.contextHash,
      knowledgeVersion: task.knowledgeVersion,
      draftHash: draft.draftHash,
      draftRevision: draft.draftRevision,
      offset
    })
    const result = await this.authorized('/v1/replies/evidence', request, signal, 5000, expected)
    try {
      const page = parseAssessmentEvidencePage(result, request)
      if (
        page.totalAvailable + page.unavailableReferences !== draft.evidenceIds.length ||
        page.evidence.some((e) => !draft.evidenceIds.includes(e.evidenceId))
      )
        throw new Error('uncited_evidence')
      return page
    } catch {
      throw new DeviceRequestError('INVALID_RESPONSE')
    }
  }

  async recordLearningCorrection(
    task: ReplyTask,
    draft: ReplyDraft,
    input: LearningCorrectionInput,
    signal?: AbortSignal
  ): Promise<LearningEpisode> {
    return (await this.recordLearningEvent(
      task,
      draft,
      {
        kind: 'correction',
        input: LearningCorrectionInputSchema.parse(input)
      },
      signal
    ))!
  }

  async recordLearningResult(
    task: ReplyTask,
    draft: ReplyDraft,
    input: LearningResultInput,
    signal?: AbortSignal
  ): Promise<LearningEpisode> {
    return (await this.recordLearningEvent(
      task,
      draft,
      {
        kind: 'result',
        input: LearningResultInputSchema.parse(input)
      },
      signal
    ))!
  }

  async recordLearningFeedback(
    task: ReplyTask,
    draft: ReplyDraft,
    input: LearningHumanFeedbackInput,
    signal?: AbortSignal
  ): Promise<void> {
    await this.recordLearningEvent(
      task,
      draft,
      {
        kind: 'feedback',
        input: LearningHumanFeedbackInputSchema.parse(input)
      },
      signal
    )
  }

  private learningManagementScope(raw: MemoryScope): {
    memory: MemoryScope
    expected: { serverUrl: string; scope: DeviceScope }
  } {
    const memory = MemoryScopeSchema.parse(raw),
      status = this.status(),
      scope = status.scope
    if (
      !scope ||
      !status.serverUrl ||
      memory.tenantId !== scope.tenant_id ||
      memory.accountId !== scope.account_id ||
      memory.platform !== scope.platform ||
      memory.workspaceId !==
        `enterprise:${learningHash({ tenant: scope.tenant_id, account: scope.account_id })}`
    )
      throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    return { memory, expected: { serverUrl: status.serverUrl, scope } }
  }

  async learningSnapshot(
    scope: MemoryScope,
    signal?: AbortSignal
  ): Promise<LearningWorkbenchSnapshot> {
    const { memory, expected } = this.learningManagementScope(scope)
    const parsed = LearningWorkbenchSnapshotSchema.safeParse(
      await this.authorized(
        '/v1/learning/snapshot',
        { conversationId: memory.conversationId ?? null },
        signal,
        5000,
        expected
      )
    )
    if (!parsed.success) throw new DeviceRequestError('INVALID_RESPONSE')
    const snapshot = parsed.data
    const owned = (value: MemoryScope): boolean =>
      value.workspaceId === memory.workspaceId &&
      value.tenantId === memory.tenantId &&
      value.accountId === memory.accountId &&
      value.platform === memory.platform
    const selected = (value: MemoryScope): boolean =>
      owned(value) && value.conversationId === memory.conversationId
    if (
      !selected(snapshot.scope) ||
      (snapshot.publication &&
        (snapshot.publication.tenantId !== memory.tenantId ||
          snapshot.publication.accountId !== memory.accountId)) ||
      snapshot.scopes.some((value) => !owned(value)) ||
      snapshot.memories.some((value) => !selected(value.record.scope)) ||
      snapshot.episodes.some((value) => !selected(value.scope)) ||
      snapshot.jobs.some((value) => !selected(value.scope)) ||
      snapshot.unassigned.length
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return snapshot
  }

  async learningSettings(
    scope: MemoryScope,
    patch?: Partial<LearningSettings>,
    signal?: AbortSignal
  ): Promise<LearningSettings> {
    const { memory, expected } = this.learningManagementScope(scope)
    const input = {
      conversationId: memory.conversationId ?? null,
      ...(patch === undefined ? {} : { patch: LearningSettingsPatchSchema.parse(patch) })
    }
    const parsed = LearningSettingsResponseSchema.safeParse(
      await this.authorized('/v1/learning/settings', input, signal, 5000, expected)
    )
    if (!parsed.success) throw new DeviceRequestError('INVALID_RESPONSE')
    return parsed.data
  }

  async learningForgetScope(scope: MemoryScope, signal?: AbortSignal): Promise<void> {
    const { memory, expected } = this.learningManagementScope(scope)
    const response = await this.authorized(
      '/v1/learning/forget-scope',
      { conversationId: memory.conversationId ?? null },
      signal,
      5000,
      expected
    )
    if (!z.strictObject({ forgotten: z.literal(true) }).safeParse(response).success)
      throw new DeviceRequestError('INVALID_RESPONSE')
  }

  private learningSelectedScope(expected: MemoryScope, actual: MemoryScope): boolean {
    return (
      actual.workspaceId === expected.workspaceId &&
      actual.tenantId === expected.tenantId &&
      actual.accountId === expected.accountId &&
      actual.platform === expected.platform &&
      (actual.conversationId ?? null) === (expected.conversationId ?? null)
    )
  }

  /** Only named public operations reach this private authenticated transport. */
  private async learningManagedRequest<T>(
    scope: MemoryScope,
    operation: keyof typeof LearningDesktopManagementRequests,
    input: Record<string, unknown>,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    timeoutMs = 5000
  ): Promise<T> {
    const { memory, expected } = this.learningManagementScope(scope)
    const body = LearningDesktopManagementRequests[operation].parse({
      ...input,
      conversationId: memory.conversationId ?? null
    })
    const result = schema.safeParse(
      await this.authorized(`/v1/learning/${operation}`, body, signal, timeoutMs, expected)
    )
    if (!result.success) throw new DeviceRequestError('INVALID_RESPONSE')
    return result.data
  }

  async learningEpisode(
    scope: MemoryScope,
    episodeId: string,
    signal?: AbortSignal
  ): Promise<LearningEpisode> {
    const result = await this.learningManagedRequest(
      scope,
      'episode',
      { episodeId },
      LearningEpisodeSchema,
      signal
    )
    if (result.id !== episodeId || !this.learningSelectedScope(scope, result.scope))
      throw new DeviceRequestError('INVALID_RESPONSE')
    return result
  }

  async learningModelDirectory(
    scope: MemoryScope,
    signal?: AbortSignal
  ): Promise<LearningModelDirectory> {
    return this.learningManagedRequest(
      scope,
      'model-directory',
      {},
      LearningModelDirectorySchema,
      signal
    )
  }

  async learningDetail(
    scope: MemoryScope,
    id: string,
    signal?: AbortSignal
  ): Promise<{ memory: MemoryRecord; history: MemoryRevision[] }> {
    const result = await this.learningManagedRequest(
      scope,
      'detail',
      { id },
      LearningDetailResponseSchema,
      signal
    )
    if (
      !this.learningSelectedScope(scope, result.memory.scope) ||
      result.memory.id !== id ||
      result.history.some(
        (row) => row.memoryId !== id || row.revision > result.memory.currentRevision
      )
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return result
  }

  async learningAct(raw: LearningAction, signal?: AbortSignal): Promise<MemoryRecord | null> {
    const { scope, ...command } = LearningActionSchema.parse(raw)
    const result = await this.learningManagedRequest(
      scope,
      'action',
      { command },
      LearningMemoryRecordResponseSchema.nullable(),
      signal
    )
    if (command.action === 'forget') {
      if (result !== null) throw new DeviceRequestError('INVALID_RESPONSE')
    } else if (
      result === null ||
      !this.learningSelectedScope(scope, result.scope) ||
      ('id' in command && result.id !== command.id)
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return result
  }

  async learningManual(
    scope: MemoryScope,
    input: { sourceId: string; content: MemoryContent; reason: string },
    signal?: AbortSignal
  ): Promise<MemoryRecord> {
    const value = LearningDesktopManagementRequests.manual
      .omit({ conversationId: true })
      .parse(input)
    const result = await this.learningManagedRequest(
      scope,
      'manual',
      value,
      LearningMemoryRecordResponseSchema,
      signal
    )
    if (
      !this.learningSelectedScope(scope, result.scope) ||
      learningHash(result.content) !== learningHash(value.content)
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return result
  }

  async learningReview(
    scope: MemoryScope,
    input: { episodeId: string; sourceId: string },
    signal?: AbortSignal
  ): Promise<{ jobId: string | null }> {
    const value = LearningDesktopManagementRequests.review
      .omit({ conversationId: true })
      .parse(input)
    return this.learningManagedRequest(
      scope,
      'review',
      value,
      z.strictObject({ jobId: z.uuid().nullable() }),
      signal
    )
  }

  async learningCancel(scope: MemoryScope, jobId: string, signal?: AbortSignal): Promise<void> {
    await this.learningManagedRequest(
      scope,
      'cancel',
      { jobId },
      z.strictObject({ cancelled: z.literal(true) }),
      signal
    )
  }

  async learningCalibration(
    scope: MemoryScope,
    input?: LearningCalibrationInput,
    signal?: AbortSignal
  ): Promise<LearningCalibrationSet> {
    return this.learningManagedRequest(
      scope,
      'calibration',
      input === undefined ? {} : { input },
      LearningCalibrationResponseSchema,
      signal
    )
  }

  async learningReports(scope: MemoryScope, signal?: AbortSignal): Promise<LearningReports> {
    return this.learningManagedRequest(scope, 'reports', {}, LearningReportsResponseSchema, signal)
  }

  async learningSearch(
    scope: MemoryScope,
    query: string,
    limit = 10,
    signal?: AbortSignal
  ): Promise<LearningEpisode[]> {
    const result = await this.learningManagedRequest(
      scope,
      'search',
      { query, limit },
      z.array(LearningEpisodeSchema).max(20),
      signal
    )
    if (
      result.some((episode) => !this.learningSelectedScope(scope, episode.scope)) ||
      result.length > limit
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return result
  }

  async learningValidate(
    scope: MemoryScope,
    id: string,
    expectedRevision: number,
    signal?: AbortSignal
  ): Promise<LearningValidationResult> {
    return this.learningManagedRequest(
      scope,
      'validate',
      { id, expectedRevision },
      LearningValidationResultResponseSchema,
      signal,
      120000
    )
  }

  async learningCurate(
    scope: MemoryScope,
    dryRun = true,
    signal?: AbortSignal
  ): Promise<LearningCurationReport> {
    const result = await this.learningManagedRequest(
      scope,
      'curate',
      { dryRun },
      LearningCurationReportResponseSchema,
      signal,
      60000
    )
    if (result.dryRun !== dryRun) throw new DeviceRequestError('INVALID_RESPONSE')
    return result
  }

  async learningEpisodeCorrection(
    raw: Parameters<LearningMemoryDesktopApi['correct']>[0],
    signal?: AbortSignal
  ): Promise<LearningEpisode> {
    const { scope, ...input } = LearningDesktopRequests.correct.parse(raw)
    const episode = await this.learningManagedRequest(
      scope,
      'episode-correction',
      input,
      LearningEpisodeSchema,
      signal
    )
    if (
      !this.learningSelectedScope(scope, episode.scope) ||
      episode.identityStatus !== 'verified' ||
      episode.outcome !== 'corrected' ||
      episode.correction !== input.text ||
      episode.correctionReason !== input.reason
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return episode
  }
  async learningEpisodeResult(
    raw: Parameters<LearningMemoryDesktopApi['confirmResult']>[0],
    signal?: AbortSignal
  ): Promise<LearningEpisode> {
    const { scope, ...input } = LearningDesktopRequests.result.parse(raw)
    const episode = await this.learningManagedRequest(
      scope,
      'episode-result',
      input,
      LearningEpisodeSchema,
      signal
    )
    if (
      !this.learningSelectedScope(scope, episode.scope) ||
      episode.identityStatus !== 'verified' ||
      episode.outcome !== input.outcome
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return episode
  }
  async learningEpisodeFeedback(
    raw: Parameters<LearningMemoryDesktopApi['feedback']>[0],
    signal?: AbortSignal
  ): Promise<void> {
    const { scope, ...input } = LearningDesktopRequests.feedback.parse(raw)
    await this.learningManagedRequest(scope, 'episode-feedback', input, z.null(), signal)
  }

  private async recordLearningEvent(
    rawTask: ReplyTask,
    rawDraft: ReplyDraft,
    event:
      | { kind: 'correction'; input: LearningCorrectionInput }
      | { kind: 'result'; input: LearningResultInput }
      | { kind: 'feedback'; input: LearningHumanFeedbackInput },
    signal?: AbortSignal
  ): Promise<LearningEpisode | null> {
    const task = ReplyTaskSchema.parse(rawTask),
      draft = ReplyDraftSchema.parse(rawDraft)
    if (draft.taskId !== task.taskId || hashDraft(draft.text) !== draft.draftHash)
      throw new DeviceRequestError('TASK_INVALIDATED')
    const expected = this.expectedScope(task.identity)
    const response = await this.authorized(
      `/v1/learning/${event.kind}`,
      {
        ...event.input,
        reference: {
          taskId: task.taskId,
          contextHash: task.contextHash,
          draftHash: draft.draftHash,
          draftRevision: draft.draftRevision
        }
      },
      signal,
      5000,
      expected
    )
    if (event.kind === 'feedback') {
      if (response !== null) throw new DeviceRequestError('INVALID_RESPONSE')
      return null
    }
    const parsed = LearningEpisodeSchema.safeParse(response)
    if (!parsed.success) throw new DeviceRequestError('INVALID_RESPONSE')
    const episode = parsed.data,
      scope = episode.scope
    if (
      scope.workspaceId !==
        `enterprise:${learningHash({ tenant: task.identity.tenantId, account: task.identity.accountId })}` ||
      scope.tenantId !== task.identity.tenantId ||
      scope.accountId !== task.identity.accountId ||
      scope.platform !== task.identity.platform ||
      scope.conversationId !== task.conversationId ||
      episode.draft !== draft.text ||
      episode.identityStatus !== 'verified' ||
      episode.outcome !== (event.kind === 'correction' ? 'corrected' : event.input.outcome) ||
      (event.kind === 'correction' &&
        (episode.correction !== event.input.text ||
          episode.correctionReason !== event.input.reason))
    )
      throw new DeviceRequestError('INVALID_RESPONSE')
    return episode
  }

  private async authorized(
    path:
      | '/v1/configuration'
      | '/v1/runtime/status'
      | '/v1/runtime/pause/challenge'
      | '/v1/runtime/pause/report'
      | '/v1/replies/generate'
      | '/v1/replies/prepare'
      | '/v1/replies/review-edited'
      | '/v1/replies/evidence'
      | '/v1/learning/correction'
      | '/v1/learning/result'
      | '/v1/learning/feedback'
      | '/v1/learning/snapshot'
      | '/v1/learning/settings'
      | '/v1/learning/forget-scope'
      | '/v1/learning/detail'
      | '/v1/learning/model-directory'
      | '/v1/learning/episode'
      | '/v1/learning/action'
      | '/v1/learning/manual'
      | '/v1/learning/review'
      | '/v1/learning/cancel'
      | '/v1/learning/calibration'
      | '/v1/learning/reports'
      | '/v1/learning/search'
      | '/v1/learning/validate'
      | '/v1/learning/curate'
      | '/v1/learning/episode-correction'
      | '/v1/learning/episode-result'
      | '/v1/learning/episode-feedback'
      | '/v1/leases/acquire'
      | '/v1/executions/issue'
      | '/v1/executions/issue-human'
      | '/v1/executions/settle'
      | '/v1/reconciliation/challenge'
      | '/v1/reconciliation/report'
      | '/v1/reconciliation/decision'
      | '/v1/reconciliation/applied'
      | '/v1/reconciliation/seal'
      | '/v1/reconciliation/seal-applied'
      | '/v1/restorations/challenge'
      | '/v1/restorations/report'
      | '/v1/restorations/lookup'
      | '/v1/restorations/inventory/start'
      | '/v1/restorations/inventory/page'
      | '/v1/restorations/inventory/complete'
      | '/v1/restorations/application/decision'
      | '/v1/restorations/application/current'
      | '/v1/restorations/recovery/current'
      | '/v1/restorations/recovery/resolutions'
      | '/v1/restorations/recovery/observation-grant'
      | '/v1/restorations/recovery/acknowledge'
      | '/v1/restorations/application/acknowledge',
    // Lookup is metadata only and never grants a lease or execution authority.
    body: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    expected?: { serverUrl: string; scope: DeviceScope }
  ): Promise<unknown> {
    let record: EncryptedDeviceRecord
    try {
      const stored = this.store.load()
      if (!stored || !this.cipher.available()) throw new Error('unavailable')
      record = { ...stored, scope: DeviceScopeSchema.parse(stored.scope) }
    } catch {
      throw new DeviceRequestError('NOT_REGISTERED')
    }
    if (
      expected &&
      (record.serverUrl !== expected.serverUrl ||
        JSON.stringify(record.scope) !== JSON.stringify(expected.scope))
    )
      throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    let credential: string, origin: string
    try {
      origin = serverOrigin(record.serverUrl, this.allowLocalHttp)
      credential = this.cipher.decrypt(record.encryptedCredential, {
        serverUrl: origin,
        scope: record.scope
      })
      if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error('credential')
    } catch {
      throw new DeviceRequestError('NOT_REGISTERED')
    }
    let result: unknown
    try {
      result = await this.request(
        origin,
        path,
        {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Authorization: `Bearer ${credential}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        },
        { signal, timeoutMs }
      )
    } catch (e) {
      if (e instanceof DeviceRequestError) throw e
      throw new DeviceRequestError('UNAVAILABLE')
    }
    try {
      const current = this.store.load()
      if (
        !current ||
        current.serverUrl !== record.serverUrl ||
        current.encryptedCredential !== record.encryptedCredential ||
        JSON.stringify(DeviceScopeSchema.parse(current.scope)) !== JSON.stringify(record.scope)
      )
        throw new Error('changed')
    } catch {
      throw new DeviceRequestError('DEVICE_SCOPE_CHANGED')
    }
    return result
  }

  private async request(
    origin: string,
    path: string,
    options: RequestInit,
    limits: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<unknown> {
    if (limits.signal?.aborted) throw new DeviceRequestError('CANCELLED')
    // Bound richer reply explanations separately; credential/lease/permit
    // responses retain the smaller limit and no caller can choose a limit.
    const maximumResponseBytes =
      path === '/v1/restorations/recovery/current' ||
      path === '/v1/restorations/recovery/resolutions' ||
      path === '/v1/learning/snapshot' ||
      path === '/v1/learning/action' ||
      path === '/v1/learning/manual' ||
      path === '/v1/learning/detail' ||
      path === '/v1/learning/model-directory' ||
      path === '/v1/learning/episode' ||
      path === '/v1/learning/calibration' ||
      path === '/v1/learning/reports' ||
      path === '/v1/learning/search' ||
      path === '/v1/learning/curate'
        ? 2097152
        : path === '/v1/replies/generate' ||
            path === '/v1/replies/review-edited' ||
            path === '/v1/replies/evidence' ||
            path === '/v1/learning/correction' ||
            path === '/v1/learning/result' ||
            path === '/v1/learning/episode-correction' ||
            path === '/v1/learning/episode-result'
          ? 262144
          : 65536
    const controller = new AbortController()
    const signal = limits.signal
      ? AbortSignal.any([limits.signal, controller.signal])
      : controller.signal
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs ?? 5000)
    let onAbort!: () => void
    const expired = new Promise<never>((_, reject) => {
      onAbort = () =>
        reject(new DeviceRequestError(limits.signal?.aborted ? 'CANCELLED' : 'TIMEOUT'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([
        (async () => {
          const response = await this.transport(new URL(path, origin), {
            ...options,
            redirect: 'manual',
            signal
          })
          if (!response.ok || signal.aborted)
            throw new DeviceRequestError(
              response.status === 401
                ? 'AUTHORIZATION_FAILED'
                : response.status === 409 ||
                    (response.status === 404 && path.startsWith('/v1/learning/'))
                  ? 'TASK_INVALIDATED'
                  : response.status === 429
                    ? 'OVERLOADED'
                    : 'UNAVAILABLE'
            )
          if (
            Number(response.headers.get('content-length') ?? 0) > maximumResponseBytes ||
            !response.body
          )
            throw new Error('invalid_response')
          const reader = response.body.getReader(),
            chunks: Uint8Array[] = []
          let length = 0
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (signal.aborted) throw new DeviceRequestError('CANCELLED')
              if (done) break
              length += value.byteLength
              if (length > maximumResponseBytes) throw new Error('invalid_response')
              chunks.push(value)
            }
          } finally {
            void reader.cancel().catch(() => {})
          }
          if (signal.aborted) throw new DeviceRequestError('CANCELLED')
          return JSON.parse(Buffer.concat(chunks).toString('utf8'))
        })(),
        expired
      ])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }
}
