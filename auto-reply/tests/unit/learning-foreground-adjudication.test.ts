import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LearningEvaluationDatasetSchema } from '../../src/shared/contracts/learning-evaluation'
import { EnterpriseForegroundEvidence } from '../../server/src/learning/learning-foreground-evidence'
import type { Postgres } from '../../server/src/database/postgres'
import type { LearningAccountAuthority } from '../../server/src/learning/learning-account'
import { evaluateMemoryDataset } from '../../evals/memory/metrics'

const mocks = vi.hoisted(() => ({ parse: vi.fn(), adjudicate: vi.fn() }))
vi.mock('../../server/src/learning/learning-memory-replay', () => ({
  verifyEnterpriseMemoryReplayPacket: mocks.parse,
  adjudicateEnterpriseMemoryReplay: mocks.adjudicate
}))
beforeEach(() => {
  vi.restoreAllMocks()
  mocks.parse.mockReset()
  mocks.adjudicate.mockReset()
})

// Projection unit checks only. Real database/vault authority is exercised by the joint fixture.
function fixture() {
  const outcome = {
    reply: 'synthetic reply',
    humanReviewed: true,
    substantialCorrection: false,
    severeError: false,
    validAnswer: true,
    generatedAt: 20,
    latencyMs: 4,
    latencyComplete: true,
    inputTokens: 30,
    outputTokens: 6,
    costUsd: 0.012,
    configurationHash: 'a'.repeat(64),
    memoryManifestHash: 'b'.repeat(64)
  }
  const label = {
    origin: 'synthetic' as const,
    blinded: true,
    reviewerId: 'synthetic-reviewer',
    evidenceRef: 'synthetic-only',
    assignmentRef: 'synthetic-assignment',
    labelledAt: 30
  }
  const dataset = LearningEvaluationDatasetSchema.parse({
    version: 2,
    datasetId: 'synthetic-derived-foreground',
    origin: 'synthetic',
    rubricRef: 'synthetic-rubric',
    frozen: {
      frozenAt: 10,
      sharedConfigurationHash: 'a'.repeat(64),
      staticMemoryManifestHash: 'b'.repeat(64),
      learnedMemoryManifestHash: 'c'.repeat(64),
      noMemoryManifestHash: 'd'.repeat(64),
      modelVersion: 'synthetic-model',
      knowledgeVersion: 'synthetic-knowledge',
      policyVersion: 'synthetic-policy',
      retrievalVersion: 'synthetic-retrieval',
      backgroundCostUsd: 0.01,
      latencyScope: 'enterprise_pipeline',
      methods: [
        {
          id: 'synthetic-method',
          revision: 1,
          contentHash: 'e'.repeat(64),
          sourceCaseIds: ['learn-case']
        }
      ]
    },
    cases: [
      { caseId: 'learn-case', conversationId: 'learn-conversation', split: 'learn', label },
      {
        caseId: 'eval-case',
        conversationId: 'eval-conversation',
        split: 'evaluate',
        category: 'inquiry',
        label,
        none: { ...outcome, memoryManifestHash: 'd'.repeat(64) },
        baseline: outcome,
        learned: { ...outcome, memoryManifestHash: 'c'.repeat(64) }
      }
    ]
  })
  const arms = ['none', 'baseline', 'learned'] as const
  const receipts = arms.map((arm) => ({ assignmentId: randomUUID(), caseId: 'eval-case', arm }))
  const packet = { frozen: structuredClone(dataset.frozen), receipts, privateOriginal: 'unchanged' }
  mocks.parse.mockImplementation((raw: unknown) => structuredClone(raw))
  mocks.adjudicate.mockImplementation(() => structuredClone(dataset))
  const evidence = new EnterpriseForegroundEvidence({} as Postgres, {} as LearningAccountAuthority)
  const verification: Awaited<ReturnType<EnterpriseForegroundEvidence['verify']>> = {
    schema: 'autoreply-learning-foreground-verification-v1',
    runId: randomUUID(),
    sessionId: randomUUID(),
    endpoint: 'reviewable',
    basisHash: 'a'.repeat(64),
    packetHash: 'b'.repeat(64),
    journalHash: 'c'.repeat(64),
    observations: receipts.map((r, index) => ({
      ...r,
      executionTaskHash: 'd'.repeat(64),
      runtimeInstanceId: randomUUID(),
      latencyMs: 100 + index,
      readIds: [randomUUID()],
      presentationReceiptId: randomUUID(),
      evidenceRef: `synthetic-unit-evidence-${index}`
    })),
    serverFrozenBatchVerified: true,
    foregroundVerified: true,
    nativePlatformVerified: false,
    businessVerified: false
  }
  const verify = vi.spyOn(evidence, 'verify').mockResolvedValue(verification)
  const reference = randomUUID(),
    journal = { vaultRoot: 'host-only-synthetic-path', sessionId: verification.sessionId }
  const labels = [{ synthetic: 'original labels remain with old adjudicator' }]
  const adjudicate = () =>
    evidence.adjudicate(reference, verification.runId, packet, labels, journal)
  return { evidence, verification, verify, reference, journal, packet, labels, dataset, adjudicate }
}

describe('online foreground adjudication projection', () => {
  it('derives only timing while preserving the original freeze, source, replies and fees', async () => {
    const f = fixture(),
      originalPacket = structuredClone(f.packet),
      originalDataset = structuredClone(f.dataset)
    const result = await f.adjudicate()
    expect(f.verify).toHaveBeenCalledWith(
      f.reference,
      f.verification.runId,
      originalPacket,
      f.journal,
      'reviewable'
    )
    expect(mocks.adjudicate).toHaveBeenCalledWith(originalPacket, f.labels)
    expect(f.packet).toEqual(originalPacket)
    expect(f.dataset).toEqual(originalDataset)
    expect(result.dataset.origin).toBe('synthetic')
    expect(result.dataset.frozen).toEqual({
      ...originalDataset.frozen,
      latencyScope: 'foreground_end_to_end'
    })
    const item = result.dataset.cases.find((value) => value.split === 'evaluate')!
    const original = originalDataset.cases.find((value) => value.split === 'evaluate')!
    if (item.split !== 'evaluate' || original.split !== 'evaluate')
      throw new Error('synthetic_fixture_invalid')
    for (const [index, arm] of (['none', 'baseline', 'learned'] as const).entries()) {
      expect(item[arm]).toEqual({
        ...original[arm],
        latencyMs: 100 + index,
        latencyComplete: true,
        latencyEvidenceRef: `synthetic-unit-evidence-${index}`
      })
    }
    expect(result.verification).toMatchObject({
      nativePlatformVerified: false,
      businessVerified: false
    })
    expect(evaluateMemoryDataset(result.dataset).assessment.status).toBe('insufficient')
  })
  it('does not derive a dataset when online verification fails', async () => {
    const f = fixture()
    f.verify.mockRejectedValue(new Error('evaluation_foreground_timing_incomplete'))
    await expect(f.adjudicate()).rejects.toThrow('evaluation_foreground_timing_incomplete')
    expect(mocks.adjudicate).not.toHaveBeenCalled()
  })
  it.each(['missing_adjudication', 'missing_metered_cost', 'missing_metered_usage'])(
    'keeps the original %s refusal',
    async (reason) => {
      const f = fixture()
      mocks.adjudicate.mockImplementation(() => {
        throw new Error(reason)
      })
      await expect(f.adjudicate()).rejects.toThrow(reason)
    }
  )
  it('rejects a missing or duplicate verified assignment instead of filling its timing', async () => {
    const f = fixture()
    f.verification.observations.pop()
    await expect(f.adjudicate()).rejects.toThrow('evaluation_foreground_assignments_incomplete')
    f.verification.observations.push(f.verification.observations[0])
    await expect(f.adjudicate()).rejects.toThrow('evaluation_foreground_assignments_incomplete')
  })
  it('does not reinterpret confirmed_sent as a reviewable endpoint', async () => {
    const f = fixture()
    f.verify.mockRejectedValue(new Error('evaluation_foreground_timing_incomplete'))
    await expect(
      f.evidence.adjudicate(
        f.reference,
        f.verification.runId,
        f.packet,
        f.labels,
        f.journal,
        'confirmed_sent'
      )
    ).rejects.toThrow('evaluation_foreground_timing_incomplete')
    expect(f.verify).toHaveBeenCalledWith(
      f.reference,
      f.verification.runId,
      f.packet,
      f.journal,
      'confirmed_sent'
    )
  })
})
