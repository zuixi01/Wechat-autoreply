import { z } from 'zod'
import type { Postgres } from '../database/postgres'
import { learningHash } from '../../../src/core/memory/learning-scope'
import type { LearningAccountAuthority } from './learning-account'
import { EnterpriseLearningValidationBudget } from './learning-validation-budget'
import { EnterpriseEvaluationCheckpoint } from './learning-evaluation-checkpoint'
import { verifyEnterpriseMemoryReplayPacket } from './learning-memory-replay'

/** Live database authentication is required on every read; exported hashes are not credentials. */
export class EnterpriseEvaluationEvidence {
  private readonly checkpoints: EnterpriseEvaluationCheckpoint
  constructor(database: Postgres, authority: LearningAccountAuthority) {
    this.checkpoints = new EnterpriseEvaluationCheckpoint(
      authority,
      new EnterpriseLearningValidationBudget(database, authority)
    )
  }

  async verify(
    reference: string,
    runId: string,
    raw: unknown
  ): Promise<{
    runId: string
    basisHash: string
    packetHash: string
    assignments: {
      ordinal: number
      assignmentId: string
      caseId: string
      arm: 'none' | 'baseline' | 'learned'
    }[]
    executionBindings: { assignmentId: string; taskHash: string }[]
    serverFrozenBatchVerified: true
    foregroundVerified: false
    businessVerified: false
  }> {
    const id = z.uuid().parse(runId)
    const snapshot = await this.checkpoints.readCompleted(reference, id)
    const packet = verifyEnterpriseMemoryReplayPacket(raw)
    const { input, publication, model, methods, episodes, frames, frozen, receipts, blind } = packet
    if (
      learningHash({ input, publication, model, methods, episodes, frames }) !==
        learningHash(snapshot.basis) ||
      learningHash(frozen) !== learningHash(snapshot.frozen) ||
      learningHash(receipts) !== learningHash(snapshot.receipts)
    )
      throw new Error('evaluation_server_evidence_conflict')
    const expectedBlind = snapshot.receipts.map((receipt) => {
      const item = snapshot.basis.input.cases.find((value) => value.caseId === receipt.caseId)
      if (!item) throw new Error('evaluation_checkpoint_basis_conflict')
      return {
        assignmentId: receipt.assignmentId,
        caseId: receipt.caseId,
        category: item.category,
        question: item.context
          ? JSON.stringify({ context: item.context, inbound: item.inbound })
          : item.inbound.join('\n'),
        reply: receipt.reply
      }
    })
    if (learningHash(blind) !== learningHash(expectedBlind))
      throw new Error('evaluation_server_evidence_conflict')
    return {
      runId: id,
      basisHash: learningHash({
        scope: snapshot.scope,
        basis: snapshot.basis,
        frozen,
        assignments: snapshot.assignments
      }),
      packetHash: learningHash(packet),
      assignments: structuredClone(snapshot.assignments),
      executionBindings: snapshot.executionTasks.map(({ assignmentId, taskHash }) => ({
        assignmentId,
        taskHash
      })),
      serverFrozenBatchVerified: true,
      foregroundVerified: false,
      businessVerified: false
    }
  }
}
