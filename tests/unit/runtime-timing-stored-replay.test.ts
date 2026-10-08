import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { RuntimeTimingEvidence } from '../../src/core/agent/runtime-timing-evidence'
import type { RuntimeTimingEvent } from '../../src/core/agent/runtime-timing'
import { taskFixture } from '../fixtures/task'

function fixture() {
  const records: unknown[] = []
  const sessionId = randomUUID()
  const journal = {
    sessionId,
    offer: (value: unknown) => {
      records.push(value)
      return true
    },
    health: () => ({
      sessionId,
      records: records.length,
      dropped: 0,
      pending: 0,
      bytes: 0,
      closed: true
    }),
    close: async () => ({
      sessionId,
      records: records.length,
      dropped: 0,
      pending: 0,
      bytes: 0,
      closed: true
    }),
    export: async () => {
      throw new Error('readonly')
    }
  }
  const task = taskFixture().task,
    runtimeInstanceId = randomUUID()
  const stored = {
    kind: 'event' as const,
    value: {
      runtimeInstanceId,
      kind: 'collection' as const,
      event: {
        stage: 'read_started' as const,
        readId: randomUUID(),
        binding: {
          identity: task.identity,
          conversationId: task.conversationId,
          bindingVersion: task.bindingVersion,
          identityVerified: true
        },
        startedAtMs: 10,
        atMs: 10,
        sourceMessageIds: [],
        complete: false
      }
    }
  }
  return { evidence: new RuntimeTimingEvidence(journal), stored, records, runtimeInstanceId }
}

describe('original stored timing event replay', () => {
  it('accepts originally redacted collection proof without filling it or changing runtime/clock', () => {
    const f = fixture()
    f.evidence.recordStored(f.stored)
    expect(f.records).toEqual([f.stored])
    expect(f.evidence.snapshot()).toMatchObject({
      runtimeInstanceId: f.runtimeInstanceId,
      events: 1
    })
    expect(f.evidence.snapshot().reasons).not.toContain('invalid_timing_event')
  })
  it('keeps the live capture entry requiring the original adapter proof', () => {
    const f = fixture()
    f.evidence.record(f.stored.value as unknown as RuntimeTimingEvent)
    expect(f.records).toEqual([])
    expect(f.evidence.snapshot().reasons).toContain('invalid_timing_event')
  })
  it('rejects an added private proof in a stored record instead of broadening its schema', () => {
    const f = fixture()
    f.evidence.recordStored({
      ...f.stored,
      value: {
        ...f.stored.value,
        event: {
          ...f.stored.value.event,
          binding: { ...f.stored.value.event.binding, identityEvidence: ['invented-proof'] }
        }
      }
    })
    expect(f.records).toEqual([])
    expect(f.evidence.snapshot().reasons).toContain('invalid_timing_event')
  })
  it('preserves rejection of mixed runtime instances during stored replay', () => {
    const f = fixture()
    f.evidence.recordStored(f.stored)
    f.evidence.recordStored({
      ...f.stored,
      value: {
        ...f.stored.value,
        runtimeInstanceId: randomUUID(),
        event: { ...f.stored.value.event, readId: randomUUID() }
      }
    })
    expect(f.records).toHaveLength(1)
    expect(f.evidence.snapshot().reasons).toContain('mixed_runtime_instances')
  })
})
