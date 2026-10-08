import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { EnterpriseLearningRepository } from '../../server/src/learning/learning-repository'
import type { MemoryProposal } from '../../src/shared/contracts/learning-memory'
import {
  savePublication,
  loadPublication,
  type Publication
} from '../../server/src/generation/publication'
import { ExecutionAuthority } from '../../server/src/execution/execution-authority'
import {
  loadEnterpriseMemoryCatalog,
  EMPTY_ENTERPRISE_MEMORY_VERSION
} from '../../server/src/learning/learning-publication'
import { evaluationSnapshotHash } from '../../server/src/generation/evaluation-authorization'
import { seedSyntheticApproval } from '../fixtures/evaluation-approval'

const credentials = ['A'.repeat(43), 'B'.repeat(43), 'C'.repeat(43)]
let db: Awaited<ReturnType<typeof embeddedPostgres>>,
  repository: EnterpriseLearningRepository,
  now: number
beforeAll(async () => {
  db = await embeddedPostgres()
  await db.adminExec(
    "INSERT INTO tenants(id,name) VALUES('company','合成企业'),('other','合成其他企业'); INSERT INTO employees(tenant_id,id,role) VALUES('company','employee-A','employee'),('company','employee-B','employee'),('other','employee-C','employee'); INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','shared-account','employee-A','wework',false),('company','second-account','employee-B','wework',false),('other','shared-account','employee-C','wework',false)"
  )
  for (const [i, id] of ['A', 'B', 'C'].entries())
    await db.adminQuery(
      'INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES($1,$2,$3,$4,$5)',
      [
        i === 2 ? 'other' : 'company',
        `agent-${id}`,
        i === 1 ? 'second-account' : 'shared-account',
        `employee-${id}`,
        tokenHash(credentials[i])
      ]
    )
  repository = new EnterpriseLearningRepository(new AccountAuthority(db.db), { now: () => now })
}, 20000)
afterAll(async () => {
  if (db) await db.db.close()
})
beforeEach(async () => {
  now = Date.now()
  await db.adminExec(
    'TRUNCATE learning_context_epochs,learning_preparations,learning_versions,learning_episodes,learning_memories,learning_settings,learning_feedback,learning_generations,learning_tombstones,learning_mutations,generation_publications,published_configurations,evaluation_runs CASCADE'
  )
})
async function method(
  credential = credentials[0],
  conversationId: string | null = 'customer-A',
  guidance = '先确认型号和数量'
) {
  const episode = await repository.recordEpisode(credential, conversationId, {
    sourceId: `source-${guidance}`,
    topic: '设备询价',
    startedAt: now,
    messages: [],
    outcome: 'corrected',
    identityStatus: 'verified'
  })
  const proposal: MemoryProposal = {
    content: {
      kind: 'lesson',
      scenario: '设备询价',
      guidance,
      rationale: '',
      steps: [],
      pitfalls: [],
      verification: []
    },
    evidence: [{ episodeId: episode.id }],
    source: 'review',
    reason: '合成员工纠正'
  }
  const memory = await repository.propose(credential, conversationId, proposal)
  await repository.activate(credential, conversationId, memory.id, 1)
  return { episode, memory, proposal }
}
describe('enterprise-authoritative learning storage', () => {
  it('binds explicitly empty publication, refuses a forged manifest and invalidates it after the first method is activated', async () => {
    const authority = repository.authority,
      execution = new ExecutionAuthority(authority, async (client, scope) => {
        await loadPublication(client, scope)
      })
    const publication: Publication = {
      configuration: {
        configVersion: 'config-1',
        knowledgeVersion: 'knowledge-1',
        decisionPolicyVersion: 'policy-1',
        questionSetVersion: 'questions-1',
        modelResolved: 'jev-test',
        automaticEnabled: false
      },
      textGeneratorVersion: 'fixture-generator',
      evidence: [],
      policy: {
        version: 'policy-1',
        questionSetVersion: 'questions-1',
        knowledgeVersion: 'knowledge-1',
        modelResolved: 'jev-test',
        modelAlias: 'fixture',
        mode: 'shadow',
        evaluationApproved: false,
        automaticIntents: [],
        minimumChoiceProbability: 0.9,
        minimumChoiceConfidence: 0.9,
        minimumChoiceMargin: 0.3,
        presentIntentProbability: 0.9,
        humanRequestThreshold: 0.1,
        minimumAuditProbability: 0.95,
        reviewValidityMs: 5000,
        preBudgetMs: 1000,
        postBudgetMs: 1000
      }
    }
    await savePublication(authority, execution, credentials[0], publication)
    expect(
      await authority.withLockedAccount(credentials[0], (client, scope) =>
        loadPublication(client, scope)
      )
    ).toMatchObject({ memoryCorpusVersion: EMPTY_ENTERPRISE_MEMORY_VERSION, memoryManifest: [] })
    const { memory } = await method()
    await expect(
      authority.withLockedAccount(credentials[0], (client, scope) => loadPublication(client, scope))
    ).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
    const catalog = await authority.withLockedAccount(credentials[0], (client, scope) =>
      loadEnterpriseMemoryCatalog(client, scope)
    )
    const updated: Publication = {
      ...publication,
      configuration: { ...publication.configuration, configVersion: 'config-2' },
      memoryCorpusVersion: catalog.memoryCorpusVersion,
      memoryManifest: catalog.memoryManifest
    }
    await expect(
      savePublication(authority, execution, credentials[0], {
        ...updated,
        memoryManifest: [{ id: memory.id, revision: 1, contentHash: '0'.repeat(64) }]
      })
    ).rejects.toMatchObject({ code: 'TASK_CONFLICT' })
    expect(evaluationSnapshotHash(updated)).not.toBe(evaluationSnapshotHash(publication))
    await savePublication(authority, execution, credentials[0], updated)
    expect(
      await authority.withLockedAccount(credentials[0], (client, scope) =>
        loadPublication(client, scope)
      )
    ).toMatchObject({
      memoryCorpusVersion: catalog.memoryCorpusVersion,
      memoryManifest: catalog.memoryManifest
    })
    const before = catalog.memoryCorpusVersion
    await repository.recordEpisode(credentials[0], 'customer-A', {
      sourceId: 'unknown-new-draft',
      topic: '设备询价',
      startedAt: now,
      draft: '未知结果',
      messages: [],
      outcome: 'unknown'
    })
    expect(
      (
        await authority.withLockedAccount(credentials[0], (client, scope) =>
          loadEnterpriseMemoryCatalog(client, scope)
        )
      ).memoryCorpusVersion
    ).toBe(before)
    await repository.forgetScope(credentials[0], 'customer-A')
    await expect(
      authority.withLockedAccount(credentials[0], (client, scope) => loadPublication(client, scope))
    ).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
  })
  it('isolates tenant/account/conversation and retrieves only the account parent plus the exact customer', async () => {
    const customer = await method(),
      account = await method(credentials[0], null, '查有效设备询价资料')
    const snapshot = await repository.retrieve(credentials[0], 'customer-A', '设备询价')
    expect(snapshot.items.map((item) => item.id).sort()).toEqual(
      [customer.memory.id, account.memory.id].sort()
    )
    expect(
      (await repository.retrieve(credentials[0], 'customer-B', '设备询价')).items.map(
        (item) => item.id
      )
    ).toEqual([account.memory.id])
    for (const credential of credentials.slice(1)) {
      expect((await repository.retrieve(credential, 'customer-A', '设备询价')).items).toEqual([])
      await expect(repository.get(credential, 'customer-A', customer.memory.id)).rejects.toThrow(
        'memory_not_found'
      )
    }
    expect(snapshot.scope).toMatchObject({
      tenantId: 'company',
      accountId: 'shared-account',
      platform: 'wework',
      conversationId: 'customer-A'
    })
    expect(snapshot.scope.workspaceId).toMatch(/^enterprise:/)
  })
  it('requires a fresh independent evaluation approval when published methods change', async () => {
    const authority = repository.authority
    const execution = new ExecutionAuthority(authority, async (client, scope) => {
      await loadPublication(client, scope)
    })
    const publication: Publication = {
      configuration: {
        configVersion: 'evaluated-config',
        knowledgeVersion: 'knowledge-1',
        decisionPolicyVersion: 'policy-1',
        questionSetVersion: 'questions-1',
        modelResolved: 'jev-test',
        automaticEnabled: true
      },
      textGeneratorVersion: 'fixture-generator',
      evidence: [],
      policy: {
        version: 'policy-1',
        questionSetVersion: 'questions-1',
        knowledgeVersion: 'knowledge-1',
        modelResolved: 'jev-test',
        modelAlias: 'fixture',
        mode: 'enforced',
        evaluationApproved: true,
        automaticIntents: [],
        minimumChoiceProbability: 0.9,
        minimumChoiceConfidence: 0.9,
        minimumChoiceMargin: 0.3,
        presentIntentProbability: 0.9,
        humanRequestThreshold: 0.1,
        minimumAuditProbability: 0.95,
        reviewValidityMs: 5000,
        preBudgetMs: 1000,
        postBudgetMs: 1000
      }
    }
    const approved = await seedSyntheticApproval(db, publication, 'company', 'shared-account')
    await savePublication(authority, execution, credentials[0], approved)
    expect(
      await authority.withLockedAccount(credentials[0], (client, scope) =>
        loadPublication(client, scope)
      )
    ).toMatchObject({ evaluationApprovalId: approved.evaluationApprovalId })
    await method()
    const catalog = await authority.withLockedAccount(credentials[0], (client, scope) =>
      loadEnterpriseMemoryCatalog(client, scope)
    )
    // Keep the other executable settings identical: the method catalogue alone must invalidate approval.
    const changed: Publication = { ...approved, ...catalog }
    await expect(
      savePublication(authority, execution, credentials[0], changed)
    ).rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' })
    const next = await seedSyntheticApproval(
      db,
      {
        ...changed,
        configuration: { ...changed.configuration, configVersion: 'evaluated-config-next' }
      },
      'company',
      'shared-account'
    )
    expect(next.evaluationApprovalId).not.toBe(approved.evaluationApprovalId)
    await savePublication(authority, execution, credentials[0], next)
    expect(
      await authority.withLockedAccount(credentials[0], (client, scope) =>
        loadPublication(client, scope)
      )
    ).toMatchObject({
      evaluationApprovalId: next.evaluationApprovalId,
      memoryManifest: catalog.memoryManifest
    })
  })
  it('rejects client scope fields and evidence from a different customer', async () => {
    await expect(
      repository.recordEpisode(credentials[0], 'customer-A', {
        sourceId: 'forged',
        topic: '设备询价',
        startedAt: now,
        messages: [],
        outcome: 'corrected',
        tenantId: 'other'
      } as never)
    ).rejects.toThrow()
    const { proposal } = await method()
    await expect(repository.propose(credentials[0], 'customer-B', proposal)).rejects.toThrow(
      'memory_evidence_unavailable'
    )
  })
  it('keeps V1 active while V2 is pending and records rollback as a new human revision', async () => {
    const { memory, proposal } = await method()
    await repository.revise(credentials[0], 'customer-A', memory.id, 1, {
      ...proposal,
      content: { ...proposal.content, guidance: '一次核对设备型号数量和用途' }
    })
    expect(
      (await repository.retrieve(credentials[0], 'customer-A', '设备询价')).items[0]
    ).toMatchObject({ revision: 1, content: { guidance: proposal.content.guidance } })
    await repository.activate(credentials[0], 'customer-A', memory.id, 2)
    expect(await repository.rollback(credentials[0], 'customer-A', memory.id, 2, 1)).toMatchObject({
      currentRevision: 3,
      activeRevision: 3
    })
    expect(
      (await repository.history(credentials[0], 'customer-A', memory.id)).map(
        (entry) => entry.source
      )
    ).toEqual(['review', 'review', 'human'])
  })
  it('enforces compare-and-swap for simultaneous revision attempts', async () => {
    const { memory, proposal } = await method()
    const results = await Promise.allSettled(
      ['A', 'B'].map((label) =>
        repository.revise(credentials[0], 'customer-A', memory.id, 1, {
          ...proposal,
          content: { ...proposal.content, guidance: `先确认需求-${label}` }
        })
      )
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await repository.history(credentials[0], 'customer-A', memory.id)).toHaveLength(2)
  })
  it('inherits account controls and prevents a child scope from overriding off or disabled reading', async () => {
    await method()
    await repository.settings(credentials[0], null, { mode: 'off', memoryEnabled: false })
    await repository.settings(credentials[0], 'customer-A', { mode: 'auto', memoryEnabled: true })
    expect(await repository.settings(credentials[0], 'customer-A')).toMatchObject({
      mode: 'off',
      memoryEnabled: false
    })
    expect((await repository.retrieve(credentials[0], 'customer-A', '设备询价')).items).toEqual([])
  })
  it('protects pinned methods from maintenance and restores an archived method only while its evidence is usable', async () => {
    const { memory, proposal } = await method()
    await repository.setPinned(credentials[0], 'customer-A', memory.id, 1, true)
    await expect(
      repository.revise(credentials[0], 'customer-A', memory.id, 1, proposal)
    ).rejects.toThrow('memory_pinned')
    await expect(
      repository.archive(credentials[0], 'customer-A', memory.id, 1, 'curator')
    ).rejects.toThrow('memory_pinned')
    await repository.archive(credentials[0], 'customer-A', memory.id, 1, 'human')
    expect((await repository.retrieve(credentials[0], 'customer-A', '设备询价')).items).toEqual([])
    await repository.restore(credentials[0], 'customer-A', memory.id, 1)
    expect(await repository.get(credentials[0], 'customer-A', memory.id)).toMatchObject({
      state: 'active',
      pinned: true,
      activeRevision: 1
    })
    await repository.archive(credentials[0], 'customer-A', memory.id, 1, 'human')
    await repository.settings(credentials[0], 'customer-A', { caseRetentionDays: 7 })
    now += 8 * 86400000
    await repository.restore(credentials[0], 'customer-A', memory.id, 1)
    expect(await repository.get(credentials[0], 'customer-A', memory.id)).toMatchObject({
      state: 'stale',
      pinned: true
    })
    await expect(
      repository.setPinned(credentials[0], 'customer-A', memory.id, 2, false)
    ).rejects.toThrow('memory_revision_conflict')
  })
  it('forgets every method revision and its saved usage, rejecting late feedback and content replay', async () => {
    const { memory, proposal, episode } = await method()
    await repository.registerGeneration(
      credentials[0],
      'customer-A',
      'forgotten-generation',
      episode.id,
      [{ id: memory.id, revision: 1 }]
    )
    const updated = {
      ...proposal,
      content: { ...proposal.content, guidance: '另一条需要遗忘的流程' }
    }
    await repository.revise(credentials[0], 'customer-A', memory.id, 1, updated)
    await repository.forget(credentials[0], 'customer-A', memory.id, 2)
    await expect(repository.get(credentials[0], 'customer-A', memory.id)).rejects.toThrow(
      'memory_not_found'
    )
    for (const input of [proposal, updated])
      await expect(repository.propose(credentials[0], 'customer-A', input)).rejects.toThrow(
        'memory_forgotten'
      )
    await expect(
      repository.feedback(credentials[0], 'customer-A', 'forgotten-generation', {
        sourceId: 'late-error',
        kind: 'fact_error',
        reason: '迟到错误',
        memoryId: memory.id
      })
    ).rejects.toThrow('generation_not_found')
    await expect(
      repository.registerGeneration(
        credentials[0],
        'customer-A',
        'forgotten-generation',
        episode.id,
        []
      )
    ).rejects.toThrow('generation_forgotten')
    for (const table of [
      'learning_revisions',
      'learning_mutations',
      'learning_generations',
      'learning_feedback'
    ]) {
      expect(
        (await db.adminQuery(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0]
      ).toMatchObject({ n: 0 })
    }
  })
  it('forgets bodies and prevents old sources from replaying while retaining a changed empty context version', async () => {
    const { episode } = await method()
    const before = await repository.retrieve(credentials[0], 'customer-A', '设备询价')
    await repository.forgetScope(credentials[0], 'customer-A')
    const after = await repository.retrieve(credentials[0], 'customer-A', '设备询价')
    expect(after.items).toEqual([])
    expect(after.corpusVersion).not.toBe(before.corpusVersion)
    await expect(
      repository.recordEpisode(credentials[0], 'customer-A', {
        sourceId: episode.sourceId,
        topic: episode.topic,
        startedAt: episode.startedAt,
        messages: [],
        outcome: episode.outcome,
        identityStatus: 'verified'
      })
    ).rejects.toThrow('episode_forgotten')
    expect(await repository.episodes(credentials[0], 'customer-A')).toEqual([])
  })
  it('excludes expired case evidence before cleanup and removes source bodies without discarding revision history', async () => {
    const { memory } = await method()
    await repository.settings(credentials[0], 'customer-A', { caseRetentionDays: 7 })
    now += 8 * 86400000
    expect((await repository.retrieve(credentials[0], 'customer-A', '设备询价')).items).toEqual([])
    expect(await repository.pruneExpired(credentials[0], 'customer-A')).toMatchObject({
      deletedEpisodes: 1
    })
    expect(await repository.episodes(credentials[0], 'customer-A')).toEqual([])
    expect(await repository.get(credentials[0], 'customer-A', memory.id)).toMatchObject({
      state: 'stale'
    })
    expect(
      (await repository.history(credentials[0], 'customer-A', memory.id))[0].redactedEvidenceIds
    ).toHaveLength(1)
    await expect(repository.activate(credentials[0], 'customer-A', memory.id, 1)).rejects.toThrow(
      'memory_evidence_unavailable'
    )
  })
  it('purges customer usage references when their account method is forgotten, preserving unrelated generations', async () => {
    const accountMethod = await method(credentials[0], null, '账号方法')
    const customerMethod = await method(credentials[0], 'customer-A', '客户独立方法')
    await repository.registerGeneration(
      credentials[0],
      'customer-A',
      'uses-account-method',
      customerMethod.episode.id,
      [{ id: accountMethod.memory.id, revision: 1 }]
    )
    await repository.registerGeneration(
      credentials[0],
      'customer-A',
      'uses-customer-method',
      customerMethod.episode.id,
      [{ id: customerMethod.memory.id, revision: 1 }]
    )
    await repository.forgetScope(credentials[0], null)
    expect(
      (await db.adminQuery('SELECT generation_id FROM learning_generations ORDER BY generation_id'))
        .rows
    ).toEqual([{ generation_id: 'uses-customer-method' }])
    expect(
      (
        await db.adminQuery(
          "SELECT count(*)::int AS n FROM learning_feedback WHERE payload->'memoryRefs' @> $1::jsonb",
          [JSON.stringify([{ id: accountMethod.memory.id }])]
        )
      ).rows
    ).toEqual([{ n: 0 }])
    await expect(
      repository.feedback(credentials[0], 'customer-A', 'uses-account-method', {
        sourceId: 'late-forgotten-error',
        kind: 'fact_error',
        reason: '迟到反馈',
        memoryId: accountMethod.memory.id
      })
    ).rejects.toThrow('generation_not_found')
    await expect(
      repository.registerGeneration(
        credentials[0],
        'customer-A',
        'uses-account-method',
        customerMethod.episode.id,
        []
      )
    ).rejects.toThrow('generation_forgotten')
    expect(
      await repository.get(credentials[0], 'customer-A', customerMethod.memory.id)
    ).toMatchObject({ state: 'active', activeRevision: 1 })
  })
  it('counts redacted revision references rather than unrelated expired episodes', async () => {
    const { memory, proposal } = await method()
    await repository.revise(credentials[0], 'customer-A', memory.id, 1, {
      ...proposal,
      content: { ...proposal.content, guidance: '第二版处理方法' }
    })
    await repository.recordEpisode(credentials[0], 'customer-A', {
      sourceId: 'unused-source',
      topic: '未引用的案例',
      startedAt: now,
      messages: [],
      outcome: 'unknown'
    })
    await repository.recordEpisode(credentials[0], 'customer-A', {
      sourceId: 'another-unused-source',
      topic: '另一条未引用案例',
      startedAt: now,
      messages: [],
      outcome: 'unknown'
    })
    await repository.settings(credentials[0], 'customer-A', { caseRetentionDays: 7 })
    now += 8 * 86400000
    // One source is referenced by two revisions; the other two expired sources have no references.
    expect(await repository.pruneExpired(credentials[0], 'customer-A')).toMatchObject({
      deletedEpisodes: 3,
      redactedEvidence: 2,
      invalidatedMethods: [memory.id]
    })
    expect(await repository.pruneExpired(credentials[0], 'customer-A')).toMatchObject({
      deletedEpisodes: 0,
      redactedEvidence: 0,
      invalidatedMethods: []
    })
  })
  it('quarantines the actual used revision and keeps a newer active revision available', async () => {
    const { memory, episode, proposal } = await method()
    await repository.registerGeneration(credentials[0], 'customer-A', 'generation-1', episode.id, [
      { id: memory.id, revision: 1 }
    ])
    await repository.revise(credentials[0], 'customer-A', memory.id, 1, {
      ...proposal,
      content: { ...proposal.content, guidance: '核对资料出处和型号数量' }
    })
    await repository.activate(credentials[0], 'customer-A', memory.id, 2)
    await repository.feedback(credentials[0], 'customer-A', 'generation-1', {
      sourceId: 'employee-error',
      kind: 'fact_error',
      reason: '旧方法错误',
      memoryId: memory.id
    })
    expect(await repository.get(credentials[0], 'customer-A', memory.id)).toMatchObject({
      state: 'active',
      activeRevision: 2
    })
    await expect(
      repository.rollback(credentials[0], 'customer-A', memory.id, 2, 1)
    ).rejects.toThrow('memory_revision_quarantined')
    await expect(
      repository.feedback(credentials[0], 'customer-A', 'generation-1', {
        sourceId: 'forged-ref',
        kind: 'fact_error',
        reason: '伪造实际使用引用',
        memoryId: 'unloaded-method'
      })
    ).rejects.toThrow('feedback_memory_not_loaded')
  })
})
