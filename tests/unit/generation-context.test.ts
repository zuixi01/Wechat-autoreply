import { describe, expect, it } from 'vitest'
import {
  Ledger,
  selectConversationContext,
  hashConversationContext
} from '../../src/core/persistence/ledger'
import { parseGenerationInput } from '../../src/core/reply/generation-validation'
import { taskFixture } from '../fixtures/task'
import { hashContext } from '../../src/core/reply/hashes'
import type { GenerationInput } from '../../src/shared/contracts/generation'

describe('bounded verified conversation context', () => {
  it('uses the newest complete messages and preserves order without private identity fields', () => {
    const ledger = new Ledger(':memory:'),
      f = taskFixture()
    try {
      for (let i = 0; i < 45; i++)
        ledger.observe({
          identity: f.task.identity,
          conversationId: f.task.conversationId,
          sourceMessageId: `m${i}`,
          direction: 'inbound',
          kind: 'text',
          text: `内容 ${i}`,
          observedAt: 1,
          identityVerified: true,
          messageIdVerified: true
        })
      const snapshot = ledger.snapshot(f.task.identity, f.task.conversationId),
        context = selectConversationContext(snapshot)
      expect(context).toHaveLength(40)
      expect(context[0].sequence).toBe(6)
      expect(context.at(-1)?.sequence).toBe(45)
      expect(hashConversationContext(snapshot)).toBe(hashContext(context))
      expect(JSON.stringify(context)).not.toContain('employee-A')
    } finally {
      ledger.close()
    }
  })
  it('preserves whitespace and accepts mixed outbound history inside a pending inbound interval', () => {
    const context: GenerationInput['context'] = [
      { sequence: 1, sourceMessageId: 'a', direction: 'inbound', kind: 'text', text: ' 第一问 ' },
      {
        sequence: 2,
        sourceMessageId: 'b',
        direction: 'human_outbound',
        kind: 'text',
        text: '请稍候'
      },
      { sequence: 3, sourceMessageId: 'c', direction: 'inbound', kind: 'text', text: '第二问' }
    ]
    const task = {
      ...taskFixture().task,
      inboundRange: { from: 1, to: 3 },
      contextHash: hashContext(context)
    }
    expect(
      parseGenerationInput({ task, context, inbound: [' 第一问 ', '第二问'] }).inbound[0]
    ).toBe(' 第一问 ')
    expect(() =>
      parseGenerationInput({ task, context: context.slice(1), inbound: ['第二问'] })
    ).toThrow()
  })
  it('rejects a different message order, sequence gaps and a conflicting context hash', () => {
    const context: GenerationInput['context'] = [
      { sequence: 1, sourceMessageId: 'a', direction: 'inbound', kind: 'text', text: 'A' },
      { sequence: 2, sourceMessageId: 'b', direction: 'inbound', kind: 'text', text: 'B' }
    ]
    const task = { ...taskFixture().task, contextHash: hashContext(context) }
    expect(() =>
      parseGenerationInput({ task, context: [...context].reverse(), inbound: ['B', 'A'] })
    ).toThrow()
    expect(() =>
      parseGenerationInput({
        task,
        context: [context[0], { ...context[1], sequence: 3 }],
        inbound: ['A', 'B']
      })
    ).toThrow()
    expect(() =>
      parseGenerationInput({
        task: { ...task, contextHash: 'b'.repeat(64) },
        context,
        inbound: ['A', 'B']
      })
    ).toThrow()
  })
})
