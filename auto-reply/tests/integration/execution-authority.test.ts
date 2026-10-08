import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Postgres } from '../../server/src/database/postgres'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { ExecutionAuthority } from '../../server/src/execution/execution-authority'
import { taskFixture } from '../fixtures/task'
import { hashContext } from '../../src/core/reply/hashes'
import type { ReplyCandidate } from '../../src/core/agent/reliable-agent'
import type { PermitRequest } from '../../src/shared/contracts/execution'

let sql: PGlite, accounts: AccountAuthority, execution: ExecutionAuthority
const token = 'A'.repeat(43),
  otherToken = 'B'.repeat(43)
let candidate: ReplyCandidate, request: PermitRequest
const config = {
  configVersion: 'config-1',
  knowledgeVersion: 'knowledge-1',
  decisionPolicyVersion: 'policy-1',
  questionSetVersion: 'questions-1',
  modelResolved: 'jev-test-version',
  automaticEnabled: true
}

// This facade runs the production SQL/transactions on an embedded PostgreSQL
// connection. It tests contracts and RLS, NOT concurrent multi-connection locks.
beforeAll(async () => {
  sql = new PGlite()
  // The actual approval authority also validates current learning bindings.
  // Load the complete current schema instead of keeping a partial historical database.
  const migrations = (await readdir(resolve('server/migrations')))
    .filter((file) => /^\d{3}-.+\.sql$/.test(file))
    .sort()
  for (const file of migrations) {
    const source = await readFile(resolve('server/migrations', file), 'utf8')
    await sql.exec(source)
    await sql.exec(source)
  }
  await sql.exec(`INSERT INTO tenants(id,name) VALUES('company','测试企业');
    INSERT INTO employees(tenant_id,id,role) VALUES('company','employee-A','employee');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','account-A','employee-A','wework',false);`)
  for (const [id, credential] of [
    ['agent-A', token],
    ['agent-B', otherToken]
  ])
    await sql.query(
      `INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('company',$1,'account-A','employee-A',$2)`,
      [id, tokenHash(credential)]
    )
  const query = async (text: string, values?: unknown[]) => {
    const result = await sql.query(text, values)
    return { ...result, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
  }
  const facade = {
    pool: { query },
    transaction: async (tenantId: string, operation: (client: unknown) => Promise<unknown>) => {
      await sql.exec('BEGIN')
      try {
        await sql.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId])
        const result = await operation({ query })
        await sql.exec('COMMIT')
        return result
      } catch (error) {
        await sql.exec('ROLLBACK')
        throw error
      }
    }
  } as unknown as Postgres
  accounts = new AccountAuthority(facade)
  // This suite isolates lease/candidate/permit SQL; the full publication gate is
  // exercised by generation-service and evaluation-admission integration suites.
  execution = new ExecutionAuthority(accounts, async () => {})
}, 20000)
afterAll(async () => {
  if (sql) await sql.close()
})
beforeEach(async () => {
  await sql.exec(`RESET ROLE; TRUNCATE model_call_results,model_call_attempts,model_call_limits,execution_request_seal_applications,execution_request_seals,reconciliation_applied,reconciliation_decisions,device_reconciliation_reports,reconciliation_notes,reconciliation_cases,audit_events,execution_permits,reviewed_replies,published_configurations,account_leases CASCADE;
    UPDATE accounts SET enabled=true,paused=false; UPDATE agents SET revoked_at=NULL; SET ROLE autoreply_app`)
  const f = taskFixture(),
    now = Date.now()
  candidate = {
    task: { ...f.task, createdAt: now - 1000, expiresAt: now + 60000 },
    draft: f.draft,
    review: { ...f.review, reviewedAt: now - 500, expiresAt: now + 60000 },
    automaticAllowed: true,
    factsVerified: true,
    reasons: []
  }
  const lease = await accounts.acquireLease(token, 1, 'process-A')
  request = {
    taskId: f.task.taskId,
    taskHash: hashContext(candidate.task),
    draftHash: f.draft.draftHash,
    draftRevision: f.draft.draftRevision,
    loginEpoch: 1,
    clientInstanceId: 'process-A',
    leaseVersion: lease.version
  }
  await execution.publishConfiguration(token, config)
})
async function approve() {
  await execution.recordApprovedCandidate(token, candidate)
}
async function admin(statement: string) {
  await sql.exec('RESET ROLE')
  await sql.exec(statement)
  await sql.exec('SET ROLE autoreply_app')
}

describe('central approval and one-time execution permit SQL', () => {
  it('requires a server-recorded review rather than accepting hashes from the client', async () => {
    await expect(execution.issue(token, request)).rejects.toThrow('REVIEW_REQUIRED')
    await approve()
    const permit = await execution.issue(token, request)
    expect(permit).toMatchObject({
      newlyIssued: true,
      status: 'issued',
      taskId: request.taskId,
      identity: candidate.task.identity
    })
    expect(permit.expiresAt).toBeLessThanOrEqual(candidate.review!.expiresAt)
    expect((await execution.issue(token, request)).newlyIssued).toBe(false)
  })
  it('refuses edited text and mismatched identity before recording approval', async () => {
    await expect(
      execution.recordApprovedCandidate(token, {
        ...candidate,
        draft: { ...candidate.draft!, text: '篡改后价格' }
      })
    ).rejects.toThrow('REVIEW_REQUIRED')
    await expect(
      execution.recordApprovedCandidate(token, {
        ...candidate,
        task: {
          ...candidate.task,
          conversationId: 'other',
          identity: { ...candidate.task.identity, tenantId: 'B' }
        }
      })
    ).rejects.toThrow('REVIEW_REQUIRED')
    expect((await sql.query('SELECT * FROM reviewed_replies')).rows).toEqual([])
  })
  it('does not allow a second device or an old login/lease version to use the approval', async () => {
    await approve()
    await expect(execution.issue(otherToken, request)).rejects.toThrow('LEASE_INVALID')
    await expect(execution.issue(token, { ...request, loginEpoch: 2 })).rejects.toThrow(
      'LEASE_INVALID'
    )
    await expect(execution.issue(token, { ...request, leaseVersion: 2 })).rejects.toThrow(
      'LEASE_INVALID'
    )
  })
  it('invalidates old approvals after a configuration/model publication', async () => {
    await approve()
    await execution.publishConfiguration(token, { ...config, modelResolved: 'new-model' })
    await expect(execution.issue(token, request)).rejects.toThrow('STALE_REVIEW')
  })
  it('rejects expired reviews and expired leases', async () => {
    await expect(
      execution.recordApprovedCandidate(token, {
        ...candidate,
        review: { ...candidate.review!, reviewedAt: 1, expiresAt: 2 }
      })
    ).rejects.toThrow('STALE_REVIEW')
    await approve()
    await admin("UPDATE account_leases SET expires_at=clock_timestamp()-interval '1 second'")
    await expect(execution.issue(token, request)).rejects.toThrow('LEASE_INVALID')
  })
  it('keeps unknown delivery unresolved even after the lease expires and the Agent changes', async () => {
    await approve()
    const permit = await execution.issue(token, request)
    const receipt = {
      permitId: permit.permitId,
      draftHash: request.draftHash,
      status: 'unknown' as const
    }
    expect(await execution.settle(token, receipt)).toEqual({ status: 'unknown' })
    expect(await execution.settle(token, receipt)).toEqual({ status: 'unknown' })
    await expect(
      execution.settle(token, {
        ...receipt,
        status: 'confirmed',
        sourceMessageId: 'echo',
        verificationProofHash: 'a'.repeat(64)
      })
    ).rejects.toThrow('PERMIT_CONFLICT')
    await admin("UPDATE account_leases SET expires_at=clock_timestamp()-interval '1 second'")
    await expect(accounts.acquireLease(otherToken, 2, 'new-process')).rejects.toThrow(
      'UNRESOLVED_EXECUTION'
    )
  })
  it('accepts an exact receipt once and rejects a changed receipt or task hash', async () => {
    await approve()
    const permit = await execution.issue(token, request)
    await expect(execution.issue(token, { ...request, draftHash: 'b'.repeat(64) })).rejects.toThrow(
      'PERMIT_CONFLICT'
    )
    const receipt = {
      permitId: permit.permitId,
      draftHash: request.draftHash,
      status: 'confirmed' as const,
      sourceMessageId: 'echo-1',
      verificationProofHash: 'a'.repeat(64)
    }
    expect(await execution.settle(token, receipt)).toEqual({ status: 'confirmed' })
    expect(await execution.settle(token, receipt)).toEqual({ status: 'confirmed' })
    await expect(
      execution.settle(token, { ...receipt, sourceMessageId: 'echo-2' })
    ).rejects.toThrow('PERMIT_CONFLICT')
    expect((await execution.issue(token, request)).newlyIssued).toBe(false)
  })
  it('allows settlement while paused but cannot issue a new permit', async () => {
    await approve()
    const permit = await execution.issue(token, request)
    await admin('UPDATE accounts SET paused=true')
    await expect(execution.issue(token, request)).rejects.toThrow('PAUSED')
    expect(
      await execution.settle(token, {
        permitId: permit.permitId,
        draftHash: request.draftHash,
        status: 'not_sent',
        dispatchStarted: false,
        quiescent: true,
        verificationProofHash: 'a'.repeat(64)
      })
    ).toEqual({ status: 'not_sent' })
  })
  it('refuses a revoked device, including settlement', async () => {
    await approve()
    const permit = await execution.issue(token, request)
    await admin("UPDATE agents SET revoked_at=clock_timestamp() WHERE id='agent-A'")
    await expect(
      execution.settle(token, {
        permitId: permit.permitId,
        draftHash: request.draftHash,
        status: 'unknown'
      })
    ).rejects.toThrow('DENIED')
  })
})
