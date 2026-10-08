import { z } from 'zod'
import type { Postgres } from '../database/postgres'
import type { LearningAccountAuthority } from './learning-account'
import { EnterpriseEvaluationCheckpoint } from './learning-evaluation-checkpoint'
import { EnterpriseEvaluationEvidence } from './learning-evaluation-evidence'
import { EnterpriseLearningValidationBudget } from './learning-validation-budget'
import { RuntimeTimingEvidence } from '../../../src/core/agent/runtime-timing-evidence'
import { readSealedRuntimeTimingJournal } from '../../../src/core/persistence/runtime-timing-reader'
import { hashContext } from '../../../src/core/reply/hashes'
import type { PrivateRuntimeTimingJournal } from '../../../src/core/persistence/runtime-timing-journal'
import {
  LearningEvaluationDatasetSchema,
  type LearningEvaluationDataset
} from '../../../src/shared/contracts/learning-evaluation'
import {
  adjudicateEnterpriseMemoryReplay,
  verifyEnterpriseMemoryReplayPacket
} from './learning-memory-replay'

export interface VerifiedForegroundObservation {
  assignmentId: string
  caseId: string
  arm: 'none' | 'baseline' | 'learned'
  executionTaskHash: string
  runtimeInstanceId: string
  latencyMs: number
  readIds: string[]
  presentationReceiptId: string | null
  evidenceRef: string
}

/** Trusted host path only. Every invocation authenticates the original server run anew. */
export class EnterpriseForegroundEvidence {
  private readonly checkpoints: EnterpriseEvaluationCheckpoint
  private readonly evidence: EnterpriseEvaluationEvidence
  constructor(database: Postgres, authority: LearningAccountAuthority) {
    this.checkpoints = new EnterpriseEvaluationCheckpoint(
      authority,
      new EnterpriseLearningValidationBudget(database, authority)
    )
    this.evidence = new EnterpriseEvaluationEvidence(database, authority)
  }

  /** Derives timing only after online verification; the original packet and fee evidence stay intact. */
  async adjudicate(
    reference: string,
    runId: string,
    rawPacket: unknown,
    labels: unknown,
    journalReference: { vaultRoot: string; sessionId: string },
    endpoint: 'reviewable' | 'confirmed_sent' = 'reviewable'
  ): Promise<{
    dataset: LearningEvaluationDataset
    verification: Awaited<ReturnType<EnterpriseForegroundEvidence['verify']>>
  }> {
    const packet = verifyEnterpriseMemoryReplayPacket(structuredClone(rawPacket))
    const annotations = structuredClone(labels)
    const verification = await this.verify(reference, runId, packet, journalReference, endpoint)
    const dataset = adjudicateEnterpriseMemoryReplay(packet, annotations)
    const observations = new Map(
      verification.observations.map((value) => [value.assignmentId, value])
    )
    if (
      observations.size !== packet.receipts.length ||
      observations.size !== verification.observations.length
    )
      throw new Error('evaluation_foreground_assignments_incomplete')
    for (const item of dataset.cases) {
      if (item.split !== 'evaluate') continue
      for (const arm of ['none', 'baseline', 'learned'] as const) {
        const receipt = packet.receipts.find(
          (value) => value.caseId === item.caseId && value.arm === arm
        )
        const observed = receipt && observations.get(receipt.assignmentId)
        const outcome = item[arm]
        if (
          !receipt ||
          !observed ||
          !outcome ||
          observed.caseId !== item.caseId ||
          observed.arm !== arm
        )
          throw new Error('evaluation_foreground_assignments_incomplete')
        item[arm] = {
          ...outcome,
          latencyMs: observed.latencyMs,
          latencyComplete: true,
          latencyEvidenceRef: observed.evidenceRef
        }
      }
    }
    dataset.frozen.latencyScope = 'foreground_end_to_end'
    return { dataset: LearningEvaluationDatasetSchema.parse(dataset), verification }
  }

  async verify(
    reference: string,
    runId: string,
    rawPacket: unknown,
    journalReference: { vaultRoot: string; sessionId: string },
    endpoint: 'reviewable' | 'confirmed_sent' = 'reviewable'
  ): Promise<{
    schema: 'autoreply-learning-foreground-verification-v1'
    runId: string
    sessionId: string
    endpoint: 'reviewable' | 'confirmed_sent'
    basisHash: string
    packetHash: string
    journalHash: string
    observations: VerifiedForegroundObservation[]
    serverFrozenBatchVerified: true
    foregroundVerified: true
    nativePlatformVerified: false
    businessVerified: false
  }> {
    const id = z.uuid().parse(runId)
    const selectedEndpoint = z.enum(['reviewable', 'confirmed_sent']).parse(endpoint)
    const server = await this.evidence.verify(reference, id, rawPacket)
    const snapshot = await this.checkpoints.readCompleted(reference, id)
    const journal = await readSealedRuntimeTimingJournal(
      journalReference.vaultRoot,
      journalReference.sessionId
    )
    const runtimes = new Map<string, RuntimeTimingEvidence>()
    const taskRuntimes = new Map<string, string>()
    const bindings = new Set<string>()
    const scope = snapshot.scope
    const checkIdentity = (identity: {
      tenantId: string
      employeeId: string
      accountId: string
      agentId: string
      platform: string
    }): void => {
      if (
        identity.tenantId !== scope.tenant_id ||
        identity.employeeId !== scope.employee_id ||
        identity.accountId !== scope.account_id ||
        identity.agentId !== scope.agent_id ||
        identity.platform !== scope.platform
      )
        throw new Error('evaluation_foreground_scope_conflict')
    }
    const readonlyJournal: Pick<
      PrivateRuntimeTimingJournal,
      'offer' | 'health' | 'sessionId' | 'close' | 'export'
    > = {
      sessionId: journal.sessionId,
      offer: () => true,
      health: () => ({ ...journal.health }),
      close: async () => ({ ...journal.health }),
      export: async () => {
        throw new Error('runtime_timing_reader_readonly')
      }
    }
    for (const record of journal.records) {
      if (record.kind === 'event') {
        const { value } = record
        const runtimeId = value.runtimeInstanceId
        let runtime = runtimes.get(runtimeId)
        if (!runtime) {
          runtime = new RuntimeTimingEvidence(readonlyJournal)
          runtimes.set(runtimeId, runtime)
        }
        const event = value.event
        const identity =
          'task' in event
            ? event.task.identity
            : 'binding' in event
              ? event.binding.identity
              : 'identity' in event
                ? event.identity
                : undefined
        if (!identity) throw new Error('evaluation_foreground_scope_conflict')
        checkIdentity(identity)
        if ('task' in event) {
          const taskHash = hashContext(event.task)
          const previous = taskRuntimes.get(taskHash)
          if (previous && previous !== runtimeId)
            throw new Error('evaluation_foreground_runtime_conflict')
          taskRuntimes.set(taskHash, runtimeId)
        }
        runtime.recordStored(record)
      } else {
        checkIdentity(record.task.identity)
        const taskHash = hashContext(record.task)
        const runtimeId = taskRuntimes.get(taskHash)
        const execution = snapshot.executionTasks.find((value) => value.taskHash === taskHash)
        const assignment =
          execution &&
          snapshot.assignments.find((value) => value.assignmentId === execution.assignmentId)
        if (
          !runtimeId ||
          !execution ||
          !assignment ||
          bindings.has(assignment.assignmentId) ||
          record.binding.batchId !== id ||
          record.binding.assignmentId !== assignment.assignmentId ||
          record.binding.caseId !== assignment.caseId ||
          record.binding.arm !== assignment.arm ||
          record.binding.expectedTaskHash !== taskHash ||
          record.binding.sharedConfigurationHash !== snapshot.frozen.sharedConfigurationHash ||
          record.binding.memoryManifestHash !==
            (assignment.arm === 'none'
              ? snapshot.frozen.noMemoryManifestHash
              : assignment.arm === 'baseline'
                ? snapshot.frozen.staticMemoryManifestHash
                : snapshot.frozen.learnedMemoryManifestHash) ||
          record.binding.policyVersion !== snapshot.frozen.policyVersion ||
          record.binding.retrievalVersion !== snapshot.frozen.retrievalVersion ||
          record.binding.modelVersion !== snapshot.frozen.modelVersion ||
          record.binding.knowledgeVersion !== snapshot.frozen.knowledgeVersion ||
          record.binding.modelResolved !== snapshot.basis.publication.configuration.modelResolved ||
          hashContext(record.task) !== hashContext(execution.task)
        )
          throw new Error('evaluation_foreground_binding_conflict')
        runtimes.get(runtimeId)!.bind(record.task, record.binding)
        bindings.add(assignment.assignmentId)
      }
    }
    if (
      bindings.size !== snapshot.assignments.length ||
      runtimes.size !== snapshot.assignments.length
    )
      throw new Error('evaluation_foreground_assignments_incomplete')

    const observations: VerifiedForegroundObservation[] = []
    const usedAssignments = new Set<string>()
    const usedReceipts = new Set<string>()
    const usedReads = new Set<string>()
    for (const [runtimeId, runtime] of runtimes) {
      const report = runtime.snapshot(selectedEndpoint)
      if (
        report.runtimeInstanceId !== runtimeId ||
        report.status !== 'captured' ||
        report.tasks.length !== 1
      )
        throw new Error('evaluation_foreground_timing_incomplete')
      const observation = report.tasks[0]
      const taskHash = hashContext(observation.task)
      const binding = observation.binding
      const assignment =
        binding && snapshot.assignments.find((value) => value.assignmentId === binding.assignmentId)
      const executions =
        assignment &&
        snapshot.executionTasks.filter((value) => value.assignmentId === assignment.assignmentId)
      const receipt =
        assignment &&
        snapshot.receipts.find((value) => value.assignmentId === assignment.assignmentId)
      if (
        !assignment ||
        !executions ||
        executions.length !== 1 ||
        !receipt ||
        !receipt.latencyComplete ||
        hashContext(receipt.executionTaskHashes) !== hashContext([taskHash]) ||
        executions[0].taskHash !== taskHash ||
        usedAssignments.has(assignment.assignmentId) ||
        !observation.latencyComplete ||
        observation.latencyMs === null ||
        observation.startedAtMs === null ||
        observation.endedAtMs === null ||
        observation.modelResolved !== snapshot.basis.publication.configuration.modelResolved ||
        observation.task.configVersion !== snapshot.basis.publication.configuration.configVersion ||
        observation.task.knowledgeVersion !==
          snapshot.basis.publication.configuration.knowledgeVersion ||
        observation.task.decisionPolicyVersion !== snapshot.basis.publication.policy.version ||
        observation.task.questionSetVersion !==
          snapshot.basis.publication.policy.questionSetVersion ||
        !observation.readIds.length ||
        observation.readIds.some((readId) => usedReads.has(readId)) ||
        report.reads.length !== observation.readIds.length ||
        report.reads.some((read) => !observation.readIds.includes(read.readId)) ||
        (selectedEndpoint === 'reviewable' &&
          (!observation.presentation || usedReceipts.has(observation.presentation.receiptId)))
      )
        throw new Error('evaluation_foreground_timing_incomplete')
      usedAssignments.add(assignment.assignmentId)
      observation.readIds.forEach((readId) => usedReads.add(readId))
      if (observation.presentation) usedReceipts.add(observation.presentation.receiptId)
      observations.push({
        assignmentId: assignment.assignmentId,
        caseId: assignment.caseId,
        arm: assignment.arm,
        executionTaskHash: taskHash,
        runtimeInstanceId: runtimeId,
        latencyMs: z
          .number()
          .finite()
          .nonnegative()
          .max(24 * 3600000)
          .parse(observation.latencyMs),
        readIds: [...observation.readIds],
        presentationReceiptId: observation.presentation?.receiptId ?? null,
        evidenceRef: `foreground:${hashContext({ sessionId: journal.sessionId, journalHash: journal.journalHash, runtimeId, taskHash, endpoint: selectedEndpoint })}`
      })
    }
    if (usedAssignments.size !== snapshot.assignments.length)
      throw new Error('evaluation_foreground_assignments_incomplete')
    observations.sort(
      (left, right) =>
        snapshot.assignments.findIndex((value) => value.assignmentId === left.assignmentId) -
        snapshot.assignments.findIndex((value) => value.assignmentId === right.assignmentId)
    )
    // Disk forgetting and server revocation are rechecked after replay; JSON cannot retain authority.
    await journal.assertCurrent()
    const current = await this.evidence.verify(reference, id, rawPacket)
    if (hashContext(current) !== hashContext(server))
      throw new Error('evaluation_server_evidence_conflict')
    await this.checkpoints.readCompleted(reference, id)
    await journal.assertCurrent()
    return {
      schema: 'autoreply-learning-foreground-verification-v1',
      runId: id,
      sessionId: journal.sessionId,
      endpoint: selectedEndpoint,
      basisHash: current.basisHash,
      packetHash: current.packetHash,
      journalHash: journal.journalHash,
      observations,
      serverFrozenBatchVerified: true,
      foregroundVerified: true,
      nativePlatformVerified: false,
      businessVerified: false
    }
  }
}
