import { setTimeout as delay } from 'node:timers/promises'
import { ReliableAgent } from '../../src/core/agent/reliable-agent'
import { ConversationCollector } from '../../src/core/agent/conversation-collector'
import { Ledger } from '../../src/core/persistence/ledger'
import { SyntheticCollectionSource } from './collection'
import { taskFixture } from './task'

// Real Node event loop: fake timers can finish a test before unhandledRejection is emitted.
async function main(): Promise<void> {
  const errors: string[] = []
  const onUnhandled = (error: unknown): void => {
    errors.push(error instanceof Error ? error.message : 'unknown')
  }
  process.on('unhandledRejection', onUnhandled)
  const ledger = new Ledger(':memory:'),
    f = taskFixture()
  let complete!: () => void,
    candidates = 0,
    sends = 0
  const ready = new Promise<void>((resolve) => {
    complete = resolve
  })
  const agent = new ReliableAgent(
    ledger,
    {
      readCurrent: async () => f.current,
      dispatch: async () => {
        sends++
        throw new Error('synthetic_probe_must_not_send')
      }
    },
    {
      generate: async (task) => ({
        task,
        automaticAllowed: false,
        factsVerified: false,
        reasons: ['synthetic']
      })
    },
    {
      onCandidate: () => {
        candidates++
        complete()
      },
      onProgress: async () => {
        throw new Error('synthetic_async_sink_failure')
      }
    },
    { quietMs: 0, maximumWaitMs: 0 }
  )
  const source = new SyntheticCollectionSource(f.task.identity, 1)
  source.add('customer-0', '合成采集问题')
  let committedReads = 0
  const collector = new ConversationCollector(
    ledger,
    f.task.identity,
    source,
    {
      onBindings: () => undefined,
      onRead: (_, changed) => {
        if (changed.length === 1) committedReads++
      },
      onPending: () => undefined,
      onFailure: () => {
        throw new Error('synthetic_collection_failed')
      },
      onTiming: async () => {
        throw new Error('synthetic_async_collection_sink_failure')
      }
    },
    { pollMs: 1000 }
  )
  try {
    await collector.start(new AbortController().signal)
    await collector.stop()
    await agent.configure({
      configVersion: f.task.configVersion,
      knowledgeVersion: f.task.knowledgeVersion,
      decisionPolicyVersion: f.task.decisionPolicyVersion,
      questionSetVersion: f.task.questionSetVersion,
      modelResolved: f.current.modelResolved,
      automaticEnabled: false
    })
    agent.bind({
      identity: f.task.identity,
      conversationId: f.task.conversationId,
      bindingVersion: 1,
      identityVerified: true,
      identityEvidence: ['synthetic-probe']
    })
    agent.resume()
    agent.observe({
      identity: f.task.identity,
      conversationId: f.task.conversationId,
      sourceMessageId: 'synthetic-timing-source',
      direction: 'inbound',
      kind: 'text',
      text: '合成问题',
      observedAt: Date.now(),
      identityVerified: true,
      messageIdVerified: true
    })
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('synthetic_probe_timeout')), 1000)
        })
      ])
    } finally {
      if (deadline) clearTimeout(deadline)
    }
    await delay(20)
    process.stdout.write(
      JSON.stringify({
        origin: 'synthetic',
        candidates,
        committedReads,
        sends,
        unhandledRejections: errors.length
      }) + '\n'
    )
  } finally {
    await collector.stop()
    await agent.pause()
    ledger.close()
    process.removeListener('unhandledRejection', onUnhandled)
  }
}

void main().catch(() => {
  process.stderr.write('synthetic_timing_probe_failed\n')
  process.exitCode = 1
})
