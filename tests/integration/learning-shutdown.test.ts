import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningScheduler } from '../../src/core/memory/learning-scheduler'
import { StructuredLearningReviewer } from '../../src/core/memory/learning-reviewer'
import { HttpLearningReviewTransport } from '../../src/core/memory/learning-transport'
import { BudgetedLearningValidationTransport } from '../../src/core/memory/learning-validation-budget'
import { memorySemanticUnits } from '../../src/core/memory/learning-risk'
import { LearningService } from '../../src/main/services/learning-service'
import type { LearningValidationCase } from '../../src/shared/contracts/learning-memory'

const scope = { workspaceId: 'shutdown-profile', platform: 'generic' as const }
const stores: LearningStore[] = [],
  servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const store of stores.splice(0)) store.close()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
function setup(reviewJob = true) {
  let now = 1000
  const store = new LearningStore(':memory:', () => now)
  stores.push(store)
  store.settings(scope, { mode: 'suggest', idleDelayMs: 1000 })
  const episode = store.recordEpisode(scope, {
    sourceId: 'actual-fixture-correction',
    topic: '设备询价',
    startedAt: now,
    outcome: 'corrected',
    messages: [],
    correction: '先问型号和数量',
    correctionReason: '核对需求'
  })
  const proposal = {
    content: {
      kind: 'lesson' as const,
      scenario: '设备询价',
      guidance: '先问型号和数量',
      rationale: '',
      steps: [],
      pitfalls: [],
      verification: []
    },
    evidence: [{ episodeId: episode.id }],
    reason: '真实测试案例的人工纠正'
  }
  if (reviewJob) store.jobs.enqueue(scope, episode.id, 'correction', 'actual-fixture-correction')
  now = 2000
  return { store, proposal, now: () => now }
}
function validationSetup() {
  const { store, proposal, now } = setup(false)
  const memory = store.propose(scope, { ...proposal, source: 'review' })
  const cases: LearningValidationCase[] = Array.from({ length: 5 }, (_, i) => ({
    caseId: `synthetic-calibration-${i}`,
    conversationId: `independent-synthetic-${i}`,
    input: '设备询价',
    expectedMethod: '核对需求',
    requiredTerms: ['型号', '数量'],
    forbiddenClaims: [],
    humanLabelled: true,
    labelOrigin: 'human' as const // Simulated human declaration for engineering tests only.
  }))
  const source = { cases, knowledgeVersion: 'k1', policyVersion: 'p1', validatorVersion: 'v1' }
  return { store, memory, source, now }
}

describe('learning shutdown drains actual work before database closure', () => {
  it('joins a noncooperative review and its late fee settlement while promptly cancelling its candidate', async () => {
    const { store, proposal, now } = setup()
    const held = deferred<{ text: string; usage: { inputTokens: number; outputTokens: number } }>()
    const scheduler = new LearningScheduler(
      store,
      new StructuredLearningReviewer({ complete: () => held.promise }),
      undefined,
      now
    )
    let closed = false,
      afterClose = 0,
      drained = false
    const settle = store.jobs.settleAttemptUsage.bind(store.jobs)
    vi.spyOn(store.jobs, 'settleAttemptUsage').mockImplementation((claim, usage) => {
      if (closed) afterClose++
      return settle(claim, usage)
    })
    const running = scheduler.runOnce()
    try {
      const stopping = scheduler.shutdown().then(() => {
        drained = true
      })
      expect(await running).toBe('cancelled')
      await tick()
      expect(drained).toBe(false)
      held.resolve({
        text: JSON.stringify({ operations: [{ action: 'create', proposal }] }),
        usage: { inputTokens: 100, outputTokens: 10 }
      })
      await stopping
      expect(store.jobs.usage(scope)).toMatchObject({ reservedTokens: 110, reportedRequests: 1 })
      expect(store.list(scope)).toEqual([])
      expect(await scheduler.runOnce()).toBe('idle')
      closed = true
      store.close()
      await tick()
      expect(afterClose).toBe(0)
    } finally {
      scheduler.stop()
      held.resolve({ text: '{"operations":[]}', usage: { inputTokens: 100, outputTokens: 10 } })
      await running
      await tick()
    }
  })

  it('aborts a real held HTTP model body and finishes its callbacks before local store closure', async () => {
    const { store, now } = setup()
    const received = deferred<void>(),
      detached = deferred<void>()
    let response: ServerResponse | undefined
    const server = createServer((request, reply) => {
      request.resume()
      request.on('end', () => {
        response = reply
        reply.on('close', () => detached.resolve())
        reply.writeHead(200, { 'Content-Type': 'application/json' })
        reply.write('{"choices":[')
        received.resolve()
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const transport = new HttpLearningReviewTransport({
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'synthetic-test-key',
      model: 'synthetic-model'
    })
    const service = new LearningService(store, new StructuredLearningReviewer(transport), {
      workspaceId: scope.workspaceId,
      now
    })
    const running = service.scheduler.runOnce()
    try {
      await received.promise
      await service.shutdown()
      expect(await running).toBe('cancelled')
      await detached.promise
      expect(store.list(scope)).toEqual([])
      expect(store.jobs.usage(scope)).toMatchObject({ estimatedRequests: 1, reservedTokens: 10000 })
      const fees = vi.spyOn(store.jobs, 'settleAttemptUsage')
      store.close()
      response!.end('late response cannot return to the cancelled client')
      await tick()
      expect(fees).not.toHaveBeenCalled()
    } finally {
      service.stop()
      response?.end()
      await running
    }
  })

  it('joins validation source preparation that has not yet obtained a cancellation controller', async () => {
    const { store, memory, source, now } = validationSetup()
    store.settings(scope, { mode: 'auto', idleDelayMs: 1000 })
    // createdAt=2000, hence the auto loop may inspect this candidate at 3000.
    const held = deferred<typeof source>(),
      dispatched = deferred<void>()
    const service = new LearningService(
      store,
      { review: async () => ({ operations: [], usage: { inputTokens: 0, outputTokens: 0 } }) },
      {
        workspaceId: scope.workspaceId,
        now: () => now() + 1000,
        validation: {
          dataset: async () => {
            dispatched.resolve()
            return held.promise
          }
        }
      }
    )
    const running = service.runAutoValidationOnce()
    try {
      await dispatched.promise
      let drained = false
      const stopping = service.shutdown().then(() => {
        drained = true
      })
      await tick()
      expect(drained).toBe(false)
      held.resolve(source)
      expect(await running).toBe('idle')
      await stopping
      expect(store.get(scope, memory.id).state).toBe('pending')
      expect(store.validation.reports(scope, memory.id)).toEqual([])
      expect(await service.runAutoValidationOnce()).toBe('idle')
      expect(await service.validateCandidate(scope, memory.id, 1)).toMatchObject({
        status: 'failed',
        reasons: ['validation_cancelled']
      })
    } finally {
      service.stop()
      held.resolve(source)
      await running
    }
  })

  it('joins a cancelled validation HTTP wrapper and its late actual fee without granting activation', async () => {
    const { store, memory, source, now } = validationSetup()
    const held = deferred<{ text: string; usage: { inputTokens: number; outputTokens: number } }>(),
      dispatched = deferred<void>()
    const service = new LearningService(
      store,
      { review: async () => ({ operations: [], usage: { inputTokens: 0, outputTokens: 0 } }) },
      {
        workspaceId: scope.workspaceId,
        now,
        validation: {
          dataset: async () => source,
          forRun: (_scope, run) => ({
            assessRisk: async (revision, signal) => {
              const transport = new BudgetedLearningValidationTransport(store, run, {
                complete: () => {
                  dispatched.resolve()
                  return held.promise
                }
              })
              await transport.complete(
                { system: 'risk', user: 'fixture', maxOutputTokens: 2000 },
                signal
              )
              return {
                contentHash: revision.contentHash,
                units: memorySemanticUnits(revision.content).map((unit) => ({
                  path: unit.path,
                  category: 'method',
                  reason: 'synthetic test'
                }))
              }
            },
            replay: async () => ({ text: '核对型号和数量', covered: true, severeErrors: [] })
          })
        }
      }
    )
    const running = service.validateCandidate(scope, memory.id, 1)
    try {
      await dispatched.promise
      let drained = false
      const stopping = service.shutdown().then(() => {
        drained = true
      })
      expect(await running).toMatchObject({ status: 'failed', reasons: ['validation_cancelled'] })
      await tick()
      expect(drained).toBe(false)
      held.resolve({ text: '{}', usage: { inputTokens: 100, outputTokens: 10 } })
      await stopping
      expect(store.jobs.usage(scope)).toMatchObject({ reservedTokens: 110, reportedRequests: 1 })
      expect(store.get(scope, memory.id).state).toBe('pending')
      const fees = vi.spyOn(store.validationBudget, 'settle')
      store.close()
      await tick()
      expect(fees).not.toHaveBeenCalled()
    } finally {
      service.stop()
      held.resolve({ text: '{}', usage: { inputTokens: 100, outputTokens: 10 } })
      await running
      await tick()
    }
  })
})
