import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { Administration } from '../../server/src/admin/administration'
import {
  PublicationSchema,
  loadPublication,
  type Publication
} from '../../server/src/generation/publication'
import { evaluationPlan, evaluationSubmission } from '../fixtures/evaluation-data'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { ExecutionAuthority } from '../../server/src/execution/execution-authority'
import { taskFixture } from '../fixtures/task'
import { hashContext } from '../../src/core/reply/hashes'
import { EMPTY_ENTERPRISE_MEMORY_VERSION } from '../../server/src/learning/learning-publication'
import { assessSubmission } from '../../server/src/admin/evaluation-admission'
import { replayCaseInputHash } from '../../evals/jev/replay-input'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>, admin: Administration, p: Publication
async function privileged(source: string) {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
  await pg.sql.exec(source)
}
async function login(name = 'synthetic_admin') {
  await pg.sql.exec(
    `SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION ${name}`
  )
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  await privileged(`CREATE ROLE synthetic_admin LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE synthetic_employee_admin LOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT autoreply_admin TO synthetic_admin;
    GRANT autoreply_admin TO synthetic_employee_admin;
    INSERT INTO tenants(id,name) VALUES('A','合成协议企业 A'),('B','合成协议企业 B');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin-A','admin'),('A','adjudicator-A','employee');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id)
      VALUES('synthetic_admin','A','admin-A'),('synthetic_employee_admin','A','adjudicator-A');`)
  admin = new Administration(pg.db, 'synthetic-generator')
}, 20000)
afterAll(async () => {
  if (pg) await pg.db.close()
})
beforeEach(async () => {
  await privileged(`TRUNCATE learning_versions,learning_episodes,learning_memories,learning_revisions,learning_settings,learning_generations,learning_feedback,learning_quarantines,learning_tombstones,learning_mutations,
    model_call_results,model_call_attempts,model_call_limits,execution_request_seal_applications,execution_request_seals,reconciliation_applied,reconciliation_decisions,device_reconciliation_reports,reconciliation_notes,reconciliation_cases,evaluation_approvals,evaluation_runs,generation_publications,published_configurations,
    account_leases,execution_permits,human_confirmations,reviewed_replies,generation_tasks,agents,enrollment_codes,audit_events,accounts CASCADE;
    UPDATE employees SET enabled=true`)
  await login()
  await admin.provision('A', {
    accountId: 'account-A',
    employeeId: 'employee-A',
    platform: 'wework'
  })
  p = PublicationSchema.parse(
    JSON.parse(await readFile('server/admin/publication.example.json', 'utf8'))
  )
  p.configuration = {
    ...p.configuration,
    configVersion: 'config-1',
    modelResolved: 'jev-test',
    automaticEnabled: true
  }
  p.policy = {
    ...p.policy,
    modelAlias: 'jev-test',
    modelResolved: 'jev-test',
    mode: 'enforced',
    evaluationApproved: true
  }
  p.textGeneratorVersion = 'synthetic-generator'
})
async function approved() {
  const run = await admin.freezeEvaluation('A', 'account-A', {
    publication: p,
    plan: evaluationPlan()
  })
  const input = evaluationSubmission(p, new Date(run.createdAt).getTime() + 1)
  // Move no wall clocks: server timestamp is read after constructing these records.
  const result = await admin.approveEvaluation('A', 'account-A', run.runId, input)
  return {
    run,
    input,
    result,
    publication: { ...p, evaluationApprovalId: result.evaluationApprovalId }
  }
}
describe('frozen evaluation admission on real embedded SQL with synthetic protocol data', () => {
  it('rejects a superficially passing business declaration for a replay freeze without central evidence and creates no authority', async () => {
    const plan = evaluationPlan()
    plan.replayProtocol = 'jev-abc-v1'
    plan.assignments = plan.assignments.map((a) => ({
      ...a,
      inputHash: replayCaseInputHash({
        ...a,
        conversationId: `synthetic-${a.caseId}`,
        inbound: ['合成样本']
      })
    }))
    const run = await admin.freezeEvaluation('A', 'account-A', { publication: p, plan })
    // Synthetic protocol data is deliberately declared business to exercise the
    // bypass attempt. This does not assert real business accuracy or execution.
    const input = {
      ...evaluationSubmission(p, run.createdAt.getTime()),
      executionPlanHash: hashContext(plan)
    }
    for (const m of input.measurements) m.billedCostMicros = 0
    const current = await admin.readFrozenEvaluation('A', 'account-A', run.runId)
    expect(
      assessSubmission(
        input,
        {
          publication: p,
          plan,
          createdAt: run.createdAt.getTime(),
          now: current.serverNow.getTime()
        },
        'admin-A'
      ).report.metrics.assessment.status
    ).toBe('observed_targets_met')
    const observed = () =>
      pg.db.transaction(
        'A',
        async (db) =>
          (
            await db.query(`SELECT
      (SELECT count(*)::integer FROM evaluation_approvals) AS approvals,
      (SELECT count(*)::integer FROM published_configurations) AS publications,
      (SELECT count(*)::integer FROM generation_publications) AS generation_publications,
      (SELECT count(*)::integer FROM audit_events) AS audit,
      (SELECT count(*)::integer FROM generation_tasks) AS tasks,
      (SELECT count(*)::integer FROM reviewed_replies) AS candidates,
      (SELECT count(*)::integer FROM execution_permits) AS permits,
      (SELECT count(*)::integer FROM account_leases) AS leases,
      (SELECT count(*)::integer FROM account_pause_requests) AS pause_requests,
      (SELECT count(*)::integer FROM account_pause_heads) AS pause_heads,
      (SELECT paused FROM accounts WHERE id='account-A') AS paused`)
          ).rows[0]
      )
    const before = await observed()
    await expect(admin.approveEvaluation('A', 'account-A', run.runId, input)).rejects.toThrow(
      'central_replay_evidence_required'
    )
    await expect(
      admin.approveEvaluation('A', 'account-A', run.runId, {
        ...input,
        executionPlanHash: undefined
      })
    ).rejects.toThrow('central_replay_evidence_required')
    expect(await observed()).toEqual(before)
    expect(before).toMatchObject({
      approvals: 0,
      publications: 0,
      tasks: 0,
      candidates: 0,
      permits: 0,
      leases: 0,
      paused: true
    })
  })
  it('reads the complete original server freeze without generating, approving or issuing anything', async () => {
    const plan = evaluationPlan()
    plan.replayProtocol = 'jev-abc-v1'
    for (const assignment of plan.assignments)
      assignment.inputHash = hashContext({ syntheticCase: assignment.caseId })
    p.replyRules = '合成规则：只引用审核后的事实。'
    p.evidence = [
      {
        evidenceId: 'synthetic-faq',
        tenantId: 'A',
        accountId: 'account-A',
        intent: 'faq',
        knowledgeVersion: p.configuration.knowledgeVersion,
        kind: 'approved_faq',
        content: '合成测试产品支持离线阅读。',
        source: '合成手册',
        approvedBy: 'adjudicator-A',
        validFrom: 0,
        expiresAt: Date.now() + 60000
      }
    ]
    const run = await admin.freezeEvaluation('A', 'account-A', { publication: p, plan })
    const observed = () =>
      pg.db.transaction(
        'A',
        async (db) =>
          (
            await db.query(`SELECT
      (SELECT count(*)::integer FROM audit_events) AS audit,
      (SELECT count(*)::integer FROM generation_tasks) AS tasks,
      (SELECT count(*)::integer FROM reviewed_replies) AS candidates,
      (SELECT count(*)::integer FROM execution_permits) AS permits,
      (SELECT count(*)::integer FROM account_leases) AS leases,
      (SELECT count(*)::integer FROM evaluation_approvals) AS approvals,
      (SELECT count(*)::integer FROM model_call_attempts) AS attempts,
      (SELECT count(*)::integer FROM model_call_results) AS results`)
          ).rows[0]
      )
    const before = await observed()
    const read = await admin.readFrozenEvaluation('A', 'account-A', run.runId)
    expect(read).toEqual({
      ...run,
      authenticatedScope: {
        tenantId: 'A',
        accountId: 'account-A',
        employeeId: 'employee-A',
        platform: 'wework'
      },
      publication: p,
      plan,
      serverNow: expect.any(Date)
    })
    expect(read.plan.assignments).toHaveLength(300)
    expect(read.serverNow.getTime()).toBeGreaterThanOrEqual(run.createdAt.getTime())
    expect(read.serverNow.getTime()).toBeLessThan(run.expiresAt.getTime())
    expect(await observed()).toEqual(before)
    // Caller edits cannot modify the original database freeze.
    read.publication.policy.minimumChoiceMargin = 0.8
    read.plan.assignments.pop()
    expect(await admin.readFrozenEvaluation('A', 'account-A', run.runId)).toMatchObject({
      publication: p,
      plan
    })
    expect(await admin.accounts('A')).toMatchObject([{ server_paused: true, config_version: null }])
  })

  it('denies cross-tenant and employee reads, and cannot substitute another account for the frozen account', async () => {
    const run = await admin.freezeEvaluation('A', 'account-A', {
      publication: p,
      plan: evaluationPlan()
    })
    await expect(admin.readFrozenEvaluation('B', 'account-A', run.runId)).rejects.toThrow('DENIED')
    await admin.provision('A', {
      accountId: 'account-B',
      employeeId: 'employee-B',
      platform: 'wechat'
    })
    await expect(admin.readFrozenEvaluation('A', 'account-B', run.runId)).rejects.toThrow(
      'EVALUATION_NOT_FOUND'
    )
    await login('synthetic_employee_admin')
    await expect(admin.readFrozenEvaluation('A', 'account-A', run.runId)).rejects.toThrow('DENIED')
    await login('autoreply_app')
    await expect(admin.readFrozenEvaluation('A', 'account-A', run.runId)).rejects.toThrow('DENIED')
  })

  it('rejects expired freezes and disabled accounts using database authority', async () => {
    const run = await admin.freezeEvaluation('A', 'account-A', {
      publication: p,
      plan: evaluationPlan()
    })
    await privileged("UPDATE evaluation_runs SET expires_at=clock_timestamp()-interval '1 second'")
    await login()
    await expect(admin.readFrozenEvaluation('A', 'account-A', run.runId)).rejects.toThrow(
      'EVALUATION_NOT_FOUND'
    )
    const current = await admin.freezeEvaluation('A', 'account-A', {
      publication: p,
      plan: evaluationPlan()
    })
    await privileged("UPDATE accounts SET enabled=false WHERE tenant_id='A' AND id='account-A'")
    await login()
    await expect(admin.readFrozenEvaluation('A', 'account-A', current.runId)).rejects.toThrow(
      'ACCOUNT_CONFLICT'
    )
  })

  it('rejects generator mismatches, invalid stored schemas and an invalid snapshot hash', async () => {
    const run = await admin.freezeEvaluation('A', 'account-A', {
      publication: p,
      plan: evaluationPlan()
    })
    const changedGenerator = new Administration(pg.db, 'different-generator')
    await expect(
      changedGenerator.readFrozenEvaluation('A', 'account-A', run.runId)
    ).rejects.toThrow('PUBLICATION_INVALID')
    await privileged("UPDATE evaluation_runs SET snapshot_hash='wrong-snapshot'")
    await login()
    await expect(admin.readFrozenEvaluation('A', 'account-A', run.runId)).rejects.toThrow(
      'frozen_snapshot_invalid'
    )
    await privileged("UPDATE evaluation_runs SET publication_json='{}'::jsonb")
    await login()
    await expect(admin.readFrozenEvaluation('A', 'account-A', run.runId)).rejects.toThrow()
    const valid = await admin.freezeEvaluation('A', 'account-A', {
      publication: p,
      plan: evaluationPlan()
    })
    await privileged("UPDATE evaluation_runs SET plan_json='{}'::jsonb")
    await login()
    await expect(admin.readFrozenEvaluation('A', 'account-A', valid.runId)).rejects.toThrow()
  })

  it('refuses a boolean pass flag, a synthetic declaration and employee approval authority', async () => {
    await expect(admin.publish('A', 'account-A', p)).rejects.toThrow('CONFIGURATION_UNAVAILABLE')
    const run = await admin.freezeEvaluation('A', 'account-A', {
      publication: p,
      plan: evaluationPlan()
    })
    const data = evaluationSubmission(p, new Date(run.createdAt).getTime() + 1)
    await expect(
      admin.approveEvaluation('A', 'account-A', run.runId, { ...data, dataKind: 'synthetic' })
    ).rejects.toThrow('synthetic_data_cannot_enable_automatic_reply')
    await login('autoreply_app')
    await expect(admin.approveEvaluation('A', 'account-A', run.runId, data)).rejects.toThrow(
      'DENIED'
    )
    await expect(
      pg.db.transaction('A', (db) => db.query('INSERT INTO evaluation_approvals DEFAULT VALUES'))
    ).rejects.toThrow(/permission denied/i)
  })
  it('freezes actual contents, recomputes paired metrics and atomically permits the exact publication', async () => {
    const a = await approved()
    expect(await admin.approveEvaluation('A', 'account-A', a.run.runId, a.input)).toEqual(a.result)
    await admin.publish('A', 'account-A', a.publication)
    expect(await admin.accounts('A')).toMatchObject([
      { server_paused: true, automatic_enabled: true }
    ])
    const loaded = await pg.db.transaction('A', (db) =>
      loadPublication(db, { tenant_id: 'A', account_id: 'account-A' })
    )
    expect(loaded).toEqual({
      ...a.publication,
      memoryCorpusVersion: EMPTY_ENTERPRISE_MEMORY_VERSION,
      memoryManifest: []
    })
    expect(await admin.evaluations('A', 'account-A')).toMatchObject([
      {
        evaluation_approval_id: a.result.evaluationApprovalId,
        approved_by: 'admin-A',
        adjudicated_by: 'adjudicator-A'
      }
    ])
    const report = await pg.db.transaction('A', (db) =>
      db.query('SELECT report_json FROM evaluation_approvals')
    )
    expect(report.rows[0].report_json).toMatchObject({
      maximumObservedCostMicros: 5000,
      stageLatencyMs: { pre: { p50: 20, p95: 20 } },
      metrics: {
        sample: { calibration: 100, holdout: 200 },
        assessment: { status: 'observed_targets_met' },
        pairedConversationBootstrap: { replicates: 2000 }
      }
    })
  })
  it('cannot reuse approval after changing versions, knowledge, thresholds or generator', async () => {
    const a = await approved()
    for (const changed of [
      { ...a.publication, configuration: { ...p.configuration, configVersion: 'config-2' } },
      { ...a.publication, policy: { ...p.policy, minimumChoiceMargin: 0.4 } },
      {
        ...a.publication,
        evidence: [
          {
            evidenceId: 'new-fact',
            tenantId: 'A',
            knowledgeVersion: 'knowledge-1',
            intent: 'faq',
            kind: 'approved_faq',
            content: '合成测试内容',
            source: '合成',
            approvedBy: 'adjudicator-A',
            validFrom: 0,
            expiresAt: Date.now() + 10000
          }
        ]
      }
    ])
      await expect(admin.publish('A', 'account-A', changed as Publication)).rejects.toThrow(
        'CONFIGURATION_UNAVAILABLE'
      )
    await admin.provision('A', {
      accountId: 'account-B',
      employeeId: 'employee-B',
      platform: 'wechat'
    })
    await expect(admin.publish('A', 'account-B', a.publication)).rejects.toThrow(
      'CONFIGURATION_UNAVAILABLE'
    )
    await expect(
      admin.publish('A', 'account-A', { ...a.publication, textGeneratorVersion: 'changed' })
    ).rejects.toThrow('PUBLICATION_INVALID')
  })
  it('rejects changed holdout membership, self review, missing measurements and execution before freeze', async () => {
    const run = await admin.freezeEvaluation('A', 'account-A', {
      publication: p,
      plan: evaluationPlan()
    })
    const make = () => evaluationSubmission(p, new Date(run.createdAt).getTime() + 1)
    const self = make()
    self.dataset.adjudicatedBy = 'admin-A'
    await expect(admin.approveEvaluation('A', 'account-A', run.runId, self)).rejects.toThrow(
      'independent_adjudicator_required'
    )
    const changed = make()
    changed.dataset.cases[299].conversationGroup = 'changed'
    await expect(admin.approveEvaluation('A', 'account-A', run.runId, changed)).rejects.toThrow(
      'planned_sample_mismatch'
    )
    const missing = make()
    missing.measurements.pop()
    await expect(admin.approveEvaluation('A', 'account-A', run.runId, missing)).rejects.toThrow(
      'incomplete_measurements'
    )
    const early = make()
    early.measurements.find((m) => m.caseId === 'case-100')!.executedAt =
      new Date(run.createdAt).getTime() - 1
    await expect(admin.approveEvaluation('A', 'account-A', run.runId, early)).rejects.toThrow(
      'execution_time_invalid'
    )
  })
  it('rejects failing accuracy, over-budget measurements and unregistered/disabled adjudicators', async () => {
    const run = await admin.freezeEvaluation('A', 'account-A', {
      publication: p,
      plan: evaluationPlan()
    })
    const make = () => evaluationSubmission(p, new Date(run.createdAt).getTime() + 1)
    const inaccurate = make()
    for (const c of inaccurate.dataset.cases)
      c.outcomes.find((o) => o.arm === 'C')!.substantialCorrection = true
    await expect(admin.approveEvaluation('A', 'account-A', run.runId, inaccurate)).rejects.toThrow(
      'accuracy_targets_not_met'
    )
    const expensive = make()
    expensive.measurements.find((m) => m.caseId === 'case-100' && m.arm === 'C')!.billedCostMicros =
      10001
    await expect(admin.approveEvaluation('A', 'account-A', run.runId, expensive)).rejects.toThrow(
      'budget_exceeded'
    )
    await privileged("UPDATE employees SET enabled=false WHERE id='adjudicator-A'")
    await login()
    await expect(admin.approveEvaluation('A', 'account-A', run.runId, make())).rejects.toThrow(
      'ACCOUNT_CONFLICT'
    )
    expect(await admin.evaluations('A', 'account-A')).toMatchObject([
      { evaluation_approval_id: null }
    ])
  })
  it('rolls approval back if its audit insert fails and makes frozen runs immutable for the admin role', async () => {
    const run = await admin.freezeEvaluation('A', 'account-A', {
      publication: p,
      plan: evaluationPlan()
    })
    await expect(
      pg.db.transaction('A', (db) => db.query("UPDATE evaluation_runs SET snapshot_hash='changed'"))
    ).rejects.toThrow(/permission denied/i)
    await privileged(`CREATE FUNCTION autoreply.fail_evaluation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.kind='evaluation_approved' THEN RAISE EXCEPTION 'synthetic_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_evaluation_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION autoreply.fail_evaluation_audit()`)
    await login()
    try {
      await expect(
        admin.approveEvaluation(
          'A',
          'account-A',
          run.runId,
          evaluationSubmission(p, new Date(run.createdAt).getTime() + 1)
        )
      ).rejects.toThrow('synthetic_failure')
    } finally {
      await privileged(
        'DROP TRIGGER reject_evaluation_audit ON audit_events; DROP FUNCTION autoreply.fail_evaluation_audit()'
      )
      await login()
    }
    expect(await admin.evaluations('A', 'account-A')).toMatchObject([
      { evaluation_approval_id: null }
    ])
  })
  it('revocation prevents publication/load/resume and is irreversible for this run', async () => {
    const a = await approved()
    await admin.publish('A', 'account-A', a.publication)
    await admin.resume('A', 'account-A')
    await admin.revokeEvaluation('A', 'account-A', a.result.evaluationApprovalId)
    await expect(
      pg.db.transaction('A', (db) => db.query('UPDATE evaluation_approvals SET revoked_at=NULL'))
    ).rejects.toThrow('evaluation_revocation_is_final')
    expect(await admin.accounts('A')).toMatchObject([{ server_paused: true }])
    await expect(admin.resume('A', 'account-A')).rejects.toThrow('CONFIGURATION_UNAVAILABLE')
    await expect(admin.publish('A', 'account-A', a.publication)).rejects.toThrow(
      'CONFIGURATION_UNAVAILABLE'
    )
    await expect(admin.approveEvaluation('A', 'account-A', a.run.runId, a.input)).rejects.toThrow(
      'run_already_decided'
    )
    // The publication check still rejects a revoked approval even if another
    // privileged operator incorrectly opens the account pause flag.
    await privileged('UPDATE accounts SET paused=false')
    await login('autoreply_app')
    await expect(
      pg.db.transaction('A', (db) =>
        loadPublication(db, { tenant_id: 'A', account_id: 'account-A' })
      )
    ).rejects.toThrow('CONFIGURATION_UNAVAILABLE')
  })
  it('rechecks approval before recording a candidate and issuing any cached candidate permit', async () => {
    const a = await approved()
    await admin.publish('A', 'account-A', a.publication)
    const f = taskFixture(),
      token = 'T'.repeat(43)
    await privileged(`INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash)
      VALUES('A','agent-A','account-A','employee-A','${tokenHash(token)}');UPDATE accounts SET paused=false`)
    await login('autoreply_app')
    const authority = new AccountAuthority(pg.db),
      execution = new ExecutionAuthority(authority, async (db, s) => {
        await loadPublication(db, s)
      })
    const lease = await authority.acquireLease(token, 1, 'process-A')
    const now = Date.now()
    f.task = {
      ...f.task,
      identity: { ...f.task.identity, tenantId: 'A' },
      createdAt: now - 100,
      expiresAt: now + 10000
    }
    f.review = { ...f.review, modelResolved: 'jev-test', reviewedAt: now, expiresAt: now + 5000 }
    // Match the concrete publication versions, retaining the task/draft/review binding.
    f.task = {
      ...f.task,
      ...{
        configVersion: p.configuration.configVersion,
        knowledgeVersion: p.configuration.knowledgeVersion,
        decisionPolicyVersion: p.configuration.decisionPolicyVersion,
        questionSetVersion: p.configuration.questionSetVersion
      }
    }
    f.review = {
      ...f.review,
      configVersion: f.task.configVersion,
      knowledgeVersion: f.task.knowledgeVersion,
      decisionPolicyVersion: f.task.decisionPolicyVersion,
      questionSetVersion: f.task.questionSetVersion
    }
    const candidate = {
      task: f.task,
      draft: f.draft,
      review: f.review,
      automaticAllowed: true,
      factsVerified: true,
      reasons: []
    }
    await execution.recordApprovedCandidate(token, candidate)
    await login()
    await admin.revokeEvaluation('A', 'account-A', a.result.evaluationApprovalId)
    await privileged('UPDATE accounts SET paused=false')
    await login('autoreply_app')
    await expect(execution.recordApprovedCandidate(token, candidate)).rejects.toThrow(
      'CONFIGURATION_UNAVAILABLE'
    )
    await expect(
      execution.issue(token, {
        taskId: f.task.taskId,
        taskHash: hashContext(f.task),
        draftHash: f.draft.draftHash,
        draftRevision: f.draft.draftRevision,
        loginEpoch: 1,
        clientInstanceId: 'process-A',
        leaseVersion: lease.version
      })
    ).rejects.toThrow('CONFIGURATION_UNAVAILABLE')
  })
})
