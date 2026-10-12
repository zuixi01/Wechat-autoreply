import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { ForegroundEvaluationHost } from '../../src/main/services/foreground-evaluation-host'
import { WorkbenchPresentationCapture } from '../../src/main/services/workbench-presentation-capture'
import { hashContext, hashDraft } from '../../src/core/reply/hashes'
import type { ForegroundEvaluationAssignment } from '../../src/shared/contracts/foreground-evaluation'
import { taskFixture } from '../fixtures/task'
import { SyntheticCollectionSource } from '../fixtures/collection'

let directory: string
beforeAll(async () => {
  const root = resolve('.local/tests')
  await mkdir(root, { recursive: true })
  directory = await mkdtemp(join(root, 'foreground-host-'))
})
afterAll(async () => {
  if (!directory) return
  const part = relative(resolve('.local/tests'), directory)
  if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('unsafe_test_cleanup')
  await rm(directory, { recursive: true, force: true })
})
function fixture(name: string, leaseDurationMs = 20000) {
  const original = taskFixture().task
  const identity = {
    ...original.identity,
    loginEpoch: 7,
    clientInstanceId: 'synthetic-source-instance'
  }
  const scope = {
    tenant_id: identity.tenantId,
    employee_id: identity.employeeId,
    account_id: identity.accountId,
    agent_id: identity.agentId,
    platform: identity.platform
  }
  const sources: SyntheticCollectionSource[] = []
  const host = new ForegroundEvaluationHost({
    directory: join(directory, name),
    client: {
      status: () => ({ state: 'registered', scope }),
      acquireLease: async () => {
        const now = Date.now()
        return {
          identity,
          leaseId: 'synthetic-host-lease',
          version: 1,
          serverIssuedAt: now,
          expiresAt: now + leaseDurationMs
        }
      }
    },
    configuration: {
      configVersion: original.configVersion,
      knowledgeVersion: original.knowledgeVersion,
      decisionPolicyVersion: original.decisionPolicyVersion,
      questionSetVersion: original.questionSetVersion,
      modelResolved: 'synthetic-host-model',
      automaticEnabled: true,
      memoryCorpusVersion: 'must-not-prepare-learning'
    },
    platform: () => {
      const source = new SyntheticCollectionSource(identity, 1)
      source.add('customer-0', '合成前台问题')
      sources.push(source)
      const forbidden = async (): Promise<never> => {
        throw new Error('must_not_send')
      }
      return {
        collectionSource: source,
        capabilities: () => ({ backgroundRead: true, nonInterferingSend: true }),
        binding: async () => ({ identity, conversations: [] }),
        observe: async () => {},
        stop: async () => {},
        readCurrent: forbidden,
        dispatch: forbidden
      }
    }
  })
  const runId = randomUUID()
  const assignment = (
    arm: 'none' | 'baseline' | 'learned',
    ordinal = 0
  ): ForegroundEvaluationAssignment => {
    const now = Date.now()
    return {
      runId,
      scope,
      assignment: { ordinal, assignmentId: randomUUID(), caseId: 'case-0', arm },
      task: {
        ...original,
        taskId: randomUUID(),
        conversationId: 'customer-0',
        createdAt: now,
        expiresAt: now + 30000
      },
      item: {
        caseId: 'case-0',
        conversationId: 'customer-0',
        category: 'inquiry',
        inbound: ['合成前台问题']
      },
      frozen: {
        frozenAt: now,
        sharedConfigurationHash: 'a'.repeat(64),
        noMemoryManifestHash: 'b'.repeat(64),
        staticMemoryManifestHash: 'c'.repeat(64),
        learnedMemoryManifestHash: 'd'.repeat(64),
        policyVersion: 'synthetic-policy-deployment',
        retrievalVersion: 'synthetic-retrieval',
        modelVersion: 'synthetic-model-version',
        knowledgeVersion: original.knowledgeVersion,
        methods: [
          { id: 'method-1', revision: 1, contentHash: 'e'.repeat(64), sourceCaseIds: ['learn-1'] }
        ]
      }
    }
  }
  return { host, sources, assignment }
}
async function until(predicate: () => boolean): Promise<void> {
  const expires = Date.now() + 2500
  while (!predicate()) {
    if (Date.now() >= expires) throw new Error('candidate_timeout')
    await new Promise((done) => setTimeout(done, 10))
  }
}
describe('host-only foreground evaluation bridge', () => {
  it('retains bodyless lease-loss diagnostics and refuses an invalid real lease before collection or generation', async () => {
    const f = fixture('invalid-lease', 60000)
    try {
      await expect(
        f.host.foregroundTask(f.assignment('learned'), new AbortController().signal)
      ).rejects.toMatchObject({
        message: 'evaluation_foreground_runtime_unavailable',
        runtimeStatus: { reason: 'lease_lost', lease: 'stopped' }
      })
      expect(f.sources).toHaveLength(1)
      expect(f.sources[0].readCalls).toEqual([])
      expect(
        (await readdir(join(directory, 'invalid-lease'))).filter((name) =>
          name.startsWith('ledger-')
        )
      ).toEqual([])
      await expect(f.host.finish()).rejects.toThrow('evaluation_foreground_evidence_incomplete')
    } finally {
      await f.host.close()
    }
  })
  it('uses actual core collection/generation for all three arms in one journal without enabling any learning or send action', async () => {
    const f = fixture('three-arms'),
      signal = new AbortController().signal
    const taskHashes: string[] = []
    try {
      for (const [ordinal, arm] of (['none', 'baseline', 'learned'] as const).entries()) {
        const assignment = f.assignment(arm, ordinal)
        const input = await f.host.foregroundTask(assignment, signal)
        expect(input.task.identity.loginEpoch).toBe(7)
        expect(input.task.identity.clientInstanceId).toBe('synthetic-source-instance')
        expect(input.task.contextHash).toBe(hashContext(input.context))
        expect(input.task.memoryCorpusVersion).toBeUndefined()
        taskHashes.push(hashContext(input.task))
        const text = `合成原管线结果 ${arm}`
        const result = f.host.foregroundResult(
          {
            ...assignment,
            task: input.task,
            result: {
              status: 'handoff',
              automaticAllowed: false,
              factsVerified: false,
              reasons: ['shadow_mode'],
              intents: ['faq'],
              usage: { input_tokens: 1, output_tokens: 1 },
              draft: {
                taskId: input.task.taskId,
                draftRevision: 1,
                action: 'clarify',
                text,
                draftHash: hashDraft(text),
                evidenceIds: []
              }
            }
          },
          signal
        )
        await until(() => f.host.currentRuntime()?.workbench().rows[0]?.replyText === text)
        const runtime = f.host.currentRuntime()!,
          row = runtime.workbench().rows[0]
        expect(row.canLearn).toBe(false)
        expect(row.canSkip).toBe(false)
        expect(row.canReview).toBe(false)
        expect(row.canConfirm).toBe(false)
        const request = { taskId: row.taskId, expectedVersion: row.version }
        for (const operation of [
          () => runtime.workbenchLearn(request),
          () => runtime.workbenchAction(request),
          () => runtime.workbenchReviewEdited(request),
          () => runtime.workbenchConfirmSend(request),
          () => runtime.workbenchReconcile(request)
        ])
          expect(await operation()).toMatchObject({
            success: false,
            code: 'unavailable'
          })
        expect(runtime.learningBackend()).toBeNull()
        await expect(runtime.submitLearning({})).rejects.toThrow('learning_scope_unavailable')
        // This surface is synthetic. A separate actual Electron fixture verifies native rendering.
        const capture = new WorkbenchPresentationCapture(
          (raw) => runtime.presentationTarget(raw),
          (receipt) => runtime.recordPresentation(receipt)
        )
        const surface = {
          owner: 1,
          document: 'synthetic-surface',
          visible: () => true,
          inspect: async () => true,
          capture: async () => true
        }
        const ticket = capture.issue(request, surface)
        expect(ticket.available).toBe(true)
        if (!ticket.available) throw new Error('ticket_missing')
        expect(await capture.acknowledge({ nonce: ticket.nonce }, surface)).toEqual({
          accepted: true
        })
        capture.close()
        await result
        expect(f.host.currentRuntime()?.status().state).toBe('closed')
      }
      const sealed = await f.host.finish()
      expect(sealed.observations).toBe(3)
      const report = JSON.parse(await readFile(sealed.path, 'utf8'))
      expect(report.businessVerified).toBe(false)
      expect(report.serverFrozenBatchVerified).toBe(false)
      expect(
        new Set(
          report.observations.map((item: { runtimeInstanceId: string }) => item.runtimeInstanceId)
        ).size
      ).toBe(3)
      expect(
        report.observations.map((item: { executionTaskHash: string }) => item.executionTaskHash)
      ).toEqual(taskHashes)
      expect(f.sources.every((source) => source.readCalls.length > 0)).toBe(true)
      expect(
        (await readdir(join(directory, 'three-arms'))).filter((name) => name.startsWith('ledger-'))
      ).toEqual([])
      expect(
        (await readdir(join(directory, 'three-arms', 'timing-vault'))).filter(
          (name) => name === sealed.sessionId
        )
      ).toHaveLength(1)
    } finally {
      await f.host.close()
    }
    // Three actual runtime lifecycles include collector polling, private Windows
    // permission checks and ledger cleanup; the default 5 s ceiling is too tight.
  }, 15000)
  it('rejects a foreign scope before collection and cannot seal an aborted generation as complete', async () => {
    const f = fixture('aborted')
    const original = f.assignment('learned')
    await expect(
      f.host.foregroundTask(
        { ...original, scope: { ...original.scope, account_id: 'foreign' } },
        new AbortController().signal
      )
    ).rejects.toThrow('evaluation_foreground_assignment_conflict')
    expect(f.sources).toHaveLength(0)
    const controller = new AbortController()
    const input = await f.host.foregroundTask(original, controller.signal)
    expect(input.inbound).toEqual(original.item.inbound)
    controller.abort()
    await f.host.close()
    await expect(f.host.finish()).rejects.toThrow('evaluation_foreground_evidence_incomplete')
    expect(
      (await readdir(join(directory, 'aborted'))).filter((name) => name.startsWith('ledger-'))
    ).toEqual([])
  })
})
