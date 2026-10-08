import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { EnterpriseLearningRepository } from '../../server/src/learning/learning-repository'
import { EnterpriseLearningQueue } from '../../server/src/learning/learning-queue'
import { EnterpriseLearningReviewerWorker } from '../../server/src/learning/learning-reviewer-worker'
import { stopEnterpriseLearningService } from '../../server/src/learning/learning-reviewer-service'
import {
  StructuredLearningReviewer,
  type LearningReviewTransport
} from '../../src/core/memory/learning-reviewer'
import { HttpLearningReviewTransport } from '../../src/core/memory/learning-transport'

const credential = 'Q'.repeat(43)
let db: Awaited<ReturnType<typeof embeddedPostgres>>,
  repository: EnterpriseLearningRepository,
  queue: EnterpriseLearningQueue,
  now: number
const workers: EnterpriseLearningReviewerWorker[] = []
beforeAll(async () => {
  db = await embeddedPostgres()
  await db.adminExec(
    "INSERT INTO tenants(id,name) VALUES('company','合成企业'); INSERT INTO employees(tenant_id,id,role) VALUES('company','employee','employee'); INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','account','employee','wework',false)"
  )
  await db.adminQuery(
    "INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('company','agent','account','employee',$1)",
    [tokenHash(credential)]
  )
  const authority = new AccountAuthority(db.db)
  repository = new EnterpriseLearningRepository(authority, { now: () => now })
  queue = new EnterpriseLearningQueue(db.db, authority, { now: () => now })
}, 20000)
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()))
})
afterAll(async () => {
  if (db) await db.db.close()
})
beforeEach(async () => {
  now = Date.now()
  await db.adminExec(
    'TRUNCATE learning_versions,learning_episodes,learning_memories,learning_generations,learning_feedback,learning_mutations,learning_quarantines,learning_settings,learning_jobs,learning_attempts,learning_retained_usage,learning_background_leases,learning_foreground_activity,learning_tombstones,learning_context_epochs,learning_preparations CASCADE; UPDATE agents SET revoked_at=NULL; UPDATE accounts SET paused=false'
  )
})
const content = {
  kind: 'lesson' as const,
  scenario: '设备询价',
  guidance: '先确认设备型号再检索企业资料',
  rationale: '避免匹配错误型号',
  steps: [],
  pitfalls: [],
  verification: []
}
function response(user: string) {
  const input = JSON.parse(user) as { episodes: { episodeId: string }[] }
  return {
    text: JSON.stringify({
      operations: [
        {
          action: 'create',
          proposal: {
            content,
            evidence: [{ episodeId: input.episodes[0].episodeId }],
            reason: '员工纠正'
          }
        }
      ]
    }),
    usage: { inputTokens: 10, outputTokens: 5 }
  }
}
function worker(transport: LearningReviewTransport, fingerprint = () => 'model-v1') {
  const value = new EnterpriseLearningReviewerWorker(
    queue,
    repository,
    new StructuredLearningReviewer(transport),
    {
      references: async () => [credential],
      fingerprint,
      monitorIntervalMs: 20,
      pollIntervalMs: 20
    }
  )
  workers.push(value)
  return value
}
async function enqueue() {
  const episode = await repository.recordEpisode(credential, 'customer-A', {
    sourceId: 'correction-A',
    topic: '设备询价',
    startedAt: now,
    messages: [],
    outcome: 'corrected',
    correction: '先确认型号',
    identityStatus: 'verified'
  })
  const job = await queue.enqueue(
    credential,
    'customer-A',
    episode.id,
    'correction',
    'correction-A'
  )
  now += 15000
  return job!
}
function heldTransport(buildResponse = response) {
  let finish!: () => void, started!: () => void, observedSignal!: AbortSignal
  const dispatched = new Promise<void>((resolve) => {
    started = resolve
  })
  const transport: LearningReviewTransport = {
    complete: async (request, signal) => {
      observedSignal = signal
      started()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return buildResponse(request.user)
    }
  }
  return { transport, dispatched, release: () => finish(), signal: () => observedSignal }
}
describe('enterprise learning reviewer runtime', () => {
  it('aborts learning immediately on service shutdown while an HTTP response is still draining', async () => {
    await enqueue()
    const held = heldTransport(),
      runtime = worker(held.transport)
    const reviewing = runtime.runOnce(credential)
    await held.dispatched
    let pendingResponse!: ServerResponse
    let databaseClosed = false
    const server = createServer((_request, response) => {
      pendingResponse = response
      response.writeHead(200)
      response.write('held')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const client = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    const httpClosed = new Promise<void>((resolve) => server.once('close', resolve))
    let stopping: Promise<void> | undefined
    try {
      stopping = stopEnterpriseLearningService(server, runtime, [
        {
          close: async () => {
            databaseClosed = true
          }
        }
      ])
      await expect.poll(() => held.signal().aborted).toBe(true)
      expect(await reviewing).toBe('cancelled')
      expect(databaseClosed).toBe(false)
      expect(await repository.list(credential, 'customer-A')).toHaveLength(0)
      pendingResponse.end('done')
      await client.text()
      server.closeIdleConnections()
      await httpClosed
      // The held model still owns a fee callback after HTTP draining. Do not close its database yet.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(databaseClosed).toBe(false)
      held.release()
      await stopping
      expect(databaseClosed).toBe(true)
    } finally {
      held.release()
      pendingResponse.end()
      server.closeAllConnections()
      await stopping
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it('service shutdown failure still drains the actual HTTP callback before closing databases', async () => {
    let pendingResponse!: ServerResponse
    const events: string[] = [],
      server = createServer((_request, response) => {
        pendingResponse = response
        response.writeHead(200)
        response.write('synthetic-held-response')
      })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const client = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      originalClose = server.close.bind(server),
      closing = vi.spyOn(server, 'close').mockImplementation((callback) =>
        originalClose((error) => {
          events.push('http-close-callback')
          callback?.(error)
        })
      ),
      shutdown = vi.fn(async () => {
        events.push('worker-shutdown')
        throw new Error('synthetic-worker-failure')
      }),
      databases = [0, 1].map((index) => ({
        close: vi.fn(async () => {
          expect(events).toContain('http-close-callback')
          events.push(`database-${index}`)
        })
      }))
    const stopping = stopEnterpriseLearningService(server, { shutdown, stop: vi.fn() }, databases),
      outcome = stopping.then(
        () => null,
        (error: unknown) => error
      )
    try {
      expect(shutdown).toHaveBeenCalledOnce()
      expect(closing).toHaveBeenCalledOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(events).toEqual(['worker-shutdown'])
      for (const database of databases) expect(database.close).not.toHaveBeenCalled()
      pendingResponse.end('synthetic-done')
      await client.text()
      server.closeIdleConnections()
      const error = await outcome
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('service_shutdown_failed')
      for (const database of databases) expect(database.close).toHaveBeenCalledOnce()
      expect(events.slice(0, 2)).toEqual(['worker-shutdown', 'http-close-callback'])
    } finally {
      pendingResponse.end()
      server.closeAllConnections()
      closing.mockRestore()
      await outcome
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it('service shutdown reports database failures after attempting every close including synchronous throws', async () => {
    const server = createServer(),
      synchronous = vi.fn(() => {
        throw new Error('synthetic-synchronous-database-failure')
      }),
      rejected = vi.fn(async () => {
        throw new Error('synthetic-async-database-failure')
      }),
      completed = vi.fn(async () => undefined)
    await expect(
      stopEnterpriseLearningService(server, undefined, [
        { close: synchronous },
        { close: rejected },
        { close: completed }
      ])
    ).rejects.toThrow('service_shutdown_failed')
    expect(synchronous).toHaveBeenCalledOnce()
    expect(rejected).toHaveBeenCalledOnce()
    expect(completed).toHaveBeenCalledOnce()
  })
  it('service shutdown reports an unexpected HTTP close error and still closes all databases', async () => {
    const server = createServer(),
      databases = [0, 1].map(() => ({ close: vi.fn(async () => undefined) }))
    let completed!: (error?: Error) => void
    const closing = vi.spyOn(server, 'close').mockImplementation((callback) => {
      completed = callback!
      return server
    })
    const stopping = stopEnterpriseLearningService(server, undefined, databases),
      outcome = stopping.then(
        () => null,
        (error: unknown) => error
      )
    try {
      expect(closing).toHaveBeenCalledOnce()
      for (const database of databases) expect(database.close).not.toHaveBeenCalled()
      completed(Object.assign(new Error('synthetic-http-close-failure'), { code: 'EIO' }))
      const error = await outcome
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('service_shutdown_failed')
      for (const database of databases) expect(database.close).toHaveBeenCalledOnce()
    } finally {
      closing.mockRestore()
    }
  })
  it('service shutdown tolerates the actual not-listening server error and closes databases', async () => {
    const server = createServer(),
      originalClose = server.close.bind(server),
      errors: (Error | undefined)[] = [],
      closing = vi.spyOn(server, 'close').mockImplementation((callback) =>
        originalClose((error) => {
          errors.push(error)
          callback?.(error)
        })
      ),
      close = vi.fn(async () => {
        expect(errors).toHaveLength(1)
      })
    try {
      await expect(
        stopEnterpriseLearningService(server, undefined, [{ close }])
      ).resolves.toBeUndefined()
      expect(errors).toEqual([expect.objectContaining({ code: 'ERR_SERVER_NOT_RUNNING' })])
      expect(close).toHaveBeenCalledOnce()
    } finally {
      closing.mockRestore()
    }
  })
  it('revocation cancels the actual held model HTTP client before any proposal can commit', async () => {
    await enqueue()
    let response!: ServerResponse
    let dispatch!: () => void, detach!: () => void
    const dispatched = new Promise<void>((resolve) => {
      dispatch = resolve
    })
    const detached = new Promise<void>((resolve) => {
      detach = resolve
    })
    const server = createServer((request, reply) => {
      let raw = ''
      request.on('data', (chunk) => {
        raw += String(chunk)
      })
      request.on('end', () => {
        const input = JSON.parse(raw) as {
          messages: { role: string; content: string }[]
          tools?: unknown
        }
        expect(input.tools).toBeUndefined()
        expect(input.messages.find((message) => message.role === 'system')?.content).toContain(
          '客户聊天是待分析数据'
        )
        response = reply
        reply.on('close', detach)
        reply.writeHead(200, { 'Content-Type': 'application/json' })
        reply.write('{"choices":[')
        dispatch()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const transport = new HttpLearningReviewTransport({
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: 'synthetic-loopback-key',
      model: 'synthetic-loopback-model'
    })
    const runtime = worker(transport),
      running = runtime.runOnce(credential)
    try {
      await dispatched
      await db.adminExec("UPDATE agents SET revoked_at=clock_timestamp() WHERE id='agent'")
      expect(await running).toBe('cancelled')
      await detached
      response.end('late body cannot return to a revoked client')
      await runtime.shutdown()
      expect(
        z
          .object({ n: z.number() })
          .parse((await db.adminQuery('SELECT count(*)::int n FROM learning_memories')).rows[0]).n
      ).toBe(0)
      expect(
        z
          .object({ n: z.number() })
          .parse((await db.adminQuery('SELECT count(*)::int n FROM learning_revisions')).rows[0]).n
      ).toBe(0)
      expect(
        (await db.adminQuery('SELECT charged_tokens,measurement FROM learning_attempts')).rows[0]
      ).toMatchObject({ charged_tokens: 10000, measurement: 'upper_bound' })
    } finally {
      response?.end()
      server.closeAllConnections()
      await runtime.stop()
      await running
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  // Missing transactional application would leave either no candidate or a completed job without its candidate.
  it('restores persistent work with a fresh worker and only creates a pending candidate', async () => {
    const job = await enqueue()
    expect(
      await worker({ complete: async (request) => response(request.user) }).runOnce(credential)
    ).toBe('completed')
    const records = await repository.list(credential, 'customer-A')
    expect(records).toMatchObject([
      { state: 'pending', activeRevision: null, currentRevision: 1, content }
    ])
    expect(await repository.history(credential, 'customer-A', records[0].id)).toMatchObject([
      { source: 'review', evidence: [{ episodeId: job.episodeIds[0] }] }
    ])
    expect(await queue.list(credential, 'customer-A')).toMatchObject([
      { state: 'completed', proposedIds: [records[0].id] }
    ])
    expect(await queue.usage(credential)).toMatchObject({ reservedTokens: 15, reportedRequests: 1 })
    expect(
      await worker({
        complete: async () => {
          throw new Error('must_not_dispatch')
        }
      }).runOnce(credential)
    ).toBe('idle')
  })
  it('rolls back candidate and completion together on database failure, retaining fees before retry', async () => {
    await enqueue()
    const runtime = worker({ complete: async (request) => response(request.user) })
    await db.adminExec(
      "CREATE FUNCTION reject_learning_worker_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected_write_failure'; END $$; CREATE TRIGGER reject_learning_worker_audit BEFORE INSERT ON learning_mutations FOR EACH ROW EXECUTE FUNCTION reject_learning_worker_audit()"
    )
    try {
      expect(await runtime.runOnce(credential)).toBe('failed')
      expect(await repository.list(credential, 'customer-A')).toHaveLength(0)
      expect(await queue.list(credential, 'customer-A')).toMatchObject([
        { state: 'failed', proposedIds: [], attempts: 1 }
      ])
      expect(await queue.usage(credential)).toMatchObject({
        reservedTokens: 15,
        reportedRequests: 1
      })
    } finally {
      await db.adminExec(
        'DROP TRIGGER reject_learning_worker_audit ON learning_mutations; DROP FUNCTION reject_learning_worker_audit()'
      )
    }
    now += 5000
    expect(await runtime.runOnce(credential)).toBe('completed')
    expect(await repository.list(credential, 'customer-A')).toHaveLength(1)
    expect(await queue.usage(credential)).toMatchObject({ reservedTokens: 30, reportedRequests: 2 })
  })
  it('preempts a noncooperative model on foreground activity and only settles its late fees', async () => {
    await enqueue()
    const held = heldTransport(),
      runtime = worker(held.transport)
    const running = runtime.runOnce(credential)
    await held.dispatched
    try {
      await queue.recordForegroundActivity(credential)
      expect(await running).toBe('cancelled')
      expect(held.signal().aborted).toBe(true)
      expect(await repository.list(credential, 'customer-A')).toHaveLength(0)
    } finally {
      held.release()
    }
    await expect.poll(async () => (await queue.usage(credential)).reservedTokens).toBe(15)
    expect(await queue.list(credential, 'customer-A')).toMatchObject([
      { state: 'failed', lastError: 'learning_foreground_preempted', proposedIds: [] }
    ])
    expect(await repository.list(credential, 'customer-A')).toHaveLength(0)
  })
  it('cannot recreate a forgotten scope from a late response or its accounting receipt', async () => {
    await enqueue()
    const held = heldTransport(),
      running = worker(held.transport).runOnce(credential)
    await held.dispatched
    try {
      await repository.forgetScope(credential, 'customer-A')
      expect(await running).toBe('cancelled')
      expect(held.signal().aborted).toBe(true)
    } finally {
      held.release()
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(await repository.list(credential, 'customer-A')).toHaveLength(0)
    expect(await queue.list(credential, 'customer-A')).toHaveLength(0)
    expect(await queue.usage(credential)).toMatchObject({
      reservedTokens: 10000,
      estimatedRequests: 1
    })
  })
  it('runs durable reference enumeration and stop aborts the in-flight model without committing', async () => {
    await enqueue()
    const held = heldTransport(),
      runtime = worker(held.transport)
    runtime.start()
    await held.dispatched
    try {
      await runtime.stop()
      expect(held.signal().aborted).toBe(true)
      expect(await repository.list(credential, 'customer-A')).toHaveLength(0)
    } finally {
      held.release()
    }
    await expect.poll(async () => (await queue.usage(credential)).reservedTokens).toBe(15)
    expect(await runtime.runOnce(credential)).toBe('idle')
    expect(await queue.list(credential, 'customer-A')).toMatchObject([
      { state: 'failed', lastError: 'review_shutdown' }
    ])
  })
  it('rejects a changed-and-restored configuration before commit, preserving the reported fee', async () => {
    await enqueue()
    const held = heldTransport(),
      running = worker(held.transport).runOnce(credential)
    await held.dispatched
    try {
      await repository.settings(credential, 'customer-A', { maxContextTokens: 1000 })
      await repository.settings(credential, 'customer-A', { maxContextTokens: 2000 })
    } finally {
      held.release()
    }
    expect(await running).not.toBe('completed')
    expect(await repository.list(credential, 'customer-A')).toHaveLength(0)
    expect(await queue.usage(credential)).toMatchObject({ reservedTokens: 15, reportedRequests: 1 })
  })
  it('aborts on a trusted model fingerprint change and cannot accept a late proposal', async () => {
    await enqueue()
    let model = 'model-v1'
    const held = heldTransport(),
      running = worker(held.transport, () => model).runOnce(credential)
    await held.dispatched
    try {
      model = 'model-v2'
      expect(await running).toBe('cancelled')
      expect(held.signal().aborted).toBe(true)
    } finally {
      held.release()
    }
    await expect.poll(async () => (await queue.usage(credential)).reservedTokens).toBe(15)
    expect(await repository.list(credential, 'customer-A')).toHaveLength(0)
    expect(await queue.list(credential, 'customer-A')).toMatchObject([
      { lastError: 'learning_review_context_changed' }
    ])
  })
  it('reclaims an expired process claim without discarding its potentially dispatched cost', async () => {
    await enqueue()
    const original = (await queue.claim(credential, 'crashed-worker'))!
    now = original.leaseUntil
    expect(
      await worker({ complete: async (request) => response(request.user) }).runOnce(credential)
    ).toBe('completed')
    expect(await repository.list(credential, 'customer-A')).toHaveLength(1)
    expect(await queue.list(credential, 'customer-A')).toMatchObject([
      { state: 'completed', attempts: 2 }
    ])
    expect(await queue.usage(credential)).toMatchObject({
      reservedTokens: 10015,
      estimatedRequests: 1,
      reportedRequests: 1
    })
    expect(
      await original.settleUsage({ inputTokens: 12, outputTokens: 3, measurement: 'reported' })
    ).toBe(true)
    expect(await queue.usage(credential)).toMatchObject({ reservedTokens: 30, reportedRequests: 2 })
  })
  it('keeps invalid model output out of memory while retaining its actual consumed tokens', async () => {
    await enqueue()
    expect(
      await worker({
        complete: async () => ({
          text: '{"operations":[],"activate":true}',
          usage: { inputTokens: 10, outputTokens: 5 }
        })
      }).runOnce(credential)
    ).toBe('failed')
    expect(await repository.list(credential, 'customer-A')).toHaveLength(0)
    expect(await queue.list(credential, 'customer-A')).toMatchObject([
      { state: 'failed', lastError: 'review_response_invalid' }
    ])
    expect(await queue.usage(credential)).toMatchObject({ reservedTokens: 15, reportedRequests: 1 })
  })
  it('refuses to generalize a personal preference into an account-level method', async () => {
    const episode = await repository.recordEpisode(credential, null, {
      sourceId: 'account-correction',
      topic: '沟通偏好',
      startedAt: now,
      messages: [],
      outcome: 'corrected',
      correction: '这个客户喜欢简短回复',
      identityStatus: 'verified'
    })
    await queue.enqueue(credential, null, episode.id, 'correction', 'account-correction')
    now += 15000
    const runtime = worker({
      complete: async (request) => {
        const result = response(request.user),
          parsed = JSON.parse(result.text)
        parsed.operations[0].proposal.content.kind = 'preference'
        return { ...result, text: JSON.stringify(parsed) }
      }
    })
    expect(await runtime.runOnce(credential)).toBe('failed')
    expect(await repository.list(credential, null)).toHaveLength(0)
    expect(await queue.list(credential, null)).toMatchObject([
      { lastError: 'review_identity_unverified' }
    ])
    expect(await queue.usage(credential)).toMatchObject({ reservedTokens: 15, reportedRequests: 1 })
  })
  it('reviews the actually loaded old revision and appends a pending revision while preserving the active method', async () => {
    const job = await enqueue()
    const proposal = {
      content: { ...content, guidance: '已发布的处理方法' },
      evidence: [{ episodeId: job.episodeIds[0] }],
      source: 'human' as const,
      reason: '员工确认'
    }
    const memory = await repository.propose(credential, 'customer-A', proposal)
    await repository.activate(credential, 'customer-A', memory.id, 1)
    await repository.revise(credential, 'customer-A', memory.id, 1, {
      ...proposal,
      content: { ...content, guidance: '待审的处理方法' }
    })
    await repository.registerGeneration(
      credential,
      'customer-A',
      'generation-used-V1',
      job.episodeIds[0],
      [{ id: memory.id, revision: 1 }]
    )
    let observed: Record<string, unknown> | undefined
    const runtime = worker({
      complete: async (request) => {
        observed = JSON.parse(request.user)
        return {
          text: JSON.stringify({
            operations: [
              {
                action: 'revise',
                memoryId: memory.id,
                expectedRevision: 2,
                proposal: {
                  content: { ...content, guidance: '补充员工纠正后的处理方法' },
                  evidence: [{ episodeId: job.episodeIds[0] }],
                  reason: '在当前待审版本上补充'
                }
              }
            ]
          }),
          usage: { inputTokens: 10, outputTokens: 5 }
        }
      }
    })
    expect(await runtime.runOnce(credential)).toBe('completed')
    expect(observed).toMatchObject({
      loadedMemoryRefs: [{ id: memory.id, revision: 1 }],
      loadedRevisions: [
        { memoryId: memory.id, revision: 1, content: { guidance: '已发布的处理方法' } }
      ],
      memories: [
        { memoryId: memory.id, expectedRevision: 2, content: { guidance: '待审的处理方法' } }
      ]
    })
    expect(await repository.get(credential, 'customer-A', memory.id)).toMatchObject({
      currentRevision: 3,
      activeRevision: 1
    })
    expect((await repository.retrieve(credential, 'customer-A', '设备询价')).items).toMatchObject([
      { revision: 1, content: { guidance: '已发布的处理方法' } }
    ])
    expect(await repository.history(credential, 'customer-A', memory.id)).toMatchObject([
      { revision: 1 },
      { revision: 2 },
      { revision: 3, source: 'review' }
    ])
  })
  it('rejects a model revision when the employee pins the method while the model is running', async () => {
    const job = await enqueue()
    const memory = await repository.propose(credential, 'customer-A', {
      content,
      evidence: [{ episodeId: job.episodeIds[0] }],
      source: 'human',
      reason: '人工方法'
    })
    const held = heldTransport((user) => {
        const result = response(user),
          parsed = JSON.parse(result.text)
        parsed.operations[0] = {
          ...parsed.operations[0],
          action: 'revise',
          memoryId: memory.id,
          expectedRevision: 1
        }
        parsed.operations[0].proposal.content.guidance = '模型提出的修订方法'
        return { ...result, text: JSON.stringify(parsed) }
      }),
      running = worker(held.transport).runOnce(credential)
    await held.dispatched
    try {
      await repository.setPinned(credential, 'customer-A', memory.id, 1, true)
    } finally {
      held.release()
    }
    expect(await running).not.toBe('completed')
    expect(await repository.get(credential, 'customer-A', memory.id)).toMatchObject({
      pinned: true,
      currentRevision: 1
    })
    expect(await repository.history(credential, 'customer-A', memory.id)).toHaveLength(1)
    expect(await queue.usage(credential)).toMatchObject({ reservedTokens: 15, reportedRequests: 1 })
  })
})
