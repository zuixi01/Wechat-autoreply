import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { tokenHash, AccountAuthority } from '../../server/src/auth/account-authority'
import { EnterpriseLearningWorkerAuthority } from '../../server/src/learning/learning-worker-authority'
import { EnterpriseLearningRepository } from '../../server/src/learning/learning-repository'
import { EnterpriseLearningValidationStore } from '../../server/src/learning/learning-validation-store'
import { LearningValidator } from '../../src/core/memory/learning-validation'
import { memorySemanticUnits } from '../../src/core/memory/learning-risk'
import type {
  LearningValidationCase,
  MemoryRevision
} from '../../src/shared/contracts/learning-memory'

const credential = 'V'.repeat(43)
const references = [randomUUID(), randomUUID()]
let db: Awaited<ReturnType<typeof embeddedPostgres>>, now: number
let repository: EnterpriseLearningRepository<EnterpriseLearningWorkerAuthority>
let validation: EnterpriseLearningValidationStore
const cases = (): LearningValidationCase[] =>
  Array.from({ length: 5 }, (_, index) => ({
    caseId: `calibration-${index}`,
    conversationId: `independent-${index}`,
    input: '客户要求报价',
    expectedMethod: '询问型号和数量',
    requiredTerms: ['型号', '数量'],
    forbiddenClaims: ['保证退款'],
    humanLabelled: true,
    labelOrigin: 'human' as const // Simulated human declaration for engineering tests only.
  }))
beforeAll(async () => {
  db = await embeddedPostgres('autoreply_learning_worker')
  await db.adminExec(
    "INSERT INTO tenants(id,name) VALUES('company','合成企业'); INSERT INTO employees(tenant_id,id,role) VALUES('company','employee','employee'); INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','account-A','employee','wework',false),('company','account-B','employee','wework',false)"
  )
  const login = ((await db.adminQuery('SELECT session_user AS login')).rows[0] as { login: string })
    .login
  for (const [index, account] of ['account-A', 'account-B'].entries()) {
    await db.adminQuery(
      'INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES($1,$2,$3,$4,$5)',
      [
        'company',
        `agent-${index}`,
        account,
        'employee',
        tokenHash(index ? 'W'.repeat(43) : credential)
      ]
    )
    await db.adminQuery(
      'INSERT INTO learning_worker_bindings(id,login_name,tenant_id,account_id,employee_id,agent_id,agent_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        references[index],
        login,
        'company',
        account,
        'employee',
        `agent-${index}`,
        tokenHash(index ? 'W'.repeat(43) : credential)
      ]
    )
  }
  const authority = new EnterpriseLearningWorkerAuthority(db.db)
  repository = new EnterpriseLearningRepository(authority, { now: () => now })
  validation = new EnterpriseLearningValidationStore(authority, {
    now: () => now,
    validatorVersion: 'validator-1'
  })
}, 20000)
afterAll(async () => {
  if (db) await db.db.close()
})
beforeEach(async () => {
  now = Date.now()
  await db.adminExec(
    'TRUNCATE learning_context_epochs,learning_preparations,learning_versions,learning_episodes,learning_memories,learning_settings,learning_feedback,learning_generations,learning_tombstones,learning_mutations,learning_calibration_sets,learning_validation_environments,learning_activation_grants,learning_validation_reports,published_configurations CASCADE; UPDATE agents SET revoked_at=NULL; UPDATE accounts SET paused=false'
  )
  await db.adminExec(
    "INSERT INTO published_configurations(tenant_id,account_id,config_version,knowledge_version,policy_version,questions_version,model_resolved) VALUES('company','account-A','config-1','knowledge-1','policy-1','questions-1','synthetic'),('company','account-B','config-1','knowledge-1','policy-1','questions-1','synthetic')"
  )
})
async function candidate() {
  const episode = await repository.recordEpisode(references[0], 'training', {
    sourceId: 'correction',
    startedAt: now,
    topic: '报价',
    messages: [],
    correction: '先问型号和数量',
    outcome: 'corrected',
    identityStatus: 'verified'
  })
  return repository.propose(references[0], 'training', {
    content: {
      kind: 'skill',
      scenario: '报价前确认需求',
      guidance: '先询问型号和数量，再查询有效资料',
      rationale: '',
      steps: ['询问型号和数量'],
      pitfalls: ['不要猜价格'],
      verification: ['需求已完整']
    },
    evidence: [{ episodeId: episode.id }],
    source: 'review',
    reason: '员工纠正'
  })
}
async function validate(id: string) {
  const port = await validation.bind(references[0], 'training')
  const data = await validation.calibration(references[0], 'training')
  let replayCount = 0
  const validator = new LearningValidator(port, {
    assessRisk: async (revision: MemoryRevision) => ({
      contentHash: revision.contentHash,
      units: memorySemanticUnits(revision.content).map((unit) => ({
        path: unit.path,
        category: 'method' as const,
        reason: '仅描述处理方法'
      }))
    }),
    replay: async () => {
      replayCount++
      return { text: '请提供具体型号和数量', covered: false, severeErrors: [] }
    }
  })
  const result = await validator.validate(
    {
      scope: port.scope,
      memoryId: id,
      revision: 1,
      cases: data.cases,
      knowledgeVersion: 'knowledge-1',
      policyVersion: 'policy-1'
    },
    new AbortController().signal
  )
  return { result, replayCount }
}
describe('enterprise calibration and activation authority', () => {
  it('rejects the exact expiry boundary and permits no consumption', async () => {
    const memory = await candidate()
    await validation.importCalibration(references[0], 'training', {
      cases: cases(),
      humanConfirmed: true
    })
    const { result } = await validate(memory.id)
    await repository.settings(references[0], 'training', { mode: 'auto' })
    now += 86400000
    await expect(
      validation.activateValidated(references[0], 'training', memory.id, 1, result.grantId!)
    ).rejects.toThrow('validation_grant_expired')
    expect(await validation.grants(references[0], 'training', memory.id)).toMatchObject([
      { usedAt: null }
    ])
  })
  it('reauthorizes a captured port after device revocation and rejects forged descriptors', async () => {
    const memory = await candidate()
    const port = await validation.bind(references[0], 'training')
    expect(() => port.get({ ...port.scope, accountId: 'account-B' }, memory.id)).toThrow(
      'learning_scope_mismatch'
    )
    await db.adminExec("UPDATE agents SET revoked_at=clock_timestamp() WHERE id='agent-0'")
    await expect(port.get(port.scope, memory.id)).rejects.toThrow('DENIED')
  })
  it('revokes a grant when learning is turned off and restored, or the account is paused', async () => {
    const memory = await candidate()
    await validation.importCalibration(references[0], 'training', {
      cases: cases(),
      humanConfirmed: true
    })
    const { result } = await validate(memory.id)
    await repository.settings(references[0], 'training', { mode: 'off' })
    await repository.settings(references[0], 'training', { mode: 'auto' })
    await expect(
      validation.activateValidated(references[0], 'training', memory.id, 1, result.grantId!)
    ).rejects.toThrow('validation_environment_changed')
    const fresh = await validate(memory.id)
    await db.adminExec("UPDATE accounts SET paused=true WHERE id='account-A'")
    await expect(
      validation.activateValidated(references[0], 'training', memory.id, 1, fresh.result.grantId!)
    ).rejects.toThrow('account_paused')
  })
  it('cannot issue a proof for training conversations or invented calibration identifiers', async () => {
    const memory = await candidate()
    await validation.importCalibration(references[0], 'training', {
      cases: cases(),
      humanConfirmed: true
    })
    const port = await validation.bind(references[0], 'training')
    const snapshot = await port.validation.capture(port.scope, memory.id, 1)
    await expect(
      port.validation.issue(snapshot, {
        baselineCovered: 0,
        candidateCovered: 5,
        caseIds: ['invented-1', 'invented-2', 'invented-3', 'invented-4', 'invented-5']
      })
    ).rejects.toThrow('validation_proof_invalid')
    await validation.importCalibration(references[0], 'training', {
      cases: cases().map((entry, index) => ({
        ...entry,
        conversationId: index ? entry.conversationId : 'training'
      })),
      humanConfirmed: true
    })
    expect(await validate(memory.id)).toMatchObject({
      result: { status: 'insufficient', reasons: ['calibration_training_overlap'] },
      replayCount: 0
    })
  })
  it('does not invoke replay or create a grant without human calibration evidence', async () => {
    const memory = await candidate()
    expect(await validate(memory.id)).toMatchObject({
      result: { status: 'insufficient' },
      replayCount: 0
    })
    expect(await validation.grants(references[0], 'training', memory.id)).toEqual([])
    expect(await repository.get(references[0], 'training', memory.id)).toMatchObject({
      state: 'pending',
      activeRevision: null
    })
  })
  it('persists an awaited grant after paired replay and atomically consumes it in auto mode', async () => {
    const memory = await candidate()
    await validation.importCalibration(references[0], 'training', {
      cases: cases(),
      humanConfirmed: true
    })
    const { result, replayCount } = await validate(memory.id)
    expect(result).toMatchObject({ status: 'passed', grantId: expect.any(String) })
    expect(replayCount).toBe(10)
    const restarted = new EnterpriseLearningValidationStore(repository.authority, {
      now: () => now,
      validatorVersion: 'validator-1'
    })
    expect(await restarted.grants(references[0], 'training', memory.id)).toMatchObject([
      {
        id: result.grantId,
        revision: 1,
        expiresAt: now + 86400000,
        usedAt: null,
        knowledgeVersion: 'knowledge-1',
        policyVersion: 'policy-1'
      }
    ])
    await repository.settings(references[0], 'training', { mode: 'auto' })
    expect(
      await restarted.activateValidated(references[0], 'training', memory.id, 1, result.grantId!)
    ).toMatchObject({ activeRevision: 1 })
    await expect(
      restarted.activateValidated(references[0], 'training', memory.id, 1, result.grantId!)
    ).rejects.toThrow('validation_grant_used')
    expect(await restarted.grants(references[0], 'training', memory.id)).toMatchObject([
      { usedAt: now }
    ])
  })
  it('does not refresh calibration retention on exact reimport and refuses model labelled cases', async () => {
    for (const labelOrigin of ['synthetic', 'model', undefined] as const) {
      await expect(
        validation.importCalibration(references[0], 'training', {
          cases: cases().map((entry) => ({ ...entry, humanLabelled: true, labelOrigin })),
          humanConfirmed: true
        })
      ).rejects.toThrow('calibration_human_labels_required')
      expect(await validation.calibration(references[0], 'training')).toEqual({ cases: [] })
    }
    const first = await validation.importCalibration(references[0], 'training', {
      cases: cases(),
      humanConfirmed: true
    })
    now += 1000
    expect(
      await validation.importCalibration(references[0], 'training', {
        cases: cases(),
        humanConfirmed: true
      })
    ).toMatchObject({ importedAt: first.importedAt, authorId: 'employee' })
    await expect(
      validation.importCalibration(references[0], 'training', {
        cases: cases().map((entry) => ({ ...entry, humanLabelled: false })),
        humanConfirmed: true
      })
    ).rejects.toThrow('calibration_human_labels_required')
    await repository.settings(references[0], 'training', { caseRetentionDays: 7 })
    now += 8 * 86400000
    expect(await validation.calibration(references[0], 'training')).toEqual({ cases: [] })
    await validation.pruneCalibration(references[0], 'training')
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_calibration_sets')).rows
    ).toEqual([{ n: 0 }])
  })
  it('revokes a grant after an actual publication changes and reverts between validation reads', async () => {
    const memory = await candidate()
    await validation.importCalibration(references[0], 'training', {
      cases: cases(),
      humanConfirmed: true
    })
    const { result } = await validate(memory.id)
    await db.adminExec(
      "UPDATE published_configurations SET knowledge_version='knowledge-2' WHERE account_id='account-A'; UPDATE published_configurations SET knowledge_version='knowledge-1' WHERE account_id='account-A'"
    )
    await repository.settings(references[0], 'training', { mode: 'auto' })
    await expect(
      validation.activateValidated(references[0], 'training', memory.id, 1, result.grantId!)
    ).rejects.toThrow('validation_environment_changed')
    expect(await repository.get(references[0], 'training', memory.id)).toMatchObject({
      activeRevision: null
    })
  })
  it('rolls back activation and grant consumption together if the audit write fails', async () => {
    const memory = await candidate()
    await validation.importCalibration(references[0], 'training', {
      cases: cases(),
      humanConfirmed: true
    })
    const { result } = await validate(memory.id)
    await repository.settings(references[0], 'training', { mode: 'auto' })
    await db.adminExec(
      "CREATE FUNCTION reject_validation_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected_activation_failure'; END $$; CREATE TRIGGER reject_validation_activation BEFORE INSERT ON learning_mutations FOR EACH ROW EXECUTE FUNCTION reject_validation_activation()"
    )
    try {
      await expect(
        validation.activateValidated(references[0], 'training', memory.id, 1, result.grantId!)
      ).rejects.toThrow('injected_activation_failure')
      expect(await repository.get(references[0], 'training', memory.id)).toMatchObject({
        activeRevision: null
      })
      expect(await validation.grants(references[0], 'training', memory.id)).toMatchObject([
        { usedAt: null }
      ])
    } finally {
      await db.adminExec(
        'DROP TRIGGER reject_validation_activation ON learning_mutations; DROP FUNCTION reject_validation_activation()'
      )
    }
    expect(
      await validation.activateValidated(references[0], 'training', memory.id, 1, result.grantId!)
    ).toMatchObject({ activeRevision: 1 })
  })
  it('isolates credentials and removes calibration and grants when their scope is forgotten', async () => {
    const memory = await candidate()
    await validation.importCalibration(references[0], 'training', {
      cases: cases(),
      humanConfirmed: true
    })
    const { result } = await validate(memory.id)
    await expect(
      validation.activateValidated(references[1], 'training', memory.id, 1, result.grantId!)
    ).rejects.toThrow('validation_grant_missing')
    const ordinary = new EnterpriseLearningValidationStore(new AccountAuthority(db.db), {
      now: () => now,
      validatorVersion: 'validator-1'
    })
    await db.sql.exec('SET ROLE autoreply_app')
    try {
      await expect(
        ordinary.activateValidated(credential, 'training', memory.id, 1, result.grantId!)
      ).rejects.toMatchObject({ code: '42501' })
    } finally {
      await db.sql.exec('SET ROLE autoreply_learning_worker')
    }
    await repository.forgetScope(references[0], 'training')
    expect(await validation.calibration(references[0], 'training')).toEqual({ cases: [] })
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_activation_grants')).rows
    ).toEqual([{ n: 0 }])
  })
})
