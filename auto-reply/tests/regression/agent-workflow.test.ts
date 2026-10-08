import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ReliableAgent,
  type ReplyCandidate,
  type ReplyService
} from '../../src/core/agent/reliable-agent'
import { Ledger } from '../../src/core/persistence/ledger'
import type { ReplyTask } from '../../src/shared/contracts/task'
import type { ConversationBinding } from '../../src/shared/contracts/identity'
import type { ObservedMessage } from '../../src/shared/contracts/message'
import type {
  DeliveryResult,
  SendCommand,
  VerifiedSendAdapter
} from '../../src/core/sending/sender'
import { hashDraft } from '../../src/core/reply/hashes'
import { taskFixture } from '../fixtures/task'
import type { AgentProgressEvent } from '../../src/core/agent/reliable-agent'

const ledgers: Ledger[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const ledger of ledgers.splice(0)) ledger.close()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((r) => {
      resolve = r
    }),
    resolve
  }
}
function candidate(task: ReplyTask): ReplyCandidate {
  const draftHash = hashDraft('审核后的产品说明')
  return {
    task,
    automaticAllowed: true,
    factsVerified: true,
    reasons: [],
    draft: {
      taskId: task.taskId,
      draftRevision: 1,
      draftHash,
      action: 'reply',
      text: '审核后的产品说明',
      evidenceIds: ['faq-A']
    },
    review: {
      reviewId: 'review-A',
      taskId: task.taskId,
      contextHash: task.contextHash,
      draftRevision: 1,
      draftHash,
      configVersion: task.configVersion,
      knowledgeVersion: task.knowledgeVersion,
      decisionPolicyVersion: task.decisionPolicyVersion,
      questionSetVersion: task.questionSetVersion,
      modelResolved: 'jev-test-version',
      status: 'passed',
      reasons: [],
      reviewedAt: Date.now(),
      expiresAt: task.expiresAt
    }
  }
}
async function fixture(onProgress?: (event: AgentProgressEvent) => void) {
  vi.useFakeTimers()
  vi.setSystemTime(10000)
  const f = taskFixture()
  const ledger = new Ledger(':memory:')
  ledgers.push(ledger)
  const adapter: VerifiedSendAdapter = {
    readCurrent: vi.fn(async (task) => ({
      ...f.current,
      identity: task.identity,
      conversationId: task.conversationId
    })),
    dispatch: vi.fn(
      async (c: SendCommand): Promise<DeliveryResult> => ({
        status: 'confirmed',
        executionId: c.executionId,
        identity: c.task.identity,
        conversationId: c.task.conversationId,
        draftHash: c.draft.draftHash,
        evidence: 'native-confirmation-A'
      })
    )
  }
  const reply: ReplyService = { generate: vi.fn(async (task) => candidate(task)) }
  const onCandidate = vi.fn()
  const onSend = vi.fn()
  const onHandoff = vi.fn()
  const agent = new ReliableAgent(
    ledger,
    adapter,
    reply,
    { onCandidate, onSend, onHandoff, ...{ onProgress } },
    { quietMs: 100, maximumWaitMs: 300 },
    Date.now,
    Date.now
  )
  await agent.configure({
    configVersion: 'config-1',
    knowledgeVersion: 'knowledge-1',
    decisionPolicyVersion: 'policy-1',
    questionSetVersion: 'questions-1',
    modelResolved: 'jev-test-version',
    automaticEnabled: true
  })
  const binding: ConversationBinding = {
    identity: f.task.identity,
    conversationId: 'customer-A',
    bindingVersion: 1,
    identityVerified: true,
    identityEvidence: ['test-native-binding']
  }
  agent.bind(binding)
  agent.resume()
  const message = (
    id: string,
    text = '问题',
    overrides: Partial<ObservedMessage> = {}
  ): ObservedMessage => ({
    identity: binding.identity,
    conversationId: binding.conversationId,
    sourceMessageId: id,
    direction: 'inbound',
    kind: 'text',
    text,
    observedAt: Date.now(),
    identityVerified: true,
    messageIdVerified: true,
    ...overrides
  })
  return { ...f, ledger, adapter, reply, agent, binding, message, onCandidate, onSend, onHandoff }
}
describe('reliable message-to-review-to-send workflow with synthetic devices', () => {
  it('honors the first-message maximum wait when committed collection pages keep adding inbound messages', async () => {
    const f = await fixture()
    const entry = { binding: f.binding, displayName: '客户', activityVersion: '1' }
    const scan = f.ledger.collection.begin(f.binding.identity)
    f.ledger.collection.page(f.binding.identity, scan, [entry], 'burst', null, 1, true, Date.now())
    const collect = (index: number): void => {
      if (index > 1) f.ledger.collection.hint(f.binding.identity, f.binding.conversationId)
      f.agent.collectionPending(f.binding)
      const request = f.ledger.collection.next(f.binding.identity)!
      const result = f.ledger.collection.commit(
        f.binding.identity,
        request,
        {
          binding: f.binding,
          activityVersion: '1',
          fromCursor: request.cursor,
          nextCursor: String(index),
          messages: [f.message(`burst-${index}`, `问题-${index}`)],
          complete: true,
          hasGap: false
        },
        100
      )
      f.agent.collected(f.binding, result.changed, result.complete)
    }
    collect(1)
    for (let index = 2; index <= 4; index++) {
      await vi.advanceTimersByTimeAsync(80)
      collect(index)
    }
    expect(f.reply.generate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60)
    expect(f.reply.generate).toHaveBeenCalledOnce()
    expect(vi.mocked(f.reply.generate).mock.calls[0][1]).toEqual([
      '问题-1',
      '问题-2',
      '问题-3',
      '问题-4'
    ])
    expect(f.adapter.dispatch).toHaveBeenCalledOnce()
    await f.agent.pause()
  })

  it('records observation before queue waiting, then exact task-bound generation and send milestones without message text', async () => {
    const progress: AgentProgressEvent[] = []
    const f = await fixture((event) => progress.push(event))
    f.agent.observe(f.message('timed-source', 'SYNTHETIC_PRIVATE_TEXT', { observedAt: 1 }))
    await vi.advanceTimersByTimeAsync(100)
    expect(progress.map((event) => event.stage)).toEqual([
      'observed',
      'generation_started',
      'generation_completed',
      'candidate_ready',
      'send_started',
      'send_finished'
    ])
    expect(progress[0].atMs).toBe(10000)
    expect(progress[1].atMs - progress[0].atMs).toBe(100)
    const tasks = progress.filter((event) => 'task' in event)
    expect(new Set(tasks.map((event) => 'task' in event && event.task.taskId)).size).toBe(1)
    expect(JSON.stringify(progress)).not.toContain('SYNTHETIC_PRIVATE_TEXT')
    expect(f.onSend).toHaveBeenCalledOnce()
  })

  it('isolates timing callback mutation and failure from the candidate and verified send decision', async () => {
    const callback = vi.fn((event: AgentProgressEvent) => {
      if ('task' in event) event.task.taskId = 'telemetry-must-not-change-task'
      throw new Error('synthetic_timing_sink_failure')
    })
    const f = await fixture(callback)
    f.agent.observe(f.message('timed-source'))
    await vi.advanceTimersByTimeAsync(100)
    expect(callback).toHaveBeenCalled()
    expect(f.onCandidate).toHaveBeenCalledOnce()
    expect(f.onSend).toHaveBeenCalledOnce()
    expect(f.onCandidate.mock.calls[0][0].task.taskId).not.toBe('telemetry-must-not-change-task')
  })

  it('handles asynchronous timing sink rejection without an unhandled error or blocking the workflow', async () => {
    const callback = vi.fn(async () => {
      throw new Error('synthetic_async_timing_sink_failure')
    })
    const f = await fixture(callback)
    f.agent.observe(f.message('timed-async-source'))
    await vi.advanceTimersByTimeAsync(100)
    expect(callback).toHaveBeenCalled()
    expect(f.onCandidate).toHaveBeenCalledOnce()
    expect(f.onSend).toHaveBeenCalledOnce()
  })

  it('reuses the candidate if an unchanged drain finishes before a preflight rejection arrives', async () => {
    const f = await fixture(),
      entry = { binding: f.binding, displayName: '客户', activityVersion: '1' }
    const physical = vi.mocked(f.adapter.readCurrent).getMockImplementation()!
    vi.mocked(f.adapter.readCurrent).mockImplementationOnce(async (task, signal) => {
      const scan = f.ledger.collection.begin(f.binding.identity)
      f.ledger.collection.page(f.binding.identity, scan, [entry], 's', null, 1, true, Date.now())
      f.agent.collectionPending(f.binding)
      queueMicrotask(() =>
        queueMicrotask(() => {
          const req = f.ledger.collection.next(f.binding.identity)!
          f.ledger.collection.commit(
            f.binding.identity,
            req,
            {
              binding: f.binding,
              activityVersion: '1',
              fromCursor: null,
              nextCursor: '1',
              messages: [],
              complete: true,
              hasGap: false
            },
            100
          )
          f.agent.collected(f.binding, [], true)
        })
      )
      return physical(task, signal)
    })
    f.agent.observe(f.message('1'))
    await vi.advanceTimersByTimeAsync(300)
    // A later inventory sweep must not regenerate an already completed input.
    f.agent.collected(f.binding, [], true)
    await vi.advanceTimersByTimeAsync(300)
    expect(f.reply.generate).toHaveBeenCalledOnce()
    expect(f.adapter.dispatch).toHaveBeenCalledOnce()
    await f.agent.pause()
  })
  it('keeps a completed candidate if a collection hint interrupts send preflight before any action', async () => {
    const f = await fixture(),
      entry = { binding: f.binding, displayName: '客户', activityVersion: '1' }
    const physical = vi.mocked(f.adapter.readCurrent).getMockImplementation()!
    vi.mocked(f.adapter.readCurrent).mockImplementationOnce(async (task, signal) => {
      const scan = f.ledger.collection.begin(f.binding.identity)
      f.ledger.collection.page(f.binding.identity, scan, [entry], 's', null, 1, true, Date.now())
      f.agent.collectionPending(f.binding)
      return physical(task, signal)
    })
    f.agent.observe(f.message('1'))
    await vi.advanceTimersByTimeAsync(200)
    expect(f.adapter.dispatch).not.toHaveBeenCalled()
    const req = f.ledger.collection.next(f.binding.identity)!
    f.ledger.collection.commit(
      f.binding.identity,
      req,
      {
        binding: f.binding,
        activityVersion: '1',
        fromCursor: null,
        nextCursor: '1',
        messages: [],
        complete: true,
        hasGap: false
      },
      100
    )
    f.agent.collected(f.binding, [], true)
    await vi.advanceTimersByTimeAsync(300)
    expect(f.reply.generate).toHaveBeenCalledOnce()
    expect(f.adapter.dispatch).toHaveBeenCalledOnce()
    await f.agent.pause()
  })
  it('retains a candidate when collection becomes pending between generation and application', async () => {
    const f = await fixture()
    const entry = { binding: f.binding, displayName: '客户', activityVersion: '1' }
    vi.mocked(f.reply.generate).mockImplementationOnce(async (task) => {
      queueMicrotask(() =>
        queueMicrotask(() => {
          const scan = f.ledger.collection.begin(f.binding.identity)
          f.ledger.collection.page(
            f.binding.identity,
            scan,
            [entry],
            's',
            null,
            1,
            true,
            Date.now()
          )
          f.agent.collectionPending(f.binding)
        })
      )
      return candidate(task)
    })
    f.agent.observe(f.message('1'))
    await vi.advanceTimersByTimeAsync(200)
    expect(f.adapter.dispatch).not.toHaveBeenCalled()
    const req = f.ledger.collection.next(f.binding.identity)!
    f.ledger.collection.commit(
      f.binding.identity,
      req,
      {
        binding: f.binding,
        activityVersion: '1',
        fromCursor: null,
        nextCursor: '1',
        messages: [],
        complete: true,
        hasGap: false
      },
      100
    )
    f.agent.collected(f.binding, [], true)
    await vi.advanceTimersByTimeAsync(300)
    expect(f.reply.generate).toHaveBeenCalledOnce()
    expect(f.adapter.dispatch).toHaveBeenCalledOnce()
    await f.agent.pause()
  })
  it('preserves slow generation across unchanged collection sweeps and waits for collection before sending', async () => {
    const f = await fixture(),
      gate = deferred<ReplyCandidate>()
    vi.mocked(f.reply.generate).mockReturnValueOnce(gate.promise)
    f.agent.observe(f.message('1'))
    await vi.advanceTimersByTimeAsync(100)
    const [task, , isCurrent, signal] = vi.mocked(f.reply.generate).mock.calls[0]
    const scan = f.ledger.collection.begin(f.binding.identity)
    const entry = { binding: f.binding, displayName: '客户', activityVersion: '1' }
    f.ledger.collection.page(f.binding.identity, scan, [entry], 's', null, 1, true, Date.now())
    f.agent.collectionPending(f.binding)
    expect(signal.aborted).toBe(false)
    expect(isCurrent()).toBe(true)
    gate.resolve(candidate(task))
    await vi.advanceTimersByTimeAsync(200)
    expect(f.adapter.dispatch).not.toHaveBeenCalled()
    const req = f.ledger.collection.next(f.binding.identity)!
    f.ledger.collection.commit(
      f.binding.identity,
      req,
      {
        binding: f.binding,
        activityVersion: '1',
        fromCursor: null,
        nextCursor: '1',
        messages: [],
        complete: true,
        hasGap: false
      },
      100
    )
    f.agent.collected(f.binding, [], true)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.reply.generate).toHaveBeenCalledOnce()
    expect(f.adapter.dispatch).toHaveBeenCalledOnce()
    await f.agent.pause()
  })
  it('discovery of another customer preserves an existing in-flight task and its run epoch', async () => {
    const f = await fixture(),
      gate = deferred<ReplyCandidate>()
    vi.mocked(f.reply.generate).mockReturnValueOnce(gate.promise)
    f.agent.observe(f.message('1'))
    await vi.advanceTimersByTimeAsync(100)
    const task = vi.mocked(f.reply.generate).mock.calls[0][0]
    f.agent.discoverBindings([{ ...f.binding, conversationId: 'new-customer' }])
    expect(f.agent.matchesCurrentTask(task)).toBe(true)
    gate.resolve(candidate(task))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.adapter.dispatch).toHaveBeenCalledOnce()
  })
  it('more than 200 discovered customers are bound, while generation overload has durable human outcomes', async () => {
    const f = await fixture()
    const bindings = Array.from({ length: 300 }, (_, i) => ({
      ...f.binding,
      conversationId: `many-${i}`
    }))
    f.agent.discoverBindings(bindings)
    for (const b of bindings)
      f.agent.observe({ ...f.message('same-source-id'), conversationId: b.conversationId })
    expect(f.onHandoff).toHaveBeenCalledTimes(100)
    for (let i = 200; i < 300; i++) {
      expect(f.ledger.snapshot(f.binding.identity, `many-${i}`).humanOwned).toBe(true)
      expect(f.agent.currentBinding(`many-${i}`)).toBeDefined()
    }
    const rows = f.ledger.replies.list(f.binding.identity)
    expect(rows.filter((r) => r.reasons?.includes('queue_overloaded'))).toHaveLength(100)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.adapter.dispatch).toHaveBeenCalledTimes(200)
  })
  it('taking over another customer does not abort the current customer dispatch', async () => {
    const f = await fixture(),
      gate = deferred<DeliveryResult>(),
      other = { ...f.binding, conversationId: 'customer-B' }
    f.agent.bind(other)
    let signal: AbortSignal | undefined
    vi.mocked(f.adapter.dispatch).mockImplementationOnce((_command, s) => {
      signal = s
      return gate.promise
    })
    f.agent.observe(f.message('1'))
    await vi.advanceTimersByTimeAsync(100)
    expect(f.adapter.dispatch).toHaveBeenCalledOnce()
    f.agent.takeOver(other)
    expect(signal?.aborted).toBe(false)
    expect(f.ledger.snapshot(f.binding.identity, 'customer-B').humanOwned).toBe(true)
    expect(f.ledger.snapshot(f.binding.identity, f.binding.conversationId).humanOwned).toBe(false)
    gate.resolve({ status: 'unknown' })
    await vi.advanceTimersByTimeAsync(0)
  })
  it('aborts an in-flight send on takeover and cannot release until physical quiescence and unknown outcome are resolved', async () => {
    const f = await fixture(),
      gate = deferred<DeliveryResult>()
    let signal: AbortSignal | undefined
    vi.mocked(f.adapter.dispatch).mockImplementationOnce((_command, s) => {
      signal = s
      return gate.promise
    })
    f.agent.observe(f.message('1'))
    await vi.advanceTimersByTimeAsync(100)
    expect(f.adapter.dispatch).toHaveBeenCalledOnce()
    f.agent.takeOver(f.binding)
    expect(signal?.aborted).toBe(true)
    expect(f.agent.sender.conversationQuiescent(f.binding.identity, f.binding.conversationId)).toBe(
      false
    )
    expect(() => f.agent.releaseToAutomation(f.binding)).toThrow('execution_pending')
    const ack = f.agent.sender.cancelConversation(f.binding.identity, f.binding.conversationId)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await ack).toBe(false)
    gate.resolve({ status: 'unknown' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.agent.sender.conversationQuiescent(f.binding.identity, f.binding.conversationId)).toBe(
      true
    )
    expect(() => f.agent.releaseToAutomation(f.binding)).toThrow('execution_pending')
    expect(f.ledger.snapshot(f.binding.identity, f.binding.conversationId).humanOwned).toBe(true)
  })
  it('a newly observed human reply aborts the matching dispatch without waiting for another automated task', async () => {
    const f = await fixture(),
      gate = deferred<DeliveryResult>()
    let signal: AbortSignal | undefined
    vi.mocked(f.adapter.dispatch).mockImplementationOnce((_command, s) => {
      signal = s
      return gate.promise
    })
    f.agent.observe(f.message('1'))
    await vi.advanceTimersByTimeAsync(100)
    f.agent.observe({ ...f.message('human'), direction: 'human_outbound' })
    expect(signal?.aborted).toBe(true)
    gate.resolve({ status: 'unknown' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.ledger.snapshot(f.binding.identity, f.binding.conversationId).humanOwned).toBe(true)
    expect(f.adapter.dispatch).toHaveBeenCalledOnce()
  })
  it('coalesces inbound bursts and records exactly one confirmed handling of the range', async () => {
    const f = await fixture()
    f.agent.observe(f.message('1', '产品咨询'))
    await vi.advanceTimersByTimeAsync(50)
    f.agent.observe(f.message('2', '补充问题'))
    await vi.advanceTimersByTimeAsync(100)
    expect(f.reply.generate).toHaveBeenCalledTimes(1)
    expect(vi.mocked(f.reply.generate).mock.calls[0][1]).toEqual(['产品咨询', '补充问题'])
    expect(f.adapter.dispatch).toHaveBeenCalledTimes(1)
    expect(
      f.ledger.snapshot(f.binding.identity, 'customer-A').messages.every((m) => m.handledBy)
    ).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.reply.generate).toHaveBeenCalledTimes(1)
  })
  it('preserves the maximum merge window under continued inbound traffic', async () => {
    const f = await fixture()
    for (let i = 0; i < 5; i++) {
      f.agent.observe(f.message(String(i)))
      await vi.advanceTimersByTimeAsync(70)
    }
    expect(f.reply.generate).toHaveBeenCalledTimes(1)
    expect(vi.mocked(f.reply.generate).mock.calls[0][1]).toHaveLength(5)
  })
  it('discards a late old draft and generates from the entire still-pending message range', async () => {
    const f = await fixture()
    const gate = deferred<ReplyCandidate>()
    let original!: ReplyTask
    vi.mocked(f.reply.generate).mockImplementationOnce(async (task) => {
      original = task
      return gate.promise
    })
    f.agent.observe(f.message('1', '原问题'))
    await vi.advanceTimersByTimeAsync(100)
    f.agent.observe(f.message('2', '新的条件'))
    await vi.advanceTimersByTimeAsync(100)
    gate.resolve(candidate(original))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.adapter.dispatch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(f.reply.generate).mock.calls[1][1]).toEqual(['原问题', '新的条件'])
    expect(f.onCandidate).toHaveBeenCalledTimes(1)
  })
  it('does not apply or send a generation after pause and resume', async () => {
    const f = await fixture()
    const gate = deferred<ReplyCandidate>()
    let original!: ReplyTask
    vi.mocked(f.reply.generate).mockImplementationOnce(async (task) => {
      original = task
      return gate.promise
    })
    f.agent.observe(f.message('1'))
    await vi.advanceTimersByTimeAsync(100)
    expect((await f.agent.pause()).status).toBe('acknowledged')
    expect(vi.mocked(f.reply.generate).mock.calls[0][3].aborted).toBe(true)
    f.agent.resume()
    gate.resolve(candidate(original))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.onCandidate).not.toHaveBeenCalled()
    expect(f.adapter.dispatch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(f.adapter.dispatch).toHaveBeenCalledTimes(1)
  })
  it('gives human outbound and takeover priority until explicitly released', async () => {
    const f = await fixture()
    f.agent.observe(f.message('1'))
    f.agent.observe(f.message('human-1', '我来处理', { direction: 'human_outbound' }))
    f.agent.observe(f.message('2'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.reply.generate).not.toHaveBeenCalled()
    expect(f.onHandoff).toHaveBeenCalledWith('customer-A', 'human_takeover')
    f.agent.releaseToAutomation(f.binding)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.adapter.dispatch).toHaveBeenCalledTimes(1)
  })
  it('aborts an actual in-flight dispatch even when saving the pause epoch fails', async () => {
    const f = await fixture()
    const gate = deferred<DeliveryResult>()
    let dispatchSignal: AbortSignal | undefined
    vi.mocked(f.adapter.dispatch).mockImplementationOnce((_command, signal) => {
      dispatchSignal = signal
      return gate.promise
    })
    f.agent.observe(f.message('1'))
    await vi.advanceTimersByTimeAsync(100)
    expect(f.adapter.dispatch).toHaveBeenCalledOnce()
    const storage = vi.spyOn(f.ledger, 'nextRunEpoch').mockImplementation(() => {
      throw new Error('synthetic_storage_fault')
    })
    const stopped = f.agent.pause()
    const failed = expect(stopped).rejects.toThrow('run_epoch_persistence_failed')
    expect(dispatchSignal?.aborted).toBe(true)
    expect(f.agent.sender.isPaused()).toBe(true)
    f.agent.observe(f.message('2'))
    gate.resolve({ status: 'unknown' })
    await vi.advanceTimersByTimeAsync(1000)
    await failed
    expect(f.agent.sender.isQuiescent()).toBe(true)
    expect(f.reply.generate).toHaveBeenCalledOnce()
    expect(f.adapter.dispatch).toHaveBeenCalledOnce()
    expect(() => f.agent.resume()).toThrow('run_epoch_persistence_failed')
    expect(f.agent.sender.isPaused()).toBe(true)
    storage.mockRestore()
  })
  it('does not ask a text model to guess voice/image messages', async () => {
    const f = await fixture()
    f.agent.observe(f.message('image', '', { kind: 'image' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.reply.generate).not.toHaveBeenCalled()
    expect(f.onHandoff).toHaveBeenCalledWith('customer-A', 'unsupported_message')
  })
  it('rejects an unbound account and keeps names out of routing decisions', async () => {
    const f = await fixture()
    expect(() =>
      f.agent.observe(
        f.message('private', '另一账号的订单', {
          identity: { ...f.binding.identity, accountId: 'account-B' }
        })
      )
    ).toThrow('unbound_message_identity')
    expect(
      f.ledger.snapshot({ ...f.binding.identity, accountId: 'account-B' }, 'customer-A').messages
    ).toEqual([])
  })
  it('refuses a service which mutates or changes the task target', async () => {
    const f = await fixture()
    vi.mocked(f.reply.generate).mockImplementation(async (task) => {
      task.conversationId = 'customer-B'
      return candidate(task)
    })
    f.agent.observe(f.message('1'))
    await vi.advanceTimersByTimeAsync(100)
    expect(f.adapter.dispatch).not.toHaveBeenCalled()
    expect(f.onHandoff).toHaveBeenCalledWith('customer-A', 'generation_failed')
  })
  it('leaves reviewed suggestions unsent when automatic sending is disabled', async () => {
    const f = await fixture()
    await f.agent.configure({
      configVersion: 'config-1',
      knowledgeVersion: 'knowledge-1',
      decisionPolicyVersion: 'policy-1',
      questionSetVersion: 'questions-1',
      modelResolved: 'jev-test-version',
      automaticEnabled: false
    })
    f.agent.resume()
    f.agent.observe(f.message('1'))
    await vi.advanceTimersByTimeAsync(100)
    expect(f.onCandidate).toHaveBeenCalledTimes(1)
    expect(f.adapter.dispatch).not.toHaveBeenCalled()
  })
  it('cannot start without a published configuration or with an unverified binding', async () => {
    const f = await fixture()
    await f.agent.pause()
    f.agent.bind({ ...f.binding, bindingVersion: 2, identityVerified: false })
    f.agent.resume()
    f.agent.observe(f.message('1'))
    await vi.advanceTimersByTimeAsync(100)
    expect(f.adapter.dispatch).not.toHaveBeenCalled()
  })
})
