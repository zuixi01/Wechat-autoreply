import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PublicationSchema, type Publication } from '../../server/src/generation/publication'
import { textGeneratorVersion } from '../../server/src/generation/text-generator'
import { evaluationSnapshotHash } from '../../server/src/generation/evaluation-authorization'
import {
  ModelCallError,
  type ModelCallResult
} from '../../server/src/generation/model-call-contracts'
import {
  createJevReplayProviderFactory,
  type ReplayCallJournal,
  type ReplayCallBinding,
  type JevReplayProviderOptions
} from '../../evals/jev/replay-providers'
import {
  executeJevReplayArm,
  type AuthorizedReplaySource,
  type ReplayAttempt,
  type ReplayAssignment
} from '../../evals/jev/replay'
import { replayCaseInputHash, type ReplayCaseInput } from '../../evals/jev/replay-input'
import { hashContext } from '../../src/core/reply/hashes'
import { evaluationPlan } from '../fixtures/evaluation-data'
import { taskFixture } from '../fixtures/task'
import type { JevRequest } from '../../src/shared/contracts/decision'

let base: Publication
beforeAll(async () => {
  base = PublicationSchema.parse(
    JSON.parse(await readFile('server/admin/publication.example.json', 'utf8'))
  )
})

function fixture() {
  const at = Date.now()
  const identity = taskFixture().task.identity
  const text = {
    apiKey: 'synthetic-text-key',
    baseUrl: 'https://text.invalid/v1/',
    model: 'text-request',
    expectedModel: 'text-resolved'
  }
  const publication = structuredClone(base)
  publication.configuration.automaticEnabled = true
  publication.configuration.modelResolved = 'jev-resolved'
  publication.policy = {
    ...publication.policy,
    modelAlias: 'jev-alias',
    modelResolved: 'jev-resolved',
    mode: 'enforced',
    evaluationApproved: true
  }
  publication.textGeneratorVersion = textGeneratorVersion(text)
  publication.evidence = [
    {
      evidenceId: 'faq-synthetic',
      tenantId: identity.tenantId,
      accountId: identity.accountId,
      conversationId: 'customer-A',
      intent: 'faq',
      knowledgeVersion: publication.policy.knowledgeVersion,
      kind: 'approved_faq',
      content: '支持离线阅读。',
      source: 'synthetic test only',
      approvedBy: 'synthetic-author',
      validFrom: 0,
      expiresAt: at + 100000
    }
  ]
  const item: ReplayCaseInput = {
    caseId: 'case-0',
    conversationGroup: 'conversation-0',
    split: 'calibration',
    conversationId: 'customer-A',
    inbound: ['支持离线阅读吗？']
  }
  const plan = evaluationPlan()
  plan.replayProtocol = 'jev-abc-v1'
  for (const row of plan.assignments)
    row.inputHash = row.caseId === item.caseId ? replayCaseInputHash(item) : hashContext(row)
  const frozen: AuthorizedReplaySource = {
    runId: 'synthetic-run',
    authenticatedScope: {
      tenantId: identity.tenantId,
      accountId: identity.accountId,
      employeeId: identity.employeeId,
      platform: identity.platform
    },
    publication,
    plan,
    snapshotHash: evaluationSnapshotHash(publication),
    createdAt: new Date(at - 1000),
    serverNow: new Date(at),
    expiresAt: new Date(at + 100000)
  }
  const bindings: ReplayCallBinding[] = []
  const attempts = new Map<string, ReplayAttempt[]>()
  const journal: ReplayCallJournal = {
    reserve: vi.fn(async (binding, stage, start) => {
      bindings.push(structuredClone(binding))
      const receipt: ReplayAttempt = {
        attemptId: randomUUID(),
        stage,
        start: structuredClone(start),
        result: { outcome: 'not_dispatched', durationMs: 0 }
      }
      const rows = attempts.get(binding.assignmentId) ?? []
      rows.push(receipt)
      attempts.set(binding.assignmentId, rows)
      return {
        finish: vi.fn(async (result: ModelCallResult) => {
          receipt.result = structuredClone(result)
        })
      }
    }),
    readAttempts: vi.fn(async (binding) =>
      structuredClone(attempts.get(binding.assignmentId) ?? [])
    )
  }
  const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // The upstream cannot run until its attempt has been reserved.
    expect(bindings.length).toBeGreaterThanOrEqual(transport.mock.calls.length)
    const request = JSON.parse(String(init?.body))
    if (request.questions) {
      const decision = request as JevRequest
      return new Response(
        JSON.stringify({
          model: 'jev-resolved',
          usage: { input_tokens: 10, output_tokens: 5 },
          answers: Object.fromEntries(
            Object.entries(decision.questions).map(([id, question]) => [
              id,
              question.type === 'choice'
                ? {
                    type: 'choice',
                    choice: 'faq',
                    confidence: 1,
                    probabilities: { faq: 1, price: 0, order: 0, aftersales: 0, other: 0 }
                  }
                : {
                    type: 'noul',
                    noul:
                      id === 'human_requested' || (id.startsWith('has_') && id !== 'has_faq')
                        ? 0
                        : 1
                  }
            ])
          )
        }),
        { status: 200 }
      )
    }
    return new Response(
      JSON.stringify({
        model: 'text-resolved',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                text: publication.evidence[0].content,
                evidenceIds: ['faq-synthetic']
              })
            }
          }
        ]
      }),
      { status: 200 }
    )
  })
  const options: JevReplayProviderOptions = {
    jevApiKey: 'synthetic-jev-key',
    text,
    fetch: transport,
    now: () => at
  }
  const assignment = (arm: 'A' | 'B' | 'C'): ReplayAssignment => ({
    runId: frozen.runId,
    caseId: item.caseId,
    arm,
    assignmentId: randomUUID()
  })
  return {
    input: { frozen, caseInput: item, identity },
    frozen,
    options,
    journal,
    bindings,
    attempts,
    transport,
    assignment
  }
}

describe('Jev replay production HTTP provider wiring', () => {
  it('independently runs A/B/C through real HTTP clients and records all six calls before dispatch', async () => {
    const f = fixture()
    const noNetwork = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network_forbidden'))
    try {
      const factory = createJevReplayProviderFactory(f.frozen, f.options, f.journal)
      const outputs = []
      for (const arm of ['A', 'B', 'C'] as const) {
        const assignment = f.assignment(arm)
        outputs.push(
          await executeJevReplayArm(
            arm,
            f.input,
            factory(assignment),
            undefined,
            assignment.assignmentId
          )
        )
      }
      expect(f.transport).toHaveBeenCalledTimes(6)
      expect(noNetwork).not.toHaveBeenCalled()
      expect(outputs.map((o) => o.usage)).toEqual([
        { inputTokens: 100, outputTokens: 50 },
        { inputTokens: 110, outputTokens: 55 },
        { inputTokens: 120, outputTokens: 60 }
      ])
      expect(
        outputs.every((o) => o.wouldRelease && !o.releaseAuthorized && o.billedCostMicros === null)
      ).toBe(true)
      expect(f.bindings.map((b) => b.arm)).toEqual(['A', 'B', 'B', 'C', 'C', 'C'])
      for (const binding of f.bindings)
        expect(binding).toMatchObject({
          ...f.frozen.authenticatedScope,
          runId: f.frozen.runId,
          caseId: 'case-0',
          inputHash: f.frozen.plan.assignments[0].inputHash,
          executionPlanHash: hashContext(f.frozen.plan),
          snapshotHash: f.frozen.snapshotHash
        })
      const serialized = JSON.stringify([...f.attempts.values()])
      expect(serialized).not.toContain('synthetic-jev-key')
      expect(serialized).not.toContain('支持离线阅读吗')
    } finally {
      noNetwork.mockRestore()
    }
  })

  it('reserves a rate-limited retry separately and preserves unknown total usage', async () => {
    const f = fixture()
    const actual = f.transport
    let calls = 0
    f.options.fetch = vi.fn(async (url, init) => {
      calls++
      if (calls === 1) {
        expect(f.bindings).toHaveLength(1)
        return new Response(null, { status: 429 })
      }
      return actual(url, init)
    }) as typeof fetch
    const assignment = f.assignment('B')
    const result = await executeJevReplayArm(
      'B',
      f.input,
      createJevReplayProviderFactory(f.frozen, f.options, f.journal)(assignment),
      undefined,
      assignment.assignmentId
    )
    expect(f.journal.reserve).toHaveBeenCalledTimes(3)
    expect(result.attempts?.map((a) => a.stage)).toEqual(['pre', 'pre', 'text'])
    expect(result.attempts?.[0].result).toMatchObject({
      outcome: 'error',
      failureCode: 'RATE_LIMITED'
    })
    expect(result.usage).toBeNull()
    expect(result.usageSource).toBe('unknown')
  })

  it('does not dispatch when durable reservation rejects and does not advance when receipt persistence fails', async () => {
    for (const phase of ['reserve', 'finish'] as const) {
      const f = fixture()
      f.journal.reserve = vi.fn(async () => {
        if (phase === 'reserve') throw new ModelCallError('LIMIT_REACHED')
        f.bindings.push({} as ReplayCallBinding)
        return {
          finish: async () => {
            throw new ModelCallError('RECORD_UNAVAILABLE')
          }
        }
      })
      const assignment = f.assignment('C')
      const result = await executeJevReplayArm(
        'C',
        f.input,
        createJevReplayProviderFactory(f.frozen, f.options, f.journal)(assignment),
        undefined,
        assignment.assignmentId
      )
      expect(result).toMatchObject({
        status: phase === 'reserve' ? 'handoff' : 'invalid',
        wouldRelease: false,
        releaseAuthorized: false
      })
      expect(f.transport).toHaveBeenCalledTimes(phase === 'reserve' ? 0 : 1)
      expect(result.stages.map((s) => s.stage)).toEqual(['pre'])
    }
  })

  it('rejects unfrozen versions, missing identity, expired runs, unknown cases, duplicate assignments and out-of-stage calls', async () => {
    for (const change of ['model', 'scope', 'expiry', 'protocol', 'snapshot'] as const) {
      const f = fixture()
      if (change === 'model') f.options.text.model = 'different-model'
      if (change === 'scope') Object.assign(f.frozen, { authenticatedScope: undefined })
      if (change === 'expiry') f.frozen.expiresAt = new Date(10000)
      if (change === 'protocol') delete f.frozen.plan.replayProtocol
      if (change === 'snapshot') f.frozen.snapshotHash = 'a'.repeat(64)
      expect(() => createJevReplayProviderFactory(f.frozen, f.options, f.journal)).toThrow()
      expect(f.transport).not.toHaveBeenCalled()
    }
    const f = fixture(),
      factory = createJevReplayProviderFactory(f.frozen, f.options, f.journal)
    expect(() => factory({ ...f.assignment('A'), caseId: 'unplanned' })).toThrow()
    expect(() => factory({ ...f.assignment('A'), runId: 'other-run' })).toThrow()
    const assignment = f.assignment('A'),
      providers = factory(assignment)
    expect(() => factory(assignment)).toThrow()
    await expect(
      providers.generator.generate({
        identity: f.input.identity,
        conversationId: 'customer-A',
        inbound: f.input.caseInput.inbound,
        intents: ['faq'],
        evidence: f.frozen.publication.evidence
      })
    ).rejects.toThrow()
    expect(f.journal.reserve).not.toHaveBeenCalled()
    expect(f.transport).not.toHaveBeenCalled()
  })

  it('keeps concurrent assignment stage contexts and receipts isolated', async () => {
    const f = fixture(),
      factory = createJevReplayProviderFactory(f.frozen, f.options, f.journal)
    const assignments = [f.assignment('A'), f.assignment('C')]
    const outputs = await Promise.all(
      assignments.map((a) =>
        executeJevReplayArm(a.arm, f.input, factory(a), undefined, a.assignmentId)
      )
    )
    expect(outputs.map((o) => o.attempts?.map((a) => a.stage))).toEqual([
      ['text'],
      ['pre', 'text', 'post']
    ])
    expect(outputs.every((o) => o.usageSource === 'recorded_http_attempts')).toBe(true)
    expect(new Set(f.bindings.map((b) => b.assignmentId)).size).toBe(2)
  })

  it('rejects case/assignment cross-use before reserving or dispatching an HTTP request', async () => {
    for (const change of ['case', 'assignment'] as const) {
      const f = fixture()
      if (change === 'case') {
        const planned = f.frozen.plan.assignments[1]
        f.input.caseInput = {
          ...f.input.caseInput,
          caseId: planned.caseId,
          conversationGroup: planned.conversationGroup
        }
        planned.inputHash = replayCaseInputHash(f.input.caseInput)
      }
      const factory = createJevReplayProviderFactory(f.frozen, f.options, f.journal)
      const original = { ...f.assignment('A'), caseId: 'case-0' }
      const providers = factory(original)
      await expect(
        executeJevReplayArm(
          'A',
          f.input,
          providers,
          undefined,
          change === 'assignment' ? randomUUID() : original.assignmentId
        )
      ).rejects.toThrow('CONTEXT_UNAVAILABLE')
      expect(f.journal.reserve).not.toHaveBeenCalled()
      expect(f.transport).not.toHaveBeenCalled()
      expect(Object.isFrozen(providers)).toBe(true)
    }
  })

  it('rejects C providers in an A execution and binds the full plan even when the current case stays unchanged', async () => {
    for (const change of ['arm', 'plan'] as const) {
      const f = fixture()
      const assignment = f.assignment('C')
      const providers = createJevReplayProviderFactory(f.frozen, f.options, f.journal)(assignment)
      if (change === 'plan') f.frozen.plan.assignments[299].inputHash = 'f'.repeat(64)
      await expect(
        executeJevReplayArm(
          change === 'arm' ? 'A' : 'C',
          f.input,
          providers,
          undefined,
          assignment.assignmentId
        )
      ).rejects.toThrow('CONTEXT_UNAVAILABLE')
      expect(f.journal.reserve).not.toHaveBeenCalled()
      expect(f.transport).not.toHaveBeenCalled()
    }
  })
})
