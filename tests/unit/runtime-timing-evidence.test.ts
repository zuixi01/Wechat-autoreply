import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, link, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  RuntimeTimingEvidence,
  type HostRuntimeEvaluationBinding
} from '../../src/core/agent/runtime-timing-evidence'
import {
  PrivateRuntimeTimingJournal,
  type TimingJournalHealth
} from '../../src/core/persistence/runtime-timing-journal'
import { verifyPrivatePaths } from '../../src/core/persistence/private-backup-directory'
import type { RuntimeTimingEvent } from '../../src/core/agent/runtime-timing'
import { hashContext } from '../../src/core/reply/hashes'
import { taskFixture } from '../fixtures/task'

// Every event, frozen assignment and model here is synthetic engineering evidence.
function fixture() {
  const task = taskFixture().task,
    runtimeInstanceId = randomUUID(),
    readId = randomUUID()
  const values: unknown[] = []
  const health: TimingJournalHealth = {
    sessionId: randomUUID(),
    records: 0,
    dropped: 0,
    pending: 0,
    bytes: 0,
    closed: false
  }
  const journal = {
    sessionId: health.sessionId,
    offer: vi.fn((value: unknown) => {
      values.push(value)
      health.records++
      return true
    }),
    health: () => ({ ...health }),
    close: async () => {
      health.closed = true
      return { ...health }
    },
    export: async () => 'synthetic-only'
  }
  const evidence = new RuntimeTimingEvidence(journal)
  const collection = (
    stage: 'read_started' | 'read_completed' | 'read_failed' | 'read_cancelled',
    atMs: number
  ): RuntimeTimingEvent => ({
    runtimeInstanceId,
    kind: 'collection',
    event: {
      stage,
      readId,
      binding: {
        identity: task.identity,
        conversationId: task.conversationId,
        bindingVersion: task.bindingVersion,
        identityVerified: true,
        identityEvidence: ['PRIVATE_ADAPTER_PROOF_DO_NOT_LOG']
      },
      startedAtMs: 100,
      atMs,
      sourceMessageIds: stage === 'read_completed' ? ['source-1', 'source-2'] : [],
      complete: stage === 'read_completed'
    }
  })
  const agent = (
    stage:
      | 'generation_started'
      | 'generation_completed'
      | 'candidate_ready'
      | 'send_started'
      | 'send_finished',
    atMs: number
  ): RuntimeTimingEvent => ({
    runtimeInstanceId,
    kind: 'agent',
    event: {
      stage,
      task,
      atMs,
      ...(stage === 'send_finished' ? { outcome: 'confirmed' as const } : {})
    },
    modelResolved: 'synthetic-model',
    sources: [
      { sourceMessageId: 'source-1', sequence: 1, verified: true },
      { sourceMessageId: 'source-2', sequence: 2, verified: true }
    ]
  })
  const binding: HostRuntimeEvaluationBinding = {
    batchId: 'synthetic-batch',
    assignmentId: randomUUID(),
    caseId: 'synthetic-case',
    arm: 'learned',
    expectedTaskHash: hashContext(task),
    sharedConfigurationHash: 'a'.repeat(64),
    memoryManifestHash: 'b'.repeat(64),
    policyVersion: 'synthetic-policy',
    retrievalVersion: 'synthetic-retrieval',
    modelVersion: 'synthetic-version',
    knowledgeVersion: task.knowledgeVersion,
    modelResolved: 'synthetic-model'
  }
  const collect = (): void => {
    evidence.record(collection('read_started', 100))
    evidence.record(collection('read_completed', 150))
    evidence.record(agent('generation_started', 200))
    evidence.record(agent('generation_completed', 250))
    evidence.record(agent('candidate_ready', 300))
    evidence.bind(task, binding)
  }
  return { task, evidence, journal, values, health, collection, agent, binding, collect }
}

describe('trusted runtime timing evidence', () => {
  it('ends reviewable timing only at a host presentation receipt and preserves the first endpoint', () => {
    const f = fixture()
    f.collect()
    const presentation = (atMs: number): RuntimeTimingEvent =>
      ({
        runtimeInstanceId: f.collection('read_started', 100).runtimeInstanceId,
        kind: 'presentation',
        event: {
          task: f.task,
          rowVersion: 'c'.repeat(64),
          receiptId: randomUUID(),
          webContentsId: 7,
          atMs
        }
      }) as unknown as RuntimeTimingEvent
    f.evidence.record(presentation(420))
    expect(f.evidence.snapshot().tasks[0]).toMatchObject({
      endedAtMs: 420,
      latencyMs: 320,
      latencyComplete: true,
      presentation: { rowVersion: 'c'.repeat(64), webContentsId: 7, atMs: 420 }
    })
    f.evidence.record(presentation(450))
    expect(f.evidence.snapshot().tasks[0].endedAtMs).toBe(420)
    f.evidence.record({
      runtimeInstanceId: f.collection('read_started', 100).runtimeInstanceId,
      kind: 'agent',
      event: { task: f.task, stage: 'obsolete', atMs: 500 }
    })
    expect(f.evidence.snapshot().tasks[0].latencyComplete).toBe(true)
    expect(f.evidence.snapshot('confirmed_sent').tasks[0].latencyComplete).toBe(false)
    expect(f.evidence.snapshot().businessVerified).toBe(false)
  })
  it('refuses a presentation before candidate readiness or for a different task version', () => {
    const f = fixture()
    f.evidence.record(f.collection('read_started', 100))
    f.evidence.record(f.collection('read_completed', 150))
    f.evidence.record(f.agent('generation_started', 200))
    f.evidence.record({
      runtimeInstanceId: f.collection('read_started', 100).runtimeInstanceId,
      kind: 'presentation',
      event: {
        task: f.task,
        rowVersion: 'c'.repeat(64),
        receiptId: randomUUID(),
        webContentsId: 7,
        atMs: 220
      }
    } as unknown as RuntimeTimingEvent)
    expect(f.evidence.snapshot().tasks[0].reasons).toContain('invalid_presentation')
    const g = fixture()
    g.collect()
    g.evidence.record({
      runtimeInstanceId: g.collection('read_started', 100).runtimeInstanceId,
      kind: 'presentation',
      event: {
        task: { ...g.task, knowledgeVersion: 'different' },
        rowVersion: 'c'.repeat(64),
        receiptId: randomUUID(),
        webContentsId: 7,
        atMs: 420
      }
    } as unknown as RuntimeTimingEvent)
    expect(g.evidence.snapshot().tasks[0].reasons).toContain('invalid_presentation')
    expect(g.evidence.snapshot().tasks[0].endedAtMs).toBeNull()
  })
  it('rejects incomplete send milestones and nonmonotonic clocks', () => {
    const f = fixture()
    f.collect()
    f.evidence.record(f.agent('send_finished', 450))
    expect(f.evidence.snapshot('confirmed_sent').tasks[0].reasons).toContain('missing_send_start')
    f.evidence.record(f.agent('candidate_ready', 299))
    expect(f.evidence.snapshot('confirmed_sent').reasons).toContain('nonmonotonic_event')
  })
  it('links actual source ranges to the earliest trusted read and keeps candidate readiness insufficient', () => {
    const f = fixture()
    f.collect()
    const report = f.evidence.snapshot()
    expect(report.status).toBe('insufficient')
    expect(report.tasks[0]).toMatchObject({
      startedAtMs: 100,
      generationAtMs: 200,
      candidateAtMs: 300,
      endedAtMs: null,
      latencyMs: null,
      latencyComplete: false,
      reasons: ['missing_reviewable_endpoint']
    })
    expect(report.businessVerified).toBe(false)
    expect(JSON.stringify(f.values)).not.toContain('PRIVATE_ADAPTER_PROOF_DO_NOT_LOG')
    report.tasks[0].task.identity.accountId = 'changed-copy'
    expect(f.evidence.snapshot().tasks[0].task.identity.accountId).toBe(f.task.identity.accountId)
  })
  it('measures a confirmed send from source.read rather than task.createdAt or generation start', () => {
    const f = fixture()
    f.collect()
    f.evidence.record(f.agent('send_started', 350))
    f.evidence.record(f.agent('send_finished', 450))
    expect(f.evidence.snapshot('confirmed_sent').tasks[0]).toMatchObject({
      startedAtMs: 100,
      endedAtMs: 450,
      latencyMs: 350,
      latencyComplete: true,
      status: 'captured'
    })
    expect(f.evidence.snapshot('reviewable').status).toBe('insufficient')
  })
  it('does not join cross-process or unverified source records into complete evidence', () => {
    const f = fixture()
    f.collect()
    f.evidence.record({ ...f.agent('send_finished', 450), runtimeInstanceId: randomUUID() })
    expect(f.evidence.snapshot('confirmed_sent').reasons).toContain('mixed_runtime_instances')
    const g = fixture()
    g.collect()
    const changed = g.agent('send_finished', 450)
    if (changed.kind !== 'agent') throw new Error('synthetic_invalid_fixture')
    changed.sources![0].verified = false
    g.evidence.record(changed)
    expect(g.evidence.snapshot('confirmed_sent').tasks[0].reasons).toEqual(
      expect.arrayContaining(['source_range_changed', 'source_range_unverified'])
    )
  })
  it('retains failed and cancelled reads and rejects terminal receipts with no trusted start', () => {
    for (const stage of ['read_failed', 'read_cancelled'] as const) {
      const f = fixture()
      f.evidence.record(f.collection('read_started', 100))
      f.evidence.record(f.collection(stage, 150))
      expect(f.evidence.snapshot().reads[0].state).toBe(stage)
      expect(f.evidence.snapshot().reasons).toContain('collection_attempts_incomplete')
    }
    const f = fixture()
    f.evidence.record(f.collection('read_completed', 150))
    expect(f.evidence.snapshot().reasons).toContain('missing_read_start')
  })
  it('keeps write loss and invalid body-bearing events insufficient without logging their content', () => {
    const f = fixture()
    f.collect()
    f.health.reason = 'journal_write_failed'
    f.health.dropped = 1
    f.evidence.record(f.agent('send_finished', 450))
    expect(f.evidence.snapshot('confirmed_sent').status).toBe('insufficient')
    const raw = f.agent('candidate_ready', 500)
    f.evidence.record({
      ...raw,
      body: 'PRIVATE_MESSAGE_MUST_NOT_BE_WRITTEN'
    } as unknown as RuntimeTimingEvent)
    expect(f.evidence.snapshot().reasons).toContain('invalid_timing_event')
    expect(JSON.stringify(f.values)).not.toContain('PRIVATE_MESSAGE_MUST_NOT_BE_WRITTEN')
    f.journal.offer.mockImplementationOnce(() => {
      throw new Error('synthetic_sink_failure')
    })
    expect(() => f.evidence.record(f.agent('candidate_ready', 550))).not.toThrow()
    expect(f.evidence.snapshot().reasons).toContain('timing_listener_failed')
  })
  it('freezes host bindings and rejects a different task or second assignment', () => {
    const f = fixture()
    f.collect()
    f.binding.caseId = 'mutated-caller-copy'
    expect(f.evidence.snapshot().tasks[0].binding?.caseId).toBe('synthetic-case')
    expect(() => f.evidence.bind(f.task, f.binding)).toThrow('runtime_evaluation_binding_conflict')
    const changed = f.agent('candidate_ready', 400)
    if (changed.kind === 'agent' && 'task' in changed.event)
      changed.event.task = { ...changed.event.task, knowledgeVersion: 'changed-version' }
    f.evidence.record(changed)
    expect(f.evidence.snapshot().tasks[0].reasons).toContain('frozen_task_changed')
  })
  it('records binding-write loss even when the surrounding listener isolates the exception', () => {
    const f = fixture()
    f.evidence.record(f.collection('read_started', 100))
    f.evidence.record(f.collection('read_completed', 150))
    f.evidence.record(f.agent('generation_started', 200))
    f.journal.offer.mockImplementationOnce(() => {
      throw new Error('synthetic_binding_write_failure')
    })
    expect(() => f.evidence.bind(f.task, f.binding)).toThrow(
      'runtime_evaluation_binding_unavailable'
    )
    expect(f.evidence.snapshot().reasons).toContain('journal_incomplete')
  })
})

const roots: string[] = []
async function root(): Promise<string> {
  const base = resolve('.local/reports')
  await mkdir(base, { recursive: true })
  const path = await mkdtemp(join(base, 'runtime-timing-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  for (const path of roots.splice(0)) {
    const part = relative(resolve('.local/reports'), resolve(path))
    if (
      !part ||
      isAbsolute(part) ||
      part === '..' ||
      part.startsWith('..' + sep) ||
      !part.startsWith('runtime-timing-')
    )
      throw new Error('fixture_cleanup_boundary')
    await rm(path, { recursive: true, force: true })
  }
})
describe('actual private bounded timing journal', () => {
  it('rejects a linked log before appending metadata, while preserving the linked file', async () => {
    const directory = await root(),
      other = await root(),
      journal = await PrivateRuntimeTimingJournal.open(directory),
      log = join(directory, 'events.private.jsonl'),
      alias = join(other, 'alias.private.jsonl')
    await link(log, alias)
    const header = await readFile(alias, 'utf8')
    journal.offer({ event: 'synthetic-new-metadata' })
    expect(await journal.close()).toMatchObject({
      records: 0,
      dropped: 1,
      reason: 'journal_write_failed'
    })
    expect(await readFile(alias, 'utf8')).toBe(header)
    await expect(journal.export({ status: 'captured' })).rejects.toThrow(
      'runtime_evidence_incomplete'
    )
  })
  it('forgets its actual sealed log and report without allowing subsequent export', async () => {
    const directory = await root(),
      journal = await PrivateRuntimeTimingJournal.open(directory)
    journal.offer({ event: 'synthetic' })
    await journal.export({ status: 'insufficient', businessVerified: false })
    await Promise.all([journal.forget(), journal.forget()])
    await journal.forget()
    await expect(access(directory)).rejects.toBeDefined()
    await expect(journal.export({ status: 'captured' })).rejects.toThrow(
      'runtime_evidence_incomplete'
    )
    expect(journal.offer({ event: 'late' })).toBe(false)
    await expect(access(directory)).rejects.toBeDefined()
  })
  it('refuses unexpected files and linked files before deletion and preserves data outside its session', async () => {
    const directory = await root(),
      other = await root(),
      journal = await PrivateRuntimeTimingJournal.open(directory),
      log = join(directory, 'events.private.jsonl'),
      unknown = join(directory, 'unexpected.private.json'),
      linked = join(other, 'outside-session.private.jsonl')
    await journal.close()
    await writeFile(unknown, 'synthetic unrelated file')
    await expect(journal.forget()).rejects.toThrow('runtime_timing_forget_failed')
    await access(log)
    expect(await readFile(unknown, 'utf8')).toBe('synthetic unrelated file')
    await unlink(unknown)
    await link(log, linked)
    const original = await readFile(linked, 'utf8')
    await expect(journal.forget()).rejects.toThrow('runtime_timing_forget_failed')
    expect(await readFile(log, 'utf8')).toBe(original)
    expect(await readFile(linked, 'utf8')).toBe(original)
    await unlink(linked)
    await journal.forget()
    await expect(access(directory)).rejects.toBeDefined()
    await access(other)
  })
  it('rejects emissions after sealing without disguising the lost record as complete', async () => {
    const journal = await PrivateRuntimeTimingJournal.open(await root())
    await journal.close()
    expect(journal.offer({ late: true })).toBe(false)
    expect(journal.health()).toMatchObject({ reason: 'journal_record_invalid', dropped: 1 })
    await expect(journal.export({ status: 'captured' })).rejects.toThrow(
      'runtime_evidence_incomplete'
    )
  })
  it('protects real files and exports incomplete evidence without pretending candidate readiness is a full endpoint', async () => {
    const directory = await root(),
      journal = await PrivateRuntimeTimingJournal.open(directory),
      evidence = new RuntimeTimingEvidence(journal),
      f = fixture()
    evidence.record(f.collection('read_started', 100))
    evidence.record(f.collection('read_completed', 150))
    evidence.record(f.agent('generation_started', 200))
    evidence.record(f.agent('candidate_ready', 300))
    evidence.bind(f.task, f.binding)
    const output = await evidence.export()
    await verifyPrivatePaths(directory, [join(directory, 'events.private.jsonl'), output])
    const saved = JSON.parse(await readFile(output, 'utf8'))
    expect(saved).toMatchObject({ status: 'insufficient', businessVerified: false })
    expect(saved.tasks[0].reasons).toContain('missing_reviewable_endpoint')
    expect(await readFile(join(directory, 'events.private.jsonl'), 'utf8')).not.toContain(
      'PRIVATE_ADAPTER_PROOF_DO_NOT_LOG'
    )
  })
  it('bounds pending writes and retains loss in the durable footer', async () => {
    const directory = await root(),
      journal = await PrivateRuntimeTimingJournal.open(directory, { maxPending: 2 })
    expect(journal.offer({ event: 1 })).toBe(true)
    expect(journal.offer({ event: 2 })).toBe(true)
    expect(journal.offer({ event: 3 })).toBe(false)
    const closed = await Promise.all([journal.close(), journal.close()])
    expect(closed[0]).toEqual(closed[1])
    expect(closed[0]).toMatchObject({
      reason: 'journal_capacity_exceeded',
      records: 2,
      dropped: 1,
      pending: 0,
      closed: true
    })
    const lines = (await readFile(join(directory, 'events.private.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines.at(-1)).toMatchObject({
      kind: 'session_closed',
      reason: 'journal_capacity_exceeded',
      dropped: 1
    })
    expect(lines.filter((line) => line.kind === 'session_closed')).toHaveLength(1)
    await expect(journal.export({ status: 'passed' })).rejects.toThrow(
      'runtime_evidence_incomplete'
    )
  })
  it('detects actual filesystem write failure and never exports a success artifact', async () => {
    const directory = await root(),
      journal = await PrivateRuntimeTimingJournal.open(directory)
    await unlink(join(directory, 'events.private.jsonl'))
    await mkdir(join(directory, 'events.private.jsonl'))
    expect(journal.offer({ event: 1 })).toBe(true)
    expect(await journal.close()).toMatchObject({
      reason: 'journal_write_failed',
      records: 0,
      dropped: 1
    })
    await expect(journal.export({ status: 'passed' })).rejects.toThrow(
      'runtime_evidence_incomplete'
    )
  })
  it('enforces record and UTF-8 byte ceilings before admission', async () => {
    const a = await PrivateRuntimeTimingJournal.open(await root(), { maxRecords: 1 })
    expect(a.offer({ event: 1 })).toBe(true)
    await a.drain()
    expect(a.offer({ event: 2 })).toBe(false)
    await a.close()
    const b = await PrivateRuntimeTimingJournal.open(await root(), { maxBytes: 1024 })
    expect(b.offer({ event: '中'.repeat(400) })).toBe(false)
    expect(await b.close()).toMatchObject({
      reason: 'journal_capacity_exceeded',
      records: 0,
      dropped: 1
    })
  })
})
