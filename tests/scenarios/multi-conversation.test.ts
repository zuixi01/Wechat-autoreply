import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Ledger } from '../../src/core/persistence/ledger'
import { ReliableAgent, type ReplyCandidate } from '../../src/core/agent/reliable-agent'
import { ConversationCollector } from '../../src/core/agent/conversation-collector'
import { UiaCollectionSource } from '../../src/core/adapters/collection-sources'
import { SyntheticCollectionSource } from '../fixtures/collection'
import { taskFixture } from '../fixtures/task'
import { hashDraft } from '../../src/core/reply/hashes'
import type { ReplyTask } from '../../src/shared/contracts/task'

const opened: { collector: ConversationCollector; agent: ReliableAgent; ledger: Ledger }[] = []
afterEach(async () => {
  for (const f of opened.splice(0)) {
    await f.collector.stop()
    await f.agent.pause()
    f.ledger.close()
  }
  vi.useRealTimers()
})
function candidate(task: ReplyTask): ReplyCandidate {
  const text = `合成答复 ${task.conversationId}`,
    draftHash = hashDraft(text)
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
      text,
      evidenceIds: ['synthetic-evidence']
    },
    review: {
      reviewId: randomUUID(),
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
describe('500-customer discovery to review to simulated confirmed send', () => {
  it('covers both platforms with bounded concurrency, durable watermarks and no replay across unchanged sweeps', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10000)
    const report: unknown[] = []
    for (const platform of ['wechat', 'wework'] as const) {
      const f = taskFixture(),
        identity = { ...f.task.identity, platform }
      const ledger = new Ledger(':memory:'),
        synthetic = new SyntheticCollectionSource(identity, 500)
      for (const entry of synthetic.entries) synthetic.add(entry.binding.conversationId)
      const sent = new Map<string, number>(),
        handed = new Set<string>()
      let active = 0,
        peak = 0,
        calls = 0
      const source = new UiaCollectionSource(
        {
          identity: async () => identity,
          resolve: async (id) =>
            structuredClone(
              synthetic.entries.find((e) => e.binding.conversationId === id)!.binding
            ),
          inventory: (input, signal) => synthetic.inventory(input, signal),
          messages: (request, _limit, signal) => synthetic.read(request, signal),
          subscribe: (onHint) => synthetic.subscribe(onHint)
        },
        {
          platform,
          clientVersion: 'synthetic-reader-only',
          backgroundRead: true,
          stableCustomerIds: true,
          stableMessageIds: true,
          offscreenEnumeration: true
        }
      )
      const agent = new ReliableAgent(
        ledger,
        {
          readCurrent: async (task) => ({
            ...f.current,
            identity: task.identity,
            conversationId: task.conversationId
          }),
          dispatch: async (command) => {
            active++
            peak = Math.max(active, peak)
            await new Promise<void>((resolve) => setTimeout(resolve, 1))
            active--
            const id = command.task.conversationId
            sent.set(id, (sent.get(id) ?? 0) + 1)
            return {
              status: 'confirmed',
              executionId: command.executionId,
              identity: command.task.identity,
              conversationId: id,
              draftHash: command.draft.draftHash,
              evidence: `synthetic-confirmation-${command.executionId}`
            }
          }
        },
        {
          generate: async (task) => {
            calls++
            return candidate(task)
          }
        },
        { onHandoff: (id) => handed.add(id) },
        { quietMs: 10, maximumWaitMs: 30 }
      )
      await agent.configure({
        configVersion: 'config-1',
        knowledgeVersion: 'knowledge-1',
        decisionPolicyVersion: 'policy-1',
        questionSetVersion: 'questions-1',
        modelResolved: 'jev-test-version',
        automaticEnabled: true
      })
      const collector = new ConversationCollector(
        ledger,
        identity,
        source,
        {
          onBindings: (bindings) => agent.discoverBindings(bindings),
          onPending: (binding) => agent.collectionPending(binding),
          onRead: (binding, messages, complete) => agent.collected(binding, messages, complete),
          onFailure: () => {
            throw new Error('synthetic collection failed')
          }
        },
        { pollMs: 10, sweepIntervalMs: 3000 }
      )
      opened.push({ collector, agent, ledger })
      await collector.start(new AbortController().signal)
      agent.resume()
      await vi.advanceTimersByTimeAsync(2000)
      expect(collector.status()).toMatchObject({
        knownConversations: 500,
        coverage: 'complete',
        pendingReads: 0,
        needsHuman: 0
      })
      expect(sent.size).toBe(500)
      expect(calls).toBe(500)
      expect(handed.size).toBe(0)
      expect(peak).toBe(1)
      for (const entry of synthetic.entries) {
        const snapshot = ledger.snapshot(identity, entry.binding.conversationId)
        expect(snapshot.messages).toHaveLength(1)
        expect(snapshot.messages[0].handledBy).not.toBeNull()
        expect(sent.get(entry.binding.conversationId)).toBe(1)
      }
      await vi.advanceTimersByTimeAsync(5000)
      expect(calls).toBe(500)
      expect([...sent.values()].every((count) => count === 1)).toBe(true)
      synthetic.add('customer-499', '新咨询')
      synthetic.emit('customer-499')
      await vi.advanceTimersByTimeAsync(1000)
      expect(sent.get('customer-499')).toBe(2)
      expect(calls).toBe(501)
      await collector.stop()
      await agent.pause()
      expect(active).toBe(0)
      expect(agent.sender.isQuiescent()).toBe(true)
      report.push({
        platform,
        customers: 500,
        uniqueMessages: 501,
        generationCalls: calls,
        confirmedSyntheticSends: [...sent.values()].reduce((a, b) => a + b, 0),
        peakPhysicalConcurrency: peak,
        humanHandoffs: handed.size,
        coverage: collector.status(),
        timersAfterStop: vi.getTimerCount()
      })
      expect(vi.getTimerCount()).toBe(0)
    }
    const directory = join(process.cwd(), '.local', 'reports', 'multi-conversation', randomUUID())
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          syntheticOnly: true,
          realChatRead: false,
          realSend: false,
          scope:
            'paged UIA source -> collector -> SQLite -> ReliableAgent -> review -> unified Sender -> synthetic confirmation',
          platforms: report
        },
        null,
        2
      )
    )
  })
})
