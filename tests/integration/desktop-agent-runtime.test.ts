import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopAgentRuntime,
  type RuntimePlatform,
  type RuntimeTimingEvent
} from '../../src/main/services/desktop-agent-runtime'
import { Ledger } from '../../src/core/persistence/ledger'
import { taskFixture } from '../fixtures/task'
import type { ObservedMessage } from '../../src/shared/contracts/message'
import type { DeviceStatus } from '../../src/shared/contracts/registration'
import { RuntimeStatusSchema } from '../../src/shared/contracts/runtime'
import {
  WorkbenchSnapshotSchema,
  WorkbenchResultSchema
} from '../../src/shared/contracts/workbench'
import { hashConversationContext } from '../../src/core/persistence/ledger'
import { hashDraft, hashContext } from '../../src/core/reply/hashes'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createLedgerBackup, restoreLedgerBackup } from '../../src/core/persistence/ledger-backup'
import type { ReconciliationChallenge } from '../../src/shared/contracts/reconciliation'
import type { EditedReviewInput } from '../../src/shared/contracts/edited-review'
import { SyntheticCollectionSource } from '../fixtures/collection'
import { DeviceRequestError } from '../../src/main/services/agent-registration'
import * as inventorySnapshot from '../../src/main/services/restore-inventory-snapshot'
import { RestoreRecoveryPackageSchema } from '../../src/shared/contracts/restore-recovery'
import {
  parseRestoreResolutionPackage,
  type RestoreResolutionPackage
} from '../../src/shared/contracts/restore-resolution'
import { learningHash } from '../../src/core/memory/learning-scope'
import { restoreObservationFixture } from '../fixtures/restore-observation'
import { restoreCompletionAckFixture } from '../fixtures/restore-completion'
import type {
  RestoreRecoveryCompletionInput,
  RestoreRecoveryCompletionReceipt
} from '../../src/shared/contracts/restore-completion'
import { access, readFile, readdir } from 'node:fs/promises'

const runtimes: DesktopAgentRuntime[] = []
const recoveryDirectories: string[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const directory of recoveryDirectories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep + 'runtime-recovery-'))
      throw new Error('unexpected_recovery_fixture')
    rmSync(directory, { recursive: true, force: true })
  }
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
function fixture(
  installed = true,
  ledger = new Ledger(':memory:'),
  onTiming?: (event: RuntimeTimingEvent) => void
) {
  const f = taskFixture()
  const identity = f.task.identity
  let registered = true
  const configuration = {
    configVersion: f.task.configVersion,
    knowledgeVersion: f.task.knowledgeVersion,
    decisionPolicyVersion: f.task.decisionPolicyVersion,
    questionSetVersion: f.task.questionSetVersion,
    modelResolved: f.current.modelResolved,
    automaticEnabled: true
  }
  const client = {
    status: (): DeviceStatus =>
      registered
        ? {
            state: 'registered',
            serverUrl: 'https://enterprise.example',
            scope: {
              tenant_id: identity.tenantId,
              employee_id: identity.employeeId,
              account_id: identity.accountId,
              agent_id: identity.agentId,
              platform: identity.platform
            }
          }
        : { state: 'unregistered' },
    configuration: vi.fn(async () => configuration),
    recordLearningCorrection: undefined as
      | import('../../src/main/services/agent-registration').AgentRegistration['recordLearningCorrection']
      | undefined,
    recordLearningResult: undefined as
      | import('../../src/main/services/agent-registration').AgentRegistration['recordLearningResult']
      | undefined,
    recordLearningFeedback: undefined as
      | import('../../src/main/services/agent-registration').AgentRegistration['recordLearningFeedback']
      | undefined,
    learningForgetScope: undefined as
      | import('../../src/main/services/agent-registration').AgentRegistration['learningForgetScope']
      | undefined,
    prepareGeneration: undefined as
      | import('../../src/main/services/agent-registration').AgentRegistration['prepareGeneration']
      | undefined,
    issueExecution: vi.fn(async () => {
      throw new Error('no physical dispatch in lifecycle tests')
    }),
    issueHumanExecution: vi.fn<
      import('../../src/main/services/agent-registration').AgentRegistration['issueHumanExecution']
    >(async () => {
      throw new Error('no physical human dispatch in lifecycle tests')
    }),
    settleExecution: vi.fn<
      import('../../src/main/services/agent-registration').AgentRegistration['settleExecution']
    >(async () => {
      throw new Error('no receipt in lifecycle tests')
    }),
    generateCandidate: vi.fn<
      import('../../src/main/services/agent-registration').AgentRegistration['generateCandidate']
    >(async () => {
      throw new Error('no model called in lifecycle tests')
    }),
    reviewEdited: vi.fn<
      import('../../src/main/services/agent-registration').AgentRegistration['reviewEdited']
    >(async () => {
      throw new Error('no edited review in lifecycle tests')
    }),
    assessmentEvidence: vi.fn<
      import('../../src/main/services/agent-registration').AgentRegistration['assessmentEvidence']
    >(async () => {
      throw new Error('no reference read in lifecycle tests')
    }),
    reconciliationChallenge: vi.fn<
      import('../../src/main/services/agent-registration').AgentRegistration['reconciliationChallenge']
    >(async () => {
      throw new Error('no case in lifecycle tests')
    }),
    reportReconciliation: vi.fn<
      import('../../src/main/services/agent-registration').AgentRegistration['reportReconciliation']
    >(async () => {
      throw new Error('no report in lifecycle tests')
    }),
    reconciliationDecision: vi.fn<
      import('../../src/main/services/agent-registration').AgentRegistration['reconciliationDecision']
    >(async () => null),
    reconciliationApplied: vi.fn<
      import('../../src/main/services/agent-registration').AgentRegistration['reconciliationApplied']
    >(async (_report, decision) => ({
      decisionId: decision.decisionId,
      decisionHash: hashContext(decision),
      status: 'resolution_applied'
    })),
    sealExecutionRequest: vi.fn<
      import('../../src/main/services/agent-registration').AgentRegistration['sealExecutionRequest']
    >(async () => {
      throw new Error('no request seal in lifecycle tests')
    }),
    requestSealApplied: vi.fn<
      import('../../src/main/services/agent-registration').AgentRegistration['requestSealApplied']
    >(async (seal) => ({
      sealId: seal.sealId,
      sealHash: hashContext(seal),
      requestHash: seal.requestHash,
      executionId: seal.input.executionId,
      status: 'request_seal_applied'
    })),
    acquireLease: vi.fn(async () => ({
      identity,
      leaseId: 'lease-A',
      version: 1,
      serverIssuedAt: 100000,
      expiresAt: 110000
    }))
  }
  const conversation = {
    identity,
    conversationId: f.task.conversationId,
    bindingVersion: 1,
    identityVerified: true,
    identityEvidence: ['synthetic-identity-proof']
  }
  let onMessage: ((message: ObservedMessage) => void) | undefined
  let onFailure: (() => void) | undefined
  const platform: RuntimePlatform = {
    capabilities: vi.fn(() => ({
      backgroundRead: true,
      nonInterferingSend: true
    })),
    binding: vi.fn(async () => ({ identity, conversations: [conversation] })),
    observe: vi.fn(async (message, failure) => {
      onMessage = message
      onFailure = failure
    }),
    stop: vi.fn(async () => {}),
    readCurrent: vi.fn(async () => f.current),
    dispatch: vi.fn(async () => ({ status: 'unknown' as const })),
    inspectExecution: vi.fn<NonNullable<RuntimePlatform['inspectExecution']>>(async () => ({
      status: 'unknown'
    }))
  }
  const runtime = new DesktopAgentRuntime(
    ledger,
    client,
    installed ? platform : undefined,
    onTiming
  )
  runtimes.push(runtime)
  const message: ObservedMessage = {
    identity,
    conversationId: conversation.conversationId,
    sourceMessageId: 'synthetic-new',
    direction: 'inbound',
    kind: 'text',
    text: '合成问题',
    observedAt: Date.now(),
    identityVerified: true,
    messageIdVerified: true
  }
  return {
    f,
    identity,
    configuration,
    client,
    platform,
    ledger,
    runtime,
    conversation,
    message,
    register: (value: boolean) => {
      registered = value
    },
    emit: (value = message) => onMessage?.(value),
    fail: () => onFailure?.()
  }
}

describe('paged collector connected to the real desktop runtime', () => {
  it('rejects an expired presentation target even when its recorded task and row versions still match', async () => {
    vi.useRealTimers()
    const directory = mkdtempSync(join(tmpdir(), 'runtime-recovery-presentation-'))
    recoveryDirectories.push(directory)
    let ready = false
    const f = fixture(true, undefined, (event) => {
      if (event.kind === 'agent' && event.event.stage === 'candidate_ready') ready = true
    })
    f.configuration.automaticEnabled = false
    const source = new SyntheticCollectionSource(f.identity, 1)
    source.add('customer-0', 'SYNTHETIC_PRESENTATION_EXPIRED')
    f.platform.collectionSource = source
    f.client.generateCandidate.mockImplementation(async (input) => ({
      task: input.task,
      status: 'handoff',
      automaticAllowed: false,
      factsVerified: false,
      reasons: ['shadow_mode'],
      intents: ['faq'],
      usage: { input_tokens: 0, output_tokens: 0 },
      draft: { ...f.f.draft, taskId: input.task.taskId }
    }))
    await f.runtime.configureManagedTimingCapture(directory)
    expect((await f.runtime.start()).state).toBe('running')
    await vi.waitFor(() => expect(ready).toBe(true), { timeout: 3500 })
    const row = f.runtime.workbench().rows[0],
      input = { taskId: row.taskId, expectedVersion: row.version }
    expect(f.runtime.presentationTarget(input)).toBeDefined()
    expect(
      f.runtime.presentationTarget({ ...input, expectedVersion: 'a'.repeat(64) })
    ).toBeUndefined()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 61000)
      expect(f.runtime.presentationTarget(input)).toBeUndefined()
    } finally {
      vi.useRealTimers()
      await f.runtime.close()
    }
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('installs a managed host vault and seals an insufficient private report without gaining platform capability', async () => {
    vi.useRealTimers()
    const directory = mkdtempSync(join(tmpdir(), 'runtime-recovery-timing-vault-'))
    recoveryDirectories.push(directory)
    const f = fixture(false)
    await f.runtime.configureManagedTimingCapture(directory)
    expect((await f.runtime.start()).reason).toBe('capability_unverified')
    await f.runtime.close()
    const output = await f.runtime.exportTimingEvidence()
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({
      status: 'insufficient',
      businessVerified: false,
      reasons: ['no_foreground_tasks']
    })
    expect(await readdir(directory)).toContain('index.private.sqlite')
    expect(f.platform.binding).not.toHaveBeenCalled()
    expect(f.client.acquireLease).not.toHaveBeenCalled()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('clears an earlier runtime capture through the same vault after authorized account forgetting', async () => {
    vi.useRealTimers()
    const directory = mkdtempSync(join(tmpdir(), 'runtime-recovery-timing-vault-'))
    recoveryDirectories.push(directory)
    const first = fixture()
    await first.runtime.configureManagedTimingCapture(directory)
    await first.runtime.start()
    first.emit()
    await first.runtime.close()
    const old = await first.runtime.exportTimingEvidence()
    const second = fixture()
    await second.runtime.configureManagedTimingCapture(directory)
    const scope = {
      workspaceId: `enterprise:${learningHash({ tenant: second.identity.tenantId, account: second.identity.accountId })}`,
      tenantId: second.identity.tenantId,
      accountId: second.identity.accountId,
      platform: second.identity.platform
    }
    second.client.learningForgetScope = vi.fn(async () => {})
    await second.runtime.forgetLearningScope(scope)
    await expect(access(old)).rejects.toBeDefined()
    await expect(first.runtime.exportTimingEvidence()).rejects.toThrow()
    expect((await readdir(directory)).filter((name) => /^[a-f0-9-]{36}$/.test(name))).toHaveLength(
      0
    )
    expect(second.platform.dispatch).not.toHaveBeenCalled()
  })
  it('keeps an unverified message unverified in actual ledger timing metadata without returning its body', () => {
    const f = fixture()
    f.ledger.observe({
      ...f.message,
      sourceMessageId: 'timing-verified',
      text: 'SYNTHETIC_PRIVATE_SOURCE_ONE'
    })
    f.ledger.observe({
      ...f.message,
      sourceMessageId: 'timing-unverified',
      text: 'SYNTHETIC_PRIVATE_SOURCE_TWO',
      messageIdVerified: false
    })
    const task = {
      ...taskFixture().task,
      identity: f.identity,
      conversationId: f.message.conversationId,
      inboundRange: { from: 1, to: 2 }
    }
    const refs = f.ledger.inboundReferences(task)
    expect(refs).toEqual([
      { sourceMessageId: 'timing-verified', sequence: 1, verified: true },
      { sourceMessageId: 'timing-unverified', sequence: 2, verified: false }
    ])
    expect(JSON.stringify(refs)).not.toContain('SYNTHETIC_PRIVATE_SOURCE')
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('writes actual private timing evidence from the real event loop without enabling a send or claiming a rendered endpoint', async () => {
    vi.useRealTimers()
    const directory = mkdtempSync(join(tmpdir(), 'runtime-recovery-timing-'))
    recoveryDirectories.push(directory)
    let arrived!: () => void
    const ready = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const f = fixture(true, undefined, (event) => {
      if (event.kind === 'agent' && event.event.stage === 'candidate_ready') arrived()
    })
    await f.runtime.configureTimingCapture(directory)
    f.configuration.automaticEnabled = false
    const source = new SyntheticCollectionSource(f.identity, 1)
    source.add('customer-0', 'SYNTHETIC_PRIVATE_TIMING_BODY')
    f.platform.collectionSource = source
    f.client.generateCandidate.mockImplementation(async (input) => ({
      task: input.task,
      status: 'handoff',
      automaticAllowed: false,
      factsVerified: false,
      reasons: ['synthetic_timing_only'],
      intents: ['faq'],
      usage: { input_tokens: 0, output_tokens: 0 }
    }))
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      expect((await f.runtime.start()).state).toBe('running')
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('synthetic_timing_timeout')), 3500)
        })
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
      await f.runtime.close()
    }
    const output = await f.runtime.exportTimingEvidence()
    const saved = JSON.parse(await readFile(output, 'utf8'))
    expect(saved).toMatchObject({ status: 'insufficient', businessVerified: false })
    expect(saved.tasks).toHaveLength(1)
    expect(saved.tasks[0].startedAtMs).toBeLessThanOrEqual(saved.tasks[0].generationAtMs)
    expect(saved.tasks[0].sources).toEqual([
      { sourceMessageId: 'source-0', sequence: 1, verified: true }
    ])
    expect(saved.tasks[0].reasons).toContain('missing_reviewable_endpoint')
    expect(await readFile(join(directory, 'events.private.jsonl'), 'utf8')).not.toContain(
      'SYNTHETIC_PRIVATE_TIMING_BODY'
    )
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('refuses an unfinished or late-installed host capture without manufacturing a report', async () => {
    vi.useRealTimers()
    const directory = mkdtempSync(join(tmpdir(), 'runtime-recovery-timing-'))
    recoveryDirectories.push(directory)
    const f = fixture()
    await f.runtime.configureTimingCapture(directory)
    await expect(f.runtime.exportTimingEvidence()).rejects.toThrow('runtime_timing_not_quiescent')
    await f.runtime.start()
    await expect(f.runtime.configureTimingCapture(directory)).rejects.toThrow(
      'runtime_timing_capture_unavailable'
    )
    f.platform.stop = vi.fn(async () => {
      throw new Error('synthetic_stop_failure')
    })
    expect((await f.runtime.close()).pauseAcknowledged).toBe(false)
    await expect(f.runtime.exportTimingEvidence()).rejects.toThrow('runtime_timing_not_quiescent')
    await expect(access(join(directory, 'report.private.json'))).rejects.toBeDefined()
    f.platform.stop = vi.fn(async () => {})
    await f.runtime.close()
  })
  it('joins shutdown during private capture installation and removes the abandoned session before returning', async () => {
    vi.useRealTimers()
    const directory = mkdtempSync(join(tmpdir(), 'runtime-recovery-timing-'))
    recoveryDirectories.push(directory)
    const f = fixture()
    const configuring = f.runtime.configureTimingCapture(directory)
    const closing = f.runtime.close()
    const [configured, closed] = await Promise.allSettled([configuring, closing])
    expect(configured.status).toBe('rejected')
    expect(closed).toMatchObject({ status: 'fulfilled', value: { state: 'closed' } })
    await expect(access(directory)).rejects.toBeDefined()
    expect(f.platform.binding).not.toHaveBeenCalled()
    expect(f.platform.observe).not.toHaveBeenCalled()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('does not override a user pause while start is waiting for private capture installation', async () => {
    vi.useRealTimers()
    const directory = mkdtempSync(join(tmpdir(), 'runtime-recovery-timing-'))
    recoveryDirectories.push(directory)
    const f = fixture()
    const configuring = f.runtime.configureTimingCapture(directory)
    const started = f.runtime.start()
    const paused = f.runtime.pause()
    const [configured, start, pause] = await Promise.allSettled([configuring, started, paused])
    expect(configured.status).toBe('rejected')
    expect(start).toMatchObject({ status: 'fulfilled', value: { state: 'paused' } })
    expect(pause).toMatchObject({ status: 'fulfilled', value: { state: 'paused' } })
    expect(f.platform.binding).not.toHaveBeenCalled()
    expect(f.platform.observe).not.toHaveBeenCalled()
    expect(f.client.acquireLease).not.toHaveBeenCalled()
    await expect(access(directory)).rejects.toBeDefined()
  })
  it('removes the managed private capture on authorized scope forgetting and never recreates it on restart', async () => {
    vi.useRealTimers()
    const directory = mkdtempSync(join(tmpdir(), 'runtime-recovery-timing-'))
    recoveryDirectories.push(directory)
    const f = fixture()
    await f.runtime.configureTimingCapture(directory)
    const scope = {
      workspaceId: `enterprise:${learningHash({ tenant: f.identity.tenantId, account: f.identity.accountId })}`,
      tenantId: f.identity.tenantId,
      accountId: f.identity.accountId,
      platform: f.identity.platform
    }
    f.client.learningForgetScope = vi.fn(async () => {})
    await expect(f.runtime.forgetLearningScope({ ...scope, accountId: 'forged' })).rejects.toThrow(
      'learning_scope_unavailable'
    )
    await access(join(directory, 'events.private.jsonl'))
    await f.runtime.forgetLearningScope(scope)
    await expect(access(directory)).rejects.toBeDefined()
    await f.runtime.start()
    f.emit()
    await f.runtime.close()
    await expect(f.runtime.exportTimingEvidence()).rejects.toThrow(
      'runtime_timing_capture_unavailable'
    )
    await expect(access(directory)).rejects.toBeDefined()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('connects trusted collection and actual agent milestones in one runtime session without enabling sends', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10000)
    const timings: RuntimeTimingEvent[] = []
    const f = fixture(true, undefined, (event) => timings.push(event))
    f.configuration.automaticEnabled = false
    const source = new SyntheticCollectionSource(f.identity, 1)
    source.add('customer-0', 'SYNTHETIC_PRIVATE_RUNTIME_TEXT')
    f.client.generateCandidate.mockImplementation(async (input) => ({
      task: input.task,
      status: 'handoff',
      automaticAllowed: false,
      factsVerified: false,
      reasons: ['synthetic_timing_fixture'],
      intents: ['faq'],
      usage: { input_tokens: 0, output_tokens: 0 }
    }))
    f.platform.collectionSource = source
    expect(await f.runtime.start()).toMatchObject({ state: 'running' })
    await vi.advanceTimersByTimeAsync(1100)
    expect(new Set(timings.map((event) => event.runtimeInstanceId)).size).toBe(1)
    expect(
      timings.filter((event) => event.kind === 'collection').map((event) => event.event.stage)
    ).toContain('read_completed')
    const generation = timings.find(
      (event) => event.kind === 'agent' && event.event.stage === 'generation_started'
    )
    const ready = timings.find(
      (event) => event.kind === 'agent' && event.event.stage === 'candidate_ready'
    )
    expect(generation).toBeDefined()
    expect(ready).toBeDefined()
    if (generation?.kind !== 'agent') throw new Error('synthetic_missing_generation')
    expect(generation.sources).toEqual(
      f.ledger
        .snapshot(f.identity, 'customer-0')
        .messages.filter((message) => message.direction === 'inbound')
        .map((message) => ({
          sourceMessageId: message.sourceMessageId,
          sequence: message.sequence,
          verified: message.identityVerified && message.messageIdVerified
        }))
    )
    expect(generation.modelResolved).toBe(f.configuration.modelResolved)
    expect(JSON.stringify(timings)).not.toContain('SYNTHETIC_PRIVATE_RUNTIME_TEXT')
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })

  it('reports registration and unavailable chat capabilities before any start request', () => {
    const f = fixture(false)
    f.register(false)
    expect(RuntimeStatusSchema.parse(f.runtime.status())).toMatchObject({
      state: 'paused',
      readiness: { registered: false, backgroundRead: false, nonInterferingSend: false }
    })
    f.register(true)
    expect(RuntimeStatusSchema.parse(f.runtime.status())).toMatchObject({
      readiness: { registered: true, backgroundRead: false, nonInterferingSend: false }
    })
    expect(f.platform.binding).not.toHaveBeenCalled()
    expect(f.client.configuration).not.toHaveBeenCalled()
    expect(f.client.acquireLease).not.toHaveBeenCalled()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('does not report send readiness when only message reading is available', () => {
    const f = fixture()
    vi.mocked(f.platform.capabilities).mockReturnValue({
      backgroundRead: true,
      nonInterferingSend: false
    })
    expect(RuntimeStatusSchema.parse(f.runtime.status())).toMatchObject({
      readiness: { registered: true, backgroundRead: true, nonInterferingSend: false }
    })
    expect(f.platform.binding).not.toHaveBeenCalled()
    expect(f.platform.observe).not.toHaveBeenCalled()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('keeps status available if registration cannot be read after collection starts', async () => {
    const f = fixture()
    f.platform.collectionSource = new SyntheticCollectionSource(f.identity, 0)
    expect((await f.runtime.start()).state).toBe('running')
    const registration = vi.spyOn(f.client, 'status').mockImplementation(() => {
      throw new Error('synthetic_registration_unavailable')
    })
    try {
      const status = RuntimeStatusSchema.parse(f.runtime.status())
      expect(status.readiness?.registered).toBe(false)
      expect(status.collection).toBeUndefined()
    } finally {
      registration.mockRestore()
    }
  })
  it('does not generate from static bindings outside the validated collection pages', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      source = new SyntheticCollectionSource(f.identity, 500)
    f.configuration.automaticEnabled = false
    f.ledger.observe({ ...f.message, conversationId: 'customer-499' })
    f.platform.collectionSource = source
    vi.mocked(f.platform.binding).mockResolvedValue({
      identity: f.identity,
      conversations: source.entries.map((e) => e.binding)
    })
    const inventory = source.inventory.bind(source)
    source.inventory = async (input, signal) =>
      input.cursor === null ? inventory(input, signal) : new Promise(() => {})
    expect(await f.runtime.start()).toMatchObject({ state: 'running' })
    await vi.advanceTimersByTimeAsync(1500)
    expect(f.client.generateCandidate).not.toHaveBeenCalled()
    await f.runtime.close()
    vi.useRealTimers()
  })
  it.each(['wechat', 'wework'] as const)(
    'processes 500 %s customers through persistence and generation without rescanning into duplicate model calls',
    async (platform) => {
      vi.useFakeTimers()
      vi.setSystemTime(10000)
      const f = fixture()
      Object.assign(f.identity, { platform })
      f.configuration.automaticEnabled = false
      const source = new SyntheticCollectionSource(f.identity, 500)
      for (const entry of source.entries) source.add(entry.binding.conversationId)
      f.platform.collectionSource = source
      vi.mocked(f.platform.binding).mockResolvedValue({ identity: f.identity, conversations: [] })
      f.client.generateCandidate.mockImplementation(async (input) => ({
        task: input.task,
        status: 'handoff',
        automaticAllowed: false,
        factsVerified: false,
        reasons: ['synthetic_handoff'],
        intents: ['faq'],
        usage: { input_tokens: 0, output_tokens: 0 }
      }))
      expect(await f.runtime.start()).toMatchObject({ state: 'running' })
      await vi.advanceTimersByTimeAsync(25000)
      expect(f.runtime.status().collection).toMatchObject({
        coverage: 'complete',
        knownConversations: 500,
        pendingReads: 0
      })
      expect(f.client.generateCandidate).toHaveBeenCalledTimes(500)
      expect(f.platform.observe).not.toHaveBeenCalled()
      for (let i = 0; i < 500; i++)
        expect(f.ledger.snapshot(f.identity, `customer-${i}`).messages).toHaveLength(1)
      source.add('customer-499', '底部会话没有红点变化的新消息')
      await vi.advanceTimersByTimeAsync(25000)
      expect(f.client.generateCandidate).toHaveBeenCalledTimes(501)
      expect(f.ledger.snapshot(f.identity, 'customer-499').messages).toHaveLength(2)
      expect(f.client.issueExecution).not.toHaveBeenCalled()
      expect(f.platform.dispatch).not.toHaveBeenCalled()
      expect(await f.runtime.pause()).toMatchObject({ state: 'paused', pauseAcknowledged: true })
      const calls = source.inventoryCalls
      await vi.advanceTimersByTimeAsync(40000)
      expect(source.inventoryCalls).toBe(calls)
      await f.runtime.close()
      vi.useRealTimers()
    },
    20000
  )
  it('allows an empty initial directory and discovers a new customer without restarting the account', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10000)
    const f = fixture(),
      source = new SyntheticCollectionSource(f.identity, 0)
    f.configuration.automaticEnabled = false
    f.platform.collectionSource = source
    vi.mocked(f.platform.binding).mockResolvedValue({ identity: f.identity, conversations: [] })
    f.client.generateCandidate.mockImplementation(async (input) => ({
      task: input.task,
      status: 'handoff',
      automaticAllowed: false,
      factsVerified: false,
      reasons: [],
      intents: ['faq'],
      usage: { input_tokens: 0, output_tokens: 0 }
    }))
    expect(await f.runtime.start()).toMatchObject({ state: 'running' })
    expect(f.runtime.status().collection?.knownConversations).toBe(0)
    const entry = {
      binding: { ...f.conversation, conversationId: 'new-customer' },
      displayName: '新客户',
      activityVersion: 'new-activity'
    }
    source.entries.push(entry)
    source.history.set('new-customer', [])
    source.add('new-customer')
    source.emit('new-customer')
    await vi.advanceTimersByTimeAsync(1500)
    expect(f.client.generateCandidate).toHaveBeenCalledOnce()
    expect(f.runtime.status().collection?.knownConversations).toBe(1)
    await f.runtime.close()
    vi.useRealTimers()
  })
  it('pauses while the initial read is unresolved and cannot apply its late result', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10000)
    const f = fixture(),
      source = new SyntheticCollectionSource(f.identity, 1)
    source.add('customer-0')
    f.platform.collectionSource = source
    vi.mocked(f.platform.binding).mockResolvedValue({ identity: f.identity, conversations: [] })
    const gate = deferred<Awaited<ReturnType<typeof source.read>>>(),
      native = source.read.bind(source)
    const read = vi.spyOn(source, 'read').mockReturnValue(gate.promise)
    const starting = f.runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledOnce()
    const request = read.mock.calls[0][0]
    expect(await f.runtime.pause()).toMatchObject({ state: 'paused', pauseAcknowledged: true })
    gate.resolve(await native(request, new AbortController().signal))
    await starting
    expect(f.ledger.snapshot(f.identity, 'customer-0').messages).toHaveLength(0)
    expect(f.client.generateCandidate).not.toHaveBeenCalled()
    await f.runtime.close()
    vi.useRealTimers()
  })
})

function reconciliationFixture() {
  const f = fixture()
  f.ledger.observe(f.message)
  const snapshot = f.ledger.snapshot(f.identity, f.conversation.conversationId)
  const task = {
    ...f.f.task,
    contextHash: hashConversationContext(snapshot),
    conversationRevision: snapshot.revision,
    inboundRange: { from: 1, to: 1 }
  }
  f.ledger.replies.begin(task, ['合成问题'], Date.now())
  f.ledger.replies.update(
    f.identity,
    task.taskId,
    { status: 'needs_human', draft: f.f.draft },
    Date.now()
  )
  const send = f.ledger.prepare(task, f.f.draft.draftHash, Date.now()).record
  f.ledger.transition(send.executionId, 'prepared', 'dispatching', Date.now())
  const request = {
    taskId: task.taskId,
    taskHash: hashContext(task),
    draftHash: f.f.draft.draftHash,
    draftRevision: f.f.draft.draftRevision,
    leaseVersion: 1,
    loginEpoch: f.identity.loginEpoch,
    clientInstanceId: f.identity.clientInstanceId
  }
  const permit = {
    permitId: 'permit-A',
    identity: f.identity,
    taskId: task.taskId,
    conversationId: task.conversationId,
    taskHash: request.taskHash,
    draftHash: request.draftHash,
    draftRevision: request.draftRevision,
    leaseVersion: 1,
    issuedAt: Date.now() - 4000,
    expiresAt: Date.now() - 1000,
    status: 'issued' as const,
    newlyIssued: true
  }
  f.ledger.central.begin(send.executionId, request, Date.now())
  f.ledger.central.issued(send.executionId, permit, Date.now())
  f.ledger.central.dispatching(send.executionId, Date.now())
  f.ledger.central.recordReceipt(
    send.executionId,
    { permitId: permit.permitId, draftHash: request.draftHash, status: 'unknown' },
    Date.now()
  )
  f.ledger.replies.update(f.identity, task.taskId, { status: 'unknown' }, Date.now())
  const challenge: ReconciliationChallenge = {
    caseId: randomUUID(),
    snapshotHash: hashContext('synthetic-original-case'),
    openedAt: Date.now() - 100,
    permit: { ...permit, status: 'unknown', newlyIssued: false }
  }
  f.client.reconciliationChallenge.mockResolvedValue(challenge)
  const inspect = vi.mocked(f.platform.inspectExecution!)
  inspect.mockImplementation(async () => ({
    executionId: send.executionId,
    identity: f.identity,
    conversationId: task.conversationId,
    permitId: permit.permitId,
    taskHash: request.taskHash,
    draftHash: request.draftHash,
    draftRevision: request.draftRevision,
    leaseVersion: 1,
    observedAt: Date.now(),
    verificationProofHash: hashContext('synthetic-journal-proof'),
    status: 'not_sent',
    dispatchStarted: false,
    quiescent: true
  }))
  f.client.reportReconciliation.mockImplementation(async (report) => ({
    caseId: report.caseId,
    reportHash: hashContext(report),
    status: 'evidence_recorded'
  }))
  const row = f.runtime.workbench().rows[0]
  return {
    ...f,
    send,
    challenge,
    inspect,
    input: { taskId: row.taskId, expectedVersion: row.version }
  }
}
it.each([false, true])(
  'blocks a restored ledger before external requests after marker removal=%s',
  async (removeMarker) => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-recovery-'))
    recoveryDirectories.push(root)
    const sourcePath = join(root, 'source.sqlite'),
      initial = new Ledger(sourcePath)
    initial.close()
    const source = new DatabaseSync(sourcePath, { readOnly: true })
    let saved
    try {
      saved = await createLedgerBackup(source, join(root, 'backups'))
    } finally {
      source.close()
    }
    const restored = await restoreLedgerBackup(saved.directory, join(root, 'restored'))
    if (removeMarker) {
      const changed = new DatabaseSync(restored.databasePath)
      changed.exec("UPDATE runtime_metadata SET value=0 WHERE key='restore_review_required'")
      changed.close()
    }
    const f = fixture(true, new Ledger(restored.databasePath))
    expect(f.runtime.status()).toMatchObject({
      state: 'blocked',
      reason: 'execution_reconciliation_required',
      lease: 'stopped'
    })
    expect(await f.runtime.synchronize()).toMatchObject({
      state: 'blocked',
      reason: 'execution_reconciliation_required'
    })
    expect(await f.runtime.start()).toMatchObject({
      state: 'blocked',
      reason: 'execution_reconciliation_required',
      pauseAcknowledged: true
    })
    expect(f.platform.binding).not.toHaveBeenCalled()
    expect(f.platform.observe).not.toHaveBeenCalled()
    expect(f.client.acquireLease).not.toHaveBeenCalled()
    expect(f.client.configuration).not.toHaveBeenCalled()
    expect(f.client.generateCandidate).not.toHaveBeenCalled()
    expect(f.client.issueExecution).not.toHaveBeenCalled()
    expect(f.client.issueHumanExecution).not.toHaveBeenCalled()
    expect(f.client.settleExecution).not.toHaveBeenCalled()
  }
)

async function restoredPauseFixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-recovery-'))
  recoveryDirectories.push(root)
  const sourcePath = join(root, 'source.sqlite'),
    initial = new Ledger(sourcePath)
  initial.close()
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  let saved
  try {
    saved = await createLedgerBackup(source, join(root, 'backups'))
  } finally {
    source.close()
  }
  const restored = await restoreLedgerBackup(saved.directory, join(root, 'restored'))
  const f = fixture(true, new Ledger(restored.databasePath))
  const challenges = new Map<
    string,
    import('../../src/shared/contracts/restoration').RestorePauseChallenge
  >()
  const challenge = vi.fn(async (input: { caseId: string; requestId: string }) => {
    const existing = challenges.get(input.requestId)
    if (existing) return existing
    const now = Date.now()
    const value = {
      challengeId: randomUUID(),
      caseId: input.caseId,
      requestId: input.requestId,
      scope: f.client.status().scope!,
      context: restored.restoreContext,
      frontierHash: 'a'.repeat(64),
      issuedAt: now,
      expiresAt: now + 30000
    }
    challenges.set(input.requestId, value)
    return value
  })
  const report = vi.fn(
    async (proof: import('../../src/shared/contracts/restoration').RestorePauseReport) => {
      const check = new DatabaseSync(restored.databasePath, { readOnly: true })
      try {
        expect(
          check
            .prepare('SELECT report_hash FROM ledger_restore_pause_reports WHERE challenge_id = ?')
            .get(proof.challenge.challengeId)?.report_hash
        ).toBe(hashContext(proof))
      } finally {
        check.close()
      }
      return {
        challengeId: proof.challenge.challengeId,
        reportHash: hashContext(proof),
        status: 'target_pause_report_recorded' as const
      }
    }
  )
  Object.assign(f.client, { restorePauseChallenge: challenge, reportRestorePause: report })
  const caseId = randomUUID()
  const lookup = vi.fn(async (input: { restoreId: string; contextHash: string }) => {
    expect(input).toEqual({
      restoreId: restored.restoreContext.restoreId,
      contextHash: restored.restoreContext.contextHash
    })
    return {
      caseId,
      scope: f.client.status().scope!,
      restoreId: restored.restoreContext.restoreId,
      contextHash: restored.restoreContext.contextHash
    }
  })
  Object.assign(f.client, { lookupRestoration: lookup })
  return {
    ...f,
    restored,
    challenge,
    report,
    lookup,
    input: { caseId: randomUUID(), requestId: randomUUID() }
  }
}
async function restoreApplicationFixture() {
  const f = await restoredPauseFixture(),
    scope = f.client.status().scope!
  const {
    items: _items,
    nextAfter: _after,
    ...manifest
  } = f.ledger.visitRestoreInventory(scope, () => {})
  expect(_items).toHaveLength(0)
  expect(_after).toBeNull()
  const decision = {
    caseId: (
      await f.lookup({
        restoreId: manifest.context.restoreId,
        contextHash: manifest.context.contextHash
      })
    ).caseId,
    uploadId: randomUUID(),
    decisionId: randomUUID(),
    basisHash: 'a'.repeat(64),
    rulingsHash: 'b'.repeat(64),
    historyPolicy: 'quarantine' as const,
    reviewedAllSubjects: true as const,
    restoreId: manifest.context.restoreId,
    targetAgentId: scope.agent_id,
    contextHash: manifest.context.contextHash,
    inventoryBasisHash: manifest.basisHash,
    subjectCount: 1,
    decidedBy: 'admin',
    decidedAt: Date.now(),
    applicationRequired: true as const,
    automaticStart: false as const,
    canRelease: false as const
  }
  const input = {
    scope,
    decision,
    decisionHash: hashContext(decision),
    manifest,
    canRelease: false as const
  }
  const latest = vi.fn(async () => input)
  const acknowledge = vi.fn(
    async (
      receipt: import('../../src/shared/contracts/restore-application').RestoreLocalApplicationReceipt
    ) => ({
      acknowledgementId: randomUUID(),
      applicationId: receipt.applicationId,
      applicationHash: hashContext(receipt),
      scope,
      caseId: receipt.caseId,
      decisionId: receipt.decisionId,
      restoreId: receipt.restoreId,
      contextHash: receipt.contextHash,
      recordedAt: Date.now(),
      status: 'quarantine_recorded' as const,
      externalEvidenceRequired: true as const,
      automaticStart: false as const,
      canRelease: false as const
    })
  )
  Object.assign(f.client, {
    restoreLatestApplicationDecision: latest,
    acknowledgeRestoreApplication: acknowledge
  })
  return { ...f, scope, input, latest, acknowledge }
}
async function restoreRecoveryBoundaryFixture() {
  const f = await restoreApplicationFixture(),
    now = Date.now(),
    authorizationId = randomUUID(),
    manifest = f.input.manifest,
    caseId = f.input.decision.caseId,
    uploadId = randomUUID(),
    history = {
      formatVersion: 1,
      kind: 'restore-account-history',
      proofId: randomUUID(),
      caseId,
      uploadId,
      restoreId: manifest.context.restoreId,
      contextHash: manifest.context.contextHash,
      inventoryBasisHash: manifest.basisHash,
      scope: f.scope,
      platformAccountIdHash: 'a'.repeat(64),
      source: {
        sourceId: 'synthetic',
        keyId: 'test-key',
        version: '1',
        releaseSha256: 'b'.repeat(64)
      },
      historyFrom: 0,
      observedThrough: now,
      capturedAt: now,
      complete: true,
      allConversationsEnumerated: true,
      nextPageToken: null,
      conversations: [
        {
          conversationId: 'source-only-customer',
          complete: true,
          hasGap: false,
          nextPageToken: null,
          messages: []
        }
      ]
    },
    boundary = {
      formatVersion: 1,
      kind: 'restore-account-boundary',
      authorizationId,
      manifest,
      history,
      historyReceiptHash: 'c'.repeat(64),
      executionReceiptHash: 'd'.repeat(64),
      resolutionBasisHash: 'e'.repeat(64),
      humanOwnershipPolicy: 'all_restored_conversations'
    }
  const input = RestoreRecoveryPackageSchema.parse({
    boundary,
    authorization: {
      formatVersion: 1,
      authorizationId,
      scope: f.scope,
      caseId,
      uploadId,
      reviewId: randomUUID(),
      restoreId: history.restoreId,
      contextHash: history.contextHash,
      inventoryBasisHash: manifest.basisHash,
      assessmentBasisHash: 'f'.repeat(64),
      historyProofId: history.proofId,
      historyReceiptHash: boundary.historyReceiptHash,
      executionReceiptHash: boundary.executionReceiptHash,
      resolutionBasisHash: boundary.resolutionBasisHash,
      boundaryHash: hashContext(boundary),
      requestHash: '1'.repeat(64),
      historyPolicy: 'quarantine_all_history',
      recordedBy: 'synthetic-maintenance',
      recordedAt: now,
      expiresAt: now + 300000,
      status: 'approved_for_boundary',
      localDurableApplicationRequired: true,
      centralCompletionRequired: true,
      physicalFactsVerifiedByThisCommand: false,
      canRelease: false,
      automaticStart: false
    }
  })
  const latestRecovery = vi.fn(async () => input)
  Object.assign(f.client, { restoreLatestRecoveryBoundary: latestRecovery })
  return { ...f, recoveryInput: input, latestRecovery }
}
async function restoreRecoveryResolutionFixture() {
  const f = await restoreRecoveryBoundaryFixture(),
    p = f.recoveryInput,
    a = p.authorization,
    review = {
      reviewId: a.reviewId,
      tenantId: a.scope.tenant_id,
      accountId: a.scope.account_id,
      caseId: a.caseId,
      uploadId: a.uploadId,
      historyProofId: a.historyProofId,
      assessmentBasisHash: a.assessmentBasisHash,
      reviewerId: 'synthetic-independent',
      reviewedAt: a.recordedAt,
      outcomes: []
    },
    reviewReceipt = {
      formatVersion: 1,
      reviewId: a.reviewId,
      tenantId: a.scope.tenant_id,
      accountId: a.scope.account_id,
      caseId: a.caseId,
      uploadId: a.uploadId,
      historyProofId: a.historyProofId,
      assessmentBasisHash: a.assessmentBasisHash,
      historyReceiptHash: a.historyReceiptHash,
      subjectsSnapshotHash: hashContext([]),
      requestHash: hashContext(review),
      outcomesHash: hashContext([]),
      subjects: 0,
      confirmed: 0,
      notSent: 0,
      executionGroups: 0,
      recordedBy: 'maintenance',
      recordedAt: a.recordedAt,
      maintenanceReviewRecorded: true,
      physicalOutcomeVerifiedByThisCommand: false,
      separateReconciliationRequired: true,
      automaticStart: false,
      canRelease: false
    }
  p.boundary.executionReceiptHash = a.executionReceiptHash = hashContext(reviewReceipt)
  p.boundary.resolutionBasisHash = a.resolutionBasisHash = hashContext({
    formatVersion: 1,
    tenantId: a.scope.tenant_id,
    accountId: a.scope.account_id,
    caseId: a.caseId,
    uploadId: a.uploadId,
    reviewId: a.reviewId,
    assessmentBasisHash: a.assessmentBasisHash,
    subjects: [],
    facts: []
  })
  a.boundaryHash = hashContext(p.boundary)
  const resolutions = parseRestoreResolutionPackage(
      {
        formatVersion: 1,
        authorizationId: a.authorizationId,
        authorizationHash: hashContext(a),
        boundaryHash: a.boundaryHash,
        resolutionBasisHash: a.resolutionBasisHash,
        review,
        reviewReceipt,
        subjects: [],
        localExecutions: [],
        records: [],
        automaticStart: false,
        canRelease: false
      },
      p
    ),
    fetchResolutions = vi.fn(async () => resolutions)
  Object.assign(f.client, { restoreExecutionResolutions: fetchResolutions })
  return { ...f, resolutions, fetchResolutions }
}
it('persists completion intent before transport, retries a lost response after restart without refetching expired approval and stays paused', async () => {
  const f = await restoreRecoveryResolutionFixture(),
    source = restoreObservationFixture(f.recoveryInput, Date.now()),
    fetchGrant = vi.fn(async () => source.grant),
    acknowledge = vi.fn(async (input: RestoreRecoveryCompletionInput) =>
      restoreCompletionAckFixture(input)
    ),
    ackHolder: { value?: RestoreRecoveryCompletionReceipt } = {}
  acknowledge.mockImplementationOnce(async (input) => {
    expect(f.ledger.restoreCompletionIntent(f.scope)).toEqual(input)
    ackHolder.value = restoreCompletionAckFixture(input)
    throw Error('synthetic_response_lost')
  })
  Object.assign(f.client, {
    restoreObservationGrant: fetchGrant,
    acknowledgeRestoreRecovery: acknowledge
  })
  expect(await f.runtime.acknowledgeRestoreRecovery({})).toEqual({
    success: false,
    code: 'unavailable'
  })
  const input = f.ledger.restoreCompletionIntent(f.scope)!
  expect(input).not.toBeNull()
  expect(f.ledger.restoreCompletionAck(f.scope)).toBeNull()
  await f.runtime.close()
  vi.spyOn(Date, 'now').mockReturnValue(f.recoveryInput.authorization.expiresAt + 1)
  const restarted = fixture(true, new Ledger(f.restored.databasePath)),
    lookup = vi.fn(async () => {
      throw Error('should_not_refetch_expired_approval')
    })
  Object.assign(restarted.client, {
    lookupRestoration: lookup,
    restoreLatestRecoveryBoundary: f.latestRecovery,
    restoreExecutionResolutions: f.fetchResolutions,
    restoreObservationGrant: fetchGrant,
    acknowledgeRestoreRecovery: vi.fn(async (request: RestoreRecoveryCompletionInput) => {
      expect(request).toEqual(input)
      return ackHolder.value!
    })
  })
  expect(await restarted.runtime.acknowledgeRestoreRecovery({})).toEqual({
    success: true,
    status: 'completion_recorded',
    canRelease: false
  })
  expect(lookup).not.toHaveBeenCalled()
  expect(restarted.ledger.restoreCompletionAck(restarted.client.status().scope!)).toEqual(
    ackHolder.value
  )
  expect(restarted.ledger.requiresRestoreReview()).toBe(true)
  expect(restarted.runtime.status().state).toBe('paused')
  expect(restarted.client.acquireLease).not.toHaveBeenCalled()
  expect(restarted.platform.dispatch).not.toHaveBeenCalled()
})
it('rejects caller-supplied completion evidence, overlap and a late confirmation after device removal', async () => {
  const f = await restoreRecoveryResolutionFixture(),
    source = restoreObservationFixture(f.recoveryInput, Date.now()),
    gate = deferred<RestoreRecoveryCompletionReceipt>(),
    acknowledge = vi.fn(async () => gate.promise)
  Object.assign(f.client, {
    restoreObservationGrant: vi.fn(async () => source.grant),
    acknowledgeRestoreRecovery: acknowledge
  })
  expect(await f.runtime.acknowledgeRestoreRecovery({ completionId: randomUUID() })).toEqual({
    success: false,
    code: 'invalid_input'
  })
  const pending = f.runtime.acknowledgeRestoreRecovery({})
  await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce())
  expect(await f.runtime.acknowledgeRestoreRecovery({})).toEqual({
    success: false,
    code: 'unavailable'
  })
  const input = f.ledger.restoreCompletionIntent(f.scope)!
  f.register(false)
  gate.resolve(restoreCompletionAckFixture(input))
  expect(await pending).toEqual({ success: false, code: 'device_changed' })
  expect(f.ledger.restoreCompletionAck(f.scope)).toBeNull()
  expect(f.platform.dispatch).not.toHaveBeenCalled()
})
it('installs only host-fetched ordered observation trust after durable boundary and resolution while keeping all send fences', async () => {
  const f = await restoreRecoveryResolutionFixture(),
    s = restoreObservationFixture(f.recoveryInput, Date.now()),
    fetchGrant = vi.fn(async () => s.grant)
  Object.assign(f.client, { restoreObservationGrant: fetchGrant })
  expect(await f.runtime.prepareRestoreRecoveryReads({ grant: s.grant })).toEqual({
    success: false,
    code: 'invalid_input'
  })
  fetchGrant.mockRejectedValueOnce(Error('synthetic_transport_loss'))
  expect(await f.runtime.prepareRestoreRecoveryReads({})).toEqual({
    success: false,
    code: 'unavailable'
  })
  expect(f.ledger.restoreObservationGrant(f.identity)).toBeUndefined()
  expect(await f.runtime.prepareRestoreRecoveryReads({})).toEqual({
    success: true,
    status: 'reads_prepared',
    canRelease: false
  })
  expect(f.ledger.restoreObservationGrant(f.identity)).toEqual(s.grant)
  expect(f.runtime.status().state).toBe('paused')
  expect(f.ledger.requiresRestoreReview()).toBe(true)
  expect(f.client.acquireLease).not.toHaveBeenCalled()
  expect(f.platform.dispatch).not.toHaveBeenCalled()
})
it('retries host resolution retrieval after a durable boundary and restarts with the exact independently bound journal while remaining paused', async () => {
  const f = await restoreRecoveryResolutionFixture(),
    id = f.recoveryInput.authorization.authorizationId
  f.fetchResolutions.mockRejectedValueOnce(Error('synthetic_transport_loss'))
  expect(await f.runtime.applyRestoreRecoveryExecutions({})).toEqual({
    success: false,
    code: 'unavailable'
  })
  const boundary = f.ledger.restoreRecoveryApplication(id)
  expect(boundary).not.toBeNull()
  expect(f.ledger.restoreResolutionApplication(id)).toBeNull()
  expect(await f.runtime.applyRestoreRecoveryExecutions({})).toEqual({
    success: true,
    status: 'executions_recorded',
    canRelease: false
  })
  const receipt = f.ledger.restoreResolutionApplication(id)
  expect(receipt).toMatchObject({
    boundaryApplicationId: boundary!.applicationId,
    localExecutions: 0,
    canRelease: false
  })
  await f.runtime.close()
  const restarted = fixture(true, new Ledger(f.restored.databasePath))
  Object.assign(restarted.client, {
    lookupRestoration: f.lookup,
    restoreLatestRecoveryBoundary: f.latestRecovery,
    restoreExecutionResolutions: f.fetchResolutions
  })
  expect(await restarted.runtime.applyRestoreRecoveryExecutions({})).toEqual({
    success: true,
    status: 'executions_recorded',
    canRelease: false
  })
  expect(restarted.ledger.restoreRecoveryApplication(id)).toEqual(boundary)
  expect(restarted.ledger.restoreResolutionApplication(id)).toEqual(receipt)
  expect(restarted.ledger.requiresRestoreReview()).toBe(true)
  expect(restarted.client.acquireLease).not.toHaveBeenCalled()
  expect(restarted.platform.dispatch).not.toHaveBeenCalled()
  expect(f.acknowledge).not.toHaveBeenCalled()
})
it('refuses caller-authored resolution authority, overlap and a late resolution after a connection change without writing its journal', async () => {
  const f = await restoreRecoveryResolutionFixture(),
    late = deferred<RestoreResolutionPackage>()
  expect(await f.runtime.applyRestoreRecoveryExecutions({ resolutions: f.resolutions })).toEqual({
    success: false,
    code: 'invalid_input'
  })
  f.fetchResolutions.mockImplementationOnce(() => late.promise)
  const pending = f.runtime.applyRestoreRecoveryExecutions({})
  await vi.waitFor(() => expect(f.fetchResolutions).toHaveBeenCalledTimes(1))
  expect(await f.runtime.applyRestoreRecoveryExecutions({})).toEqual({
    success: false,
    code: 'unavailable'
  })
  f.register(false)
  late.resolve(f.resolutions)
  expect(await pending).toEqual({ success: false, code: 'device_changed' })
  expect(
    f.ledger.restoreResolutionApplication(f.recoveryInput.authorization.authorizationId)
  ).toBeNull()
  expect(f.ledger.requiresRestoreReview()).toBe(true)
  expect(f.client.acquireLease).not.toHaveBeenCalled()
  expect(f.platform.dispatch).not.toHaveBeenCalled()
})
it('applies a host-fetched approved boundary after quiescence and retains every runtime and human fence', async () => {
  const f = await restoreRecoveryBoundaryFixture()
  expect(await f.runtime.applyRestoreRecoveryBoundary({})).toEqual({
    success: true,
    status: 'boundary_recorded',
    canRelease: false
  })
  expect(f.latestRecovery).toHaveBeenCalledWith(
    {
      caseId: f.recoveryInput.authorization.caseId,
      restoreId: f.restored.restoreContext.restoreId,
      contextHash: f.restored.restoreContext.contextHash
    },
    f.scope,
    expect.any(AbortSignal)
  )
  const receipt = f.ledger.restoreRecoveryApplication(f.recoveryInput.authorization.authorizationId)
  expect(receipt).toMatchObject({
    ownedConversationCount: 1,
    localExecutionResolutionRequired: true,
    canRelease: false
  })
  expect(f.ledger.requiresRestoreReview()).toBe(true)
  expect(f.client.acquireLease).not.toHaveBeenCalled()
  expect(f.platform.dispatch).not.toHaveBeenCalled()
  expect(f.acknowledge).not.toHaveBeenCalled()
  expect(f.ledger.conversationState(f.f.task.identity, 'source-only-customer').humanOwned).toBe(
    true
  )
})
it('rejects renderer-supplied recovery authority, concurrent preparation and late results after connection removal', async () => {
  const f = await restoreRecoveryBoundaryFixture(),
    waiting = deferred<typeof f.recoveryInput>()
  expect(
    await f.runtime.applyRestoreRecoveryBoundary({
      authorizationId: f.recoveryInput.authorization.authorizationId
    })
  ).toEqual({ success: false, code: 'invalid_input' })
  f.latestRecovery.mockImplementationOnce(() => waiting.promise)
  const pending = f.runtime.applyRestoreRecoveryBoundary({})
  await vi.waitFor(() => expect(f.latestRecovery).toHaveBeenCalled())
  expect(await f.runtime.applyRestoreRecoveryBoundary({})).toEqual({
    success: false,
    code: 'unavailable'
  })
  expect(await f.runtime.applyRestoreDecision({})).toEqual({ success: false, code: 'unavailable' })
  f.register(false)
  waiting.resolve(f.recoveryInput)
  expect(await pending).toEqual({ success: false, code: 'device_changed' })
  expect(
    f.ledger.restoreRecoveryApplication(f.recoveryInput.authorization.authorizationId)
  ).toBeNull()
})
it('does not apply changed target responses or failed transport, and stores the same boundary receipt after restart', async () => {
  const f = await restoreRecoveryBoundaryFixture()
  f.latestRecovery.mockRejectedValueOnce(Error('synthetic_transport_loss'))
  expect(await f.runtime.applyRestoreRecoveryBoundary({})).toEqual({
    success: false,
    code: 'unavailable'
  })
  expect(
    f.ledger.restoreRecoveryApplication(f.recoveryInput.authorization.authorizationId)
  ).toBeNull()
  const bad = structuredClone(f.recoveryInput)
  bad.authorization.scope.account_id = 'other'
  bad.boundary.history.scope.account_id = 'other'
  bad.boundary.manifest.scope.account_id = 'other'
  bad.authorization.boundaryHash = hashContext(bad.boundary)
  f.latestRecovery.mockResolvedValueOnce(bad)
  expect(await f.runtime.applyRestoreRecoveryBoundary({})).toEqual({
    success: false,
    code: 'unavailable'
  })
  expect(await f.runtime.applyRestoreRecoveryBoundary({})).toEqual({
    success: true,
    status: 'boundary_recorded',
    canRelease: false
  })
  const receipt = f.ledger.restoreRecoveryApplication(f.recoveryInput.authorization.authorizationId)
  await f.runtime.close()
  const restarted = fixture(true, new Ledger(f.restored.databasePath))
  Object.assign(restarted.client, {
    lookupRestoration: f.lookup,
    restoreLatestRecoveryBoundary: f.latestRecovery
  })
  expect(await restarted.runtime.applyRestoreRecoveryBoundary({})).toEqual({
    success: true,
    status: 'boundary_recorded',
    canRelease: false
  })
  expect(
    restarted.ledger.restoreRecoveryApplication(f.recoveryInput.authorization.authorizationId)
  ).toEqual(receipt)
  expect(restarted.ledger.requiresRestoreReview()).toBe(true)
  expect(restarted.client.acquireLease).not.toHaveBeenCalled()
  expect(restarted.platform.dispatch).not.toHaveBeenCalled()
})
it('retries the durable quarantine receipt after response loss and persists acknowledgement without starting', async () => {
  const f = await restoreApplicationFixture()
  f.acknowledge.mockRejectedValueOnce(new Error('synthetic_response_loss'))
  expect(await f.runtime.applyRestoreDecision({})).toEqual({ success: false, code: 'unavailable' })
  const first = f.acknowledge.mock.calls[0][0]
  expect(await f.runtime.applyRestoreDecision({})).toEqual({
    success: true,
    status: 'quarantine_recorded',
    canRelease: false
  })
  expect(f.acknowledge.mock.calls[1][0]).toEqual(first)
  expect(f.runtime.restorationStatus()).toEqual({ state: 'quarantine_recorded' })
  expect(f.ledger.hasRestoreApplicationAck(f.scope)).toBe(true)
  expect(f.ledger.requiresRestoreReview()).toBe(true)
  expect(f.client.acquireLease).not.toHaveBeenCalled()
  expect(f.platform.dispatch).not.toHaveBeenCalled()
})
it('rejects renderer authority, overlapping application and changed connection before local quarantine', async () => {
  const f = await restoreApplicationFixture(),
    waiting = deferred<typeof f.input>()
  expect(await f.runtime.applyRestoreDecision({ canRelease: true })).toEqual({
    success: false,
    code: 'invalid_input'
  })
  f.latest.mockImplementationOnce(() => waiting.promise)
  const first = f.runtime.applyRestoreDecision({})
  await vi.waitFor(() => expect(f.latest).toHaveBeenCalled())
  expect(await f.runtime.applyRestoreDecision({})).toEqual({ success: false, code: 'unavailable' })
  f.register(false)
  waiting.resolve(f.input)
  expect(await first).toEqual({ success: false, code: 'device_changed' })
  expect(f.acknowledge).not.toHaveBeenCalled()
})
it('continues an application committed before shutdown using the identical receipt on a fresh runtime', async () => {
  const f = await restoreApplicationFixture()
  f.acknowledge.mockRejectedValueOnce(new Error('synthetic_response_loss'))
  expect((await f.runtime.applyRestoreDecision({})).success).toBe(false)
  const original = f.acknowledge.mock.calls[0][0]
  await f.runtime.close()
  const restarted = fixture(true, new Ledger(f.restored.databasePath))
  Object.assign(restarted.client, {
    lookupRestoration: f.lookup,
    restoreLatestApplicationDecision: f.latest,
    acknowledgeRestoreApplication: f.acknowledge
  })
  expect(await restarted.runtime.applyRestoreDecision({})).toEqual({
    success: true,
    status: 'quarantine_recorded',
    canRelease: false
  })
  expect(f.acknowledge.mock.calls[1][0]).toEqual(original)
  expect(restarted.runtime.restorationStatus()).toEqual({ state: 'quarantine_recorded' })
  expect(restarted.platform.dispatch).not.toHaveBeenCalled()
})
it('discards a late acknowledgement after employee connection removal and retains the durable application', async () => {
  const f = await restoreApplicationFixture(),
    waiting = deferred<Awaited<ReturnType<typeof f.acknowledge>>>()
  f.acknowledge.mockImplementationOnce(() => waiting.promise)
  const pending = f.runtime.applyRestoreDecision({})
  await vi.waitFor(() => expect(f.acknowledge).toHaveBeenCalled())
  const receipt = f.acknowledge.mock.calls[0][0]
  f.register(false)
  waiting.resolve({
    acknowledgementId: randomUUID(),
    applicationId: receipt.applicationId,
    applicationHash: hashContext(receipt),
    scope: f.scope,
    caseId: receipt.caseId,
    decisionId: receipt.decisionId,
    restoreId: receipt.restoreId,
    contextHash: receipt.contextHash,
    recordedAt: Date.now(),
    status: 'quarantine_recorded',
    externalEvidenceRequired: true,
    automaticStart: false,
    canRelease: false
  })
  expect(await pending).toEqual({ success: false, code: 'device_changed' })
  expect(f.ledger.hasRestoreApplicationAck(f.scope)).toBe(false)
  expect(f.ledger.requiresRestoreReview()).toBe(true)
})
it('uploads a restored snapshot from host identity only and retries a lost completion response with the same request', async () => {
  const f = await restoredPauseFixture()
  const uploadId = randomUUID(),
    starts: unknown[] = []
  let completeCalls = 0
  const start = vi.fn(
    async (
      request: import('../../src/shared/contracts/restore-inventory').RestoreInventoryStartInput
    ) => {
      starts.push(structuredClone(request))
      return {
        uploadId,
        manifestHash: hashContext(request.manifest),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 900000
      }
    }
  )
  const page = vi.fn(async () => {
    throw Error('empty source has no pages')
  })
  const complete = vi.fn(async () => {
    if (++completeCalls === 1) throw Error('synthetic completion response lost')
    const request = starts[0] as { manifest: { basisHash: string } }
    return {
      uploadId,
      manifestHash: hashContext((starts[0] as { manifest: unknown }).manifest),
      basisHash: request.manifest.basisHash,
      itemCount: 0,
      pageCount: 0,
      status: 'inventory_received',
      canRelease: false,
      externalEvidenceRequired: true
    }
  })
  Object.assign(f.client, {
    startRestoreInventory: start,
    submitRestoreInventoryPage: page,
    completeRestoreInventory: complete
  })
  expect(await f.runtime.submitRestoreInventory({ path: 'forged' })).toEqual({
    success: false,
    code: 'invalid_input'
  })
  expect(start).not.toHaveBeenCalled()
  expect(await f.runtime.submitRestoreInventory({})).toEqual({
    success: false,
    code: 'unavailable'
  })
  expect(await f.runtime.submitRestoreInventory({})).toMatchObject({
    success: true,
    uploadId,
    itemCount: 0,
    canRelease: false
  })
  expect(starts[1]).toEqual(starts[0])
  expect(page).not.toHaveBeenCalled()
  expect(f.runtime.restorationStatus()).toEqual({ state: 'inventory_received' })
  expect(f.ledger.requiresRestoreReview()).toBe(true)
  expect(f.platform.binding).not.toHaveBeenCalled()
  expect(f.platform.observe).not.toHaveBeenCalled()
  expect(f.platform.dispatch).not.toHaveBeenCalled()
})
it('does not accept a restored inventory receipt after the employee connection changes during upload', async () => {
  const f = await restoredPauseFixture(),
    waiting = deferred<unknown>()
  const start = vi.fn(async () => waiting.promise)
  const complete = vi.fn(async () => {
    throw Error('must not complete stale connection')
  })
  Object.assign(f.client, {
    startRestoreInventory: start,
    submitRestoreInventoryPage: vi.fn(),
    completeRestoreInventory: complete
  })
  const pending = f.runtime.submitRestoreInventory({})
  while (start.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1))
  await f.runtime.deviceChanged()
  waiting.resolve({
    uploadId: randomUUID(),
    manifestHash: 'a'.repeat(64),
    issuedAt: 100,
    expiresAt: 900100
  })
  expect(await pending).toEqual({ success: false, code: 'device_changed' })
  expect(complete).not.toHaveBeenCalled()
  expect(f.ledger.requiresRestoreReview()).toBe(true)
})
it('preserves structured results and releases the upload lock after a temporary snapshot cleanup failure', async () => {
  const f = await restoredPauseFixture(),
    original = inventorySnapshot.createRestoreInventorySnapshot
  const spy = vi
    .spyOn(inventorySnapshot, 'createRestoreInventorySnapshot')
    .mockImplementationOnce((...args) => {
      const saved = original(...args)
      let tries = 0
      return {
        ...saved,
        dispose: () => {
          saved.dispose()
          if (++tries === 1) throw Error('synthetic temporary unlink failure')
        }
      }
    })
  const start = vi.fn(async () => {
    throw Error('synthetic network unavailable')
  })
  Object.assign(f.client, {
    startRestoreInventory: start,
    submitRestoreInventoryPage: vi.fn(),
    completeRestoreInventory: vi.fn()
  })
  try {
    expect(await f.runtime.submitRestoreInventory({})).toEqual({
      success: false,
      code: 'unavailable'
    })
    expect(await f.runtime.submitRestoreInventory({})).toEqual({
      success: false,
      code: 'unavailable'
    })
    expect(start).toHaveBeenCalledTimes(2)
    expect(f.ledger.requiresRestoreReview()).toBe(true)
  } finally {
    spy.mockRestore()
  }
})
it('discovers and reports restoration using only main-process source and nonce, with unchanged upload retries', async () => {
  const f = await restoredPauseFixture()
  expect(f.runtime.restorationStatus()).toEqual({ state: 'review_required' })
  expect(f.lookup).not.toHaveBeenCalled()
  f.report.mockRejectedValueOnce(Error('synthetic_upload_lost'))
  expect(await f.runtime.submitRestorePause({})).toMatchObject({
    success: false,
    code: 'unavailable'
  })
  expect(await f.runtime.submitRestorePause({})).toMatchObject({
    success: true,
    status: 'target_pause_report_recorded'
  })
  expect(f.report.mock.calls[0][0]).toEqual(f.report.mock.calls[1][0])
  expect(f.challenge.mock.calls[0][0].requestId).toBe(f.challenge.mock.calls[1][0].requestId)
  expect(f.lookup.mock.calls[0][0]).toEqual({
    restoreId: f.restored.restoreContext.restoreId,
    contextHash: f.restored.restoreContext.contextHash
  })
  expect(f.runtime.restorationStatus()).toEqual({ state: 'pause_report_recorded' })
  expect(f.ledger.requiresRestoreReview()).toBe(true)
  expect(f.platform.binding).not.toHaveBeenCalled()
  expect(f.client.acquireLease).not.toHaveBeenCalled()
  expect(f.client.generateCandidate).not.toHaveBeenCalled()
  expect(f.platform.dispatch).not.toHaveBeenCalled()
})
it('rejects renderer restoration authority fields and a device change during discovery before requesting a challenge', async () => {
  const f = await restoredPauseFixture()
  expect(
    await f.runtime.submitRestorePause({
      caseId: randomUUID(),
      platformStopped: true,
      source: 'arbitrary.sqlite'
    })
  ).toMatchObject({ success: false, code: 'invalid_input' })
  expect(f.lookup).not.toHaveBeenCalled()
  const lookup = f.lookup.getMockImplementation()!
  f.lookup.mockImplementation(async (input) => {
    const result = await lookup(input)
    f.register(false)
    return result
  })
  expect(await f.runtime.submitRestorePause({})).toMatchObject({
    success: false,
    code: 'device_changed'
  })
  expect(f.challenge).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
})
it('uses a fresh restoration request after expiry and refuses overlapping discovery', async () => {
  const f = await restoredPauseFixture()
  f.report.mockRejectedValueOnce(Error('synthetic_upload_lost'))
  expect(await f.runtime.submitRestorePause({})).toMatchObject({ success: false })
  const first = f.report.mock.calls[0][0]
  const now = vi.spyOn(Date, 'now').mockReturnValue(first.challenge.expiresAt + 1)
  try {
    expect(await f.runtime.submitRestorePause({})).toMatchObject({ success: true })
    expect(f.report.mock.calls[1][0].challenge.requestId).not.toBe(first.challenge.requestId)
    expect(f.report.mock.calls[1][0].challenge.challengeId).not.toBe(first.challenge.challengeId)
  } finally {
    now.mockRestore()
  }
  const lookup = f.lookup.getMockImplementation()!
  let release!: () => void
  f.lookup.mockImplementation(async (input) => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return lookup(input)
  })
  const pending = f.runtime.submitRestorePause({})
  expect(await f.runtime.submitRestorePause({})).toEqual({ success: false, code: 'unavailable' })
  release()
  await pending
  expect(f.platform.dispatch).not.toHaveBeenCalled()
  expect(f.client.generateCandidate).not.toHaveBeenCalled()
})
it('persists a target restore pause report before upload, retries it unchanged, and retains the send fence', async () => {
  const f = await restoredPauseFixture()
  const first = await f.runtime.reportRestorePause(f.input)
  expect(first).toMatchObject({ success: true, status: 'target_pause_report_recorded' })
  expect(await f.runtime.reportRestorePause(f.input)).toEqual(first)
  expect(f.report).toHaveBeenCalledTimes(2)
  expect(f.report.mock.calls[0][0]).toEqual(f.report.mock.calls[1][0])
  expect(f.ledger.requiresRestoreReview()).toBe(true)
  expect(f.platform.stop).toHaveBeenCalledTimes(1)
  expect(f.platform.binding).not.toHaveBeenCalled()
  expect(f.platform.observe).not.toHaveBeenCalled()
  expect(f.client.acquireLease).not.toHaveBeenCalled()
  expect(f.client.generateCandidate).not.toHaveBeenCalled()
  expect(f.client.issueExecution).not.toHaveBeenCalled()
})
it('does not request restoration evidence when a trusted platform fails to stop', async () => {
  const f = await restoredPauseFixture()
  vi.mocked(f.platform.stop).mockRejectedValueOnce(Error('synthetic_stop_pending'))
  expect(await f.runtime.reportRestorePause(f.input)).toMatchObject({
    success: false,
    code: 'execution_pending'
  })
  expect(f.challenge).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
})
it.each(['pause', 'deviceChanged'] as const)(
  'cancels restoration submission when %s interrupts a pending platform stop',
  async (action) => {
    const f = await restoredPauseFixture(),
      stop = deferred<void>()
    vi.mocked(f.platform.stop).mockReturnValueOnce(stop.promise)
    const submission = f.runtime.submitRestorePause({})
    await expect.poll(() => vi.mocked(f.platform.stop).mock.calls.length).toBe(1)
    const interruption = f.runtime[action]()
    stop.resolve()
    await interruption
    expect(await submission).toEqual({ success: false, code: 'device_changed' })
    expect(f.challenge).not.toHaveBeenCalled()
    expect(f.report).not.toHaveBeenCalled()
    expect(f.runtime.restorationStatus()).toEqual({ state: 'review_required' })
    expect(f.ledger.requiresRestoreReview()).toBe(true)
  }
)
it('retains the persisted restoration report across a lost upload response and retries unchanged', async () => {
  const f = await restoredPauseFixture()
  f.report.mockRejectedValueOnce(Error('synthetic_upload_unavailable'))
  expect(await f.runtime.reportRestorePause(f.input)).toMatchObject({
    success: false,
    code: 'unavailable'
  })
  expect(await f.runtime.reportRestorePause(f.input)).toMatchObject({
    success: true,
    status: 'target_pause_report_recorded'
  })
  expect(f.report.mock.calls[0][0]).toEqual(f.report.mock.calls[1][0])
  expect(f.platform.stop).toHaveBeenCalledTimes(1)
  expect(f.ledger.requiresRestoreReview()).toBe(true)
})
it('rejects an expired restoration challenge before persisting a target report', async () => {
  const f = await restoredPauseFixture(),
    original = f.challenge.getMockImplementation()!
  f.challenge.mockImplementation(async (input) => {
    const c = await original(input),
      now = Date.now()
    return { ...c, issuedAt: now - 31000, expiresAt: now - 1000 }
  })
  expect(await f.runtime.reportRestorePause(f.input)).toMatchObject({
    success: false,
    code: 'unavailable'
  })
  expect(f.report).not.toHaveBeenCalled()
})
it('rejects a device change during a restore challenge before persisting or uploading the report', async () => {
  const f = await restoredPauseFixture(),
    original = f.challenge.getMockImplementation()!
  f.challenge.mockImplementation(async (input) => {
    const c = await original(input)
    f.register(false)
    return c
  })
  expect(await f.runtime.reportRestorePause(f.input)).toMatchObject({
    success: false,
    code: 'device_changed'
  })
  expect(f.report).not.toHaveBeenCalled()
  const check = new DatabaseSync(f.restored.databasePath, { readOnly: true })
  try {
    expect(
      check.prepare("SELECT 1 FROM sqlite_schema WHERE name='ledger_restore_pause_reports'").get()
    ).toBeUndefined()
  } finally {
    check.close()
  }
})

function requestSealFixture(installed = true) {
  const f = fixture(installed)
  f.ledger.observe(f.message)
  const snapshot = f.ledger.snapshot(f.identity, f.conversation.conversationId),
    task = {
      ...f.f.task,
      contextHash: hashConversationContext(snapshot),
      conversationRevision: snapshot.revision,
      inboundRange: { from: 1, to: 1 }
    }
  f.ledger.replies.begin(task, ['合成问题'], Date.now())
  f.ledger.replies.update(
    f.identity,
    task.taskId,
    { status: 'not_sent', draft: f.f.draft },
    Date.now()
  )
  const send = f.ledger.prepare(task, f.f.draft.draftHash, Date.now()).record
  f.ledger.transition(send.executionId, 'prepared', 'dispatching', Date.now())
  f.ledger.central.begin(
    send.executionId,
    {
      taskId: task.taskId,
      taskHash: hashContext(task),
      draftHash: f.f.draft.draftHash,
      draftRevision: f.f.draft.draftRevision,
      leaseVersion: 1,
      loginEpoch: f.identity.loginEpoch,
      clientInstanceId: f.identity.clientInstanceId
    },
    Date.now()
  )
  f.ledger.central.unresolved(send.executionId, Date.now())
  f.ledger.transition(send.executionId, 'dispatching', 'cancelled', Date.now())
  f.client.sealExecutionRequest.mockImplementation(async (input) => ({
    status: 'request_sealed',
    seal: { sealId: randomUUID(), input, requestHash: hashContext(input), sealedAt: Date.now() }
  }))
  const row = f.runtime.workbench().rows[0]
  return { ...f, task, send, input: { taskId: row.taskId, expectedVersion: row.version } }
}
describe('main-owned never-dispatched request sealing', () => {
  it('ignores a late seal response after pause and never writes an application acknowledgment', async () => {
    const f = requestSealFixture(false),
      late = deferred<Awaited<ReturnType<typeof f.client.sealExecutionRequest>>>()
    f.client.sealExecutionRequest.mockReturnValueOnce(late.promise)
    const work = f.runtime.workbenchReconcile(f.input)
    await vi.waitFor(() => expect(f.client.sealExecutionRequest).toHaveBeenCalledOnce())
    const input = f.ledger.central.requestSeal(f.send.executionId)!.input
    await f.runtime.pause()
    late.resolve({
      status: 'request_sealed',
      seal: { sealId: randomUUID(), input, requestHash: hashContext(input), sealedAt: Date.now() }
    })
    expect(await work).toMatchObject({ success: false })
    expect(f.ledger.central.requestSeal(f.send.executionId)?.result).toBeUndefined()
    expect(f.ledger.central.requiresReconciliation()).toBe(true)
    expect(f.client.requestSealApplied).not.toHaveBeenCalled()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('serializes double clicks, blocks startup and does not read a client or inspect an echo', async () => {
    const f = requestSealFixture(false),
      late = deferred<Awaited<ReturnType<typeof f.client.sealExecutionRequest>>>()
    f.client.sealExecutionRequest.mockReturnValueOnce(late.promise)
    const work = f.runtime.workbenchReconcile(f.input)
    await vi.waitFor(() => expect(f.client.sealExecutionRequest).toHaveBeenCalledOnce())
    expect(await f.runtime.workbenchReconcile(f.input)).toEqual({
      success: false,
      code: 'execution_pending'
    })
    expect((await f.runtime.start()).state).toBe('paused')
    const input = f.ledger.central.requestSeal(f.send.executionId)!.input
    late.resolve({
      status: 'request_sealed',
      seal: { sealId: randomUUID(), input, requestHash: hashContext(input), sealedAt: Date.now() }
    })
    expect(await work).toMatchObject({
      success: true,
      status: 'request_sealed',
      applicationAcknowledged: true
    })
    expect(f.client.sealExecutionRequest).toHaveBeenCalledOnce()
    expect(f.platform.binding).not.toHaveBeenCalled()
    expect(f.platform.inspectExecution).not.toHaveBeenCalled()
    expect(f.platform.observe).not.toHaveBeenCalled()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
    expect(f.client.issueExecution).not.toHaveBeenCalled()
    expect(f.client.acquireLease).not.toHaveBeenCalled()
  })
  it('pauses on local application failure without acknowledging or hiding any customer message', async () => {
    const f = requestSealFixture(false)
    vi.spyOn(f.ledger.central, 'applyRequestSeal').mockImplementationOnce(() => {
      throw new Error('synthetic_storage_failure')
    })
    expect(await f.runtime.workbenchReconcile(f.input)).toMatchObject({ success: false })
    expect(f.runtime.status()).toMatchObject({
      state: 'paused',
      reason: 'local_storage_unavailable'
    })
    expect(f.ledger.central.requestSeal(f.send.executionId)?.result).toBeUndefined()
    expect(
      f.ledger
        .snapshot(f.identity, f.task.conversationId)
        .messages.every((m) => m.handledBy === null)
    ).toBe(true)
    expect(f.ledger.central.requiresReconciliation()).toBe(true)
    expect(f.client.requestSealApplied).not.toHaveBeenCalled()
  })
  it('keeps a returned original permit unresolved and never treats lookup as authority to send', async () => {
    const f = requestSealFixture(false)
    f.client.sealExecutionRequest.mockImplementationOnce(async (input) => ({
      status: 'existing_permit',
      permit: {
        permitId: 'original-permit',
        identity: f.identity,
        taskId: f.task.taskId,
        conversationId: f.task.conversationId,
        taskHash: input.request.taskHash,
        draftHash: input.request.draftHash,
        draftRevision: input.request.draftRevision,
        leaseVersion: 1,
        issuedAt: Date.now() - 4000,
        expiresAt: Date.now() - 1000,
        status: 'issued',
        newlyIssued: false
      }
    }))
    expect(await f.runtime.workbenchReconcile(f.input)).toMatchObject({
      success: false,
      code: 'unavailable'
    })
    expect(f.ledger.central.get(f.send.executionId)).toMatchObject({
      phase: 'unresolved',
      permit: { permitId: 'original-permit', newlyIssued: false }
    })
    expect(f.ledger.central.requiresReconciliation()).toBe(true)
    expect(f.client.requestSealApplied).not.toHaveBeenCalled()
    expect(f.client.reconciliationChallenge).not.toHaveBeenCalled()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
})

describe('main-owned reconciliation evidence coordinator', () => {
  function approve(f: ReturnType<typeof reconciliationFixture>) {
    f.client.reconciliationDecision.mockImplementation(async (report) => ({
      decisionId: randomUUID(),
      caseId: report.caseId,
      snapshotHash: report.snapshotHash,
      reportHash: hashContext(report),
      noteId: randomUUID(),
      outcome: report.observation.status,
      decidedBy: 'admin-A',
      decidedAt: Date.now()
    }))
  }
  it('applies reviewed local state before remote acknowledgment and stays paused without issuing another send', async () => {
    const f = reconciliationFixture()
    approve(f)
    f.client.reconciliationApplied.mockImplementation(async (_report, decision) => {
      expect(f.ledger.central.reconciliationDecision(f.send.executionId)).toEqual(decision)
      expect(f.ledger.getSend(f.send.executionId)?.status).toBe('cancelled')
      expect(f.ledger.central.requiresReconciliation()).toBe(true)
      return {
        decisionId: decision.decisionId,
        decisionHash: hashContext(decision),
        status: 'resolution_applied'
      }
    })
    expect(await f.runtime.workbenchReconcile(f.input)).toMatchObject({
      success: true,
      resolution: 'not_sent',
      applicationAcknowledged: true
    })
    expect(f.ledger.central.requiresReconciliation()).toBe(false)
    expect(f.ledger.snapshot(f.identity, f.conversation.conversationId)).toMatchObject({
      humanOwned: true,
      messages: [{ handledBy: f.send.executionId }]
    })
    expect(f.ledger.central.get(f.send.executionId)?.receipt?.status).toBe('unknown')
    expect(f.runtime.status().state).toBe('paused')
    expect(f.client.issueExecution).not.toHaveBeenCalled()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('retains a lost applied acknowledgment and retries only its exact payload during synchronization', async () => {
    const f = reconciliationFixture()
    approve(f)
    f.client.reconciliationApplied.mockRejectedValueOnce(new Error('synthetic_lost_applied_ack'))
    expect(await f.runtime.workbenchReconcile(f.input)).toMatchObject({
      success: true,
      applicationAcknowledged: false
    })
    expect(f.ledger.central.requiresReconciliation()).toBe(true)
    const first = f.client.reconciliationApplied.mock.calls[0].slice(0, 2)
    f.client.settleExecution.mockImplementation(async () => ({ status: 'unknown' }))
    expect((await f.runtime.synchronize()).state).toBe('paused')
    expect(f.client.reconciliationApplied.mock.calls[1].slice(0, 2)).toEqual(first)
    expect(f.ledger.central.requiresReconciliation()).toBe(false)
    expect(f.inspect).toHaveBeenCalledOnce()
    expect(f.platform.binding).not.toHaveBeenCalled()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('discards a cancelled late final decision before changing local outcome', async () => {
    const f = reconciliationFixture(),
      late = deferred<Awaited<ReturnType<typeof f.client.reconciliationDecision>>>()
    f.client.reconciliationDecision.mockReturnValueOnce(late.promise)
    const pending = f.runtime.workbenchReconcile(f.input)
    await vi.waitFor(() => expect(f.client.reconciliationDecision).toHaveBeenCalledOnce())
    const report = f.ledger.central.reconciliationReport(f.send.executionId)!
    await f.runtime.pause()
    late.resolve({
      decisionId: randomUUID(),
      caseId: report.caseId,
      snapshotHash: report.snapshotHash,
      reportHash: hashContext(report),
      noteId: randomUUID(),
      outcome: 'not_sent',
      decidedBy: 'admin-A',
      decidedAt: Date.now()
    })
    expect((await pending).success).toBe(false)
    expect(f.ledger.central.reconciliationDecision(f.send.executionId)).toBeUndefined()
    expect(f.client.reconciliationApplied).not.toHaveBeenCalled()
    expect(f.ledger.getSend(f.send.executionId)?.status).toBe('unknown')
  })
  it('keeps local storage failure blocked and never acknowledges a decision that did not persist', async () => {
    const f = reconciliationFixture()
    approve(f)
    const fault = vi.spyOn(f.ledger.central, 'applyReconciliation').mockImplementation(() => {
      throw new Error('synthetic_local_failure')
    })
    try {
      expect((await f.runtime.workbenchReconcile(f.input)).success).toBe(false)
      expect(f.runtime.status()).toMatchObject({
        state: 'paused',
        reason: 'local_storage_unavailable'
      })
      expect(f.client.reconciliationApplied).not.toHaveBeenCalled()
      expect(f.ledger.central.requiresReconciliation()).toBe(true)
    } finally {
      fault.mockRestore()
    }
  })
  it('pauses, records proof before transport, preserves unknown receipt and never dispatches or releases', async () => {
    const f = reconciliationFixture()
    expect(await f.runtime.workbenchReconcile(f.input)).toMatchObject({
      success: true,
      caseId: f.challenge.caseId,
      status: 'evidence_recorded'
    })
    const saved = f.ledger.central.reconciliationReport(f.send.executionId)!
    expect(saved.stopped).toMatchObject({
      observerStopped: true,
      senderQuiescent: true,
      leaseStopped: true
    })
    expect(f.client.reportReconciliation).toHaveBeenCalledWith(saved, expect.any(AbortSignal))
    expect(f.ledger.getSend(f.send.executionId)?.status).toBe('unknown')
    expect(f.ledger.central.get(f.send.executionId)?.receipt?.status).toBe('unknown')
    expect(f.ledger.central.requiresReconciliation()).toBe(true)
    expect(
      f.ledger.snapshot(f.identity, f.conversation.conversationId).messages[0].handledBy
    ).toBeNull()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
    expect(f.client.issueExecution).not.toHaveBeenCalled()
    expect(f.runtime.status()).toMatchObject({ state: 'paused', pauseAcknowledged: true })
  })
  it('retries the identical durable report after a lost network response without inspecting again', async () => {
    const f = reconciliationFixture()
    f.client.reportReconciliation.mockRejectedValueOnce(new Error('synthetic_lost_ack'))
    expect(await f.runtime.workbenchReconcile(f.input)).toMatchObject({ success: false })
    const saved = f.ledger.central.reconciliationReport(f.send.executionId)!
    expect(await f.runtime.workbenchReconcile(f.input)).toMatchObject({
      success: true,
      reportHash: hashContext(saved)
    })
    expect(f.inspect).toHaveBeenCalledTimes(1)
    expect(f.client.reportReconciliation.mock.calls[1][0]).toEqual(
      f.client.reportReconciliation.mock.calls[0][0]
    )
  })
  it('rejects renderer proof injection, stale records, missing native evidence and unknown observations', async () => {
    const f = reconciliationFixture()
    expect(
      await f.runtime.workbenchReconcile({ ...f.input, receipt: { status: 'confirmed' } })
    ).toMatchObject({ success: false, code: 'invalid_input' })
    expect(
      await f.runtime.workbenchReconcile({ ...f.input, expectedVersion: 'f'.repeat(64) })
    ).toMatchObject({ success: false, code: 'task_changed' })
    f.inspect.mockResolvedValueOnce({ status: 'unknown' })
    expect(await f.runtime.workbenchReconcile(f.input)).toMatchObject({
      success: false,
      code: 'unavailable'
    })
    f.platform.inspectExecution = undefined
    expect(await f.runtime.workbenchReconcile(f.input)).toMatchObject({
      success: false,
      code: 'unavailable'
    })
    expect(f.client.reportReconciliation).not.toHaveBeenCalled()
    expect(f.ledger.central.reconciliationReport(f.send.executionId)).toBeUndefined()
  })
  it('waits for actual observer shutdown and rejects concurrency, restarts and late proof after cancellation', async () => {
    const f = reconciliationFixture(),
      late = deferred<Awaited<ReturnType<NonNullable<RuntimePlatform['inspectExecution']>>>>()
    f.inspect.mockReturnValueOnce(late.promise)
    const pending = f.runtime.workbenchReconcile(f.input)
    await vi.waitFor(() => expect(f.inspect).toHaveBeenCalledTimes(1))
    expect(await f.runtime.workbenchReconcile(f.input)).toMatchObject({
      success: false,
      code: 'execution_pending'
    })
    expect((await f.runtime.start()).state).toBe('paused')
    expect(f.platform.binding).not.toHaveBeenCalled()
    await f.runtime.pause()
    late.resolve({ status: 'unknown' })
    expect((await pending).success).toBe(false)
    expect(f.client.reportReconciliation).not.toHaveBeenCalled()
    expect(f.ledger.central.reconciliationReport(f.send.executionId)).toBeUndefined()
  })
  it('does not mistake a stop timeout for physical quiescence', async () => {
    vi.useFakeTimers()
    const f = reconciliationFixture(),
      stop = deferred<void>()
    vi.mocked(f.platform.stop).mockReturnValueOnce(stop.promise)
    const pending = f.runtime.workbenchReconcile(f.input)
    await vi.advanceTimersByTimeAsync(1100)
    expect(await pending).toMatchObject({ success: false, code: 'execution_pending' })
    expect(f.runtime.status().pauseAcknowledged).toBe(false)
    expect(f.inspect).not.toHaveBeenCalled()
    stop.resolve()
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
  })
  it('rejects an old echo already present before original dispatch', async () => {
    const f = reconciliationFixture()
    f.inspect.mockImplementation(async (input) => ({
      executionId: input.executionId,
      identity: f.identity,
      conversationId: f.conversation.conversationId,
      permitId: 'permit-A',
      taskHash: f.challenge.permit.taskHash,
      draftHash: f.challenge.permit.draftHash,
      draftRevision: f.challenge.permit.draftRevision,
      leaseVersion: 1,
      observedAt: Date.now(),
      verificationProofHash: hashContext('synthetic-old-echo'),
      status: 'confirmed',
      sourceMessageId: f.message.sourceMessageId
    }))
    expect(await f.runtime.workbenchReconcile(f.input)).toMatchObject({ success: false })
    expect(f.client.reportReconciliation).not.toHaveBeenCalled()
    expect(f.ledger.central.reconciliationReport(f.send.executionId)).toBeUndefined()
    expect(f.ledger.getSend(f.send.executionId)?.status).toBe('unknown')
  })
})
describe('new main-process agent lifetime', () => {
  async function editable() {
    const f = fixture()
    f.f.draft.evidenceIds = ['synthetic-approved-source']
    await f.runtime.start()
    f.ledger.observe(f.message)
    const snapshot = f.ledger.snapshot(f.identity, f.conversation.conversationId)
    const task = {
      ...f.f.task,
      contextHash: hashConversationContext(snapshot),
      conversationRevision: snapshot.revision,
      inboundRange: { from: 1, to: 1 }
    }
    f.ledger.replies.begin(task, ['合成问题'], Date.now())
    f.ledger.replies.update(
      f.identity,
      task.taskId,
      { status: 'needs_human', draft: f.f.draft },
      Date.now()
    )
    const row = f.runtime.workbench().rows[0]
    await f.runtime.workbenchAction({
      taskId: row.taskId,
      expectedVersion: row.version,
      action: 'takeover'
    })
    const taken = f.runtime.workbench().rows[0]
    const response = (request: EditedReviewInput) => ({
      task: request.generation.task,
      status: 'candidate' as const,
      automaticAllowed: false,
      factsVerified: true,
      reasons: [],
      intents: ['faq' as const],
      usage: { input_tokens: 20, output_tokens: 10 },
      draft: {
        taskId: request.generation.task.taskId,
        draftHash: hashDraft(request.edit.text),
        draftRevision: request.edit.draftRevision,
        text: request.edit.text,
        evidenceIds: request.edit.evidenceIds,
        action: 'reply' as const
      },
      review: {
        ...f.f.review,
        reviewId: 'fresh-edited-audit',
        taskId: request.generation.task.taskId,
        contextHash: request.generation.task.contextHash,
        draftHash: hashDraft(request.edit.text),
        draftRevision: request.edit.draftRevision,
        reviewedAt: Date.now(),
        expiresAt: Date.now() + 5000
      }
    })
    f.client.reviewEdited.mockImplementation(async (request) => response(request))
    return { ...f, taken, response }
  }
  async function inspectable() {
    const f = await editable(),
      record = f.ledger.replies.get(f.identity, f.taken.taskId)!
    f.ledger.replies.update(
      f.identity,
      record.task.taskId,
      { status: record.status, assessmentComplete: true },
      Date.now()
    )
    f.client.assessmentEvidence.mockImplementation(async (task, draft, offset) => ({
      taskId: task.taskId,
      contextHash: task.contextHash,
      knowledgeVersion: task.knowledgeVersion,
      draftHash: draft.draftHash,
      draftRevision: draft.draftRevision,
      offset,
      assessedAt: 15000,
      totalAvailable: 1,
      unavailableReferences: 0,
      evidence: [
        {
          evidenceId: 'synthetic-approved-source',
          intent: 'faq',
          kind: 'approved_faq',
          source: '合成来源',
          content: '完整合成正文',
          validFrom: 10000,
          expiresAt: 20000
        }
      ]
    }))
    return { ...f, row: f.runtime.workbench().rows[0] }
  }
  it('permits bounded read-only reference inspection while paused, without changing ownership or dispatching', async () => {
    const f = await inspectable()
    await f.runtime.pause()
    const row = f.runtime.workbench().rows[0]
    expect(row.canReadEvidence).toBe(true)
    const request = { taskId: row.taskId, expectedVersion: row.version, offset: 0 }
    expect(await f.runtime.workbenchEvidence(request)).toMatchObject({
      success: true,
      page: { evidence: [{ content: '完整合成正文' }] }
    })
    expect(f.runtime.workbench().rows[0].version).toBe(row.version)
    expect(f.runtime.workbench().rows[0].humanOwned).toBe(true)
    expect(f.platform.dispatch).not.toHaveBeenCalled()
    expect(f.client.generateCandidate).not.toHaveBeenCalled()
    expect(f.client.reviewEdited).not.toHaveBeenCalled()
    expect(f.client.issueHumanExecution).not.toHaveBeenCalled()
    expect(await f.runtime.workbenchEvidence({ ...request, text: 'forged' })).toEqual({
      success: false,
      code: 'invalid_input'
    })
    expect(
      await f.runtime.workbenchEvidence({ ...request, expectedVersion: 'f'.repeat(64) })
    ).toEqual({ success: false, code: 'task_changed' })
    expect(f.client.assessmentEvidence).toHaveBeenCalledOnce()
  })
  it('does not surface a late reference after a new inbound message or device removal', async () => {
    const f = await inspectable(),
      gate = deferred<Awaited<ReturnType<typeof f.client.assessmentEvidence>>>()
    const record = f.ledger.replies.get(f.identity, f.row.taskId)!
    const page = await f.client.assessmentEvidence(record.task, record.draft!, 0)
    f.client.assessmentEvidence.mockImplementation(async () => gate.promise)
    const pending = f.runtime.workbenchEvidence({
      taskId: f.row.taskId,
      expectedVersion: f.row.version,
      offset: 0
    })
    f.ledger.observe({ ...f.message, sourceMessageId: 'new-reference-boundary' })
    gate.resolve(page)
    expect(await pending).toEqual({ success: false, code: 'task_changed' })
    f.register(false)
    expect(
      await f.runtime.workbenchEvidence({
        taskId: f.row.taskId,
        expectedVersion: f.row.version,
        offset: 0
      })
    ).toEqual({ success: false, code: 'unavailable' })
  })
  it('bounds concurrent reads and rejects a response with uncited content', async () => {
    const f = await inspectable(),
      gate = deferred<Awaited<ReturnType<typeof f.client.assessmentEvidence>>>()
    const record = f.ledger.replies.get(f.identity, f.row.taskId)!
    const page = await f.client.assessmentEvidence(record.task, record.draft!, 0)
    f.client.assessmentEvidence.mockImplementation(async () => gate.promise)
    const request = { taskId: f.row.taskId, expectedVersion: f.row.version, offset: 0 }
    const a = f.runtime.workbenchEvidence(request),
      b = f.runtime.workbenchEvidence(request)
    expect(await f.runtime.workbenchEvidence(request)).toEqual({
      success: false,
      code: 'unavailable'
    })
    gate.resolve({ ...page, evidence: [{ ...page.evidence[0], evidenceId: 'another-source' }] })
    expect(await a).toEqual({ success: false, code: 'unavailable' })
    expect(await b).toEqual({ success: false, code: 'unavailable' })
    f.client.assessmentEvidence.mockResolvedValue(page)
    expect(await f.runtime.workbenchEvidence(request)).toMatchObject({ success: true })
  })
  it('creates a fresh edited revision from trusted observation, keeps takeover and never dispatches it', async () => {
    const f = await editable()
    expect(f.taken.canReview).toBe(true)
    const result = WorkbenchResultSchema.parse(
      await f.runtime.workbenchReviewEdited({
        taskId: f.taken.taskId,
        expectedVersion: f.taken.version,
        text: ' 员工修改的内容 '
      })
    )
    expect(result.success).toBe(true)
    const request = f.client.reviewEdited.mock.calls[0][0]
    expect(request.generation.task.taskId).not.toBe(f.taken.taskId)
    expect(request.generation.task.expiresAt - request.generation.task.createdAt).toBe(60000)
    expect(request.generation.context[0].text).toBe(f.message.text)
    expect(request.edit).toMatchObject({
      text: ' 员工修改的内容 ',
      draftRevision: 2,
      evidenceIds: f.f.draft.evidenceIds
    })
    expect(f.ledger.replies.get(f.identity, f.taken.taskId)?.status).toBe('obsolete')
    const row = f.runtime.workbench().rows.find((r) => r.taskId === request.generation.task.taskId)!
    expect(row).toMatchObject({
      status: 'needs_human',
      humanOwned: true,
      replyText: ' 员工修改的内容 ',
      reviewStatus: 'passed'
    })
    expect(f.client.issueExecution).not.toHaveBeenCalled()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
    expect(f.client.generateCandidate).not.toHaveBeenCalled()
  })
  it('keeps the runtime available when preparing an edited memory snapshot fails remotely', async () => {
    const f = await editable()
    f.client.prepareGeneration = async () => {
      throw new Error('synthetic_private_transport_failure')
    }
    const result = await f.runtime.workbenchReviewEdited({
      taskId: f.taken.taskId,
      expectedVersion: f.taken.version,
      text: '员工修订'
    })
    expect(result).toEqual({ success: false, code: 'task_changed' })
    expect(f.runtime.status().state).toBe('running')
    expect(f.ledger.replies.get(f.identity, f.taken.taskId)?.status).toBe('needs_human')
    expect(f.client.reviewEdited).not.toHaveBeenCalled()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('rejects authority changes in a prepared edit without creating a ledger row or pausing for a storage error', async () => {
    const f = await editable()
    f.client.prepareGeneration = async (request) => ({
      ...request.task,
      identity: { ...request.task.identity, accountId: 'other-account' },
      memoryCorpusVersion: 'empty-enterprise-memory-v1',
      memorySnapshotHash: '1'.repeat(64),
      learningContextVersion: '2'.repeat(64)
    })
    const before = f.runtime.workbench().rows.length
    expect(
      await f.runtime.workbenchReviewEdited({
        taskId: f.taken.taskId,
        expectedVersion: f.taken.version,
        text: '员工修订'
      })
    ).toEqual({ success: false, code: 'task_changed' })
    expect(f.runtime.workbench().rows).toHaveLength(before)
    expect(f.runtime.status().state).toBe('running')
    expect(f.client.reviewEdited).not.toHaveBeenCalled()
  })
  it('never trusts renderer text, approvals or an old row when confirming a send', async () => {
    const f = await editable()
    await f.runtime.workbenchReviewEdited({
      taskId: f.taken.taskId,
      expectedVersion: f.taken.version,
      text: '员工回复'
    })
    const row = f.runtime.workbench().rows.find((r) => r.replyText === '员工回复')!
    expect(row.canConfirm).toBe(true)
    expect(
      await f.runtime.workbenchConfirmSend({
        taskId: row.taskId,
        expectedVersion: row.version,
        text: '替换内容',
        automaticAllowed: true
      })
    ).toEqual({ success: false, code: 'invalid_input' })
    f.emit({ ...f.message, sourceMessageId: 'new-before-confirm' })
    expect(
      await f.runtime.workbenchConfirmSend({ taskId: row.taskId, expectedVersion: row.version })
    ).toEqual({ success: false, code: 'task_changed' })
    expect(f.client.issueHumanExecution).not.toHaveBeenCalled()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('does not dispatch or replay a human permit response arriving after pause', async () => {
    const f = await editable()
    await f.runtime.workbenchReviewEdited({
      taskId: f.taken.taskId,
      expectedVersion: f.taken.version,
      text: '员工回复'
    })
    const row = f.runtime.workbench().rows.find((r) => r.replyText === '员工回复')!
    const gate = deferred<import('../../src/shared/contracts/execution').ExecutionPermit>()
    f.client.issueHumanExecution.mockReturnValueOnce(gate.promise)
    const sending = f.runtime.workbenchConfirmSend({
      taskId: row.taskId,
      expectedVersion: row.version
    })
    await vi.waitFor(() => expect(f.client.issueHumanExecution).toHaveBeenCalledOnce())
    const [task, draft, confirmation, , signal] = f.client.issueHumanExecution.mock.calls[0]
    await f.runtime.pause()
    expect(signal?.aborted).toBe(true)
    gate.resolve({
      permitId: 'late-human',
      identity: task.identity,
      taskId: task.taskId,
      conversationId: task.conversationId,
      taskHash: confirmation.taskHash,
      draftHash: draft.draftHash,
      draftRevision: draft.draftRevision,
      leaseVersion: 1,
      issuedAt: 100000,
      expiresAt: 105000,
      status: 'issued',
      newlyIssued: true,
      purpose: 'human',
      confirmationId: confirmation.confirmationId
    })
    await sending
    expect(f.platform.dispatch).not.toHaveBeenCalled()
    expect(f.runtime.workbench().rows.some((r) => r.canConfirm)).toBe(false)
    expect((await f.runtime.start()).reason).toBe('execution_reconciliation_required')
  })
  it('rejects forged edit authority fields, stale versions and duplicate clicks before another audit', async () => {
    const f = await editable()
    const input = { taskId: f.taken.taskId, expectedVersion: f.taken.version, text: '修改' }
    expect(
      await f.runtime.workbenchReviewEdited({ ...input, identity: f.identity, draftRevision: 99 })
    ).toEqual({ success: false, code: 'invalid_input' })
    expect(
      await f.runtime.workbenchReviewEdited({ ...input, expectedVersion: 'b'.repeat(64) })
    ).toEqual({ success: false, code: 'task_changed' })
    expect(f.client.reviewEdited).not.toHaveBeenCalled()
    const gate = deferred<ReturnType<typeof f.response>>()
    f.client.reviewEdited.mockReturnValueOnce(gate.promise)
    const pending = f.runtime.workbenchReviewEdited(input)
    await vi.waitFor(() => expect(f.client.reviewEdited).toHaveBeenCalledOnce())
    expect(await f.runtime.workbenchReviewEdited(input)).toEqual({
      success: false,
      code: 'task_changed'
    })
    const request = f.client.reviewEdited.mock.calls[0][0]
    gate.resolve(f.response(request))
    expect(await pending).toMatchObject({ success: true })
    expect(f.client.reviewEdited).toHaveBeenCalledOnce()
  })
  it.each(['inbound', 'pause', 'release'] as const)(
    'invalidates a late edited audit after %s',
    async (change) => {
      const f = await editable()
      const gate = deferred<ReturnType<typeof f.response>>()
      f.client.reviewEdited.mockReturnValueOnce(gate.promise)
      const pending = f.runtime.workbenchReviewEdited({
        taskId: f.taken.taskId,
        expectedVersion: f.taken.version,
        text: '修改'
      })
      await vi.waitFor(() => expect(f.client.reviewEdited).toHaveBeenCalledOnce())
      const [request, signal] = f.client.reviewEdited.mock.calls[0]
      if (change === 'inbound') f.emit({ ...f.message, sourceMessageId: 'later-input' })
      if (change === 'pause') await f.runtime.pause()
      if (change === 'release') {
        const row = f.runtime
          .workbench()
          .rows.find((r) => r.taskId === request.generation.task.taskId)!
        await f.runtime.workbenchAction({
          taskId: row.taskId,
          expectedVersion: row.version,
          action: 'release'
        })
      }
      expect(signal?.aborted).toBe(true)
      expect(await pending).toEqual({ success: false, code: 'review_unavailable' })
      gate.resolve(f.response(request))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(f.ledger.replies.get(f.identity, request.generation.task.taskId)).toMatchObject({
        status: 'obsolete'
      })
      expect(
        f.ledger.replies.get(f.identity, request.generation.task.taskId)?.review
      ).toBeUndefined()
      expect(f.platform.dispatch).not.toHaveBeenCalled()
    }
  )
  it('retains an unreviewed edit after failure and allows only an explicit fresh assessment', async () => {
    const f = await editable()
    f.client.reviewEdited.mockRejectedValueOnce(new Error('synthetic_private_provider_failure'))
    expect(
      await f.runtime.workbenchReviewEdited({
        taskId: f.taken.taskId,
        expectedVersion: f.taken.version,
        text: '保留修改的内容'
      })
    ).toEqual({ success: false, code: 'review_unavailable' })
    const first = f.client.reviewEdited.mock.calls[0][0]
    const row = f.runtime.workbench().rows.find((r) => r.taskId === first.generation.task.taskId)!
    expect(row).toMatchObject({
      status: 'obsolete',
      replyText: '保留修改的内容',
      humanOwned: true,
      canReview: true
    })
    expect(
      await f.runtime.workbenchReviewEdited({
        taskId: row.taskId,
        expectedVersion: row.version,
        text: row.replyText
      })
    ).toMatchObject({ success: true })
    const fresh = f.client.reviewEdited.mock.calls[1][0]
    expect(fresh.generation.task.taskId).not.toBe(first.generation.task.taskId)
    expect(fresh.edit.draftRevision).toBe(3)
    expect(f.platform.dispatch).not.toHaveBeenCalled()
    expect(f.client.issueExecution).not.toHaveBeenCalled()
  })
  it('distinguishes a live dispatch from an unknown outcome and disables skip/release for both', () => {
    const f = fixture(false)
    f.ledger.replies.begin(f.f.task, ['合成问题'], Date.now())
    const send = f.ledger.prepare(f.f.task, f.f.draft.draftHash, Date.now())
    f.ledger.transition(send.record.executionId, 'prepared', 'dispatching', Date.now())
    expect(f.runtime.workbench().rows[0]).toMatchObject({
      status: 'sending',
      canSkip: false,
      canRelease: false
    })
    f.ledger.transition(send.record.executionId, 'dispatching', 'unknown', Date.now())
    expect(f.runtime.workbench().rows[0]).toMatchObject({
      status: 'unknown',
      canSkip: false,
      canRelease: false
    })
  })
  it('lists only the registered employee records without probing a chat client or invoking a model', async () => {
    const f = fixture(false)
    f.ledger.replies.begin(f.f.task, ['合成问题'], Date.now())
    const history = vi.spyOn(f.ledger, 'snapshot')
    f.ledger.replies.begin(
      { ...f.f.task, taskId: 'other-task', identity: { ...f.identity, agentId: 'other-device' } },
      ['别的设备记录'],
      Date.now()
    )
    expect(WorkbenchSnapshotSchema.parse(f.runtime.workbench())).toMatchObject({
      state: 'available',
      rows: [{ taskId: f.f.task.taskId }]
    })
    expect(f.runtime.workbench().rows).toHaveLength(1)
    expect(history).not.toHaveBeenCalled()
    expect(f.platform.binding).not.toHaveBeenCalled()
    expect(f.client.configuration).not.toHaveBeenCalled()
    expect(f.client.generateCandidate).not.toHaveBeenCalled()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
    f.register(false)
    expect(f.runtime.workbench()).toEqual({ state: 'not_registered', rows: [] })
    expect(
      await f.runtime.workbenchAction({
        taskId: 'other-task',
        action: 'takeover',
        expectedVersion: 'a'.repeat(64)
      })
    ).toEqual({ success: false, code: 'unavailable' })
  })
  it('returns no records and stops automation when the catalogue cannot be read', async () => {
    const f = fixture()
    await f.runtime.start()
    const fault = vi.spyOn(f.ledger.replies, 'list').mockImplementation(() => {
      throw new Error('synthetic_private_corruption')
    })
    try {
      expect(WorkbenchSnapshotSchema.parse(f.runtime.workbench())).toEqual({
        state: 'unavailable',
        rows: []
      })
      await vi.waitFor(() =>
        expect(f.runtime.status()).toMatchObject({
          state: 'paused',
          reason: 'local_storage_unavailable'
        })
      )
      expect(f.platform.dispatch).not.toHaveBeenCalled()
    } finally {
      fault.mockRestore()
    }
  })
  it('takes over and releases only a bound conversation, does not restart paused automation, and rejects stale UI commands', async () => {
    const f = fixture()
    await f.runtime.start()
    // Direct fixture insertion avoids running any model/physical chat action.
    f.ledger.replies.begin(f.f.task, ['合成问题'], Date.now())
    const row = f.runtime.workbench().rows[0]
    expect(
      await f.runtime.workbenchAction({
        taskId: row.taskId,
        expectedVersion: row.version,
        action: 'takeover',
        identity: f.identity
      })
    ).toEqual({ success: false, code: 'invalid_input' })
    const result = WorkbenchResultSchema.parse(
      await f.runtime.workbenchAction({
        taskId: row.taskId,
        expectedVersion: row.version,
        action: 'takeover'
      })
    )
    expect(result).toMatchObject({
      success: true,
      stopAcknowledged: true,
      snapshot: { rows: [{ humanOwned: true, canRelease: true }] }
    })
    expect(
      await f.runtime.workbenchAction({
        taskId: row.taskId,
        expectedVersion: row.version,
        action: 'release'
      })
    ).toEqual({ success: false, code: 'task_changed' })
    await f.runtime.pause()
    const fresh = f.runtime.workbench().rows[0]
    expect(
      await f.runtime.workbenchAction({
        taskId: fresh.taskId,
        expectedVersion: fresh.version,
        action: 'release'
      })
    ).toMatchObject({ success: true })
    expect(f.runtime.status().state).toBe('paused')
    expect(f.client.generateCandidate).not.toHaveBeenCalled()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('skips the exact current pending range and leaves subsequent messages pending', async () => {
    const f = fixture()
    await f.runtime.start()
    f.ledger.observe(f.message)
    const snapshot = f.ledger.snapshot(f.identity, f.conversation.conversationId)
    const task = {
      ...f.f.task,
      conversationRevision: snapshot.revision,
      contextHash: hashConversationContext(snapshot),
      inboundRange: { from: 1, to: 1 }
    }
    f.ledger.replies.begin(task, ['合成问题'], Date.now())
    const row = f.runtime.workbench().rows[0]
    expect(row.canSkip).toBe(true)
    expect(
      await f.runtime.workbenchAction({
        taskId: row.taskId,
        expectedVersion: row.version,
        action: 'skip'
      })
    ).toMatchObject({ success: true })
    f.ledger.observe({ ...f.message, sourceMessageId: 'later' })
    expect(
      f.ledger.snapshot(f.identity, f.conversation.conversationId).messages.map((m) => m.handledBy)
    ).toEqual([`skip:${task.taskId}`, null])
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('refuses a skipped task after new inbound and fails closed when human ownership cannot be persisted', async () => {
    const f = fixture()
    await f.runtime.start()
    f.ledger.observe(f.message)
    const snapshot = f.ledger.snapshot(f.identity, f.conversation.conversationId)
    f.ledger.replies.begin(
      {
        ...f.f.task,
        conversationRevision: snapshot.revision,
        contextHash: hashConversationContext(snapshot),
        inboundRange: { from: 1, to: 1 }
      },
      ['合成'],
      Date.now()
    )
    const row = f.runtime.workbench().rows[0]
    f.ledger.observe({ ...f.message, sourceMessageId: 'newer' })
    expect(
      await f.runtime.workbenchAction({
        taskId: row.taskId,
        expectedVersion: row.version,
        action: 'skip'
      })
    ).toEqual({ success: false, code: 'task_changed' })
    const storage = vi.spyOn(f.ledger, 'setHumanOwned').mockImplementation(() => {
      throw new Error('private_failure')
    })
    try {
      const fresh = f.runtime.workbench().rows[0]
      expect(
        await f.runtime.workbenchAction({
          taskId: fresh.taskId,
          expectedVersion: fresh.version,
          action: 'takeover'
        })
      ).toEqual({ success: false, code: 'storage_unavailable' })
      expect(f.runtime.status()).toMatchObject({
        state: 'paused',
        reason: 'local_storage_unavailable'
      })
      expect(f.platform.dispatch).not.toHaveBeenCalled()
    } finally {
      storage.mockRestore()
    }
  })
  it('constructs without reading clients, making network requests or resuming work', async () => {
    const f = fixture(false)
    expect(RuntimeStatusSchema.parse(f.runtime.status())).toMatchObject({
      state: 'paused',
      lease: 'stopped',
      pauseAcknowledged: true
    })
    expect(f.client.acquireLease).not.toHaveBeenCalled()
    expect(f.client.configuration).not.toHaveBeenCalled()
    expect(f.platform.binding).not.toHaveBeenCalled()
    expect(await f.runtime.start()).toMatchObject({
      state: 'blocked',
      reason: 'capability_unverified'
    })
    expect(f.platform.binding).not.toHaveBeenCalled()
  })
  it('synchronizes metadata while staying paused and keeps secrets out of the status DTO', async () => {
    const f = fixture(false)
    expect(await f.runtime.synchronize()).toMatchObject({
      state: 'paused',
      configurationVersion: f.configuration.configVersion,
      lease: 'stopped'
    })
    expect(f.client.acquireLease).not.toHaveBeenCalled()
    expect(Object.keys(f.runtime.status()).sort()).toEqual([
      'configurationVersion',
      'lease',
      'pauseAcknowledged',
      'readiness',
      'reason',
      'state'
    ])
  })
  it('requires registration and both physical capability gates before probing', async () => {
    const f = fixture()
    f.register(false)
    expect(await f.runtime.start()).toMatchObject({ state: 'blocked', reason: 'not_registered' })
    expect(await f.runtime.synchronize()).toMatchObject({
      state: 'blocked',
      reason: 'not_registered'
    })
    f.register(true)
    vi.mocked(f.platform.capabilities).mockReturnValue({
      backgroundRead: true,
      nonInterferingSend: false
    })
    expect(await f.runtime.start()).toMatchObject({ reason: 'capability_unverified' })
    vi.mocked(f.platform.capabilities).mockReturnValue({
      backgroundRead: false,
      nonInterferingSend: true
    })
    expect(await f.runtime.start()).toMatchObject({ reason: 'capability_unverified' })
    expect(f.platform.binding).not.toHaveBeenCalled()
  })
  it('rejects another account and ambiguous customer bindings before acquiring a lease', async () => {
    const f = fixture()
    vi.mocked(f.platform.binding).mockResolvedValueOnce({
      identity: { ...f.identity, accountId: 'other' },
      conversations: [f.conversation]
    })
    expect(await f.runtime.start()).toMatchObject({
      reason: 'identity_unverified',
      state: 'blocked'
    })
    vi.mocked(f.platform.binding).mockResolvedValueOnce({
      identity: f.identity,
      conversations: [{ ...f.conversation, identityVerified: false }]
    })
    expect(await f.runtime.start()).toMatchObject({ reason: 'identity_unverified' })
    expect(f.client.acquireLease).not.toHaveBeenCalled()
  })
  it('serializes concurrent starts and installs observation before processing pending inbound', async () => {
    const f = fixture(),
      ready = deferred<void>()
    vi.mocked(f.platform.observe).mockImplementationOnce(async (emit) => {
      emit(f.message)
      await ready.promise
    })
    const first = f.runtime.start(),
      second = f.runtime.start()
    expect(first).toBe(second)
    await vi.waitFor(() => expect(f.platform.observe).toHaveBeenCalledOnce())
    expect(f.runtime.status().state).toBe('starting')
    expect(f.ledger.snapshot(f.identity, f.conversation.conversationId).messages).toHaveLength(1)
    expect(f.client.generateCandidate).not.toHaveBeenCalled()
    ready.resolve()
    expect(await first).toMatchObject({ state: 'running', lease: 'active' })
    await f.runtime.pause()
    expect(f.platform.binding).toHaveBeenCalledOnce()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('cancels a late binding after lock and does not resume on its return', async () => {
    const f = fixture(),
      gate = deferred<Awaited<ReturnType<RuntimePlatform['binding']>>>()
    vi.mocked(f.platform.binding).mockReturnValueOnce(gate.promise)
    const started = f.runtime.start()
    await vi.waitFor(() => expect(f.platform.binding).toHaveBeenCalledOnce())
    expect(await f.runtime.pause('locked')).toMatchObject({ state: 'paused', reason: 'locked' })
    expect(await started).toMatchObject({ state: 'paused', reason: 'locked' })
    gate.resolve({ identity: f.identity, conversations: [f.conversation] })
    expect(f.client.acquireLease).not.toHaveBeenCalled()
  })
  it('can start again after cancelling an observer setup that ignores its abort signal', async () => {
    const f = fixture()
    vi.mocked(f.platform.observe).mockReturnValueOnce(new Promise(() => {}))
    const started = f.runtime.start()
    await vi.waitFor(() => expect(f.platform.observe).toHaveBeenCalledOnce())
    await f.runtime.pause('suspended')
    expect(await started).toMatchObject({ state: 'paused', reason: 'suspended' })
    expect(await f.runtime.start()).toMatchObject({ state: 'running', lease: 'active' })
    expect(f.platform.observe).toHaveBeenCalledTimes(2)
  })
  it('external pause wins even during the initial asynchronous stop', async () => {
    const f = fixture(),
      gate = deferred<void>()
    vi.mocked(f.platform.stop).mockReturnValueOnce(gate.promise)
    const starting = f.runtime.start()
    await vi.waitFor(() => expect(f.platform.stop).toHaveBeenCalledOnce())
    const stopping = f.runtime.pause('suspended')
    gate.resolve()
    expect(await starting).toMatchObject({ state: 'paused', reason: 'suspended' })
    await stopping
    expect(f.platform.binding).not.toHaveBeenCalled()
  })
  it('drops old observer callbacks after pause and stops on malformed current observations', async () => {
    const f = fixture()
    await f.runtime.start()
    f.emit({ ...f.message, identity: { ...f.identity, accountId: 'other' } })
    await vi.waitFor(() =>
      expect(f.runtime.status()).toMatchObject({ state: 'paused', reason: 'observer_failed' })
    )
    f.emit()
    expect(f.ledger.snapshot(f.identity, f.conversation.conversationId).messages).toHaveLength(0)
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it('stops on observer failure and configuration failure without automatically restarting', async () => {
    const f = fixture()
    f.client.configuration.mockRejectedValueOnce(new Error('private service details'))
    expect(await f.runtime.start()).toMatchObject({
      state: 'paused',
      reason: 'configuration_unavailable',
      lease: 'stopped'
    })
    await f.runtime.start()
    f.fail()
    await vi.waitFor(() =>
      expect(f.runtime.status()).toMatchObject({ state: 'paused', reason: 'observer_failed' })
    )
    expect(f.client.generateCandidate).not.toHaveBeenCalled()
  })
  it('never acknowledges a platform stop that has not actually settled', async () => {
    const f = fixture(),
      gate = deferred<void>()
    await f.runtime.start()
    vi.mocked(f.platform.stop).mockReturnValueOnce(gate.promise)
    expect(await f.runtime.pause()).toMatchObject({ state: 'pausing', pauseAcknowledged: false })
    gate.resolve()
    await vi.waitFor(() =>
      expect(f.runtime.status()).toMatchObject({ state: 'paused', pauseAcknowledged: true })
    )
    expect(await f.runtime.pause()).toMatchObject({ state: 'paused', pauseAcknowledged: true })
  })
  it('closes the durable ledger only after acknowledgment and cannot restart after close', async () => {
    const f = fixture()
    await f.runtime.start()
    expect(await f.runtime.close()).toMatchObject({
      state: 'closed',
      reason: 'shutdown',
      pauseAcknowledged: true
    })
    expect(await f.runtime.start()).toMatchObject({ state: 'closed' })
    expect(() => f.ledger.nextRunEpoch()).toThrow()
  })
  it('stops observation despite an epoch storage fault and refuses restart while it persists', async () => {
    const f = fixture()
    await f.runtime.start()
    vi.mocked(f.platform.stop).mockClear()
    const storage = vi.spyOn(f.ledger, 'nextRunEpoch').mockImplementation(() => {
      throw new Error('synthetic_private_storage_details')
    })
    try {
      expect(RuntimeStatusSchema.parse(await f.runtime.pause())).toMatchObject({
        state: 'paused',
        reason: 'local_storage_unavailable',
        pauseAcknowledged: true,
        lease: 'stopped'
      })
      expect(f.platform.stop).toHaveBeenCalledOnce()
      f.emit()
      expect(f.ledger.snapshot(f.identity, f.conversation.conversationId).messages).toHaveLength(0)
      vi.mocked(f.platform.binding).mockClear()
      expect(await f.runtime.start()).toMatchObject({ reason: 'local_storage_unavailable' })
      expect(f.platform.binding).not.toHaveBeenCalled()
      expect(f.platform.dispatch).not.toHaveBeenCalled()
      expect(f.client.generateCandidate).not.toHaveBeenCalled()
      expect(JSON.stringify(f.runtime.status())).not.toContain('synthetic_private_storage_details')
    } finally {
      storage.mockRestore()
    }
    expect(await f.runtime.start()).toMatchObject({ state: 'running' })
  })
})

describe('workbench task-bound learning', () => {
  function learningFixture(installed = false) {
    const f = fixture(installed),
      now = Date.now()
    const task = { ...f.f.task, createdAt: now - 1000, expiresAt: now + 10000 }
    f.ledger.replies.begin(task, ['退款咨询'], now)
    f.ledger.replies.update(task.identity, task.taskId, { draft: f.f.draft, status: 'ready' }, now)
    const correction = { sourceId: 'teaching-A', text: '先核对订单状态', reason: '员工明确纠正' }
    const episode = {
      id: 'episode-A',
      sourceId: 'server-learning-event',
      identityStatus: 'verified' as const,
      scope: {
        workspaceId: 'enterprise:test',
        tenantId: task.identity.tenantId,
        accountId: task.identity.accountId,
        platform: task.identity.platform,
        conversationId: task.conversationId
      },
      topic: '退款咨询',
      startedAt: task.createdAt,
      endedAt: now,
      createdAt: now,
      messages: [],
      draft: f.f.draft.text,
      correction: correction.text,
      correctionReason: correction.reason,
      outcome: 'corrected' as const
    }
    f.client.recordLearningCorrection = vi.fn(async () => episode)
    f.client.recordLearningResult = vi.fn(async () => ({
      ...episode,
      outcome: 'resolved' as const
    }))
    f.client.recordLearningFeedback = vi.fn(async () => {})
    const input = {
      taskId: task.taskId,
      expectedVersion: f.runtime.workbench().rows[0].version,
      kind: 'correction' as const,
      input: correction
    }
    return { ...f, task, correction, episode, input }
  }

  it('forgets server authority before clearing matching private outbox bodies and never obtains send authority', async () => {
    const f = learningFixture()
    vi.mocked(f.client.recordLearningCorrection!).mockRejectedValue(new Error('offline'))
    expect(await f.runtime.workbenchLearn(f.input)).toMatchObject({ state: 'pending' })
    const scope = {
      workspaceId: `enterprise:${learningHash({ tenant: f.task.identity.tenantId, account: f.task.identity.accountId })}`,
      tenantId: f.task.identity.tenantId,
      accountId: f.task.identity.accountId,
      platform: f.task.identity.platform,
      conversationId: f.task.conversationId
    }
    f.client.learningForgetScope = vi.fn(async () => {})
    await f.runtime.forgetLearningScope(scope)
    expect(f.client.learningForgetScope).toHaveBeenCalledWith(scope, expect.any(AbortSignal))
    expect(f.ledger.learning.state(f.task.identity, f.correction.sourceId)).toBe('forgotten')
    await expect(
      f.runtime.forgetLearningScope({ ...scope, accountId: 'forged' })
    ).rejects.toBeDefined()
    expect(f.client.learningForgetScope).toHaveBeenCalledOnce()
    expect(f.client.acquireLease).not.toHaveBeenCalled()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })
  it.each(['close', 'deviceChanged'] as const)(
    'joins forgetting cancellation during %s and ignores the late server completion',
    async (operation) => {
      const f = learningFixture(),
        response = deferred<void>()
      vi.mocked(f.client.recordLearningCorrection!).mockRejectedValue(new Error('offline'))
      await f.runtime.workbenchLearn(f.input)
      f.client.learningForgetScope = vi.fn(() => response.promise)
      const scope = {
        workspaceId: `enterprise:${learningHash({ tenant: f.task.identity.tenantId, account: f.task.identity.accountId })}`,
        tenantId: f.task.identity.tenantId,
        accountId: f.task.identity.accountId,
        platform: f.task.identity.platform,
        conversationId: f.task.conversationId
      }
      const result = f.runtime.forgetLearningScope(scope).then(
        () => 'saved',
        () => 'cancelled'
      )
      await vi.waitFor(() => expect(f.client.learningForgetScope).toHaveBeenCalledOnce())
      expect(await f.runtime.workbenchLearn(f.input)).toMatchObject({
        success: false,
        code: 'unavailable'
      })
      expect((await f.runtime[operation]()).pauseAcknowledged).toBe(true)
      expect(await result).toBe('cancelled')
      expect(vi.mocked(f.client.learningForgetScope).mock.calls[0][1]?.aborted).toBe(true)
      response.resolve()
      await Promise.resolve()
      if (operation === 'deviceChanged')
        expect(f.ledger.learning.state(f.task.identity, f.correction.sourceId)).toBe('pending')
      expect(f.client.acquireLease).not.toHaveBeenCalled()
    }
  )
  it('does not restart feedback synchronization after device change cancels a forget request', async () => {
    vi.useFakeTimers()
    const f = learningFixture(),
      response = deferred<void>()
    try {
      vi.mocked(f.client.recordLearningCorrection!).mockRejectedValue(new Error('offline'))
      await f.runtime.workbenchLearn(f.input)
      f.client.learningForgetScope = vi.fn(() => response.promise)
      const scope = {
        workspaceId: `enterprise:${learningHash({ tenant: f.task.identity.tenantId, account: f.task.identity.accountId })}`,
        tenantId: f.task.identity.tenantId,
        accountId: f.task.identity.accountId,
        platform: f.task.identity.platform
      }
      const forgetting = f.runtime.forgetLearningScope(scope).catch(() => {})
      await vi.waitFor(() => expect(f.client.learningForgetScope).toHaveBeenCalledOnce())
      await f.runtime.deviceChanged()
      await forgetting
      await vi.advanceTimersByTimeAsync(10000)
      expect(f.client.recordLearningCorrection).toHaveBeenCalledOnce()
      response.resolve()
    } finally {
      await f.runtime.close()
      vi.useRealTimers()
    }
  })
  it('preserves pending evidence and rejects success if server forgetting fails', async () => {
    const f = learningFixture()
    vi.mocked(f.client.recordLearningCorrection!).mockRejectedValue(new Error('offline'))
    await f.runtime.workbenchLearn(f.input)
    f.client.learningForgetScope = vi.fn(async () => {
      throw new Error('offline')
    })
    const scope = {
      workspaceId: `enterprise:${learningHash({ tenant: f.task.identity.tenantId, account: f.task.identity.accountId })}`,
      tenantId: f.task.identity.tenantId,
      accountId: f.task.identity.accountId,
      platform: f.task.identity.platform
    }
    await expect(f.runtime.forgetLearningScope(scope)).rejects.toThrow('offline')
    expect(f.ledger.learning.state(f.task.identity, f.correction.sourceId)).toBe('pending')
  })
  it('teaches from the actual stored draft while paused without obtaining a lease or sending', async () => {
    const f = learningFixture()
    expect(f.runtime.workbench().rows[0]).toMatchObject({ canLearn: true, learningPending: false })
    expect(await f.runtime.workbenchLearn(f.input)).toMatchObject({
      success: true,
      state: 'saved',
      sourceId: f.correction.sourceId
    })
    expect(f.client.recordLearningCorrection).toHaveBeenCalledWith(
      f.task,
      f.f.draft,
      f.correction,
      expect.any(AbortSignal)
    )
    expect(f.ledger.learning.pending(f.task.identity)).toEqual([])
    expect(f.ledger.findTask(f.task.identity, f.task.taskId)).toBeUndefined()
    expect(f.client.acquireLease).not.toHaveBeenCalled()
    expect(f.client.issueHumanExecution).not.toHaveBeenCalled()
    expect(f.platform.dispatch).not.toHaveBeenCalled()
  })

  it('does not expire pending evidence during display before the current enterprise policy is fetched', () => {
    const f = learningFixture(),
      createdAt = Date.now() - 100 * 86400000
    f.ledger.learning.enqueue({
      task: { ...f.task, createdAt, expiresAt: createdAt + 10000 },
      draft: f.f.draft,
      kind: 'correction',
      input: f.correction,
      at: Date.now()
    })
    f.ledger.learning.setRetention(f.task.identity, f.task.conversationId, 7)
    expect(f.runtime.workbench().rows[0].learningPending).toBe(true)
    expect(f.ledger.learning.state(f.task.identity, f.correction.sourceId)).toBe('pending')
  })
  it('keeps a network failure pending and replays the original event once when connectivity returns', async () => {
    const f = learningFixture(),
      send = vi.mocked(f.client.recordLearningCorrection!)
    send.mockRejectedValueOnce(new Error('offline'))
    expect(await f.runtime.workbenchLearn(f.input)).toMatchObject({
      success: true,
      state: 'pending'
    })
    expect(f.runtime.workbench().rows[0]).toMatchObject({ learningPending: true })
    expect(f.ledger.learning.pending(f.task.identity)).toHaveLength(1)
    await f.runtime.flushLearning()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1].slice(0, 3)).toEqual(send.mock.calls[0].slice(0, 3))
    expect(f.ledger.learning.pending(f.task.identity)).toEqual([])
    expect(await f.runtime.workbenchLearn(f.input)).toMatchObject({ success: true, state: 'saved' })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('rejects stale local versions and renderer identity claims before persisting or submitting', async () => {
    const f = learningFixture()
    expect(
      await f.runtime.workbenchLearn({ ...f.input, expectedVersion: hashContext('stale') })
    ).toMatchObject({ success: false, code: 'task_changed' })
    expect(await f.runtime.workbenchLearn({ ...f.input, scope: f.task.identity })).toMatchObject({
      success: false,
      code: 'invalid_input'
    })
    expect(f.ledger.learning.pending(f.task.identity)).toEqual([])
    expect(f.client.recordLearningCorrection).not.toHaveBeenCalled()
  })

  it('rejects a late response after account removal and retains the event under its original scope', async () => {
    const f = learningFixture(),
      response = deferred<typeof f.episode>()
    vi.mocked(f.client.recordLearningCorrection!).mockReturnValue(response.promise)
    const result = f.runtime.workbenchLearn(f.input)
    await vi.waitFor(() => expect(f.client.recordLearningCorrection).toHaveBeenCalledOnce())
    f.register(false)
    response.resolve(f.episode)
    expect(await result).toMatchObject({ success: false, code: 'unavailable' })
    expect(f.ledger.learning.pending(f.task.identity)).toHaveLength(1)
    expect(f.runtime.workbench()).toMatchObject({ state: 'not_registered', rows: [] })
  })

  it('cancels noncooperating feedback on device change without acknowledging or replaying it for the next scope', async () => {
    const f = learningFixture(),
      response = deferred<typeof f.episode>()
    vi.mocked(f.client.recordLearningCorrection!).mockReturnValue(response.promise)
    const result = f.runtime.workbenchLearn(f.input)
    await vi.waitFor(() => expect(f.client.recordLearningCorrection).toHaveBeenCalledOnce())
    await f.runtime.deviceChanged()
    expect(await result).toMatchObject({ success: false, code: 'unavailable' })
    expect(vi.mocked(f.client.recordLearningCorrection!).mock.calls[0][3]?.aborted).toBe(true)
    response.resolve(f.episode)
    await Promise.resolve()
    expect(f.ledger.learning.pending(f.task.identity)).toHaveLength(1)
  })

  it('records adoption and confirmed outcomes separately from sending', async () => {
    const f = learningFixture()
    expect(
      await f.runtime.workbenchLearn({
        ...f.input,
        kind: 'feedback',
        input: { sourceId: 'adopt-A', kind: 'adopted', reason: '明确采纳' }
      })
    ).toMatchObject({ state: 'saved' })
    expect(
      await f.runtime.workbenchLearn({
        ...f.input,
        kind: 'result',
        input: { sourceId: 'result-A', outcome: 'resolved', reason: '员工确认解决' }
      })
    ).toMatchObject({ state: 'saved' })
    expect(f.client.recordLearningFeedback).toHaveBeenCalledOnce()
    expect(f.client.recordLearningResult).toHaveBeenCalledOnce()
    expect(f.ledger.findTask(f.task.identity, f.task.taskId)).toBeUndefined()
  })
  it('automatically retries pending feedback after reconnection while reply execution remains paused', async () => {
    vi.useFakeTimers()
    const f = learningFixture(),
      send = vi.mocked(f.client.recordLearningCorrection!)
    try {
      send.mockRejectedValueOnce(new Error('offline'))
      expect(await f.runtime.workbenchLearn(f.input)).toMatchObject({ state: 'pending' })
      await vi.advanceTimersByTimeAsync(10000)
      expect(send).toHaveBeenCalledTimes(2)
      expect(f.ledger.learning.pending(f.task.identity)).toEqual([])
      expect(f.runtime.status().state).not.toBe('running')
    } finally {
      await f.runtime.close()
      vi.useRealTimers()
    }
  })
  it('drops an invalidated queued source without blocking later valid feedback', async () => {
    const f = learningFixture(),
      send = vi.mocked(f.client.recordLearningCorrection!)
    send.mockRejectedValueOnce(new Error('offline'))
    expect(await f.runtime.workbenchLearn(f.input)).toMatchObject({ state: 'pending' })
    send.mockRejectedValueOnce(new DeviceRequestError('TASK_INVALIDATED'))
    const next = {
      ...f.input,
      input: { ...f.input.input, sourceId: 'teaching-B', text: '另一个明确教导' }
    }
    expect(await f.runtime.workbenchLearn(next)).toMatchObject({
      success: true,
      state: 'saved',
      sourceId: 'teaching-B'
    })
    expect(f.ledger.learning.state(f.task.identity, f.input.input.sourceId)).toBe('forgotten')
    expect(f.ledger.learning.pending(f.task.identity)).toEqual([])
    expect(send).toHaveBeenCalledTimes(3)
  })
  it.each(['close', 'deviceChanged'] as const)(
    'starts the send pause synchronously before awaiting learning cancellation during %s',
    async (operation) => {
      const f = learningFixture(true),
        response = deferred<typeof f.episode>()
      vi.mocked(f.client.recordLearningCorrection!).mockReturnValue(response.promise)
      const result = f.runtime.workbenchLearn(f.input)
      await vi.waitFor(() => expect(f.client.recordLearningCorrection).toHaveBeenCalledOnce())
      const stopping = f.runtime[operation]()
      try {
        expect(f.runtime.status().state).toBe('pausing')
      } finally {
        await stopping
      }
      expect(await result).toMatchObject({ success: false, code: 'unavailable' })
      response.resolve(f.episode)
    }
  )
  it('joins concurrent shutdown requests so a pending feedback database is closed exactly once', async () => {
    const f = learningFixture(),
      response = deferred<typeof f.episode>()
    vi.mocked(f.client.recordLearningCorrection!).mockReturnValue(response.promise)
    const result = f.runtime.workbenchLearn(f.input)
    await vi.waitFor(() => expect(f.client.recordLearningCorrection).toHaveBeenCalledOnce())
    const statuses = await Promise.all([f.runtime.close(), f.runtime.close()])
    expect(statuses).toEqual([
      expect.objectContaining({ state: 'closed' }),
      expect.objectContaining({ state: 'closed' })
    ])
    expect(await result).toMatchObject({ success: false, code: 'unavailable' })
    response.resolve(f.episode)
  })
  it('shuts down a noncooperating feedback request before closing its database', async () => {
    const f = learningFixture(),
      response = deferred<typeof f.episode>()
    vi.mocked(f.client.recordLearningCorrection!).mockReturnValue(response.promise)
    const result = f.runtime.workbenchLearn(f.input)
    await vi.waitFor(() => expect(f.client.recordLearningCorrection).toHaveBeenCalledOnce())
    expect(await f.runtime.close()).toMatchObject({ state: 'closed' })
    expect(await result).toMatchObject({ success: false, code: 'unavailable' })
    expect(vi.mocked(f.client.recordLearningCorrection!).mock.calls[0][3]?.aborted).toBe(true)
    response.resolve(f.episode)
    await Promise.resolve()
    expect(f.runtime.workbench()).toEqual({ state: 'closed', rows: [] })
  })
})
