import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ReliableAgent, type ReplyCandidate } from '../../src/core/agent/reliable-agent'
import { Ledger } from '../../src/core/persistence/ledger'
import { hashDraft } from '../../src/core/reply/hashes'
import { sameIdentity, type ConversationBinding } from '../../src/shared/contracts/identity'
import type { ReplyTask } from '../../src/shared/contracts/task'
import type { CurrentSendState } from '../../src/core/sending/validation'

const opened: { agent: ReliableAgent; ledger: Ledger }[] = []
afterEach(async () => {
  for (const { agent, ledger } of opened.splice(0)) {
    await agent.pause()
    ledger.close()
  }
  vi.useRealTimers()
})
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function candidate(task: ReplyTask, text: string): ReplyCandidate {
  const draftHash = hashDraft(text)
  return {
    task,
    automaticAllowed: true,
    factsVerified: true,
    reasons: [],
    draft: {
      taskId: task.taskId,
      draftRevision: 1,
      draftHash,
      text,
      action: 'reply',
      evidenceIds: ['synthetic-faq']
    },
    review: {
      reviewId: `review-${task.taskId}`,
      taskId: task.taskId,
      contextHash: task.contextHash,
      draftRevision: 1,
      draftHash,
      configVersion: task.configVersion,
      knowledgeVersion: task.knowledgeVersion,
      decisionPolicyVersion: task.decisionPolicyVersion,
      questionSetVersion: task.questionSetVersion,
      modelResolved: 'synthetic-jev',
      status: 'passed',
      reasons: [],
      reviewedAt: Date.now(),
      expiresAt: task.expiresAt
    }
  }
}

describe('synthetic capacity replay through the real agent, scheduler, Sender and SQLite ledger', () => {
  it('isolates 20 employees and 400 shared-name conversations across 10000 messages and duplicate observations', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(100000)
    const started = performance.now()
    const samples: Record<string, number>[] = []
    let generations = 0,
      confirmed = 0,
      observations = 0
    const handoffs: string[] = []
    const executions = new Set<string>()
    for (let employee = 0; employee < 20; employee++) {
      const identity = {
        tenantId: `synthetic-company-${employee % 2}`,
        employeeId: `employee-${employee}`,
        accountId: `account-${employee}`,
        agentId: `agent-${employee}`,
        platform: employee % 2 ? ('wework' as const) : ('wechat' as const),
        loginEpoch: 1,
        clientInstanceId: `process-${employee}`
      }
      const bindings: ConversationBinding[] = Array.from({ length: 20 }, (_, conversation) => ({
        identity,
        conversationId: `shared-customer-${conversation}`,
        bindingVersion: 1,
        identityVerified: true,
        identityEvidence: ['synthetic-only']
      }))
      const ledger = new Ledger(':memory:')
      let generating = 0,
        dispatching = 0
      const agent = new ReliableAgent(
        ledger,
        {
          readCurrent: async (task): Promise<CurrentSendState> => ({
            ...task,
            modelResolved: 'synthetic-jev',
            paused: false,
            leaseValid: true,
            identityVerified: sameIdentity(task.identity, identity),
            hasMessageGap: false,
            humanActive: false,
            hasHumanDraft: false,
            backgroundReadVerified: true,
            nonInterferingSendVerified: true,
            factsVerified: true
          }),
          dispatch: async (command, signal) => {
            expect(sameIdentity(command.task.identity, identity)).toBe(true)
            expect(signal.aborted).toBe(false)
            expect(command.draft.text).toBe(
              `synthetic:${identity.accountId}:${command.task.conversationId}`
            )
            expect(executions.has(command.executionId)).toBe(false)
            executions.add(command.executionId)
            dispatching++
            expect(dispatching).toBe(1)
            await delay(1)
            dispatching--
            return {
              status: 'confirmed',
              executionId: command.executionId,
              identity,
              conversationId: command.task.conversationId,
              draftHash: command.draft.draftHash,
              evidence: `synthetic-echo-${command.executionId}`
            }
          }
        },
        {
          generate: async (task, inbound, isCurrent, signal, context) => {
            generating++
            expect(generating).toBeLessThanOrEqual(2)
            generations++
            expect(sameIdentity(task.identity, identity)).toBe(true)
            expect(inbound).toHaveLength(5)
            expect(
              inbound.every((text) =>
                text.startsWith(`${identity.accountId}/${task.conversationId}/`)
              )
            ).toBe(true)
            expect(
              context?.every((message) =>
                message.text.startsWith(`${identity.accountId}/${task.conversationId}/`)
              )
            ).toBe(true)
            await delay(3)
            generating--
            expect(isCurrent()).toBe(true)
            expect(signal.aborted).toBe(false)
            return candidate(task, `synthetic:${identity.accountId}:${task.conversationId}`)
          }
        },
        {
          onHandoff: (conversation, reason) =>
            handoffs.push(`${identity.accountId}/${conversation}/${reason}`),
          onSend: (result) => {
            expect(result.status).toBe('recorded')
            if (result.status === 'recorded') expect(result.record.status).toBe('confirmed')
            confirmed++
          }
        },
        { quietMs: 10, maximumWaitMs: 30 }
      )
      opened.push({ agent, ledger })
      await agent.configure({
        configVersion: 'config-1',
        knowledgeVersion: 'knowledge-1',
        decisionPolicyVersion: 'policy-1',
        questionSetVersion: 'questions-1',
        modelResolved: 'synthetic-jev',
        automaticEnabled: true
      })
      agent.replaceBindings(bindings)
      agent.resume()
    }
    const sample = (wave: number) => {
      const { rss, heapUsed, external } = process.memoryUsage()
      samples.push({
        wave,
        uniqueMessages: wave * 2000,
        elapsedWallMs: performance.now() - started,
        rssBytes: rss,
        heapUsedBytes: heapUsed,
        externalBytes: external,
        pendingTimers: vi.getTimerCount()
      })
    }
    sample(0)
    for (let wave = 0; wave < 5; wave++) {
      for (const { agent, ledger } of opened) {
        // Bindings are deterministic dataset metadata, not introspected private state.
        const binding = agent.currentBinding('shared-customer-0')!
        for (let conversation = 0; conversation < 20; conversation++) {
          for (let offset = 0; offset < 5; offset++) {
            const message = {
              identity: binding.identity,
              conversationId: `shared-customer-${conversation}`,
              sourceMessageId: `shared-source-${wave * 5 + offset}`,
              direction: 'inbound' as const,
              kind: 'text' as const,
              text: `${binding.identity.accountId}/shared-customer-${conversation}/${wave * 5 + offset}`,
              observedAt: Date.now(),
              identityVerified: true,
              messageIdVerified: true
            }
            agent.observe(message)
            agent.observe(message)
            observations += 2
          }
        }
        expect(ledger.snapshot(binding.identity, 'shared-customer-0').messages).toHaveLength(
          (wave + 1) * 5
        )
      }
      await vi.advanceTimersByTimeAsync(150)
      expect(confirmed).toBe((wave + 1) * 400)
      expect(handoffs).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
      for (const { agent, ledger } of opened) {
        expect(agent.sender.isQuiescent()).toBe(true)
        const identity = agent.currentBinding('shared-customer-0')!.identity
        for (let conversation = 0; conversation < 20; conversation++) {
          const snapshot = ledger.snapshot(identity, `shared-customer-${conversation}`)
          expect(snapshot.hasGap).toBe(false)
          expect(snapshot.messages).toHaveLength((wave + 1) * 5)
          expect(snapshot.messages.every((message) => !!message.handledBy)).toBe(true)
          expect(
            snapshot.messages.every((message) => sameIdentity(message.identity, identity))
          ).toBe(true)
        }
      }
      sample(wave + 1)
    }
    expect(generations).toBe(2000)
    expect(executions.size).toBe(2000)
    expect(observations).toBe(20000)
    const directory = join('.local', 'reports', 'capacity', randomUUID())
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          dataset: 'synthetic-capacity-v1',
          agents: 20,
          conversationsPerAgent: 20,
          uniqueMessages: 10000,
          observations,
          generations,
          confirmed,
          handoffs: handoffs.length,
          node: process.versions.node,
          virtualClock: true,
          storage: 'in-memory SQLite',
          samples,
          limits: [
            'No native client, central server or real model requests.',
            'In-memory SQLite does not measure disk WAL, restart recovery or multi-device leases.',
            'RSS includes the test worker; retained message history grows intentionally.',
            'Five waves prove drained work and bounded per-agent concurrency, not long-term memory stability.'
          ]
        },
        null,
        2
      )
    )
    process.stdout.write(`Synthetic capacity report: ${join(directory, 'result.json')}\n`)
  }, 60000)
})
