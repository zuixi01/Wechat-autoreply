import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { z } from 'zod'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { ExecutionAuthority } from '../../server/src/execution/execution-authority'
import {
  savePublication as persistPublication,
  type Publication
} from '../../server/src/generation/publication'
import { seedSyntheticApproval } from '../fixtures/evaluation-approval'
import { loadPublication, GenerationError } from '../../server/src/generation/publication'
import { GenerationService } from '../../server/src/generation/generation-service'
import { ModelCallAuthority } from '../../server/src/generation/model-call-authority'
import { EnterpriseLearningRepository } from '../../server/src/learning/learning-repository'
import { EnterpriseLearningQueue } from '../../server/src/learning/learning-queue'
import {
  assertEnterpriseLearningTaskCurrent,
  prepareEnterpriseLearningTask,
  enterpriseDraftSource
} from '../../server/src/learning/learning-generation-context'
import {
  loadEnterpriseMemoryCatalog,
  EMPTY_ENTERPRISE_MEMORY_VERSION
} from '../../server/src/learning/learning-publication'
import { TypeSafeClient } from '../../server/src/decision/typesafe-client'
import { HttpTextGenerator } from '../../server/src/generation/text-generator'
import { JevReplyPipeline, type DraftGenerator } from '../../server/src/reply/jev-pipeline'
import type { JevRequest, JevResponse, DecisionProvider } from '../../src/shared/contracts/decision'
import { hashContext } from '../../src/core/reply/hashes'
import { taskFixture } from '../fixtures/task'
import { GenerationResultSchema, type GenerationInput } from '../../src/shared/contracts/generation'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApplication } from '../../server/src/http/application'
import { AgentRegistration } from '../../src/main/services/agent-registration'
import { RemoteReplyService } from '../../src/core/agent/remote-reply-service'
import { ReliableAgent } from '../../src/core/agent/reliable-agent'
import { Ledger } from '../../src/core/persistence/ledger'
import type { SenderResult, VerifiedSendAdapter } from '../../src/core/sending/sender'
import type { LeaseGrant } from '../../src/shared/contracts/lease'
import { CentralSendAdapter } from '../../src/core/sending/central-send-adapter'
import { randomUUID } from 'node:crypto'
import type { HumanPermitRequest } from '../../src/shared/contracts/human-confirmation'
import {
  DesktopAgentRuntime,
  type RuntimePlatform
} from '../../src/main/services/desktop-agent-runtime'
import type { AssessmentEvidenceRequest } from '../../src/shared/contracts/assessment-evidence'

let db: Awaited<ReturnType<typeof embeddedPostgres>>,
  authority: AccountAuthority,
  execution: ExecutionAuthority,
  service: GenerationService
let input: GenerationInput,
  publication: Publication,
  evaluate: Mock<DecisionProvider['evaluate']>,
  generator: DraftGenerator
const token = 'A'.repeat(43)
async function savePublication(
  a: AccountAuthority,
  e: ExecutionAuthority,
  t: string,
  p: Publication
) {
  // Only the test migration identity can seed these synthetic authority records.
  const approved = await seedSyntheticApproval(db, p)
  return persistPublication(a, e, t, approved)
}
function deferred<T>() {
  let resolve!: (v: T) => void
  return {
    promise: new Promise<T>((r) => {
      resolve = r
    }),
    resolve
  }
}
function decision(request: JevRequest): JevResponse {
  const answers: JevResponse['answers'] = {}
  for (const [id, q] of Object.entries(request.questions))
    answers[id] =
      q.type === 'choice'
        ? {
            type: 'choice',
            choice: 'faq',
            confidence: 0.99,
            probabilities: { faq: 1, price: 0, order: 0, aftersales: 0, other: 0 }
          }
        : {
            type: 'noul',
            noul: id === 'human_requested' || (id.startsWith('has_') && id !== 'has_faq') ? 0 : 1
          }
  return { model: 'jev-test-version', answers, usage: { input_tokens: 10, output_tokens: 5 } }
}
beforeAll(async () => {
  db = await embeddedPostgres()
  await db.adminExec(`INSERT INTO tenants(id,name) VALUES('company','合成企业');
    INSERT INTO employees(tenant_id,id,role) VALUES('company','employee-A','employee');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','account-A','employee-A','wework',false);`)
  await db.adminQuery(
    `INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('company','agent-A','account-A','employee-A',$1)`,
    [tokenHash(token)]
  )
  authority = new AccountAuthority(db.db)
  execution = new ExecutionAuthority(authority, async (client, scope) => {
    await loadPublication(client, scope)
  })
}, 20000)
afterAll(async () => {
  if (db) await db.db.close()
})
beforeEach(async () => {
  await db.adminExec(`TRUNCATE learning_context_epochs,learning_preparations,learning_episodes,learning_memories,learning_mutations,learning_settings,learning_jobs,learning_attempts,learning_retained_usage,learning_background_leases,learning_foreground_activity,learning_tombstones CASCADE;
    TRUNCATE ledger_restore_pause_reports,ledger_restore_challenges,ledger_restore_review_permits,ledger_restore_reviews,model_call_results,model_call_attempts,model_call_limits,execution_request_seal_applications,execution_request_seals,reconciliation_applied,reconciliation_decisions,device_reconciliation_reports,reconciliation_notes,reconciliation_cases,generation_tasks,generation_publications,reviewed_replies,published_configurations,account_leases,execution_permits,human_confirmations,audit_events CASCADE;
    UPDATE accounts SET paused=false,enabled=true;UPDATE agents SET revoked_at=NULL;`)
  const f = taskFixture(),
    now = Date.now()
  const context: GenerationInput['context'] = [
    {
      sequence: 1,
      sourceMessageId: 'prior',
      direction: 'human_outbound',
      kind: 'text',
      text: '刚才介绍的是阅读产品。'
    },
    {
      sequence: 2,
      sourceMessageId: 'inbound',
      direction: 'inbound',
      kind: 'text',
      text: '支持离线吗？'
    }
  ]
  input = {
    task: {
      ...f.task,
      contextHash: hashContext(context),
      inboundRange: { from: 2, to: 2 },
      createdAt: now - 1000,
      expiresAt: now + 50000
    },
    context,
    inbound: ['支持离线吗？']
  }
  publication = {
    configuration: {
      configVersion: 'config-1',
      knowledgeVersion: 'knowledge-1',
      decisionPolicyVersion: 'policy-1',
      questionSetVersion: 'questions-1',
      modelResolved: 'jev-test-version',
      automaticEnabled: true
    },
    textGeneratorVersion: 'generator-test-v1',
    policy: {
      version: 'policy-1',
      knowledgeVersion: 'knowledge-1',
      questionSetVersion: 'questions-1',
      mode: 'enforced',
      modelAlias: 'jev-test',
      modelResolved: 'jev-test-version',
      evaluationApproved: true,
      automaticIntents: ['faq'],
      minimumChoiceProbability: 0.9,
      minimumChoiceConfidence: 0.8,
      minimumChoiceMargin: 0.3,
      presentIntentProbability: 0.9,
      humanRequestThreshold: 0.2,
      minimumAuditProbability: 0.95,
      reviewValidityMs: 5000,
      preBudgetMs: 1000,
      postBudgetMs: 1000
    },
    evidence: [
      {
        evidenceId: 'faq',
        tenantId: 'company',
        intent: 'faq',
        knowledgeVersion: 'knowledge-1',
        kind: 'approved_faq',
        content: '支持离线阅读。',
        source: '合成知识',
        approvedBy: 'test',
        validFrom: now - 1000,
        expiresAt: now + 60000
      }
    ]
  }
  evaluate = vi.fn(async (request: JevRequest) => decision(request))
  generator = { generate: vi.fn(async () => ({ text: '支持离线阅读。', evidenceIds: ['faq'] })) }
  service = new GenerationService(
    authority,
    execution,
    new JevReplyPipeline({ evaluate }, generator),
    'generator-test-v1'
  )
  await authority.acquireLease(token, 1, 'process-A')
  await savePublication(authority, execution, token, publication)
})
describe('database-shared generation capacity with embedded SQL', () => {
  it('keeps an unclosed actual draft out of historical case retrieval for subsequent replies', async () => {
    input.task = await service.prepare(token, input)
    await service.generate(token, input)
    const next = await service.prepare(token, {
      ...input,
      task: { ...input.task, taskId: 'next-actual-draft' }
    })
    const context = await authority.withLockedAccount(token, (client, scope) =>
      assertEnterpriseLearningTaskCurrent(client, scope, next)
    )
    expect(context).toMatchObject({ caseIds: [], text: '' })
  })
  it('records the actual completed draft and loaded references once without declaring success or enqueueing review', async () => {
    input.task = await service.prepare(token, input)
    const generated = await service.generate(token, input)
    await service.generate(token, input)
    const episodes = await new EnterpriseLearningRepository(authority).episodes(
      token,
      input.task.conversationId
    )
    expect(episodes).toHaveLength(1)
    expect(episodes[0]).toMatchObject({
      sourceId: enterpriseDraftSource(input.task),
      outcome: 'unknown',
      draft: generated.draft!.text,
      messages: [{ role: 'customer', text: input.inbound[0] }]
    })
    expect((await db.adminQuery('SELECT refs_json FROM learning_generations')).rows).toEqual([
      { refs_json: [] }
    ])
    expect(
      (await db.adminQuery('SELECT payload FROM learning_feedback')).rows.map(
        (row) => z.object({ payload: z.object({ kind: z.string() }) }).parse(row).payload.kind
      )
    ).toEqual(['loaded'])
    expect((await db.adminQuery('SELECT * FROM learning_jobs')).rows).toHaveLength(0)
  })
  it('rolls back completed generation when actual learning source persistence fails', async () => {
    input.task = await service.prepare(token, input)
    await db.adminExec(
      "CREATE FUNCTION autoreply.reject_learning_capture() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'capture_failed';END$$; CREATE TRIGGER reject_learning_capture BEFORE INSERT ON learning_generations FOR EACH ROW EXECUTE FUNCTION autoreply.reject_learning_capture()"
    )
    try {
      await expect(service.generate(token, input)).rejects.toThrow()
      expect((await db.adminQuery('SELECT status FROM generation_tasks')).rows).toEqual([
        { status: 'failed' }
      ])
      expect((await db.adminQuery('SELECT * FROM learning_episodes')).rows).toHaveLength(0)
      expect((await db.adminQuery('SELECT * FROM learning_feedback')).rows).toHaveLength(0)
      expect((await db.adminQuery('SELECT * FROM reviewed_replies')).rows).toHaveLength(0)
    } finally {
      await db.adminExec(
        'DROP TRIGGER reject_learning_capture ON learning_generations; DROP FUNCTION autoreply.reject_learning_capture()'
      )
    }
  })
  it('invalidates an empty prepared snapshot after explicit scope forgetting and removes saved preparations', async () => {
    const prepared = await service.prepare(token, input)
    const repository = new EnterpriseLearningRepository(authority)
    await repository.forgetScope(token, input.task.conversationId)
    expect((await db.adminQuery('SELECT * FROM learning_preparations')).rows).toHaveLength(0)
    await expect(service.generate(token, { ...input, task: prepared })).rejects.toMatchObject({
      code: 'TASK_CONFLICT'
    })
    const next = await service.prepare(token, {
      ...input,
      task: { ...input.task, taskId: randomUUID() }
    })
    expect(next.learningContextVersion).not.toBe(prepared.learningContextVersion)
  })
  it('rejects a task whose identity does not match the authenticated learning account', async () => {
    await expect(
      authority.withLockedAccount(token, (client, scope) =>
        prepareEnterpriseLearningTask(
          client,
          scope,
          { ...input.task, identity: { ...input.task.identity, accountId: 'other-account' } },
          '离线阅读'
        )
      )
    ).rejects.toMatchObject({ code: 'TASK_CONFLICT' })
    expect((await db.adminQuery('SELECT * FROM learning_preparations')).rows).toHaveLength(0)
  })
  it.each([
    { conversation: null, identityStatus: 'verified' as const, expected: 0 },
    { conversation: 'customer-A', identityStatus: 'unassigned' as const, expected: 0 },
    { conversation: 'customer-A', identityStatus: 'verified' as const, expected: 1 }
  ])(
    'only loads a preference with verified customer evidence: $conversation/$identityStatus',
    async ({ conversation, identityStatus, expected }) => {
      const repository = new EnterpriseLearningRepository(authority)
      const episode = await repository.recordEpisode(token, conversation, {
        sourceId: 'preference-source',
        topic: '离线阅读',
        startedAt: Date.now(),
        messages: [],
        outcome: 'corrected',
        identityStatus
      })
      const method = await repository.propose(token, conversation, {
        content: {
          kind: 'preference',
          scenario: '离线阅读',
          guidance: '优先简短回答',
          rationale: '',
          steps: [],
          pitfalls: [],
          verification: []
        },
        evidence: [{ episodeId: episode.id }],
        source: 'human',
        reason: '合成偏好'
      })
      await repository.activate(token, conversation, method.id, 1)
      const prepared = await authority.withLockedAccount(token, (client, scope) =>
        prepareEnterpriseLearningTask(client, scope, input.task, '离线阅读')
      )
      const context = await authority.withLockedAccount(token, (client, scope) =>
        assertEnterpriseLearningTaskCurrent(client, scope, prepared)
      )
      expect(context.methodRefs).toHaveLength(expected)
    }
  )
  it('keeps its own generated episode from invalidating a prepared snapshot but rejects an independent episode', async () => {
    const prepared = await service.prepare(token, input)
    const repository = new EnterpriseLearningRepository(authority)
    const episode = {
      topic: '离线阅读',
      startedAt: Date.now(),
      messages: [],
      outcome: 'unknown' as const
    }
    await repository.recordEpisode(token, input.task.conversationId, {
      ...episode,
      sourceId: enterpriseDraftSource(prepared)
    })
    await expect(
      authority.withLockedAccount(token, (client, scope) =>
        assertEnterpriseLearningTaskCurrent(client, scope, prepared)
      )
    ).resolves.toMatchObject({ caseIds: [] })
    await repository.recordEpisode(token, input.task.conversationId, {
      ...episode,
      sourceId: 'independent-case'
    })
    await expect(
      authority.withLockedAccount(token, (client, scope) =>
        assertEnterpriseLearningTaskCurrent(client, scope, prepared)
      )
    ).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
  })
  it('bounds case references and wrapper bytes while excluding other customers and irrelevant histories', async () => {
    const repository = new EnterpriseLearningRepository(authority)
    const eligible: string[] = []
    for (const [index, conversation] of [
      null,
      'customer-A',
      'customer-A',
      'customer-A',
      'customer-A',
      'customer-B',
      'customer-A'
    ].entries()) {
      const topic = index === 6 ? '完全无关的投诉' : '离线阅读'
      const episode = await repository.recordEpisode(token, conversation, {
        sourceId: `case-${index}`,
        topic,
        startedAt: Date.now(),
        messages: [],
        outcome: 'unknown'
      })
      if (index < 5) eligible.push(episode.id)
    }
    const prepared = await authority.withLockedAccount(token, (client, scope) =>
      prepareEnterpriseLearningTask(client, scope, input.task, '离线阅读')
    )
    const context = await authority.withLockedAccount(token, (client, scope) =>
      assertEnterpriseLearningTaskCurrent(client, scope, prepared)
    )
    expect(context.caseIds).toHaveLength(3)
    expect(context.caseIds.every((id) => eligible.includes(id))).toBe(true)
    expect(context.estimatedTokens).toBe(Buffer.byteLength(context.text, 'utf8'))
    expect(context.estimatedTokens).toBeLessThanOrEqual(2000)
    await repository.settings(token, 'customer-A', { maxContextTokens: 128 })
    const bounded = await authority.withLockedAccount(token, (client, scope) =>
      prepareEnterpriseLearningTask(
        client,
        scope,
        { ...input.task, taskId: randomUUID() },
        '离线阅读'
      )
    )
    expect(
      await authority.withLockedAccount(token, (client, scope) =>
        assertEnterpriseLearningTaskCurrent(client, scope, bounded)
      )
    ).toMatchObject({ text: '', caseIds: [], estimatedTokens: 0 })
  })
  it('deletes prepared case references when actual retention cleanup expires their sources', async () => {
    let at = Date.now()
    const repository = new EnterpriseLearningRepository(authority, { now: () => at })
    await repository.recordEpisode(token, input.task.conversationId, {
      sourceId: 'retention-source',
      topic: '离线阅读',
      startedAt: at,
      messages: [],
      outcome: 'unknown'
    })
    const prepared = await service.prepare(token, input)
    at += 91 * 86400000
    expect(await repository.pruneExpired(token, input.task.conversationId)).toMatchObject({
      deletedEpisodes: 1
    })
    expect((await db.adminQuery('SELECT * FROM learning_preparations')).rows).toHaveLength(0)
    await expect(service.generate(token, { ...input, task: prepared })).rejects.toMatchObject({
      code: 'TASK_CONFLICT'
    })
  })
  it('prepares a server snapshot before generation and injects published methods as process reference only', async () => {
    const repository = new EnterpriseLearningRepository(authority)
    const episode = await repository.recordEpisode(token, input.task.conversationId, {
      sourceId: 'human-method',
      topic: '离线阅读',
      startedAt: Date.now(),
      messages: [],
      correction: '先确认设备型号',
      outcome: 'corrected',
      identityStatus: 'verified'
    })
    const method = await repository.propose(token, input.task.conversationId, {
      content: {
        kind: 'lesson',
        scenario: '离线阅读',
        guidance: '先确认设备型号',
        rationale: '',
        steps: [],
        pitfalls: [],
        verification: []
      },
      evidence: [{ episodeId: episode.id }],
      source: 'human',
      reason: '合成流程纠正'
    })
    await repository.activate(token, input.task.conversationId, method.id, 1)
    const catalog = await authority.withLockedAccount(token, (client, scope) =>
      loadEnterpriseMemoryCatalog(client, scope)
    )
    const updated = {
      ...publication,
      ...catalog,
      configuration: { ...publication.configuration, configVersion: 'config-with-method' }
    }
    await savePublication(authority, execution, token, updated)
    const request = {
      ...input,
      task: { ...input.task, configVersion: updated.configuration.configVersion }
    }
    const prepared = await service.prepare(token, request)
    expect(prepared).toMatchObject({
      ...request.task,
      memoryCorpusVersion: catalog.memoryCorpusVersion
    })
    expect(prepared.memorySnapshotHash).toMatch(/^[a-f0-9]{64}$/)
    expect(prepared.learningContextVersion).toMatch(/^[a-f0-9]{64}$/)
    const result = await service.generate(token, { ...request, task: prepared })
    expect((await db.adminQuery('SELECT refs_json FROM learning_generations')).rows).toEqual([
      { refs_json: [{ id: method.id, revision: 1 }] }
    ])
    expect(result.review).toMatchObject({
      memoryCorpusVersion: prepared.memoryCorpusVersion,
      memorySnapshotHash: prepared.memorySnapshotHash,
      learningContextVersion: prepared.learningContextVersion
    })
    expect(vi.mocked(generator.generate).mock.calls[0][0]).toMatchObject({
      processReference: expect.stringContaining('先确认设备型号')
    })
    expect(
      vi.mocked(generator.generate).mock.calls[0][0].evidence.map((item) => item.evidenceId)
    ).toEqual(['faq'])
    await repository.revise(token, input.task.conversationId, method.id, 1, {
      content: { ...method.content, guidance: '候选修订尚未批准' },
      evidence: [{ episodeId: episode.id }],
      source: 'human',
      reason: '合成待审修订'
    })
    expect(await service.generate(token, { ...request, task: prepared })).toEqual(result)
    expect(generator.generate).toHaveBeenCalledTimes(1)
    await expect(service.generate(token, request)).rejects.toMatchObject({ code: 'TASK_CONFLICT' })
    await repository.forget(token, input.task.conversationId, method.id, 2)
    expect((await db.adminQuery('SELECT * FROM learning_preparations')).rows).toHaveLength(0)
  })
  it('rejects forged bindings and stale case snapshots before returning a cached result or issuing a send permit', async () => {
    const prepared = await service.prepare(token, input)
    const request = { ...input, task: prepared }
    const result = await service.generate(token, request)
    await expect(
      service.generate(token, {
        ...input,
        task: { ...prepared, taskId: randomUUID(), memorySnapshotHash: '0'.repeat(64) }
      })
    ).rejects.toMatchObject({ code: 'TASK_CONFLICT' })
    const repository = new EnterpriseLearningRepository(authority)
    await repository.recordEpisode(token, input.task.conversationId, {
      sourceId: 'new-independent-case',
      topic: '离线阅读',
      startedAt: Date.now(),
      messages: [],
      outcome: 'unknown'
    })
    await expect(service.generate(token, request)).rejects.toMatchObject({
      code: 'CONFIGURATION_CHANGED'
    })
    const lease = await authority.acquireLease(token, 1, 'process-A')
    await expect(
      execution.issue(token, {
        taskId: prepared.taskId,
        taskHash: hashContext(prepared),
        draftHash: result.draft!.draftHash,
        draftRevision: result.draft!.draftRevision,
        loginEpoch: 1,
        clientInstanceId: 'process-A',
        leaseVersion: lease.version
      })
    ).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
    expect(generator.generate).toHaveBeenCalledTimes(1)
  })
  it('rejects the previously completed empty-memory cache when a method first becomes active', async () => {
    const original = await service.generate(token, input)
    expect(original.automaticAllowed).toBe(true)
    const repository = new EnterpriseLearningRepository(authority)
    const episode = await repository.recordEpisode(token, input.task.conversationId, {
      sourceId: 'employee-process-correction',
      topic: '离线阅读',
      startedAt: Date.now(),
      messages: [],
      outcome: 'corrected',
      correction: '先确认设备型号',
      identityStatus: 'verified'
    })
    const method = await repository.propose(token, input.task.conversationId, {
      content: {
        kind: 'lesson',
        scenario: '离线阅读',
        guidance: '先确认设备型号',
        rationale: '',
        steps: [],
        pitfalls: [],
        verification: []
      },
      evidence: [{ episodeId: episode.id }],
      source: 'human',
      reason: '合成员工流程纠正'
    })
    await repository.activate(token, input.task.conversationId, method.id, 1)
    await expect(service.generate(token, input)).rejects.toMatchObject({
      code: 'CONFIGURATION_CHANGED'
    })
    expect(generator.generate).toHaveBeenCalledTimes(1)
    const saved = (
      await db.adminQuery('SELECT result_json FROM generation_tasks WHERE task_id=$1', [
        input.task.taskId
      ])
    ).rows[0] as { result_json: unknown }
    expect(saved.result_json).toMatchObject({ task: original.task })
  })
  it('records real generation activity, prevents learning during foreground work and waits a complete idle interval after completion', async () => {
    let learningAt = Date.now()
    const repository = new EnterpriseLearningRepository(authority, { now: () => learningAt })
    const queue = new EnterpriseLearningQueue(db.db, authority, { now: () => learningAt })
    const episode = await repository.recordEpisode(token, input.task.conversationId, {
      sourceId: 'learning-correction',
      topic: '离线阅读',
      startedAt: learningAt,
      messages: [],
      outcome: 'corrected'
    })
    await queue.enqueue(
      token,
      input.task.conversationId,
      episode.id,
      'correction',
      'learning-event'
    )
    learningAt += 15000
    input.task = await service.prepare(token, input)
    const gate = deferred<void>(),
      entered = deferred<void>()
    vi.mocked(generator.generate).mockImplementation(async () => {
      entered.resolve()
      await gate.promise
      return { text: '支持离线阅读。', evidenceIds: ['faq'] }
    })
    const pending = service.generate(token, input)
    await entered.promise
    try {
      expect(await queue.claim(token, 'worker-A')).toBeNull()
      expect(
        (await db.adminQuery('SELECT revision FROM learning_foreground_activity')).rows[0]
      ).toMatchObject({ revision: 1 })
    } finally {
      gate.resolve()
      await pending
    }
    const activity = (
      await db.adminQuery('SELECT revision,last_activity_at FROM learning_foreground_activity')
    ).rows[0] as { revision: number; last_activity_at: number }
    expect(Number(activity.revision)).toBe(2)
    // A cached result creates no new model work and does not postpone idle learning.
    await service.generate(token, input)
    const cachedActivity = (
      await db.adminQuery('SELECT revision FROM learning_foreground_activity')
    ).rows[0] as { revision: number }
    expect(Number(cachedActivity.revision)).toBe(2)
    learningAt = Number(activity.last_activity_at) + 14999
    expect(await queue.claim(token, 'worker-A')).toBeNull()
    learningAt++
    expect(await queue.claim(token, 'worker-A')).not.toBeNull()
  })
  it('persists and reloads published retrieval behavior and reply rules', async () => {
    const prepared: Publication = {
      ...publication,
      configuration: { ...publication.configuration, configVersion: 'config-knowledge' },
      retrieval: 'lexical-v1',
      replyRules: '回复礼貌简洁'
    }
    await savePublication(authority, execution, token, prepared)
    const loaded = await authority.withLockedAccount(token, (sql, scope) =>
      loadPublication(sql, scope)
    )
    expect(loaded).toMatchObject({
      retrieval: 'lexical-v1',
      replyRules: '回复礼貌简洁',
      configuration: { configVersion: 'config-knowledge' }
    })
  })
  it('bounds separate service instances per account, preserves duplicate semantics and frees finished slots', async () => {
    const gate = deferred<void>()
    evaluate.mockImplementation(async (request: JevRequest) => {
      await gate.promise
      return decision(request)
    })
    const another = () =>
      new GenerationService(
        authority,
        execution,
        new JevReplyPipeline({ evaluate }, generator),
        'generator-test-v1'
      )
    const second = another(),
      third = another()
    const change = (taskId: string) => ({ ...input, task: { ...input.task, taskId } })
    const pending = Promise.allSettled([
      service.generate(token, change('capacity-first')),
      second.generate(token, change('capacity-second'))
    ])
    try {
      await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(2))
      await expect(third.generate(token, change('capacity-third'))).rejects.toMatchObject({
        code: 'GENERATION_OVERLOADED'
      })
      await expect(third.generate(token, change('capacity-first'))).rejects.toMatchObject({
        code: 'GENERATION_IN_PROGRESS'
      })
      expect(
        (await db.adminQuery('SELECT task_id FROM generation_tasks ORDER BY task_id')).rows
      ).toEqual([{ task_id: 'capacity-first' }, { task_id: 'capacity-second' }])
    } finally {
      gate.resolve()
    }
    expect((await pending).every((r) => r.status === 'fulfilled')).toBe(true)
    expect((await third.generate(token, change('capacity-third'))).status).toBe('candidate')
  })
  it('keeps task bindings and deadlines fixed and prevents restarting a terminal task through service SQL', async () => {
    await service.generate(token, input)
    for (const statement of [
      "UPDATE generation_tasks SET expires_at=clock_timestamp()+interval '1 minute'",
      "UPDATE generation_tasks SET request_hash='substituted'",
      "UPDATE generation_tasks SET task_json='{}'"
    ])
      await expect(db.db.transaction('company', (sql) => sql.query(statement))).rejects.toThrow(
        'generation_task_immutable'
      )
    await db.db.transaction('company', (sql) =>
      sql.query("UPDATE generation_tasks SET status='failed',result_json=NULL")
    )
    await expect(
      db.db.transaction('company', (sql) =>
        sql.query("UPDATE generation_tasks SET status='running'")
      )
    ).rejects.toThrow('generation_task_not_restartable')
    await expect(service.generate(token, input)).rejects.toMatchObject({
      code: 'GENERATION_FAILED'
    })
    expect(evaluate).toHaveBeenCalledTimes(2)
  })
})
describe('authenticated central generation with actual embedded SQL and synthetic models', () => {
  function referenceRequest(
    result: import('../../src/shared/contracts/generation').GenerationResult,
    offset = 0
  ): AssessmentEvidenceRequest {
    return {
      taskId: result.task.taskId,
      contextHash: result.task.contextHash,
      knowledgeVersion: result.task.knowledgeVersion,
      draftHash: result.draft!.draftHash,
      draftRevision: result.draft!.draftRevision,
      offset
    }
  }
  it('pages every cited applicable original, including references omitted from the bounded explanation', async () => {
    const base = publication.evidence[0],
      now = Date.now()
    publication = {
      ...publication,
      configuration: { ...publication.configuration, configVersion: 'reference-config' },
      evidence: [
        ...Array.from({ length: 10 }, (_, i) => ({
          ...base,
          evidenceId: `full-${i}`,
          content: i === 0 ? '正文'.repeat(10000) : `第 ${i} 条资料`
        })),
        {
          ...base,
          evidenceId: 'other-customer',
          accountId: 'account-A',
          conversationId: 'other-customer',
          content: '另一客户的私密资料'
        },
        {
          ...base,
          evidenceId: 'expired',
          validFrom: now - 5000,
          expiresAt: now - 1000,
          content: '过期资料'
        },
        {
          ...base,
          evidenceId: 'future',
          validFrom: now + 100000,
          expiresAt: now + 200000,
          content: '未来资料'
        },
        { ...base, evidenceId: 'uncited', content: '没有被引用的资料' },
        { ...base, evidenceId: 'wrong-intent', intent: 'price', content: '没有识别到的业务意图' }
      ]
    }
    await savePublication(authority, execution, token, publication)
    input.task.configVersion = 'reference-config'
    const cited = publication.evidence
      .filter((e) => e.evidenceId !== 'uncited')
      .map((e) => e.evidenceId)
    const result = await service.reviewEdited(token, {
      generation: input,
      edit: { text: '员工待核对的内容', draftRevision: 2, evidenceIds: cited }
    })
    expect(result.explanation).toMatchObject({
      omittedReferences: 2,
      unavailableReferences: 4,
      totalReferences: 14
    })
    for (let offset = 0; offset < 10; offset++) {
      const page = await service.assessmentEvidence(token, referenceRequest(result, offset))
      expect(page).toMatchObject({
        offset,
        totalAvailable: 10,
        unavailableReferences: 4,
        evidence: [{ evidenceId: `full-${offset}`, content: publication.evidence[offset].content }]
      })
      expect(page.nextOffset).toBe(offset < 9 ? offset + 1 : undefined)
      expect(JSON.stringify(page)).not.toMatch(
        /另一客户的私密资料|过期资料|未来资料|没有被引用的资料|没有识别到的业务意图/
      )
    }
    expect(await service.assessmentEvidence(token, referenceRequest(result, 10))).toMatchObject({
      evidence: []
    })
    expect(evaluate).toHaveBeenCalledOnce()
    expect(generator.generate).not.toHaveBeenCalled()
    expect((await db.adminQuery('SELECT * FROM execution_permits')).rows).toHaveLength(0)
  })
  it('reads the immutable historical publication while paused, without a live lease or model replay', async () => {
    const result = await service.generate(token, input),
      request = referenceRequest(result)
    const calls = evaluate.mock.calls.length
    publication = {
      ...publication,
      configuration: { ...publication.configuration, configVersion: 'new-reference-publication' },
      evidence: publication.evidence.map((e) => ({ ...e, content: '后续发布内容' }))
    }
    await savePublication(authority, execution, token, publication)
    await db.adminExec('UPDATE accounts SET paused=true; DELETE FROM account_leases;')
    const page = await service.assessmentEvidence(token, request)
    expect(page.evidence[0].content).toBe('支持离线阅读。')
    expect(page.assessedAt).toBe(result.explanation!.assessedAt)
    expect(evaluate).toHaveBeenCalledTimes(calls)
    expect((await db.adminQuery('SELECT * FROM execution_permits')).rows).toHaveLength(0)
  })
  it('refuses substituted source hashes/versions, unknown tasks and offsets beyond the cited set', async () => {
    const result = await service.generate(token, input),
      request = referenceRequest(result)
    for (const change of [
      { taskId: 'missing-task' },
      { contextHash: 'b'.repeat(64) },
      { knowledgeVersion: 'other' },
      { draftHash: 'b'.repeat(64) },
      { draftRevision: 99 },
      { offset: 2 }
    ])
      await expect(service.assessmentEvidence(token, { ...request, ...change })).rejects.toThrow(
        'TASK_CONFLICT'
      )
    await expect(
      service.assessmentEvidence(token, {
        ...request,
        evidenceId: 'uncited'
      } as AssessmentEvidenceRequest)
    ).rejects.toThrow()
    await db.adminExec("UPDATE generation_tasks SET status='failed', result_json=NULL")
    await expect(service.assessmentEvidence(token, request)).rejects.toThrow('TASK_CONFLICT')
  })
  it('does not disclose another employee/account or device task, and revocation closes read access', async () => {
    const result = await service.generate(token, input),
      request = referenceRequest(result)
    await db.adminExec(`INSERT INTO employees(tenant_id,id,role) VALUES('company','reference-employee-B','employee') ON CONFLICT DO NOTHING;
      INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','reference-account-B','reference-employee-B','wework',false) ON CONFLICT DO NOTHING;`)
    for (const other of [
      {
        id: 'reference-agent-B',
        account: 'reference-account-B',
        employee: 'reference-employee-B',
        token: 'B'.repeat(43)
      },
      {
        id: 'reference-agent-C',
        account: 'account-A',
        employee: 'employee-A',
        token: 'C'.repeat(43)
      }
    ]) {
      await db.adminQuery(
        `INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('company',$1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [other.id, other.account, other.employee, tokenHash(other.token)]
      )
      await expect(service.assessmentEvidence(other.token, request)).rejects.toThrow(
        'TASK_CONFLICT'
      )
    }
    await db.adminExec("UPDATE agents SET revoked_at=clock_timestamp() WHERE id='agent-A'")
    await expect(service.assessmentEvidence(token, request)).rejects.toThrow('DENIED')
  })
  async function shadowPublication() {
    publication = {
      ...publication,
      configuration: {
        ...publication.configuration,
        configVersion: 'human-config',
        decisionPolicyVersion: 'human-policy',
        automaticEnabled: false
      },
      policy: {
        ...publication.policy,
        version: 'human-policy',
        mode: 'shadow',
        evaluationApproved: false
      }
    }
    await savePublication(authority, execution, token, publication)
    input.task.configVersion = 'human-config'
    input.task.decisionPolicyVersion = 'human-policy'
  }
  async function humanRequest(evidenceIds = ['faq']): Promise<HumanPermitRequest> {
    const source = await service.reviewEdited(token, {
      generation: input,
      edit: { text: '员工核对后的合成回复', draftRevision: 2, evidenceIds }
    })
    const now = Date.now() - 1,
      task = { ...source.task, taskId: randomUUID(), createdAt: now, expiresAt: now + 60000 },
      draft = { ...source.draft!, taskId: task.taskId }
    return {
      task,
      draft,
      leaseVersion: 1,
      confirmation: {
        confirmationId: randomUUID(),
        taskId: task.taskId,
        sourceTaskId: source.task.taskId,
        taskHash: hashContext(task),
        draftHash: draft.draftHash,
        draftRevision: draft.draftRevision,
        employeeId: task.identity.employeeId,
        modelResolved: publication.configuration.modelResolved,
        confirmedAt: now,
        expiresAt: now + 5000
      }
    }
  }
  it('issues explicit human permits in shadow mode without asserting a passed Jev/fact approval', async () => {
    await shadowPublication()
    const request = await humanRequest()
    const permit = await execution.issueHuman(token, request)
    expect(permit).toMatchObject({
      purpose: 'human',
      confirmationId: request.confirmation.confirmationId,
      newlyIssued: true
    })
    expect(await execution.issueHuman(token, request)).toMatchObject({
      newlyIssued: false,
      purpose: 'human'
    })
    await expect(
      execution.issueHuman(token, { ...request, draft: { ...request.draft, evidenceIds: [] } })
    ).rejects.toThrow('PERMIT_CONFLICT')
    expect((await db.adminQuery('SELECT * FROM reviewed_replies')).rows).toHaveLength(0)
    expect((await db.adminQuery('SELECT * FROM human_confirmations')).rows).toHaveLength(1)
    await expect(
      execution.issue(token, {
        taskId: request.task.taskId,
        taskHash: hashContext(request.task),
        draftHash: request.draft.draftHash,
        draftRevision: 2,
        leaseVersion: 1,
        loginEpoch: 1,
        clientInstanceId: 'process-A'
      })
    ).rejects.toThrow('PERMIT_CONFLICT')
    await expect(
      authority.withLockedAccount(token, (client) =>
        client.query('UPDATE human_confirmations SET draft_hash=$1', ['b'.repeat(64)])
      )
    ).rejects.toThrow()
    expect((await db.adminQuery('SELECT kind FROM audit_events')).rows).toContainEqual({
      kind: 'human_reply_confirmed'
    })
  })
  it('binds human confirmation to the stored text, source assessment, employee, customer and version', async () => {
    const request = await humanRequest()
    for (const bad of [
      { ...request, task: { ...request.task, conversationId: 'other-customer' } },
      { ...request, task: { ...request.task, contextHash: 'a'.repeat(64) } },
      { ...request, task: { ...request.task, configVersion: 'unpublished' } },
      { ...request, draft: { ...request.draft, action: 'clarify' as const } },
      { ...request, draft: { ...request.draft, evidenceIds: ['other'] } },
      { ...request, confirmation: { ...request.confirmation, employeeId: 'other' } },
      { ...request, confirmation: { ...request.confirmation, sourceTaskId: 'not-completed' } }
    ]) {
      bad.confirmation = { ...bad.confirmation, taskHash: hashContext(bad.task) }
      await expect(execution.issueHuman(token, bad)).rejects.toThrow('REVIEW_REQUIRED')
    }
    expect((await db.adminQuery('SELECT * FROM execution_permits')).rows).toHaveLength(0)
    expect((await db.adminQuery('SELECT * FROM human_confirmations')).rows).toHaveLength(0)
  })
  it('retains an employee draft with no knowledge references after an explicit human request without pretending Jev passed', async () => {
    input.inbound = ['请转人工处理']
    input.context.at(-1)!.text = input.inbound[0]
    input.task.contextHash = hashContext(input.context)
    const request = await humanRequest([])
    expect(evaluate).not.toHaveBeenCalled()
    expect(generator.generate).not.toHaveBeenCalled()
    expect((await db.adminQuery('SELECT result_json FROM generation_tasks')).rows[0]).toMatchObject(
      {
        result_json: {
          status: 'handoff',
          automaticAllowed: false,
          factsVerified: false,
          draft: { text: '员工核对后的合成回复', evidenceIds: [] }
        }
      }
    )
    expect(await execution.issueHuman(token, request)).toMatchObject({
      purpose: 'human',
      newlyIssued: true
    })
    expect((await db.adminQuery('SELECT * FROM reviewed_replies')).rows).toHaveLength(0)
  })
  it('rejects expired human confirmations and rolls back confirmation and permit on audit failure', async () => {
    const request = await humanRequest(),
      now = Date.now()
    await expect(
      execution.issueHuman(token, {
        ...request,
        confirmation: { ...request.confirmation, confirmedAt: now - 6000, expiresAt: now - 1000 }
      })
    ).rejects.toThrow('STALE_REVIEW')
    await db.adminExec(`CREATE FUNCTION fail_human_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='human_reply_confirmed' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF;RETURN NEW;END $$;
      CREATE TRIGGER fail_human_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_human_audit();`)
    try {
      await expect(execution.issueHuman(token, request)).rejects.toThrow()
      expect((await db.adminQuery('SELECT * FROM human_confirmations')).rows).toHaveLength(0)
      expect((await db.adminQuery('SELECT * FROM execution_permits')).rows).toHaveLength(0)
    } finally {
      await db.adminExec(
        'DROP TRIGGER fail_human_audit ON audit_events;DROP FUNCTION fail_human_audit()'
      )
    }
  })
  it('connects employee confirmation through the actual desktop runtime, HTTP, SQL, shared sender and synthetic echo', async () => {
    const started = performance.now(),
      timings: { stage: string; elapsedMs: number }[] = []
    const stamp = (stage: string): void => {
      timings.push({ stage, elapsedMs: Math.round(performance.now() - started) })
    }
    stamp('publication_start')
    await shadowPublication()
    stamp('publication_ready')
    const server = createServer(createApplication(authority, { execution, generation: service }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      identity = input.task.identity
    const registration = new AgentRegistration(
      {
        load: () => ({
          serverUrl: origin,
          scope: {
            tenant_id: 'company',
            employee_id: 'employee-A',
            account_id: 'account-A',
            agent_id: 'agent-A',
            platform: 'wework'
          },
          encryptedCredential: 'synthetic-cipher'
        }),
        save: () => {}
      },
      { available: () => true, encrypt: () => '', decrypt: () => token },
      fetch,
      true
    )
    let observe:
      | ((message: import('../../src/shared/contracts/message').ObservedMessage) => void)
      | undefined
    const platform: RuntimePlatform = {
      capabilities: () => ({ backgroundRead: true, nonInterferingSend: true }),
      binding: async () => ({
        identity,
        conversations: [
          {
            identity,
            conversationId: 'customer-A',
            bindingVersion: 1,
            identityVerified: true,
            identityEvidence: ['synthetic-proof']
          }
        ]
      }),
      observe: async (callback) => {
        observe = callback
      },
      stop: async () => {},
      readCurrent: async (task) => ({
        ...taskFixture().current,
        ...task,
        identityVerified: true,
        factsVerified: false
      }),
      dispatch: vi.fn(async (command) => {
        expect(command.purpose).toBe('human')
        expect(command.review).toBeUndefined()
        expect(command.confirmation).toBeDefined()
        return {
          status: 'confirmed' as const,
          executionId: command.executionId,
          identity: command.task.identity,
          conversationId: command.task.conversationId,
          draftHash: command.draft.draftHash,
          evidence: 'synthetic-human-echo',
          proof: {
            sourceMessageId: 'synthetic-human-echo',
            verificationProofHash: hashContext('verified synthetic echo')
          }
        }
      })
    }
    const ledger = new Ledger(':memory:'),
      runtime = new DesktopAgentRuntime(ledger, registration, platform)
    try {
      expect(await runtime.start()).toMatchObject({ state: 'running' })
      stamp('runtime_started')
      observe!({
        identity,
        conversationId: 'customer-A',
        sourceMessageId: 'manual-source',
        direction: 'inbound',
        kind: 'text',
        text: '支持离线吗？',
        observedAt: Date.now(),
        identityVerified: true,
        messageIdVerified: true
      })
      await vi.waitFor(
        () => expect(runtime.workbench().rows[0]?.replyText).toBe('支持离线阅读。'),
        { timeout: 5000 }
      )
      stamp('draft_ready')
      let row = runtime.workbench().rows[0]
      expect(row.explanation).toMatchObject({
        taskId: row.taskId,
        intents: ['faq'],
        recommendation: 'review',
        factsVerified: true,
        evidence: [{ source: '合成知识', excerpt: '支持离线阅读。' }]
      })
      await runtime.workbenchAction({
        taskId: row.taskId,
        expectedVersion: row.version,
        action: 'takeover'
      })
      row = runtime.workbench().rows[0]
      expect(row.canConfirm).toBe(true)
      expect(row.canReadEvidence).toBe(true)
      expect(
        await runtime.workbenchEvidence({
          taskId: row.taskId,
          expectedVersion: row.version,
          offset: 0
        })
      ).toMatchObject({
        success: true,
        page: { taskId: row.taskId, evidence: [{ content: '支持离线阅读。' }] }
      })
      expect(
        await runtime.workbenchConfirmSend({ taskId: row.taskId, expectedVersion: row.version })
      ).toMatchObject({ success: true })
      stamp('human_send_confirmed')
      expect(runtime.workbench().rows.some((r) => r.status === 'sent' && r.humanOwned)).toBe(true)
      expect(runtime.workbench().rows.find((r) => r.status === 'sent')?.explanation?.taskId).toBe(
        row.taskId
      )
      expect(platform.dispatch).toHaveBeenCalledOnce()
      const sentRow = runtime.workbench().rows.find((r) => r.status === 'sent')!
      expect(
        await runtime.workbenchEvidence({
          taskId: sentRow.taskId,
          expectedVersion: sentRow.version,
          offset: 0
        })
      ).toMatchObject({
        success: true,
        page: { taskId: row.taskId, evidence: [{ content: '支持离线阅读。' }] }
      })
      expect(evaluate).toHaveBeenCalledTimes(2)
      expect(ledger.snapshot(identity, 'customer-A').messages[0].handledBy).toBeTruthy()
      expect((await db.adminQuery('SELECT purpose,status FROM execution_permits')).rows).toEqual([
        { purpose: 'human', status: 'confirmed' }
      ])
      expect((await db.adminQuery('SELECT * FROM reviewed_replies')).rows).toHaveLength(0)
    } finally {
      stamp('closing')
      await runtime.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      stamp('closed')
      if (performance.now() - started >= 4500)
        process.stdout.write(`synthetic_human_flow_timing ${JSON.stringify(timings)}\n`)
    }
  })
  it('persists an edited assessment idempotently but never admits it as an execution candidate', async () => {
    const request = {
      generation: input,
      edit: { text: '支持离线阅读。', draftRevision: 2, evidenceIds: ['faq'] }
    }
    const result = await service.reviewEdited(token, request)
    expect(result).toMatchObject({
      automaticAllowed: false,
      factsVerified: true,
      review: { status: 'passed', draftRevision: 2 }
    })
    expect(await service.reviewEdited(token, request)).toEqual(result)
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(generator.generate).not.toHaveBeenCalled()
    expect((await db.adminQuery('SELECT * FROM reviewed_replies')).rows).toHaveLength(0)
    await expect(
      execution.issue(token, {
        taskId: input.task.taskId,
        taskHash: hashContext(input.task),
        draftHash: result.draft!.draftHash,
        draftRevision: 2,
        loginEpoch: 1,
        clientInstanceId: 'process-A',
        leaseVersion: 1
      })
    ).rejects.toThrow()
    await expect(service.generate(token, input)).rejects.toThrow('TASK_CONFLICT')
    await expect(
      service.reviewEdited(token, { ...request, edit: { ...request.edit, text: '改动后的草稿' } })
    ).rejects.toThrow('TASK_CONFLICT')
  })
  it('never replays a running edited assessment after a duplicate request', async () => {
    const gate = deferred<JevResponse>()
    evaluate.mockImplementationOnce(() => gate.promise)
    const request = {
      generation: input,
      edit: { text: '支持离线阅读。', draftRevision: 2, evidenceIds: ['faq'] }
    }
    const running = service.reviewEdited(token, request)
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledOnce())
    await expect(service.reviewEdited(token, request)).rejects.toThrow('GENERATION_IN_PROGRESS')
    gate.resolve(decision(evaluate.mock.calls[0][0]))
    expect(await running).toMatchObject({ automaticAllowed: false })
    expect(evaluate).toHaveBeenCalledTimes(2)
  })
  it('rechecks the central publication after a late edited assessment', async () => {
    const gate = deferred<JevResponse>()
    evaluate.mockImplementationOnce(() => gate.promise)
    const running = service.reviewEdited(token, {
      generation: input,
      edit: { text: '支持离线阅读。', draftRevision: 2, evidenceIds: ['faq'] }
    })
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledOnce())
    await db.adminExec('UPDATE accounts SET paused=true')
    gate.resolve(decision(evaluate.mock.calls[0][0]))
    await expect(running).rejects.toThrow()
    expect((await db.adminQuery('SELECT * FROM reviewed_replies')).rows).toHaveLength(0)
  })
  it('runs both Jev stages with full conversation, records approval and allows a single matching permit', async () => {
    const result = await service.generate(token, input)
    expect(result).toMatchObject({
      task: input.task,
      status: 'candidate',
      automaticAllowed: true,
      factsVerified: true,
      review: { status: 'passed' }
    })
    expect(evaluate.mock.calls[0][0].state).toMatchObject({ untrusted_conversation: input.context })
    expect(vi.mocked(generator.generate).mock.calls[0][0].context).toEqual(input.context)
    const permit = await execution.issue(token, {
      taskId: input.task.taskId,
      taskHash: hashContext(input.task),
      draftHash: result.draft!.draftHash,
      draftRevision: 1,
      loginEpoch: 1,
      clientInstanceId: 'process-A',
      leaseVersion: 1
    })
    expect(permit.newlyIssued).toBe(true)
    expect((await db.adminQuery('SELECT status FROM generation_tasks')).rows).toEqual([
      { status: 'completed' }
    ])
  })
  it('reuses a completed task without creating a second draft/review or model call', async () => {
    const first = await service.generate(token, input),
      second = await service.generate(token, input)
    expect(second).toEqual(first)
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(generator.generate).toHaveBeenCalledTimes(1)
  })
  it('refuses an expired cached review instead of treating cache retrieval as a new review', async () => {
    const result = await service.generate(token, input)
    await db.adminQuery(`UPDATE generation_tasks SET result_json=$1::jsonb`, [
      JSON.stringify({ ...result, review: { ...result.review!, reviewedAt: 1, expiresAt: 2 } })
    ])
    await expect(service.generate(token, input)).rejects.toThrow('TASK_EXPIRED')
    expect(generator.generate).toHaveBeenCalledTimes(1)
  })
  it('refuses old question implementations and generator versions at generation and permit issuance', async () => {
    const result = await service.generate(token, input)
    await db.adminQuery('UPDATE generation_publications SET question_set_hash=$1', ['b'.repeat(64)])
    await expect(service.configuration(token)).rejects.toThrow('CONFIGURATION_CHANGED')
    const guarded = new ExecutionAuthority(authority, async (client, scope) => {
      const p = await loadPublication(client, scope)
      if (p.textGeneratorVersion !== 'generator-test-v1')
        throw new GenerationError('CONFIGURATION_CHANGED')
    })
    await expect(
      guarded.issue(token, {
        taskId: input.task.taskId,
        taskHash: hashContext(input.task),
        draftHash: result.draft!.draftHash,
        draftRevision: 1,
        loginEpoch: 1,
        clientInstanceId: 'process-A',
        leaseVersion: 1
      })
    ).rejects.toThrow('CONFIGURATION_CHANGED')
    expect((await db.adminQuery('SELECT * FROM execution_permits')).rows).toHaveLength(0)
  })
  it('rejects changed request content and cross-employee scope before any model call', async () => {
    await expect(
      service.generate(token, {
        ...input,
        task: { ...input.task, identity: { ...input.task.identity, accountId: 'other' } }
      })
    ).rejects.toThrow('TASK_CONFLICT')
    await expect(service.generate(token, { ...input, inbound: ['篡改问题'] })).rejects.toThrow(
      'Context hash or inbound range'
    )
    expect(evaluate).not.toHaveBeenCalled()
    await service.generate(token, input)
    const changed = { ...input, task: { ...input.task, conversationRevision: 3 } }
    await expect(service.generate(token, changed)).rejects.toThrow('TASK_CONFLICT')
  })
  it('does not call a model for a paused account, expired task or old login instance', async () => {
    await db.adminExec('UPDATE accounts SET paused=true')
    await expect(service.generate(token, input)).rejects.toThrow('PAUSED')
    await db.adminExec('UPDATE accounts SET paused=false')
    await expect(
      service.generate(token, { ...input, task: { ...input.task, createdAt: 1, expiresAt: 2 } })
    ).rejects.toThrow('TASK_EXPIRED')
    await expect(
      service.generate(token, {
        ...input,
        task: { ...input.task, identity: { ...input.task.identity, loginEpoch: 2 } }
      })
    ).rejects.toThrow('SESSION_INVALID')
    expect(evaluate).not.toHaveBeenCalled()
  })
  it('keeps publication versions immutable and excludes other customers knowledge', async () => {
    await expect(
      savePublication(authority, execution, token, {
        ...publication,
        evidence: [{ ...publication.evidence[0], content: '改写旧版知识' }]
      })
    ).rejects.toThrow('TASK_CONFLICT')
    const next = {
      ...publication,
      configuration: { ...publication.configuration, configVersion: 'config-2' },
      evidence: [
        { ...publication.evidence[0], accountId: 'account-A', conversationId: 'other-customer' }
      ]
    }
    await savePublication(authority, execution, token, next)
    const result = await service.generate(token, {
      ...input,
      task: { ...input.task, configVersion: 'config-2' }
    })
    expect(result).toMatchObject({
      status: 'handoff',
      automaticAllowed: false,
      reasons: ['evidence_missing']
    })
    expect(generator.generate).not.toHaveBeenCalled()
  })
  it('never returns automatic permission in suggestions mode and keeps config sync free of knowledge', async () => {
    const next = {
      ...publication,
      configuration: {
        ...publication.configuration,
        configVersion: 'config-2',
        automaticEnabled: false
      }
    }
    await savePublication(authority, execution, token, next)
    expect(await service.configuration(token)).toEqual({
      ...next.configuration,
      memoryCorpusVersion: EMPTY_ENTERPRISE_MEMORY_VERSION
    })
    const result = await service.generate(token, {
      ...input,
      task: { ...input.task, configVersion: 'config-2' }
    })
    expect(result.automaticAllowed).toBe(false)
    expect((await db.adminQuery('SELECT * FROM reviewed_replies')).rows).toHaveLength(0)
  })
  it('rejects duplicate in-progress generation and invalidates results after policy publication', async () => {
    const gate = deferred<{ text: string; evidenceIds: string[] }>(),
      ready = deferred<void>()
    vi.mocked(generator.generate).mockImplementation(async () => {
      ready.resolve()
      return gate.promise
    })
    const pending = service.generate(token, input)
    const check = expect(pending).rejects.toThrow('STALE_REVIEW')
    await ready.promise
    await expect(service.generate(token, input)).rejects.toThrow('GENERATION_IN_PROGRESS')
    await savePublication(authority, execution, token, {
      ...publication,
      configuration: { ...publication.configuration, configVersion: 'config-2' }
    })
    gate.resolve({ text: '支持离线阅读。', evidenceIds: ['faq'] })
    await check
    expect((await db.adminQuery('SELECT status FROM generation_tasks')).rows).toEqual([
      { status: 'failed' }
    ])
    expect((await db.adminQuery('SELECT * FROM reviewed_replies')).rows).toHaveLength(0)
  })
  it('aborts an in-progress request without retaining an automatic approval or retrying it', async () => {
    const gate = deferred<{ text: string; evidenceIds: string[] }>(),
      ready = deferred<void>(),
      controller = new AbortController()
    vi.mocked(generator.generate).mockImplementation(async () => {
      ready.resolve()
      return gate.promise
    })
    const pending = service.generate(token, input, controller.signal),
      check = expect(pending).rejects.toThrow('CANCELLED')
    await ready.promise
    controller.abort()
    await check
    gate.resolve({ text: '支持离线阅读。', evidenceIds: ['faq'] })
    expect((await db.adminQuery('SELECT * FROM reviewed_replies')).rows).toHaveLength(0)
    await expect(service.generate(token, input)).rejects.toThrow('GENERATION_FAILED')
  })
  it('connects the actual ledger, main-process transport, HTTP, SQL, Jev stages and mock sender', async () => {
    const server = createServer(createApplication(authority, { execution, generation: service }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const scope = {
      tenant_id: 'company',
      employee_id: 'employee-A',
      account_id: 'account-A',
      agent_id: 'agent-A',
      platform: 'wework' as const
    }
    const registration = new AgentRegistration(
      {
        load: () => ({ serverUrl: origin, scope, encryptedCredential: 'synthetic-cipher' }),
        save: () => {}
      },
      { available: () => true, encrypt: () => '', decrypt: () => token },
      fetch,
      true
    )
    const ledger = new Ledger(':memory:'),
      sent = deferred<SenderResult>()
    let leaseGrant: LeaseGrant | undefined
    const adapter: VerifiedSendAdapter = {
      readCurrent: async (task) => ({ ...taskFixture().current, ...task, identityVerified: true }),
      dispatch: vi.fn<VerifiedSendAdapter['dispatch']>(async (command) => {
        expect(command.authorization?.permitId).toBeTruthy()
        expect(command.task.memoryCorpusVersion).toBe(EMPTY_ENTERPRISE_MEMORY_VERSION)
        expect(command.task.memorySnapshotHash).toMatch(/^[a-f0-9]{64}$/)
        expect(command.task.learningContextVersion).toMatch(/^[a-f0-9]{64}$/)
        expect(ledger.replies.get(command.task.identity, command.task.taskId)?.task).toEqual(
          command.task
        )
        expect(ledger.central.get(command.executionId)?.phase).toBe('dispatching')
        return {
          status: 'confirmed',
          executionId: command.executionId,
          identity: command.task.identity,
          conversationId: command.task.conversationId,
          draftHash: command.draft.draftHash,
          evidence: 'synthetic-new-echo',
          proof: {
            sourceMessageId: 'synthetic-new-echo',
            verificationProofHash: hashContext('synthetic-adapter-proof')
          }
        }
      })
    }
    const central: CentralSendAdapter = new CentralSendAdapter(ledger, registration, adapter, {
      lease: () => leaseGrant,
      revalidate: (command, signal) => agent.sender.revalidate(command, signal),
      current: (command) =>
        agent.matchesCurrentTask(command.task) && agent.sender.localCurrent(command)
    })
    const agent: ReliableAgent = new ReliableAgent(
      ledger,
      central,
      new RemoteReplyService(registration),
      { onSend: sent.resolve },
      { quietMs: 0, maximumWaitMs: 0 }
    )
    try {
      const lease = await registration.acquireLease(input.task.identity)
      expect(lease.version).toBe(1)
      leaseGrant = lease
      await agent.configure(await registration.configuration())
      agent.bind({
        identity: input.task.identity,
        conversationId: 'customer-A',
        bindingVersion: 1,
        identityVerified: true,
        identityEvidence: ['synthetic-adapter-proof']
      })
      agent.resume()
      agent.observe({
        identity: input.task.identity,
        conversationId: 'customer-A',
        sourceMessageId: 'native-new',
        direction: 'inbound',
        kind: 'text',
        text: '支持离线吗？',
        observedAt: Date.now(),
        identityVerified: true,
        messageIdVerified: true
      })
      const result = await sent.promise
      expect(result).toMatchObject({
        status: 'recorded',
        record: { status: 'confirmed' }
      })
      expect(adapter.dispatch).toHaveBeenCalledTimes(1)
      expect(ledger.snapshot(input.task.identity, 'customer-A').messages[0].handledBy).toBeTruthy()
      expect(evaluate).toHaveBeenCalledTimes(2)
      expect((await db.adminQuery('SELECT task_id FROM reviewed_replies')).rows).toHaveLength(1)
      const completed = z
        .strictObject({ result_json: GenerationResultSchema })
        .parse(
          (await db.adminQuery('SELECT result_json FROM generation_tasks')).rows[0]
        ).result_json
      const draft = completed.draft!
      if (result.status !== 'recorded') throw new Error('expected_recorded_send')
      const permit = ledger.central.get(result.record.executionId)!.permit!
      expect(permit).toBeDefined()
      expect(ledger.central.get(result.record.executionId)?.phase).toBe('settled')
      expect(await registration.issueExecution(completed.task, draft, lease.version)).toMatchObject(
        { permitId: permit.permitId, newlyIssued: false }
      )
      const receipt = {
        permitId: permit.permitId,
        draftHash: draft.draftHash,
        status: 'confirmed' as const,
        sourceMessageId: 'synthetic-new-echo',
        verificationProofHash: hashContext('synthetic-adapter-proof')
      }
      expect(await registration.settleExecution(completed.task.identity, receipt)).toEqual({
        status: 'confirmed'
      })
      expect(await registration.settleExecution(completed.task.identity, receipt)).toEqual({
        status: 'confirmed'
      })
    } finally {
      await agent.pause()
      ledger.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 10000)
})

describe('production model recording and shared account quota with synthetic HTTP providers', () => {
  it('records only pre/post decisions for employee edits and never grants automatic sending', async () => {
    const f = await recorded(2)
    const result = await service.reviewEdited(token, {
      generation: input,
      edit: { text: '支持离线阅读。', draftRevision: 2, evidenceIds: ['faq'] }
    })
    expect(result).toMatchObject({ status: 'candidate', automaticAllowed: false })
    expect((await f.rows()).map((row) => row.stage)).toEqual(['pre', 'post'])
    expect(f.textHttp).not.toHaveBeenCalled()
    expect(
      (await db.db.transaction('company', (sql) => sql.query('SELECT * FROM reviewed_replies')))
        .rows
    ).toEqual([])
  })
  it('rejects a candidate with no recorded provider attempts even if a substituted pipeline says it passed', async () => {
    const f = await recorded(5)
    const unrecorded = new GenerationService(
      authority,
      execution,
      new JevReplyPipeline({ evaluate }, generator),
      f.version,
      10,
      f.meter
    )
    await expect(unrecorded.generate(token, input)).rejects.toThrow('RECORD_UNAVAILABLE')
    expect(await f.rows()).toEqual([])
    expect(
      (await db.db.transaction('company', (sql) => sql.query('SELECT * FROM reviewed_replies')))
        .rows
    ).toEqual([])
    expect(
      (
        await db.db.transaction('company', (sql) =>
          sql.query('SELECT status FROM generation_tasks')
        )
      ).rows
    ).toEqual([{ status: 'failed' }])
  })
  it('returns an explicit quota handoff through the actual generation HTTP route without sending', async () => {
    const f = await recorded(0)
    const server = createServer(createApplication(authority, { execution, generation: service }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/replies/generate`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(input)
        }
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        status: 'handoff',
        automaticAllowed: false,
        reasons: ['model_call_limit_reached']
      })
      expect(f.jevHttp).not.toHaveBeenCalled()
      expect(f.textHttp).not.toHaveBeenCalled()
      expect(await f.rows()).toEqual([])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  async function recorded(limit?: number, decisionHttp?: typeof fetch) {
    const meter = new ModelCallAuthority(db.db, authority)
    const jevHttp = vi.fn<typeof fetch>(
      decisionHttp ??
        (async (_url, init) => Response.json(decision(JSON.parse(init!.body as string))))
    )
    const textHttp = vi.fn<typeof fetch>(async () =>
      Response.json({
        model: 'synthetic-text',
        usage: { prompt_tokens: 100, completion_tokens: 20 },
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({ text: '支持离线阅读。', evidenceIds: ['faq'] })
            }
          }
        ]
      })
    )
    const text = new HttpTextGenerator({
      apiKey: 'synthetic-secret',
      baseUrl: 'https://synthetic.invalid/v1/',
      model: 'synthetic-text',
      expectedModel: 'synthetic-text',
      fetch: meter.transport('text', textHttp, 'synthetic-text')
    })
    const pipeline = new JevReplyPipeline(
      new TypeSafeClient({
        apiKey: 'synthetic-secret',
        fetch: meter.transport('jev', jevHttp),
        retryDelayMs: 0
      }),
      text
    )
    publication.configuration.configVersion = 'recorded-config'
    publication.textGeneratorVersion = text.version
    input.task.configVersion = 'recorded-config'
    await savePublication(authority, execution, token, publication)
    if (limit !== undefined)
      await db.adminQuery(
        'INSERT INTO model_call_limits(tenant_id,account_id,daily_attempt_limit,revision) VALUES($1,$2,$3,1)',
        ['company', 'account-A', limit]
      )
    service = new GenerationService(authority, execution, pipeline, text.version, 10, meter)
    const rows = async () =>
      (
        await db.db.transaction('company', (sql) =>
          sql.query(
            `SELECT a.*,r.result_json FROM model_call_attempts a LEFT JOIN model_call_results r ON (a.tenant_id,a.account_id,a.id)=(r.tenant_id,r.account_id,r.attempt_id) ORDER BY a.started_at,a.id`
          )
        )
      ).rows
    return { meter, jevHttp, textHttp, rows, version: text.version }
  }
  it('records the complete pre/text/post chain and cache reuse consumes no extra quota', async () => {
    const f = await recorded(3)
    const result = await service.generate(token, input)
    expect(result.automaticAllowed).toBe(true)
    const runs = await f.rows()
    expect(runs.map((r) => r.stage)).toEqual(['pre', 'text', 'post'])
    expect(runs.map((r) => r.result_json.usage)).toEqual([
      { inputTokens: 10, outputTokens: 5 },
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 10, outputTokens: 5 }
    ])
    expect(
      runs.every(
        (r) =>
          r.task_hash === hashContext(input.task) &&
          r.config_version === 'recorded-config' &&
          r.limit_revision === 1
      )
    ).toBe(true)
    expect(JSON.stringify(runs)).not.toMatch(/synthetic-secret|支持离线吗|支持离线阅读/)
    expect(
      (
        await db.db.transaction('company', (sql) =>
          sql.query('SELECT count(*)::integer AS count FROM decision_runs')
        )
      ).rows[0].count
    ).toBe(2)
    expect(
      (
        await db.db.transaction('company', (sql) =>
          sql.query('SELECT review_json FROM draft_reviews')
        )
      ).rows[0].review_json.draftHash
    ).toBe(result.draft!.draftHash)
    expect(await service.generate(token, input)).toEqual(result)
    expect(await f.rows()).toHaveLength(3)
    expect(f.jevHttp).toHaveBeenCalledTimes(2)
    expect(f.textHttp).toHaveBeenCalledOnce()
  })
  it('requires a configured account quota before any provider request', async () => {
    const f = await recorded()
    expect(await service.generate(token, input)).toMatchObject({
      status: 'handoff',
      automaticAllowed: false,
      reasons: ['model_call_limit_unconfigured']
    })
    expect(f.jevHttp).not.toHaveBeenCalled()
    expect(f.textHttp).not.toHaveBeenCalled()
    expect(await f.rows()).toEqual([])
  })
  it('stops before the unaffordable next stage and preserves all already reserved requests', async () => {
    const f = await recorded(2)
    expect(await service.generate(token, input)).toMatchObject({
      status: 'handoff',
      automaticAllowed: false,
      reasons: ['model_call_limit_reached']
    })
    expect((await f.rows()).map((r) => r.stage)).toEqual(['pre', 'text'])
    expect(f.jevHttp).toHaveBeenCalledOnce()
    expect(f.textHttp).toHaveBeenCalledOnce()
    const candidates = await db.db.transaction('company', (sql) =>
      sql.query('SELECT * FROM reviewed_replies')
    )
    expect(candidates.rows).toEqual([])
    const other = structuredClone(input)
    other.task.taskId = 'another-task'
    expect(await service.generate(token, other)).toMatchObject({
      status: 'handoff',
      reasons: ['model_call_limit_reached']
    })
    expect(await f.rows()).toHaveLength(2)
  })
  it('rechecks the learning snapshot before the next provider stage without reserving or dispatching a stale request', async () => {
    const repository = new EnterpriseLearningRepository(authority)
    const f = await recorded(10, async (_url, init) => {
      await repository.recordEpisode(token, input.task.conversationId, {
        sourceId: 'between-model-stages',
        topic: '离线阅读',
        startedAt: Date.now(),
        messages: [],
        outcome: 'unknown'
      })
      return Response.json(decision(JSON.parse(String(init?.body))))
    })
    input.task = await service.prepare(token, input)
    await expect(service.generate(token, input)).rejects.toMatchObject({
      code: 'CONFIGURATION_CHANGED'
    })
    expect((await f.rows()).map((row) => row.stage)).toEqual(['pre'])
    expect(f.jevHttp).toHaveBeenCalledOnce()
    expect(f.textHttp).not.toHaveBeenCalled()
    expect((await db.adminQuery('SELECT * FROM reviewed_replies')).rows).toHaveLength(0)
  })
  it('counts a retried error independently and shares the quota with a second authority instance', async () => {
    let attempts = 0
    const f = await recorded(4, async (_url, init) =>
      ++attempts === 1
        ? new Response('private-error', { status: 503 })
        : Response.json(decision(JSON.parse(init!.body as string)))
    )
    expect((await service.generate(token, input)).automaticAllowed).toBe(true)
    const rows = await f.rows()
    expect(rows.map((r) => [r.stage, r.attempt_number])).toEqual([
      ['pre', 1],
      ['pre', 2],
      ['text', 1],
      ['post', 1]
    ])
    expect(rows[0].result_json).toMatchObject({ outcome: 'error', failureCode: 'UNAVAILABLE' })
    expect(rows[0].result_json.usage).toBeUndefined()
    const secondMeter = new ModelCallAuthority(db.db, authority)
    const blockedHttp = vi.fn<typeof fetch>()
    const second = new GenerationService(
      authority,
      execution,
      new JevReplyPipeline(
        new TypeSafeClient({
          apiKey: 'synthetic',
          fetch: secondMeter.transport('jev', blockedHttp)
        }),
        generator
      ),
      f.version,
      10,
      secondMeter
    )
    const other = structuredClone(input)
    other.task.taskId = 'second-worker-task'
    expect(await second.generate(token, other)).toMatchObject({
      status: 'handoff',
      reasons: ['model_call_limit_reached']
    })
    expect(blockedHttp).not.toHaveBeenCalled()
    expect(await f.rows()).toHaveLength(4)
  })
  it('does not release a candidate if a provider receipt cannot be persisted', async () => {
    const f = await recorded(10)
    await db.adminExec(`CREATE FUNCTION fail_model_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_receipt_failure'; END $$;
      CREATE TRIGGER fail_model_receipt BEFORE INSERT ON model_call_results FOR EACH ROW EXECUTE FUNCTION fail_model_receipt();`)
    try {
      expect(await service.generate(token, input)).toMatchObject({
        status: 'invalid',
        automaticAllowed: false,
        reasons: ['model_call_record_unavailable']
      })
      expect(f.jevHttp).toHaveBeenCalledOnce()
      expect(f.textHttp).not.toHaveBeenCalled()
      const rows = await f.rows()
      expect(rows).toHaveLength(1)
      expect(rows[0].result_json).toBeNull()
      expect(
        (await db.db.transaction('company', (sql) => sql.query('SELECT * FROM reviewed_replies')))
          .rows
      ).toEqual([])
    } finally {
      await db.adminExec(
        'DROP TRIGGER fail_model_receipt ON model_call_results; DROP FUNCTION fail_model_receipt()'
      )
    }
  })
  it('still appends a receipt after central pause or device revocation without granting candidate authority', async () => {
    const response = deferred<Response>()
    const f = await recorded(10, async () => response.promise)
    const pending = service.generate(token, input)
    await vi.waitFor(() => expect(f.jevHttp).toHaveBeenCalledOnce())
    await db.adminExec(
      'UPDATE accounts SET paused=true; UPDATE agents SET revoked_at=clock_timestamp();'
    )
    response.resolve(
      Response.json(
        decision({
          model: 'jev-test',
          state: {},
          questions: (JSON.parse(f.jevHttp.mock.calls[0][1]!.body as string) as JevRequest)
            .questions
        })
      )
    )
    await expect(pending).rejects.toThrow()
    const rows = await f.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0].result_json.outcome).toBe('response')
    expect(f.textHttp).not.toHaveBeenCalled()
    expect(
      (await db.db.transaction('company', (sql) => sql.query('SELECT * FROM reviewed_replies')))
        .rows
    ).toEqual([])
  })
  it('prevents service mutation/deletion and raw insertion beyond the database quota', async () => {
    const f = await recorded(3)
    await service.generate(token, input)
    for (const statement of [
      'UPDATE model_call_limits SET daily_attempt_limit=100',
      'UPDATE model_call_attempts SET attempt_number=8',
      'DELETE FROM model_call_attempts',
      "UPDATE model_call_results SET result_json='{}'",
      'DELETE FROM model_call_results'
    ])
      await expect(db.db.transaction('company', (sql) => sql.query(statement))).rejects.toThrow(
        /permission denied/i
      )
    await expect(
      db.db.transaction('company', (sql) =>
        sql.query(
          `INSERT INTO model_call_attempts SELECT tenant_id,account_id,$1,agent_id,task_id,task_hash,provider,stage,99,request_hash,requested_model,question_hash,config_version,policy_version,question_set_version,knowledge_version,limit_revision,usage_day,started_at FROM model_call_attempts LIMIT 1`,
          [randomUUID()]
        )
      )
    ).rejects.toThrow(/model_call_(?:not_authorized|limit_reached)/)
    expect(await f.rows()).toHaveLength(3)
  })
})
