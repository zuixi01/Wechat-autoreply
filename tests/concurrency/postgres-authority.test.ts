import { Pool, type PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Postgres } from '../../server/src/database/postgres'
import { AccountAuthority, tokenHash, type Scope } from '../../server/src/auth/account-authority'
import { Administration } from '../../server/src/admin/administration'
import { ModelCallAuthority } from '../../server/src/generation/model-call-authority'
import { EnterpriseLearningRepository } from '../../server/src/learning/learning-repository'
import { EnterpriseLearningManagement } from '../../server/src/learning/learning-service'
import { createEnterpriseLearningManagementRuntime } from '../../server/src/learning/learning-management-runtime'
import { EnterpriseLearningValidationStore } from '../../server/src/learning/learning-validation-store'
import { EnterpriseLearningValidationBudget } from '../../server/src/learning/learning-validation-budget'
import { LearningValidator } from '../../src/core/memory/learning-validation'
import { memorySemanticUnits } from '../../src/core/memory/learning-risk'
import { EnterpriseLearningQueue } from '../../server/src/learning/learning-queue'
import { EnterpriseLearningWorkerAuthority } from '../../server/src/learning/learning-worker-authority'
import { createEnterpriseLearningReviewer } from '../../server/src/learning/learning-reviewer-service'
import { createEnterpriseLearningValidator } from '../../server/src/learning/learning-validator-service'
import { createEnterpriseLearningMaintenance } from '../../server/src/learning/learning-maintenance-factory'
import { EnterpriseLearningMaintenanceService } from '../../server/src/learning/learning-maintenance-service'
import {
  prepareEnterpriseLearningTask,
  assertEnterpriseLearningTaskCurrent,
  enterpriseDraftSource
} from '../../server/src/learning/learning-generation-context'
import type { MemoryProposal } from '../../src/shared/contracts/learning-memory'
import { TypeSafeClient } from '../../server/src/decision/typesafe-client'
import { hashContext } from '../../src/core/reply/hashes'
import { taskFixture } from '../fixtures/task'
import { jevRequest, jevResponse } from '../fixtures/jev'
import type { ReplyTask } from '../../src/shared/contracts/task'
import type { GenerationInput } from '../../src/shared/contracts/generation'
import type { JevRequest, JevResponse } from '../../src/shared/contracts/decision'
import { GenerationService } from '../../server/src/generation/generation-service'
import { ExecutionAuthority } from '../../server/src/execution/execution-authority'
import { RestorePauseAuthority } from '../../server/src/execution/restore-pause-authority'
import { JevReplyPipeline } from '../../server/src/reply/jev-pipeline'
import {
  storePublication,
  loadPublication,
  type Publication
} from '../../server/src/generation/publication'
import { createApplication } from '../../server/src/http/application'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

let root: Pool, adminDb: Postgres, workers: Postgres[]
let learningWorkerDb: Postgres
let learningLoginUrl: string
let administrator: Administration
let applicationUrl: string
let administratorLoginUrl: string
const credentials = ['A'.repeat(43), 'B'.repeat(43), 'C'.repeat(43)]
const scopes: Scope[] = ['A', 'B', 'C'].map((id) => ({
  tenant_id: id === 'C' ? 'other' : 'company',
  employee_id: `employee-${id}`,
  account_id: `account-${id}`,
  agent_id: `agent-${id}`,
  platform: 'wework'
}))
let tasks: ReplyTask[]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeAll(async () => {
  const url = new URL(process.env.AUTOREPLY_POSTGRES_TEST_URL ?? 'about:blank')
  const password = process.env.AUTOREPLY_POSTGRES_TEST_PASSWORD ?? ''
  if (
    url.hostname !== '127.0.0.1' ||
    url.username !== 'postgres' ||
    !/^\/autoreply_concurrency_[a-f0-9]{32}$/.test(url.pathname) ||
    !/^[a-f0-9]{64}$/.test(password) ||
    !process.env.AUTOREPLY_POSTGRES_TEST_REPORT
  )
    throw new Error('use_isolated_postgres_runner')
  root = new Pool({
    connectionString: url.href,
    max: 5,
    options: '-c search_path=autoreply,public'
  })
  expect((await root.query("SELECT 1 FROM pg_namespace WHERE nspname='autoreply'")).rowCount).toBe(
    0
  )
  const migrations = (await readdir(resolve('server/migrations')))
    .filter((p) => /^\d{3}-.+\.sql$/.test(p))
    .sort()
  for (const file of migrations) {
    const source = await readFile(resolve('server/migrations', file), 'utf8')
    await root.query(source)
    await root.query(source)
  }
  // Only random hexadecimal synthetic passwords are interpolated into role DDL.
  await root.query(`CREATE ROLE concurrency_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${password}';
    CREATE ROLE concurrency_admin LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${password}';
    CREATE ROLE concurrency_learning LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${password}';
    GRANT autoreply_app TO concurrency_app; GRANT autoreply_admin TO concurrency_admin;`)
  await root.query('GRANT autoreply_learning_worker TO concurrency_learning')
  const loginUrl = (login: string) => {
    const copy = new URL(url)
    copy.username = login
    copy.password = password
    return copy.href
  }
  applicationUrl = loginUrl('concurrency_app')
  workers = Array.from({ length: 3 }, () => new Postgres(applicationUrl))
  administratorLoginUrl = loginUrl('concurrency_admin')
  adminDb = new Postgres(administratorLoginUrl)
  learningLoginUrl = loginUrl('concurrency_learning')
  learningWorkerDb = new Postgres(learningLoginUrl)
  administrator = new Administration(adminDb)
  const version = (await root.query('SELECT version() AS version')).rows[0].version
  const roles = (
    await root.query(
      "SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('concurrency_app','concurrency_admin') ORDER BY rolname"
    )
  ).rows
  expect(roles).toHaveLength(2)
  expect(roles.every((r) => !r.rolsuper && !r.rolbypassrls)).toBe(true)
  const clients = await Promise.all(workers.map((db) => db.pool.connect()))
  try {
    for (const client of clients)
      expect((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation).toBe(
        'read committed'
      )
    const pids = await Promise.all(
      clients.map(async (db) => (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    )
    expect(new Set(pids).size).toBe(3)
    await writeFile(
      resolve(process.env.AUTOREPLY_POSTGRES_TEST_REPORT!, 'database.json'),
      JSON.stringify(
        {
          version,
          migrations,
          roles,
          independentBackendPids: pids,
          data: 'synthetic_only',
          providers: 'synthetic_transport',
          isolation: 'read_committed'
        },
        null,
        2
      )
    )
  } finally {
    clients.forEach((client) => client.release())
  }
})

afterAll(async () => {
  await Promise.allSettled([
    ...(workers ?? []).map((db) => db.close()),
    adminDb?.close(),
    learningWorkerDb?.close(),
    root?.end()
  ])
})

beforeEach(async () => {
  // This database is a new isolated container, never an existing deployment.
  await root.query('TRUNCATE tenants CASCADE')
  await root.query(`INSERT INTO tenants(id,name) VALUES('company','合成企业'),('other','隔离企业');
    INSERT INTO employees(tenant_id,id,role) VALUES('company','admin','admin');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('concurrency_admin','company','admin');`)
  tasks = []
  for (const [index, scope] of scopes.entries()) {
    await root.query("INSERT INTO employees(tenant_id,id,role) VALUES($1,$2,'employee')", [
      scope.tenant_id,
      scope.employee_id
    ])
    await root.query(
      'INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES($1,$2,$3,$4,false)',
      [scope.tenant_id, scope.account_id, scope.employee_id, scope.platform]
    )
    await root.query(
      'INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES($1,$2,$3,$4,$5)',
      [
        scope.tenant_id,
        scope.agent_id,
        scope.account_id,
        scope.employee_id,
        tokenHash(credentials[index])
      ]
    )
    const task: ReplyTask = {
      ...taskFixture().task,
      taskId: `task-${index}`,
      identity: {
        tenantId: scope.tenant_id,
        employeeId: scope.employee_id,
        accountId: scope.account_id,
        agentId: scope.agent_id,
        platform: scope.platform,
        loginEpoch: 1,
        clientInstanceId: 'process-A'
      },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60000
    }
    tasks.push(task)
    await root.query(
      `INSERT INTO published_configurations(tenant_id,account_id,config_version,knowledge_version,policy_version,questions_version,model_resolved)
      VALUES($1,$2,$3,$4,$5,$6,'jev-test-resolved')`,
      [
        scope.tenant_id,
        scope.account_id,
        task.configVersion,
        task.knowledgeVersion,
        task.decisionPolicyVersion,
        task.questionSetVersion
      ]
    )
    await root.query(
      `INSERT INTO generation_tasks(tenant_id,account_id,task_id,agent_id,request_hash,task_json,status,expires_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,'running',clock_timestamp()+interval '60 seconds')`,
      [
        scope.tenant_id,
        scope.account_id,
        task.taskId,
        scope.agent_id,
        hashContext(task),
        JSON.stringify(task)
      ]
    )
    await root.query(
      `INSERT INTO account_leases(tenant_id,account_id,agent_id,login_epoch,client_instance_id,version,expires_at)
      VALUES($1,$2,$3,1,'process-A',1,clock_timestamp()+interval '60 seconds')`,
      [scope.tenant_id, scope.account_id, scope.agent_id]
    )
  }
})

function provider(index: number, upstream: typeof fetch, scopeIndex = 0) {
  const meter = new ModelCallAuthority(workers[index], new AccountAuthority(workers[index]))
  const client = new TypeSafeClient({
    apiKey: 'synthetic-only',
    fetch: meter.transport('jev', upstream),
    timeoutMs: 8000,
    maxAttempts: 1
  })
  return () =>
    meter
      .forTask(credentials[scopeIndex], scopes[scopeIndex], tasks[scopeIndex])
      .run('pre', () => client.evaluate(jevRequest))
}

/** A real held row lock creates contention; pg_stat_activity proves waiting backends. */
async function holdAccount(db: Pool | Postgres, account = 'account-A') {
  const client = await (db instanceof Postgres ? db.pool : db).connect()
  await client.query('BEGIN')
  await client.query("SELECT set_config('app.tenant_id','company',true)")
  await client.query("SELECT 1 FROM accounts WHERE tenant_id='company' AND id=$1 FOR UPDATE", [
    account
  ])
  let released = false
  return {
    client,
    release: async () => {
      if (released) return
      released = true
      try {
        await client.query('COMMIT')
      } finally {
        client.release()
      }
    }
  }
}
async function waitForLocks(minimum: number) {
  const deadline = Date.now() + 1500
  do {
    const count = Number(
      (
        await root.query(`SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname=current_database() AND application_name='autoreply-service' AND wait_event_type='Lock'`)
      ).rows[0].n
    )
    if (count >= minimum) return
    await delay(20)
  } while (Date.now() < deadline)
  throw new Error('real_lock_contention_not_observed')
}
async function rawReservation(client: PoolClient, attempt: number) {
  const task = tasks[0]
  return client.query(
    `INSERT INTO model_call_attempts(tenant_id,account_id,id,agent_id,task_id,task_hash,provider,stage,attempt_number,request_hash,requested_model,question_hash,config_version,policy_version,question_set_version,knowledge_version,limit_revision)
    VALUES('company','account-A',$1,'agent-A',$2,$3,'jev','pre',$4,$5,'jev-test',$6,$7,$8,$9,$10,1)`,
    [
      randomUUID(),
      task.taskId,
      hashContext(task),
      attempt,
      hashContext(jevRequest),
      hashContext(jevRequest.questions),
      task.configVersion,
      task.decisionPolicyVersion,
      task.questionSetVersion,
      task.knowledgeVersion
    ]
  )
}

async function insertGeneration(client: PoolClient, task: ReplyTask) {
  const i = task.identity
  return client.query(
    `INSERT INTO generation_tasks(tenant_id,account_id,task_id,agent_id,request_hash,task_json,status,expires_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,'running',to_timestamp($7/1000.0))`,
    [
      i.tenantId,
      i.accountId,
      task.taskId,
      i.agentId,
      hashContext(task),
      JSON.stringify(task),
      task.expiresAt
    ]
  )
}
async function extraAccount(index: number): Promise<ReplyTask> {
  const tenant = index % 2 ? 'company' : 'other'
  await root.query("INSERT INTO employees(tenant_id,id,role) VALUES($1,$2,'employee')", [
    tenant,
    `extra-employee-${index}`
  ])
  await root.query(
    "INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES($1,$2,$3,'wework',false)",
    [tenant, `extra-account-${index}`, `extra-employee-${index}`]
  )
  await root.query(
    'INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES($1,$2,$3,$4,$5)',
    [
      tenant,
      `extra-agent-${index}`,
      `extra-account-${index}`,
      `extra-employee-${index}`,
      tokenHash(randomUUID())
    ]
  )
  return {
    ...tasks[0],
    taskId: `extra-task-${index}`,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60000,
    identity: {
      ...tasks[0].identity,
      tenantId: tenant,
      employeeId: `extra-employee-${index}`,
      accountId: `extra-account-${index}`,
      agentId: `extra-agent-${index}`
    }
  }
}
function generationInput(id: string): GenerationInput {
  const context: GenerationInput['context'] = [
    {
      sequence: 1,
      sourceMessageId: 'synthetic-inbound',
      direction: 'inbound',
      kind: 'text',
      text: '合成咨询'
    }
  ]
  return {
    task: {
      ...tasks[0],
      taskId: id,
      inboundRange: { from: 1, to: 1 },
      contextHash: hashContext(context)
    },
    context,
    inbound: ['合成咨询']
  }
}
async function generationServices(beforeEvaluate: () => Promise<void> = async () => {}) {
  const cfg: Publication['configuration'] = {
    configVersion: 'config-1',
    knowledgeVersion: 'knowledge-1',
    decisionPolicyVersion: 'policy-1',
    questionSetVersion: 'questions-1',
    modelResolved: 'jev-test-resolved',
    automaticEnabled: false
  }
  const publication: Publication = {
    configuration: cfg,
    evidence: [],
    textGeneratorVersion: 'concurrency-text-v1',
    policy: {
      version: 'policy-1',
      questionSetVersion: 'questions-1',
      knowledgeVersion: 'knowledge-1',
      mode: 'enforced',
      modelAlias: 'jev-test',
      modelResolved: 'jev-test-resolved',
      evaluationApproved: false,
      automaticIntents: ['faq'],
      minimumChoiceProbability: 0.9,
      minimumChoiceConfidence: 0.8,
      minimumChoiceMargin: 0.3,
      presentIntentProbability: 0.9,
      humanRequestThreshold: 0.2,
      minimumAuditProbability: 0.95,
      reviewValidityMs: 5000,
      preBudgetMs: 10000,
      postBudgetMs: 10000
    }
  }
  const client = await root.connect()
  try {
    await storePublication(client, scopes[0], publication)
  } finally {
    client.release()
  }
  const evaluate = vi.fn(async (request: JevRequest): Promise<JevResponse> => {
    await beforeEvaluate()
    const answers: JevResponse['answers'] = {}
    for (const [id, question] of Object.entries(request.questions)) {
      if (question.type === 'choice') {
        const keys = Object.keys(question.criteria)
        answers[id] = {
          type: 'choice',
          choice: keys[0],
          confidence: 1,
          probabilities: Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0]))
        }
      } else if (question.type === 'noul') answers[id] = { type: 'noul', noul: 1 }
      else throw new Error('unexpected_synthetic_score')
    }
    return { model: 'jev-test-resolved', answers, usage: { input_tokens: 10, output_tokens: 5 } }
  })
  const generator = {
    generate: vi.fn(async () => {
      throw new Error('human_handoff_must_not_generate_text')
    })
  }
  const services = workers.map((db) => {
    const authority = new AccountAuthority(db)
    return new GenerationService(
      authority,
      new ExecutionAuthority(authority, async (db, scope) => {
        await loadPublication(db, scope)
      }),
      new JevReplyPipeline({ evaluate }, generator),
      publication.textGeneratorVersion
    )
  })
  return { services, evaluate, generator }
}

describe('real PostgreSQL multi-connection authority', () => {
  it('closes unknown evidence once across independent dedicated pools while ordinary application writes and foreign-account reads are denied', async () => {
    const reference = randomUUID()
    let now = Date.now()
    await root.query(
      'INSERT INTO learning_worker_bindings(id,login_name,tenant_id,account_id,employee_id,agent_id,agent_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        reference,
        'concurrency_learning',
        'company',
        'account-A',
        'employee-A',
        'agent-A',
        tokenHash(credentials[0])
      ]
    )
    const app = new AccountAuthority(workers[0])
    const cases = []
    for (const index of [0, 1]) {
      const repository = new EnterpriseLearningRepository(app, { now: () => now })
      const episode = await repository.recordEpisode(
        credentials[index],
        tasks[index].conversationId,
        {
          sourceId: enterpriseDraftSource(tasks[index]),
          identityStatus: 'verified',
          topic: '合成独立问题',
          startedAt: now,
          messages: [{ sourceId: 'synthetic-inbound', role: 'customer', text: '请核对订单。' }],
          draft: '请提供订单号。',
          outcome: 'unknown'
        }
      )
      await repository.registerGeneration(
        credentials[index],
        tasks[index].conversationId,
        episode.sourceId,
        episode.id,
        []
      )
      cases.push(episode)
    }
    await root.query("UPDATE generation_tasks SET status='failed'")
    const secondPool = new Postgres(learningLoginUrl)
    try {
      now += 30 * 60 * 1000
      const results = await Promise.all(
        [learningWorkerDb, secondPool].map((database) =>
          new EnterpriseLearningMaintenanceService(
            new EnterpriseLearningWorkerAuthority(database),
            { now: () => now }
          ).runOnce(reference)
        )
      )
      expect(results.flatMap((result) => result.closedEpisodes)).toHaveLength(1)
      expect(
        (await root.query('SELECT account_id,source_episode_id FROM learning_episode_closures'))
          .rows
      ).toEqual([{ account_id: 'account-A', source_episode_id: cases[0].id }])
      expect(
        (
          await root.query(
            "SELECT count(*)::int AS n FROM learning_episodes WHERE payload ? 'endedAt'"
          )
        ).rows[0]
      ).toEqual({ n: 1 })
      expect((await root.query('SELECT count(*)::int AS n FROM learning_jobs')).rows[0]).toEqual({
        n: 0
      })
      const visible = await app.withLockedAccount(credentials[1], async (client, scope) => {
        await client.query("SELECT set_config('app.learning_account_id',$1,true)", [
          scope.account_id
        ])
        return (await client.query('SELECT * FROM learning_episode_closures')).rows
      })
      expect(visible).toEqual([])
      await expect(
        app.withLockedAccount(credentials[0], async (client, scope) => {
          await client.query("SELECT set_config('app.learning_account_id',$1,true)", [
            scope.account_id
          ])
          await client.query(
            'INSERT INTO learning_episode_closures SELECT * FROM learning_episode_closures'
          )
        })
      ).rejects.toMatchObject({ code: '42501' })
    } finally {
      await secondPool.close()
    }
  })
  it('binds explicit management maintenance to the caller device as well as the dedicated worker and cancels after a lock-wait revoke', async () => {
    const secondaryCredential = 'D'.repeat(43)
    const reference = randomUUID()
    await root.query(
      'INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES($1,$2,$3,$4,$5)',
      ['company', 'agent-secondary', 'account-A', 'employee-A', tokenHash(secondaryCredential)]
    )
    await root.query(
      'INSERT INTO learning_worker_bindings(id,login_name,tenant_id,account_id,employee_id,agent_id,agent_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        reference,
        'concurrency_learning',
        'company',
        'account-A',
        'employee-A',
        'agent-A',
        tokenHash(credentials[0])
      ]
    )
    await root.query("UPDATE generation_tasks SET status='failed' WHERE account_id='account-A'")
    const authority = new AccountAuthority(workers[0])
    await expect(createEnterpriseLearningManagementRuntime(workers[0], authority)).rejects.toThrow()
    await new EnterpriseLearningManagement(workers[0], authority).request(
      secondaryCredential,
      'manual',
      {
        conversationId: 'customer-managed',
        sourceId: 'managed-method',
        reason: '合成员工教导',
        content: {
          kind: 'lesson',
          scenario: '询价',
          guidance: '核对型号',
          rationale: '',
          steps: [],
          pitfalls: [],
          verification: []
        }
      }
    )
    const runtime = await createEnterpriseLearningManagementRuntime(learningWorkerDb, authority)
    const managedServer = createServer(
      createApplication(authority, {
        learning: new EnterpriseLearningManagement(workers[0], authority, {
          curate: runtime.curate,
          validate: runtime.validate
        })
      })
    )
    await new Promise<void>((resolve) => managedServer.listen(0, '127.0.0.1', resolve))
    const managedBase = `http://127.0.0.1:${(managedServer.address() as AddressInfo).port}`
    const managedCurate = (dryRun: boolean) =>
      fetch(managedBase + '/v1/learning/curate', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secondaryCredential}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ conversationId: 'customer-managed', dryRun })
      })
    try {
      const preview = await managedCurate(true)
      expect(preview.status).toBe(200)
      expect(await preview.json()).toMatchObject({ status: 'initialized', dryRun: true })
      await expect(
        runtime.curate(credentials[1], 'customer-managed', false, new AbortController().signal)
      ).rejects.toMatchObject({ code: 'DENIED' })
      const lock = await holdAccount(root)
      const pending = managedCurate(false)
      try {
        await waitForLocks(1)
        await lock.client.query(
          "UPDATE agents SET revoked_at=clock_timestamp() WHERE id='agent-secondary'"
        )
      } finally {
        await lock.release()
      }
      const rejected = await pending
      expect(rejected.status).toBe(401)
      expect(await rejected.json()).toEqual({ error: 'DENIED' })
      expect(await new EnterpriseLearningWorkerAuthority(learningWorkerDb).references()).toEqual([
        reference
      ])
      expect(
        (
          await root.query(
            "SELECT count(*)::int AS n FROM learning_curation_state WHERE account_id='account-A'"
          )
        ).rows[0]
      ).toEqual({ n: 0 })
    } finally {
      await runtime.stop()
      managedServer.closeAllConnections()
      await new Promise<void>((resolve) => managedServer.close(() => resolve()))
    }
    await expect(
      runtime.curate(credentials[0], null, true, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'learning_shutdown' })
  })
  it('records task-bound employee corrections once across independent application pools and denies a revoked lock waiter', async () => {
    const repository = new EnterpriseLearningRepository(new AccountAuthority(workers[0]))
    const task = tasks[0],
      draft = { ...taskFixture().draft, taskId: task.taskId }
    const original = await repository.recordEpisode(credentials[0], task.conversationId, {
      sourceId: enterpriseDraftSource(task),
      topic: '退款核对',
      startedAt: Date.now(),
      messages: [{ sourceId: 'synthetic-inbound', role: 'customer', text: '如何退款？' }],
      draft: draft.text,
      outcome: 'unknown',
      identityStatus: 'verified'
    })
    await repository.registerGeneration(
      credentials[0],
      task.conversationId,
      enterpriseDraftSource(task),
      original.id,
      []
    )
    await root.query(
      "UPDATE generation_tasks SET status='completed',result_json=$1::jsonb WHERE tenant_id=$2 AND account_id=$3 AND task_id=$4",
      [
        JSON.stringify({
          task,
          status: 'handoff',
          automaticAllowed: false,
          factsVerified: false,
          reasons: [],
          intents: [],
          draft,
          usage: { input_tokens: 0, output_tokens: 0 }
        }),
        scopes[0].tenant_id,
        scopes[0].account_id,
        task.taskId
      ]
    )
    const services = workers
      .slice(0, 2)
      .map((database) => new EnterpriseLearningManagement(database, new AccountAuthority(database)))
    const input = {
      reference: {
        taskId: task.taskId,
        contextHash: task.contextHash,
        draftHash: draft.draftHash,
        draftRevision: draft.draftRevision
      },
      sourceId: 'synthetic-correction',
      text: '先核对订单状态',
      reason: '员工明确纠正'
    }
    const lock = await holdAccount(root)
    const pending = Promise.all(
      services.map((service) => service.request(credentials[0], 'correction', input))
    )
    try {
      await waitForLocks(2)
    } finally {
      await lock.release()
    }
    const records = (await pending) as { id: string }[]
    expect(records[0].id).toBe(records[1].id)
    expect(
      (await root.query('SELECT count(*)::int AS n FROM learning_task_events')).rows[0]
    ).toEqual({ n: 1 })
    expect((await root.query('SELECT count(*)::int AS n FROM learning_episodes')).rows[0]).toEqual({
      n: 2
    })
    expect((await root.query('SELECT payload FROM learning_jobs')).rows).toMatchObject([
      { payload: { episodeIds: [records[0].id], triggers: ['correction'] } }
    ])
    await expect(services[1].request(credentials[1], 'correction', input)).rejects.toMatchObject({
      status: 404
    })
    const windowInput = {
      conversationId: task.conversationId,
      episodeId: records[0].id,
      sourceId: 'synthetic-window-correction',
      text: input.text,
      reason: input.reason
    }
    const windowLock = await holdAccount(root)
    const windowPending = Promise.all(
      services.map((service) => service.request(credentials[0], 'episode-correction', windowInput))
    )
    try {
      await waitForLocks(2)
    } finally {
      await windowLock.release()
    }
    const windowRecords = (await windowPending) as {
      id: string
      draft: string
      correction: string
    }[]
    expect(windowRecords[0]).toEqual(windowRecords[1])
    expect(windowRecords[0]).toMatchObject({ draft: draft.text, correction: input.text })
    await expect(
      services[1].request(credentials[1], 'episode-correction', windowInput)
    ).rejects.toMatchObject({ status: 404 })
    const revokeLock = await holdAccount(root)
    const waiter = services[0].request(credentials[0], 'correction', {
      ...input,
      sourceId: 'revoked-correction'
    })
    const rejected = expect(waiter).rejects.toMatchObject({ code: 'DENIED' })
    try {
      await waitForLocks(1)
      await revokeLock.client.query(
        "UPDATE agents SET revoked_at=clock_timestamp() WHERE tenant_id='company' AND id='agent-A'"
      )
    } finally {
      await revokeLock.release()
    }
    await rejected
    expect(
      (await root.query('SELECT count(*)::int AS n FROM learning_task_events')).rows[0]
    ).toEqual({ n: 2 })
  })
  it('atomically teaches once across two ordinary management pools without nested account transactions', async () => {
    const services = workers
      .slice(0, 2)
      .map((database) => new EnterpriseLearningManagement(database, new AccountAuthority(database)))
    const input = {
      conversationId: 'customer-management',
      sourceId: 'synthetic-management-teaching',
      content: {
        kind: 'lesson',
        scenario: '询价',
        guidance: '核对型号',
        rationale: '',
        steps: [],
        pitfalls: [],
        verification: []
      },
      reason: '合成明确人工教导'
    }
    const lock = await holdAccount(root)
    const pending = Promise.all(
      services.map((service) => service.request(credentials[0], 'manual', input))
    )
    try {
      await waitForLocks(2)
    } finally {
      await lock.release()
    }
    const records = (await pending) as { id: string }[]
    expect(records[0].id).toBe(records[1].id)
    expect(
      (
        await root.query(
          "SELECT count(*)::int AS n FROM learning_episodes WHERE account_id='account-A' AND source_id=$1",
          [input.sourceId]
        )
      ).rows[0]
    ).toEqual({ n: 1 })
    expect(
      (
        await root.query(
          "SELECT count(*)::int AS n FROM learning_mutations WHERE memory_id=$1 AND action='propose'",
          [records[0].id]
        )
      ).rows[0]
    ).toEqual({ n: 1 })
    expect(
      await services[0].request(credentials[0], 'snapshot', {
        conversationId: input.conversationId
      })
    ).toMatchObject({
      scope: { accountId: 'account-A' },
      memories: [{ record: { id: records[0].id, state: 'pending' } }],
      episodes: [{ sourceId: input.sourceId }]
    })
    await expect(
      services[1].request(credentials[1], 'detail', {
        conversationId: input.conversationId,
        id: records[0].id
      })
    ).rejects.toMatchObject({ status: 404 })
    await root.query("UPDATE agents SET revoked_at=clock_timestamp() WHERE id='agent-A'")
    await expect(services[0].request(credentials[0], 'snapshot', {})).rejects.toMatchObject({
      code: 'DENIED'
    })
  })
  async function prepareRestorePause() {
    const descriptor = {
      formatVersion: 1,
      restoreId: randomUUID(),
      backupId: randomUUID(),
      sourceSha256: 'a'.repeat(64),
      restoredAt: new Date().toISOString(),
      previousRestoreId: null,
      previousContextHash: null,
      requiresReconciliation: true
    }
    const context = { ...descriptor, contextHash: hashContext(descriptor) }
    await root.query(
      "UPDATE account_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id='company' AND account_id='account-A'"
    )
    const review = await administrator.openRestoreReview('company', 'account-A', {
      agentId: 'agent-A',
      context
    })
    return {
      caseId: review.caseId,
      requestId: randomUUID(),
      restoreId: context.restoreId,
      contextHash: context.contextHash
    }
  }
  it('serializes target pause challenges and duplicate reports on actual account locks without releasing restoration', async () => {
    const input = await prepareRestorePause()
    const services = workers
      .slice(0, 2)
      .map((db) => new RestorePauseAuthority(new AccountAuthority(db)))
    expect(
      await services[0].lookup(credentials[0], {
        restoreId: input.restoreId,
        contextHash: input.contextHash
      })
    ).toMatchObject({
      caseId: input.caseId,
      restoreId: input.restoreId,
      contextHash: input.contextHash,
      scope: { agent_id: 'agent-A', account_id: 'account-A' }
    })
    expect(
      (await root.query('SELECT count(*)::int AS count FROM ledger_restore_challenges')).rows
    ).toEqual([{ count: 0 }])
    await expect(
      services[0].lookup(credentials[1], {
        restoreId: input.restoreId,
        contextHash: input.contextHash
      })
    ).rejects.toThrow('RESTORE_PAUSE_CONFLICT')
    const lock = await holdAccount(root)
    const pending = Promise.allSettled(
      services.map((service) => service.challenge(credentials[0], input))
    )
    try {
      await waitForLocks(2)
    } finally {
      await lock.release()
    }
    const challenges = (await pending).map((result) => {
      if (result.status !== 'fulfilled') throw result.reason
      return result.value
    })
    expect(challenges[0]).toEqual(challenges[1])
    const report = {
      challenge: challenges[0],
      instanceId: randomUUID(),
      runtimeGeneration: 2,
      stoppedAt: Date.now(),
      observedAt: Date.now(),
      stopped: {
        observerStopped: true,
        senderQuiescent: true,
        settlementQuiescent: true,
        leaseStopped: true,
        platformStopped: true
      }
    }
    const reportLock = await holdAccount(root)
    const reports = Promise.allSettled(
      services.map((service) => service.report(credentials[0], report))
    )
    try {
      await waitForLocks(2)
    } finally {
      await reportLock.release()
    }
    const receipts = (await reports).map((result) => {
      if (result.status !== 'fulfilled') throw result.reason
      return result.value
    })
    expect(receipts[0]).toEqual(receipts[1])
    expect(receipts[0].reportHash).toBe(hashContext(report))
    const permitAudit = await administrator.restorePermitAudit('company', 'account-A', input.caseId)
    expect(permitAudit).toMatchObject({
      canRelease: false,
      localWatermarksRequired: true,
      summary: { capturedCount: 0, currentCount: 0 }
    })
    await expect(
      administrator.restorePermitAudit('company', 'account-B', input.caseId)
    ).rejects.toThrow('RESTORE_REVIEW_NOT_FOUND')
    expect(
      await administrator.restorePauseReports('company', 'account-A', input.caseId)
    ).toMatchObject([
      {
        challengeId: report.challenge.challengeId,
        reportHash: receipts[0].reportHash,
        declarationKind: 'target_main_process'
      }
    ])
    expect(
      await administrator.restorePauseReport(
        'company',
        'account-A',
        input.caseId,
        report.challenge.challengeId
      )
    ).toMatchObject({ report })
    await expect(
      administrator.restorePauseReport(
        'company',
        'account-B',
        input.caseId,
        report.challenge.challengeId
      )
    ).rejects.toThrow('RESTORE_REVIEW_NOT_FOUND')
    expect(
      (await root.query('SELECT count(*)::int AS count FROM ledger_restore_challenges')).rows
    ).toEqual([{ count: 1 }])
    expect(
      (await root.query('SELECT count(*)::int AS count FROM ledger_restore_pause_reports')).rows
    ).toEqual([{ count: 1 }])
    expect(
      (
        await root.query(
          "SELECT count(*)::int AS count FROM audit_events WHERE kind='ledger_restore_target_pause_recorded'"
        )
      ).rows
    ).toEqual([{ count: 1 }])
    await expect(administrator.resume('company', 'account-A')).rejects.toThrow('UNRESOLVED_RESTORE')
    await expect(
      services[1].report(credentials[0], { ...report, instanceId: randomUUID() })
    ).rejects.toThrow('RESTORE_PAUSE_CONFLICT')
    await workers[0].transaction('company', async (db) => {
      await db.query(
        "SELECT set_config('app.restore_account_id','account-B',true),set_config('app.restore_agent_id','agent-B',true)"
      )
      expect((await db.query('SELECT id FROM ledger_restore_reviews')).rows).toEqual([])
      expect(
        (await db.query('SELECT challenge_id FROM ledger_restore_pause_reports')).rows
      ).toEqual([])
    })
  })
  it('rechecks revoked target authority after a pause report waits on the actual account lock', async () => {
    const input = await prepareRestorePause()
    const service = new RestorePauseAuthority(new AccountAuthority(workers[0]))
    const challenge = await service.challenge(credentials[0], input)
    const report = {
      challenge,
      instanceId: randomUUID(),
      runtimeGeneration: 1,
      stoppedAt: Date.now(),
      observedAt: Date.now(),
      stopped: {
        observerStopped: true,
        senderQuiescent: true,
        settlementQuiescent: true,
        leaseStopped: true,
        platformStopped: true
      }
    }
    const lock = await holdAccount(root)
    const pending = Promise.allSettled([service.report(credentials[0], report)])
    try {
      await waitForLocks(1)
      await lock.client.query(
        "UPDATE agents SET revoked_at=clock_timestamp() WHERE tenant_id='company' AND id='agent-A'"
      )
    } finally {
      await lock.release()
    }
    expect((await pending)[0]).toMatchObject({ status: 'rejected', reason: { code: 'DENIED' } })
    expect(
      (await root.query('SELECT count(*)::int AS count FROM ledger_restore_pause_reports')).rows
    ).toEqual([{ count: 0 }])
  })
  it('serializes duplicate inventory start, page and complete on independent PostgreSQL connections', async () => {
    const input = await prepareRestorePause(),
      services = workers
        .slice(0, 2)
        .map((db) => new RestorePauseAuthority(new AccountAuthority(db)))
    const challenge = await services[0].challenge(credentials[0], input),
      now = Date.now()
    await services[0].report(credentials[0], {
      challenge,
      instanceId: randomUUID(),
      runtimeGeneration: 2,
      stoppedAt: now,
      observedAt: now,
      stopped: {
        observerStopped: true,
        senderQuiescent: true,
        settlementQuiescent: true,
        leaseStopped: true,
        platformStopped: true
      }
    })
    const scope = scopes[0],
      identity = tasks[0].identity
    const message = {
      kind: 'message' as const,
      key: `m:${hashContext({ identity, conversationId: 'synthetic' })}:0000000000000001`,
      identity,
      conversationId: 'synthetic',
      sourceMessageId: 'synthetic-1',
      sequence: 1,
      observedAt: 100,
      sequenceComplete: true,
      direction: 'inbound' as const,
      contentHash: 'c'.repeat(64),
      handledBy: null,
      identityVerified: true,
      messageIdVerified: true,
      hasGap: false,
      humanOwned: false,
      lastSequence: 1,
      revision: 0
    }
    const summary = {
      conversations: 1,
      messages: 1,
      inbound: 1,
      handledInbound: 0,
      unhandledInbound: 1,
      executions: 0,
      unknownExecutions: 0,
      pendingCentral: 0
    }
    const digest = (await import('node:crypto'))
      .createHash('sha256')
      .update(hashContext({ formatVersion: 1, context: challenge.context, scope }))
      .update(hashContext(message))
      .update(hashContext(summary))
      .digest('hex')
    const request = {
      caseId: input.caseId,
      requestId: randomUUID(),
      challengeId: challenge.challengeId,
      manifest: {
        formatVersion: 1 as const,
        evidenceKind: 'local_restored_metadata' as const,
        scope,
        context: challenge.context,
        basisHash: digest,
        summary,
        canRelease: false as const,
        externalEvidenceRequired: true as const
      }
    }
    const lock = await holdAccount(root)
    const starts = Promise.all(
      services.map((service) => service.inventoryStart(credentials[0], request))
    )
    try {
      await waitForLocks(2)
    } finally {
      await lock.release()
    }
    const started = await starts
    expect(started[0]).toEqual(started[1])
    const uploadId = started[0].uploadId,
      page = { uploadId, index: 0, items: [message] }
    const pages = await Promise.all(
      services.map((service) => service.inventoryPage(credentials[0], page))
    )
    expect(pages[0]).toEqual(pages[1])
    const receipts = await Promise.all(
      services.map((service) =>
        service.inventoryComplete(credentials[0], { uploadId, pageCount: 1 })
      )
    )
    expect(receipts[0]).toEqual(receipts[1])
    expect(receipts[0]).toMatchObject({ itemCount: 1, canRelease: false })
    expect(
      (
        await root.query(
          'SELECT (SELECT count(*)::int FROM ledger_restore_inventory_uploads) AS uploads,(SELECT count(*)::int FROM ledger_restore_inventory_pages) AS pages,(SELECT count(*)::int FROM ledger_restore_inventory_receipts) AS receipts'
        )
      ).rows
    ).toEqual([{ uploads: 1, pages: 1, receipts: 1 }])
    expect(
      await administrator.restoreInventories('company', 'account-A', input.caseId)
    ).toMatchObject([{ uploadId, state: 'inventory_received' }])
    expect(
      (await administrator.restoreInventoryItems('company', 'account-A', input.caseId, uploadId))
        .items
    ).toHaveLength(1)
    const assessment = await administrator.restoreAssessment(
      'company',
      'account-A',
      input.caseId,
      uploadId
    )
    const subject = assessment.items[0]
    const evidence = {
      noteId: randomUUID(),
      basisHash: assessment.basisHash,
      subjectKey: subject.key,
      subjectHash: subject.subjectHash,
      kind: subject.requiredEvidence,
      referenceId: 'concurrent-stop-evidence',
      evidenceHash: 'e'.repeat(64),
      observedAt: Date.now()
    }
    const evidenceAdminDb = new Postgres(administratorLoginUrl)
    try {
      const evidenceLock = await holdAccount(root)
      const records = Promise.all([
        administrator.recordRestoreEvidence(
          'company',
          'account-A',
          input.caseId,
          uploadId,
          evidence
        ),
        new Administration(evidenceAdminDb).recordRestoreEvidence(
          'company',
          'account-A',
          input.caseId,
          uploadId,
          evidence
        )
      ])
      try {
        await waitForLocks(2)
      } finally {
        await evidenceLock.release()
      }
      const recorded = await records
      expect(recorded[0]).toEqual(recorded[1])
      const secondAdministrator = new Administration(evidenceAdminDb)
      const ruling = {
        rulingId: randomUUID(),
        basisHash: assessment.basisHash,
        subjectKey: subject.key,
        subjectHash: subject.subjectHash,
        noteId: recorded[0].noteId,
        noteReceiptHash: hashContext(recorded[0]),
        expectedPreviousRulingId: null,
        outcome: 'hold',
        evidenceReviewed: true
      }
      const rulingLock = await holdAccount(root)
      const initialRulings = Promise.all(
        [administrator, secondAdministrator].map((admin) =>
          admin.recordRestoreRuling('company', 'account-A', input.caseId, uploadId, ruling)
        )
      )
      try {
        await waitForLocks(2)
      } finally {
        await rulingLock.release()
      }
      const initial = await initialRulings
      expect(initial[0]).toEqual(initial[1])
      const correctionLock = await holdAccount(root)
      const corrections = Promise.allSettled(
        [administrator, secondAdministrator].map((admin) =>
          admin.recordRestoreRuling('company', 'account-A', input.caseId, uploadId, {
            ...ruling,
            rulingId: randomUUID(),
            expectedPreviousRulingId: initial[0].rulingId,
            outcome: 'accept_for_quarantine'
          })
        )
      )
      try {
        await waitForLocks(2)
      } finally {
        await correctionLock.release()
      }
      const corrected = await corrections
      expect(corrected.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(corrected.filter((result) => result.status === 'rejected')).toHaveLength(1)
      const rejected = corrected.find((result) => result.status === 'rejected')!
      expect(rejected.status === 'rejected' && rejected.reason).toMatchObject({
        code: 'RESTORE_REVIEW_CONFLICT'
      })
      const messageSubject = assessment.items[1]
      const messageEvidence = await administrator.recordRestoreEvidence(
        'company',
        'account-A',
        input.caseId,
        uploadId,
        {
          ...evidence,
          noteId: randomUUID(),
          subjectKey: messageSubject.key,
          subjectHash: messageSubject.subjectHash,
          kind: messageSubject.requiredEvidence,
          observedAt: Date.now()
        }
      )
      await administrator.recordRestoreRuling('company', 'account-A', input.caseId, uploadId, {
        ...ruling,
        rulingId: randomUUID(),
        subjectKey: messageSubject.key,
        subjectHash: messageSubject.subjectHash,
        noteId: messageEvidence.noteId,
        noteReceiptHash: hashContext(messageEvidence),
        outcome: 'accept_for_quarantine'
      })
      const coverage = await administrator.restoreRulings(
        'company',
        'account-A',
        input.caseId,
        uploadId
      )
      expect(coverage.summary).toEqual({ subjects: 2, accepted: 2, held: 0, missing: 0 })
      const decision = {
        decisionId: randomUUID(),
        basisHash: coverage.basisHash,
        rulingsHash: coverage.rulingsHash,
        historyPolicy: 'quarantine',
        reviewedAllSubjects: true
      }
      const decisionLock = await holdAccount(root)
      const decisions = Promise.all(
        [administrator, secondAdministrator].map((admin) =>
          admin.sealRestoreDecision('company', 'account-A', input.caseId, uploadId, decision)
        )
      )
      try {
        await waitForLocks(2)
      } finally {
        await decisionLock.release()
      }
      const decided = await decisions
      expect(decided[0]).toEqual(decided[1])
      expect(decided[0]).toMatchObject({
        subjectCount: 2,
        canRelease: false,
        applicationRequired: true
      })
      const applicationInput = {
        caseId: input.caseId,
        uploadId,
        decisionId: decided[0].decisionId,
        restoreId: decided[0].restoreId,
        contextHash: decided[0].contextHash,
        decisionHash: hashContext(decided[0])
      }
      const targetDecision = await services[0].applicationDecision(credentials[0], applicationInput)
      expect(targetDecision).toMatchObject({
        decision: decided[0],
        scope: scopes[0],
        canRelease: false
      })
      expect((await workers[0].pool.query('SELECT current_user')).rows[0].current_user).toBe(
        'concurrency_app'
      )
      await expect(
        workers[0].transaction('company', (db) =>
          db.query('SELECT * FROM ledger_restore_decisions')
        )
      ).rejects.toThrow('permission denied')
      await expect(
        services[1].applicationDecision(credentials[1], applicationInput)
      ).rejects.toThrow()
      const applicationReceipt = {
        applicationId: randomUUID(),
        scope: scopes[0],
        ...applicationInput,
        inventoryBasisHash: targetDecision.manifest.basisHash,
        postInventoryBasisHash: 'd'.repeat(64),
        quarantinedInboundCount: targetDecision.manifest.summary.unhandledInbound,
        ownedConversationCount: 1,
        appliedAt: Date.now(),
        centralConfirmationRequired: true,
        canRelease: false
      }
      const applicationLock = await holdAccount(root)
      const applicationAcks = Promise.all(
        services
          .slice(0, 2)
          .map((service) => service.applicationAcknowledge(credentials[0], applicationReceipt))
      )
      try {
        await waitForLocks(2)
      } finally {
        await applicationLock.release()
      }
      const acknowledged = await applicationAcks
      expect(acknowledged[0]).toEqual(acknowledged[1])
      expect(acknowledged[0]).toMatchObject({
        applicationHash: hashContext(applicationReceipt),
        canRelease: false,
        automaticStart: false,
        status: 'quarantine_recorded'
      })
      expect((await workers[1].pool.query('SELECT current_user')).rows[0].current_user).toBe(
        'concurrency_app'
      )
      await expect(
        services[1].applicationAcknowledge(credentials[1], applicationReceipt)
      ).rejects.toThrow()
      await expect(
        services[0].applicationAcknowledge(credentials[0], {
          ...applicationReceipt,
          postInventoryBasisHash: 'f'.repeat(64)
        })
      ).rejects.toThrow('CONFLICT')
      expect(
        (
          await root.query(
            "SELECT (SELECT count(*)::int FROM ledger_restore_application_acks) AS acks,(SELECT count(*)::int FROM audit_events WHERE kind='ledger_restore_quarantine_recorded') AS audits"
          )
        ).rows
      ).toEqual([{ acks: 1, audits: 1 }])
      await expect(administrator.resume('company', 'account-A')).rejects.toThrow(
        'UNRESOLVED_RESTORE'
      )
      expect(
        (
          await root.query(
            "SELECT (SELECT count(*)::int FROM ledger_restore_rulings) AS rulings,(SELECT count(*)::int FROM ledger_restore_decisions) AS decisions,(SELECT count(*)::int FROM audit_events WHERE kind='ledger_restore_ruling_recorded') AS ruling_audits,(SELECT count(*)::int FROM audit_events WHERE kind='ledger_restore_decision_sealed') AS decision_audits"
          )
        ).rows
      ).toEqual([{ rulings: 3, decisions: 1, ruling_audits: 3, decision_audits: 1 }])
    } finally {
      await evidenceAdminDb.close()
    }
    expect(
      (await root.query('SELECT count(*)::int AS count FROM ledger_restore_evidence')).rows
    ).toEqual([{ count: 2 }])
    expect(
      (
        await root.query(
          "SELECT count(*)::int AS count FROM audit_events WHERE kind='ledger_restore_evidence_recorded'"
        )
      ).rows
    ).toEqual([{ count: 2 }])
    expect(
      (await administrator.restoreEvidence('company', 'account-A', input.caseId, uploadId)).items
    ).toEqual(
      expect.arrayContaining(
        [{ currentBasis: true, receipt: { noteId: evidence.noteId, canRelease: false } }].map(
          (value) =>
            expect.objectContaining({
              currentBasis: value.currentBasis,
              receipt: expect.objectContaining(value.receipt)
            })
        )
      )
    )
    await root.query(
      "UPDATE accounts SET paused=true WHERE id='account-B'; UPDATE account_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id='account-B'"
    )
    await expect(services[1].inventoryPage(credentials[1], page)).rejects.toThrow(
      'RESTORE_INVENTORY_CONFLICT'
    )
    await expect(administrator.resume('company', 'account-A')).rejects.toThrow('UNRESOLVED_RESTORE')
    const applicationReceipt = (
      await root.query('SELECT application_json FROM ledger_restore_application_acks')
    ).rows[0].application_json
    const revokeLock = await holdAccount(root)
    const lateAck = Promise.allSettled([
      services[0].applicationAcknowledge(credentials[0], applicationReceipt)
    ])
    try {
      await waitForLocks(1)
      await revokeLock.client.query(
        "UPDATE agents SET revoked_at=clock_timestamp() WHERE tenant_id='company' AND id='agent-A'"
      )
    } finally {
      await revokeLock.release()
    }
    expect((await lateAck)[0]).toMatchObject({ status: 'rejected', reason: { code: 'DENIED' } })
    expect(
      (await root.query('SELECT count(*)::int AS n FROM ledger_restore_application_acks')).rows
    ).toEqual([{ n: 1 }])
  })
  it('compares restore snapshots with authenticated late settlement under the real administrator role', async () => {
    const draftHash = 'b'.repeat(64)
    await root.query(
      `INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status,expires_at)
      VALUES('company','account-A','restore-audit-permit','agent-A',1,'restore-audit-task',$1,'issued',clock_timestamp()-interval '1 hour')`,
      [draftHash]
    )
    const input = await prepareRestorePause()
    const before = await administrator.restorePermitAudit('company', 'account-A', input.caseId)
    expect(before.summary).toMatchObject({
      capturedCount: 1,
      currentCount: 1,
      unresolvedCentralCount: 1,
      expiredIssuedCount: 1,
      changedCount: 0
    })
    await new ExecutionAuthority(new AccountAuthority(workers[0]), async () => {
      throw Error('unexpected_publication_validation')
    }).settle(credentials[0], {
      permitId: 'restore-audit-permit',
      draftHash,
      status: 'not_sent',
      dispatchStarted: false,
      quiescent: true,
      verificationProofHash: 'c'.repeat(64)
    })
    const after = await administrator.restorePermitAudit('company', 'account-A', input.caseId)
    expect(after.summary).toMatchObject({ unresolvedCentralCount: 0, changedCount: 1 })
    expect(after.items[0]).toMatchObject({
      openingStatus: 'issued',
      currentStatus: 'not_sent',
      settlementRecorded: true
    })
    await expect(
      administrator.restorePermitAudit('company', 'account-A', input.caseId, {
        expectedBasisHash: before.basisHash
      })
    ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
    await expect(administrator.resume('company', 'account-A')).rejects.toThrow('UNRESOLVED_RESTORE')
  })
  it('serializes restoration snapshots behind the same account lock as execution issuance', async () => {
    const descriptor = {
      formatVersion: 1,
      restoreId: randomUUID(),
      backupId: randomUUID(),
      sourceSha256: 'a'.repeat(64),
      restoredAt: new Date().toISOString(),
      previousRestoreId: null,
      previousContextHash: null,
      requiresReconciliation: true
    }
    const input = {
      agentId: 'agent-A',
      context: { ...descriptor, contextHash: hashContext(descriptor) }
    }
    const lock = await holdAccount(root)
    const pending = Promise.allSettled([
      administrator.openRestoreReview('company', 'account-A', input),
      administrator.openRestoreReview('company', 'account-A', input)
    ])
    try {
      await waitForLocks(2)
      await lock.client.query(
        `INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status) VALUES('company','account-A','before-restore','agent-A',1,'before-task',$1,'issued')`,
        ['b'.repeat(64)]
      )
    } finally {
      await lock.release()
    }
    const results = await pending
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true)
    const values = results.map((result) => {
      if (result.status !== 'fulfilled') throw result.reason
      return result.value
    })
    expect(values[0]).toEqual(values[1])
    expect(values[0].permitCount).toBe(1)
    expect(
      await administrator.restoreReviewPermits('company', 'account-A', values[0].caseId)
    ).toMatchObject([{ permitId: 'before-restore', status: 'issued' }])
    expect(
      (await root.query('SELECT count(*)::int AS count FROM ledger_restore_reviews')).rows
    ).toEqual([{ count: 1 }])
    await expect(
      new AccountAuthority(workers[0]).withLockedAccount(credentials[0], async () => 'admitted')
    ).rejects.toThrow()
    await expect(
      workers[1].transaction('company', (db) =>
        db.query("UPDATE accounts SET paused=false WHERE id='account-A'")
      )
    ).rejects.toMatchObject({ message: 'ledger_restore_review_pending' })
  })
  it('refuses a revoked restore target after its administrator request waits for the account lock', async () => {
    const descriptor = {
      formatVersion: 1,
      restoreId: randomUUID(),
      backupId: randomUUID(),
      sourceSha256: 'a'.repeat(64),
      restoredAt: new Date().toISOString(),
      previousRestoreId: null,
      previousContextHash: null,
      requiresReconciliation: true
    }
    const lock = await holdAccount(root)
    const pending = Promise.allSettled([
      administrator.openRestoreReview('company', 'account-A', {
        agentId: 'agent-A',
        context: { ...descriptor, contextHash: hashContext(descriptor) }
      })
    ])
    try {
      await waitForLocks(1)
      await lock.client.query(
        "UPDATE agents SET revoked_at=clock_timestamp() WHERE tenant_id='company' AND id='agent-A'"
      )
    } finally {
      await lock.release()
    }
    expect((await pending)[0]).toMatchObject({
      status: 'rejected',
      reason: { code: 'RESTORE_REVIEW_CONFLICT' }
    })
    expect(
      (await root.query('SELECT count(*)::int AS count FROM ledger_restore_reviews')).rows
    ).toEqual([{ count: 0 }])
    expect((await root.query("SELECT paused FROM accounts WHERE id='account-A'")).rows).toEqual([
      { paused: false }
    ])
  })
  it('shares validation admission and call reservations across worker pools and reviewer accounting', async () => {
    const secondDatabase = new Postgres(learningLoginUrl)
    try {
      const reference = randomUUID(),
        now = Date.now()
      await root.query(
        'INSERT INTO learning_worker_bindings(id,login_name,tenant_id,account_id,employee_id,agent_id,agent_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          reference,
          'concurrency_learning',
          'company',
          'account-A',
          'employee-A',
          'agent-A',
          tokenHash(credentials[0])
        ]
      )
      await root.query("UPDATE generation_tasks SET status='failed' WHERE account_id='account-A'")
      const authorities = [learningWorkerDb, secondDatabase].map(
        (db) => new EnterpriseLearningWorkerAuthority(db)
      )
      const repository = new EnterpriseLearningRepository(authorities[0], { now: () => now })
      await repository.settings(reference, 'customer', { dailyReviewTokenBudget: 1000 })
      const budgets = [learningWorkerDb, secondDatabase].map(
        (db, index) =>
          new EnterpriseLearningValidationBudget(db, authorities[index], { now: () => now })
      )
      const held = await holdAccount(root)
      const pending = Promise.allSettled(
        budgets.map((budget, index) =>
          budget.begin(reference, 'customer', `race-source-${index}`, `worker-${index}`)
        )
      )
      try {
        await waitForLocks(2)
      } finally {
        await held.release()
      }
      const admission = await pending
      expect(admission.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
      expect(admission.filter((entry) => entry.status === 'rejected')).toMatchObject([
        { reason: { message: 'learning_background_busy' } }
      ])
      const winner = admission.find((entry) => entry.status === 'fulfilled')!
      if (winner.status !== 'fulfilled') throw new Error('missing_validation_admission')
      const run = winner.value
      const reservations = await Promise.allSettled(
        Array.from({ length: 12 }, (_, index) =>
          budgets[index % 2].reserve(reference, run, 100, 200)
        )
      )
      expect(reservations.filter((entry) => entry.status === 'fulfilled')).toHaveLength(3)
      expect(reservations.filter((entry) => entry.status === 'rejected')).toHaveLength(9)
      const queue = new EnterpriseLearningQueue(learningWorkerDb, authorities[0], {
        now: () => now
      })
      expect(await queue.usage(reference)).toMatchObject({ reservedTokens: 900, requests: 3 })
      expect(await queue.claim(reference, 'reviewer')).toBeNull()
      const receipt = reservations.find((entry) => entry.status === 'fulfilled')!
      if (receipt.status !== 'fulfilled') throw new Error('missing_validation_receipt')
      await receipt.value.settleUsage({ inputTokens: 10, outputTokens: 5, measurement: 'reported' })
      expect(await queue.usage(reference)).toMatchObject({
        reservedTokens: 615,
        reportedRequests: 1
      })
      await budgets[1].end(reference, run, 'cancelled')
      expect(
        (await root.query('SELECT count(*)::int AS n FROM learning_background_leases')).rows[0].n
      ).toBe(0)
    } finally {
      await secondDatabase.close()
    }
  })
  it('consumes a persisted validation grant once across separate dedicated worker pools and rejects application forgery', async () => {
    const secondDatabase = new Postgres(learningLoginUrl)
    try {
      const reference = randomUUID(),
        now = Date.now()
      await root.query(
        'INSERT INTO learning_worker_bindings(id,login_name,tenant_id,account_id,employee_id,agent_id,agent_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          reference,
          'concurrency_learning',
          'company',
          'account-A',
          'employee-A',
          'agent-A',
          tokenHash(credentials[0])
        ]
      )
      const authority = new EnterpriseLearningWorkerAuthority(learningWorkerDb)
      const repository = new EnterpriseLearningRepository(authority, { now: () => now })
      const validators = [authority, new EnterpriseLearningWorkerAuthority(secondDatabase)].map(
        (entry) =>
          new EnterpriseLearningValidationStore(entry, {
            now: () => now,
            validatorVersion: 'synthetic-validator-1'
          })
      )
      const source = await repository.recordEpisode(reference, 'training', {
        sourceId: 'grant-source',
        topic: '报价',
        startedAt: now,
        messages: [],
        correction: '先询问型号',
        outcome: 'corrected',
        identityStatus: 'verified'
      })
      const candidate = await repository.propose(reference, 'training', {
        source: 'review',
        content: {
          kind: 'skill',
          scenario: '报价前',
          guidance: '先询问型号',
          rationale: '',
          steps: ['询问型号'],
          pitfalls: [],
          verification: []
        },
        evidence: [{ episodeId: source.id }],
        reason: '员工纠正'
      })
      await validators[0].importCalibration(reference, 'training', {
        humanConfirmed: true,
        cases: Array.from({ length: 5 }, (_, index) => ({
          caseId: `case-${index}`,
          conversationId: `held-${index}`,
          input: '需要报价',
          expectedMethod: '型号',
          requiredTerms: ['型号'],
          forbiddenClaims: ['保证退款'],
          humanLabelled: true,
          labelOrigin: 'human' as const // Simulated human declaration for engineering tests only.
        }))
      })
      const port = await validators[0].bind(reference, 'training'),
        dataset = await validators[0].calibration(reference, 'training')
      const engine = new LearningValidator(port, {
        replay: async () => ({ text: '请提供型号', covered: false, severeErrors: [] }),
        assessRisk: async (revision) => ({
          contentHash: revision.contentHash,
          units: memorySemanticUnits(revision.content).map((unit) => ({
            path: unit.path,
            category: 'method',
            reason: '合成方法检查'
          }))
        })
      })
      const result = await engine.validate(
        {
          scope: port.scope,
          memoryId: candidate.id,
          revision: 1,
          cases: dataset.cases,
          knowledgeVersion: tasks[0].knowledgeVersion,
          policyVersion: tasks[0].decisionPolicyVersion
        },
        new AbortController().signal
      )
      expect(result.status).toBe('passed')
      await repository.settings(reference, 'training', { mode: 'auto' })
      const grant = (await validators[0].grants(reference, 'training', candidate.id))[0]
      await expect(
        workers[0].transaction('company', async (db) => {
          await db.query("SELECT set_config('app.learning_account_id','account-A',true)")
          await db.query(
            'INSERT INTO learning_activation_grants VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,NULL)',
            [
              'company',
              'account-A',
              'training',
              randomUUID(),
              candidate.id,
              1,
              JSON.stringify(grant)
            ]
          )
        })
      ).rejects.toMatchObject({ code: '42501' })
      const ordinary = new EnterpriseLearningValidationStore(new AccountAuthority(workers[0]), {
        validatorVersion: 'synthetic-validator-1'
      })
      expect(await ordinary.grants(credentials[1], 'training', candidate.id)).toEqual([])
      const held = await holdAccount(root)
      const pending = validators.map((store) =>
        store.activateValidated(reference, 'training', candidate.id, 1, result.grantId!)
      )
      const settled = Promise.allSettled(pending)
      try {
        await waitForLocks(2)
      } finally {
        await held.release()
      }
      const attempts = await settled
      expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
      expect(attempts.filter((entry) => entry.status === 'rejected')).toMatchObject([
        { reason: { message: 'validation_grant_used' } }
      ])
      expect(await validators[1].grants(reference, 'training', candidate.id)).toMatchObject([
        { usedAt: now }
      ])
      expect(
        (
          await root.query(
            "SELECT count(*)::int AS n FROM learning_mutations WHERE action='activate'"
          )
        ).rows[0].n
      ).toBe(1)
    } finally {
      await secondDatabase.close()
    }
  })
  it('composes the real HTTP reviewer under a dedicated login and commits one candidate across competing runtimes', async () => {
    const requests: { authorization: string | undefined; body: Record<string, unknown> }[] = []
    const model = createServer(async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk.toString()
      const body = JSON.parse(raw)
      requests.push({ authorization: request.headers.authorization, body })
      const digest = JSON.parse(body.messages[1].content)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  operations: [
                    {
                      action: 'create',
                      proposal: {
                        content: {
                          kind: 'lesson',
                          scenario: '设备询价',
                          guidance: '先确认型号再查询企业资料',
                          rationale: '避免错配',
                          steps: [],
                          pitfalls: [],
                          verification: []
                        },
                        evidence: [{ episodeId: digest.episodes[0].episodeId }],
                        reason: '员工纠正'
                      }
                    }
                  ]
                })
              }
            }
          ],
          usage: { prompt_tokens: 25, completion_tokens: 10 }
        })
      )
    })
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    const configuration = {
      models: [
        {
          id: 'reply-main',
          model: 'synthetic-review',
          baseURL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
          apiKey: 'synthetic-learning-key'
        }
      ],
      fallbackModelId: 'reply-main',
      monitorIntervalMs: 20
    }
    const runtimes: Awaited<ReturnType<typeof createEnterpriseLearningReviewer>>[] = []
    try {
      await expect(createEnterpriseLearningReviewer(workers[0], configuration)).rejects.toThrow(
        'learning_worker_role_required'
      )
      await expect(createEnterpriseLearningReviewer(adminDb, configuration)).rejects.toThrow(
        'privileged_learning_role_rejected'
      )
      const validationConfiguration = {
        ...configuration,
        text: {
          apiKey: 'synthetic-key',
          baseUrl: 'https://provider.example/v1/',
          model: 'synthetic-text',
          expectedModel: 'synthetic-text'
        },
        jevApiKey: 'synthetic-key'
      }
      await expect(
        createEnterpriseLearningValidator(workers[0], validationConfiguration)
      ).rejects.toThrow('learning_worker_role_required')
      await expect(
        createEnterpriseLearningValidator(adminDb, validationConfiguration)
      ).rejects.toThrow('privileged_learning_role_rejected')
      const validator = await createEnterpriseLearningValidator(
        learningWorkerDb,
        validationConfiguration
      )
      await validator.stop()
      await expect(createEnterpriseLearningMaintenance(workers[0])).rejects.toThrow(
        'learning_worker_role_required'
      )
      await expect(createEnterpriseLearningMaintenance(adminDb)).rejects.toThrow(
        'privileged_learning_role_rejected'
      )
      const maintenanceWorker = await createEnterpriseLearningMaintenance(learningWorkerDb)
      await maintenanceWorker.stop()
      const reference = randomUUID()
      await root.query(
        'INSERT INTO learning_worker_bindings(id,login_name,tenant_id,account_id,employee_id,agent_id,agent_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          reference,
          'concurrency_learning',
          'company',
          'account-A',
          'employee-A',
          'agent-A',
          tokenHash(credentials[0])
        ]
      )
      let now = Date.now() - 15000
      const authority = new EnterpriseLearningWorkerAuthority(learningWorkerDb)
      const repository = new EnterpriseLearningRepository(authority, { now: () => now })
      const queue = new EnterpriseLearningQueue(learningWorkerDb, authority, { now: () => now })
      // The shared fixture seeds running foreground tasks; this scenario starts after those tasks finish.
      await root.query(
        "UPDATE generation_tasks SET status='failed' WHERE tenant_id='company' AND account_id='account-A'"
      )
      const episode = await repository.recordEpisode(reference, 'customer-A', {
        sourceId: 'factory-correction',
        topic: '设备询价',
        startedAt: now,
        messages: [],
        correction: '先确认型号',
        outcome: 'corrected',
        identityStatus: 'verified'
      })
      await queue.enqueue(reference, 'customer-A', episode.id, 'correction', 'factory-correction')
      now += 15000
      runtimes.push(
        await createEnterpriseLearningReviewer(learningWorkerDb, configuration),
        await createEnterpriseLearningReviewer(learningWorkerDb, configuration)
      )
      // A caller mutating its configuration object cannot change an already constructed host catalogue.
      configuration.fallbackModelId = 'mutated-after-construction'
      const lock = await holdAccount(root)
      const pending = Promise.all(runtimes.map((runtime) => runtime.runOnce(reference)))
      try {
        await waitForLocks(2)
      } finally {
        await lock.release()
      }
      expect((await pending).sort()).toEqual(['completed', 'idle'])
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        authorization: 'Bearer synthetic-learning-key',
        body: {
          model: 'synthetic-review',
          max_tokens: 2000,
          stream: false,
          response_format: { type: 'json_object' }
        }
      })
      expect(requests[0].body).not.toHaveProperty('tools')
      const candidates = await repository.list(reference, 'customer-A')
      expect(candidates).toMatchObject([
        { state: 'pending', activeRevision: null, currentRevision: 1 }
      ])
      expect(await queue.list(reference, 'customer-A')).toMatchObject([
        { state: 'completed', proposedIds: [candidates[0].id] }
      ])
      expect(await queue.usage(reference)).toMatchObject({
        reservedTokens: 35,
        requests: 1,
        reportedRequests: 1
      })
    } finally {
      await Promise.allSettled(runtimes.map((runtime) => runtime.stop()))
      model.closeAllConnections()
      await new Promise<void>((resolve) => model.close(() => resolve()))
    }
  })
  it('serializes weekly curation across actual dedicated pools and rechecks foreground activity after lock waits', async () => {
    const reference = randomUUID()
    await root.query(
      'INSERT INTO learning_worker_bindings(id,login_name,tenant_id,account_id,employee_id,agent_id,agent_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        reference,
        'concurrency_learning',
        'company',
        'account-A',
        'employee-A',
        'agent-A',
        tokenHash(credentials[0])
      ]
    )
    await root.query(
      "UPDATE generation_tasks SET status='failed' WHERE tenant_id='company' AND account_id='account-A'"
    )
    const otherPool = new Postgres(learningLoginUrl)
    let now = Date.now() - 31 * 86400000
    const authority = new EnterpriseLearningWorkerAuthority(learningWorkerDb)
    const repository = new EnterpriseLearningRepository(authority, { now: () => now })
    const first = new EnterpriseLearningMaintenanceService(authority, { now: () => now })
    const second = new EnterpriseLearningMaintenanceService(
      new EnterpriseLearningWorkerAuthority(otherPool),
      { now: () => now }
    )
    try {
      const episode = await repository.recordEpisode(reference, 'customer-A', {
        sourceId: 'maintenance-source',
        topic: '询价',
        startedAt: now,
        messages: [],
        outcome: 'corrected'
      })
      const memory = await repository.propose(reference, 'customer-A', {
        content: {
          kind: 'lesson',
          scenario: '询价',
          guidance: '先确认型号',
          rationale: '',
          steps: [],
          pitfalls: [],
          verification: []
        },
        evidence: [{ episodeId: episode.id }],
        source: 'review',
        reason: '合成教导'
      })
      await repository.activate(reference, 'customer-A', memory.id, 1)
      await first.curate(reference, 'customer-A')
      now += 31 * 86400000
      const lock = await holdAccount(root)
      const pending = Promise.all([
        first.curate(reference, 'customer-A'),
        second.curate(reference, 'customer-A')
      ])
      try {
        await waitForLocks(2)
      } finally {
        await lock.release()
      }
      expect((await pending).map((report) => report.status).sort()).toEqual([
        'completed',
        'waiting'
      ])
      expect((await repository.get(reference, 'customer-A', memory.id)).state).toBe('archived')
      expect(
        (
          await root.query(
            "SELECT 1 FROM learning_mutations WHERE tenant_id='company' AND account_id='account-A' AND action='curator_archive'"
          )
        ).rowCount
      ).toBe(1)
      expect(await first.reports(reference, 'customer-A')).toHaveLength(2)
      await repository.restore(reference, 'customer-A', memory.id, 1)
      now += 31 * 86400000
      const activeLock = await holdAccount(root)
      const waiting = first.curate(reference, 'customer-A')
      try {
        await waitForLocks(1)
        await activeLock.client.query(
          "INSERT INTO learning_foreground_activity(tenant_id,account_id,last_activity_at) VALUES('company','account-A',$1)",
          [now]
        )
      } finally {
        await activeLock.release()
      }
      expect(await waiting).toMatchObject({ status: 'waiting', reason: 'curation_idle_required' })
      expect((await repository.get(reference, 'customer-A', memory.id)).state).toBe('active')
      await expect(
        new AccountAuthority(workers[0]).withLockedAccount(credentials[0], async (client) => {
          await client.query("SELECT set_config('app.learning_account_id','account-A',true)")
          await client.query(
            "INSERT INTO learning_curation_state(tenant_id,account_id,conversation_id) VALUES('company','account-A','forged')"
          )
        })
      ).rejects.toThrow()
    } finally {
      await otherPool.close()
    }
  })
  it('runs configured merge factories through real HTTP with one candidate and fee across dedicated pools, and blocks ordinary manifest authors', async () => {
    const reference = randomUUID(),
      otherPool = new Postgres(learningLoginUrl)
    await root.query(
      'INSERT INTO learning_worker_bindings(id,login_name,tenant_id,account_id,employee_id,agent_id,agent_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        reference,
        'concurrency_learning',
        'company',
        'account-A',
        'employee-A',
        'agent-A',
        tokenHash(credentials[0])
      ]
    )
    await root.query(
      "UPDATE generation_tasks SET status='failed' WHERE tenant_id='company' AND account_id='account-A'"
    )
    let now = Date.now() - 14 * 86400000
    const authority = new EnterpriseLearningWorkerAuthority(learningWorkerDb)
    const repository = new EnterpriseLearningRepository(authority, { now: () => now })
    const requests: unknown[] = []
    const model = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => {
        body += String(chunk)
      })
      request.on('end', () => {
        requests.push(JSON.parse(body))
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            model: 'synthetic-merge',
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    content: {
                      kind: 'lesson',
                      scenario: '询价',
                      guidance: '合并检查型号和数量',
                      rationale: '',
                      steps: [],
                      pitfalls: [],
                      verification: []
                    },
                    reason: '合成同场景合并'
                  })
                }
              }
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10 }
          })
        )
      })
    })
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    const runtimes: Awaited<ReturnType<typeof createEnterpriseLearningMaintenance>>[] = []
    try {
      const originals: Awaited<ReturnType<typeof repository.propose>>[] = []
      for (const guidance of ['先确认型号', '再确认数量']) {
        const episode = await repository.recordEpisode(reference, 'customer-A', {
          sourceId: randomUUID(),
          topic: '询价',
          startedAt: now,
          messages: [],
          outcome: 'corrected',
          identityStatus: 'verified'
        })
        const memory = await repository.propose(reference, 'customer-A', {
          content: {
            kind: 'lesson',
            scenario: '询价',
            guidance,
            rationale: '',
            steps: [],
            pitfalls: [],
            verification: []
          },
          source: 'review',
          reason: '合成教导',
          evidence: [{ episodeId: episode.id }]
        })
        await repository.activate(reference, 'customer-A', memory.id, 1)
        originals.push(memory)
      }
      await new EnterpriseLearningMaintenanceService(authority, { now: () => now }).curate(
        reference,
        'customer-A'
      )
      await repository.settings(reference, 'customer-A', { curatorMergeEnabled: true })
      now = Date.now()
      const review = {
        models: [
          {
            id: 'reply-main',
            model: 'synthetic-merge',
            baseURL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
            apiKey: 'synthetic-key'
          }
        ],
        fallbackModelId: 'reply-main',
        monitorIntervalMs: 20
      }
      runtimes.push(
        await createEnterpriseLearningMaintenance(learningWorkerDb, { review }),
        await createEnterpriseLearningMaintenance(otherPool, { review })
      )
      review.fallbackModelId = 'caller-mutated'
      const lock = await holdAccount(root)
      const pending = Promise.all(runtimes.map((runtime) => runtime.runOnce(reference)))
      try {
        await waitForLocks(2)
      } finally {
        await lock.release()
      }
      await pending
      expect(requests).toHaveLength(1)
      const candidates = (await repository.list(reference, 'customer-A')).filter(
        (memory) => memory.state === 'pending'
      )
      expect(candidates).toHaveLength(1)
      expect(await repository.replacements(reference, 'customer-A', candidates[0].id)).toHaveLength(
        2
      )
      expect(
        await new EnterpriseLearningQueue(learningWorkerDb, authority).usage(reference)
      ).toMatchObject({ requests: 1, reservedTokens: 30 })
      await expect(
        new AccountAuthority(workers[0]).withLockedAccount(credentials[0], async (client) => {
          await client.query("SELECT set_config('app.learning_account_id','account-A',true)")
          await client.query(
            'INSERT INTO learning_curation_candidates VALUES($1,$2,$3,$4,$5,$6::jsonb)',
            [
              'company',
              'account-A',
              'customer-A',
              candidates[0].id,
              2,
              JSON.stringify(originals.map((memory) => ({ memoryId: memory.id, revision: 1 })))
            ]
          )
        })
      ).rejects.toMatchObject({ code: '42501' })
      // Human activation uses the ordinary application's narrow applied_at privilege.
      const deviceRepository = new EnterpriseLearningRepository(new AccountAuthority(workers[0]))
      const mergedRevision = (
        await deviceRepository.history(credentials[0], 'customer-A', candidates[0].id)
      )[0]
      await deviceRepository.revise(credentials[0], 'customer-A', candidates[0].id, 1, {
        content: { ...mergedRevision.content, guidance: '员工完善合并方法后仍保留全部替代关系' },
        evidence: mergedRevision.evidence,
        reason: '合成人工修订',
        source: 'human'
      })
      expect(
        await deviceRepository.replacements(credentials[0], 'customer-A', candidates[0].id)
      ).toHaveLength(2)
      const activationLock = await holdAccount(root)
      const activation = Promise.allSettled([
        deviceRepository.activate(credentials[0], 'customer-A', candidates[0].id, 2),
        new EnterpriseLearningRepository(new EnterpriseLearningWorkerAuthority(otherPool)).activate(
          reference,
          'customer-A',
          candidates[0].id,
          2
        )
      ])
      try {
        await waitForLocks(2)
      } finally {
        await activationLock.release()
      }
      expect((await activation).every((result) => result.status === 'fulfilled')).toBe(true)
      for (const original of originals)
        expect((await repository.get(reference, 'customer-A', original.id)).state).toBe('archived')
      expect(
        (
          await root.query(
            "SELECT count(*)::int AS n FROM learning_mutations WHERE action='curator_replaced' AND account_id='account-A'"
          )
        ).rows[0]
      ).toEqual({ n: 2 })
    } finally {
      await Promise.allSettled(runtimes.map((runtime) => runtime.stop()))
      await otherPool.close()
      model.closeAllConnections()
      await new Promise<void>((resolve) => model.close(() => resolve()))
    }
  })
  it('authorizes a restartable learning worker by its database login without holding device credentials and rechecks revocation after locks', async () => {
    const authority = new EnterpriseLearningWorkerAuthority(learningWorkerDb)
    expect(await authority.references()).toEqual([])
    const reference = randomUUID()
    await root.query(
      'INSERT INTO learning_worker_bindings(id,login_name,tenant_id,account_id,employee_id,agent_id,agent_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        reference,
        'concurrency_learning',
        'company',
        'account-A',
        'employee-A',
        'agent-A',
        tokenHash(credentials[0])
      ]
    )
    expect(await authority.references()).toEqual([reference])
    const restarted = new EnterpriseLearningWorkerAuthority(learningWorkerDb)
    const repository = new EnterpriseLearningRepository(restarted)
    const episode = await repository.recordEpisode(reference, 'customer-A', {
      sourceId: 'worker-after-restart',
      topic: '离线阅读',
      startedAt: Date.now(),
      messages: [],
      outcome: 'corrected'
    })
    expect(episode.scope.accountId).toBe('account-A')
    await expect(new EnterpriseLearningWorkerAuthority(workers[0]).references()).rejects.toThrow(
      'DENIED'
    )
    await expect(
      workers[0].transaction('company', (client) =>
        client.query('SELECT * FROM learning_worker_bindings')
      )
    ).rejects.toMatchObject({ code: '42501' })
    await expect(restarted.withLockedAccount(randomUUID(), async () => undefined)).rejects.toThrow(
      'DENIED'
    )
    const lock = await holdAccount(root)
    const mutation = vi.fn(async () => undefined)
    const pending = restarted.withLockedAccount(reference, mutation)
    const check = expect(pending).rejects.toThrow('DENIED')
    try {
      await waitForLocks(1)
      await lock.client.query(
        "UPDATE agents SET revoked_at=clock_timestamp() WHERE tenant_id='company' AND id='agent-A'"
      )
    } finally {
      await lock.release()
    }
    await check
    expect(mutation).not.toHaveBeenCalled()
    expect(await restarted.references()).toEqual([])
    // Clearing revoked_at alone cannot revive an old worker after a credential rotation.
    await root.query(
      "UPDATE agents SET revoked_at=NULL,token_hash=$1 WHERE tenant_id='company' AND id='agent-A'",
      [tokenHash('D'.repeat(43))]
    )
    expect(await restarted.references()).toEqual([])
    await expect(
      repository.recordEpisode(reference, 'customer-A', {
        sourceId: 'revoked-worker',
        topic: '离线阅读',
        startedAt: Date.now(),
        messages: [],
        outcome: 'unknown'
      })
    ).rejects.toThrow('DENIED')
  })
  it('serializes snapshot preparation, enforces immutable account-scoped rows and revokes snapshots after forgetting', async () => {
    const authorities = workers.map((db) => new AccountAuthority(db))
    const lock = await holdAccount(root)
    const pending = Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        authorities[index % 3].withLockedAccount(credentials[0], (client, scope) =>
          prepareEnterpriseLearningTask(client, scope, tasks[0], '离线阅读')
        )
      )
    )
    try {
      await waitForLocks(3)
    } finally {
      await lock.release()
    }
    const prepared = await pending
    expect(new Set(prepared.map(hashContext)).size).toBe(1)
    expect((await root.query('SELECT * FROM learning_preparations')).rows).toHaveLength(1)
    await expect(
      authorities[1].withLockedAccount(credentials[0], async (client, scope) => {
        await client.query("SELECT set_config('app.learning_account_id',$1,true)", [
          scope.account_id
        ])
        await client.query(
          "UPDATE learning_preparations SET task_json='{}'::jsonb WHERE task_id=$1",
          [tasks[0].taskId]
        )
      })
    ).rejects.toThrow('learning_preparation_immutable')
    expect(
      (
        await workers[2].transaction('company', async (client) => {
          await client.query("SELECT set_config('app.learning_account_id','account-B',true)")
          return client.query('SELECT * FROM learning_preparations')
        })
      ).rows
    ).toEqual([])
    const other = await authorities[2].withLockedAccount(credentials[1], (client, scope) =>
      prepareEnterpriseLearningTask(client, scope, tasks[1], '离线阅读')
    )
    const repository = new EnterpriseLearningRepository(authorities[0])
    await repository.settings(credentials[0], 'customer-A', { maxEntries: 1 })
    await repository.settings(credentials[0], 'customer-A', { maxEntries: 5 })
    await expect(
      authorities[1].withLockedAccount(credentials[0], (client, scope) =>
        assertEnterpriseLearningTaskCurrent(client, scope, prepared[0])
      )
    ).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
    await repository.forgetScope(credentials[0], 'customer-A')
    expect(
      (await root.query("SELECT * FROM learning_preparations WHERE account_id='account-A'")).rows
    ).toHaveLength(0)
    await expect(
      authorities[2].withLockedAccount(credentials[0], (client, scope) =>
        assertEnterpriseLearningTaskCurrent(client, scope, prepared[0])
      )
    ).rejects.toMatchObject({ code: 'TASK_CONFLICT' })
    expect(
      await authorities[1].withLockedAccount(credentials[1], (client, scope) =>
        assertEnterpriseLearningTaskCurrent(client, scope, other)
      )
    ).toMatchObject({ text: '' })
  })
  it('claims one learning job and reserves one shared account budget across three independent worker pools', async () => {
    await root.query("UPDATE generation_tasks SET status='failed' WHERE tenant_id='company'")
    let learningAt = Date.now()
    const repositories = workers.map(
      (db) => new EnterpriseLearningRepository(new AccountAuthority(db), { now: () => learningAt })
    )
    const queues = workers.map(
      (db) => new EnterpriseLearningQueue(db, new AccountAuthority(db), { now: () => learningAt })
    )
    await repositories[0].settings(credentials[0], null, { dailyReviewTokenBudget: 10000 })
    for (const conversation of ['customer-A', 'customer-B']) {
      const episode = await repositories[0].recordEpisode(credentials[0], conversation, {
        sourceId: `correction-${conversation}`,
        topic: '设备询价',
        startedAt: learningAt,
        messages: [],
        outcome: 'corrected'
      })
      await queues[0].enqueue(
        credentials[0],
        conversation,
        episode.id,
        'correction',
        `event-${conversation}`
      )
    }
    learningAt += 15000
    const lock = await holdAccount(root)
    const pending = Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        queues[index % 3].claim(credentials[0], `worker-${index}`)
      )
    )
    try {
      await waitForLocks(3)
    } finally {
      await lock.release()
    }
    const claims = (await pending).filter((claim) => claim !== null)
    expect(claims).toHaveLength(1)
    expect(await queues[2].usage(credentials[0])).toMatchObject({
      reservedTokens: 10000,
      requests: 1,
      estimatedRequests: 1
    })
    expect(
      (await root.query('SELECT count(*)::integer AS n FROM learning_attempts')).rows[0].n
    ).toBe(1)
    await queues[1].fail(credentials[0], claims[0], 'provider_timeout')
    learningAt += 15000
    expect(
      await Promise.all(queues.map((queue, index) => queue.claim(credentials[0], `retry-${index}`)))
    ).toEqual([null, null, null])
    expect(
      (await root.query('SELECT count(*)::integer AS n FROM learning_attempts')).rows[0].n
    ).toBe(1)
    // A busy or exhausted account does not block an unrelated employee account.
    const otherEpisode = await repositories[1].recordEpisode(credentials[1], 'customer-A', {
      sourceId: 'other-account-correction',
      topic: '设备询价',
      startedAt: learningAt,
      messages: [],
      outcome: 'corrected'
    })
    await queues[1].enqueue(
      credentials[1],
      'customer-A',
      otherEpisode.id,
      'correction',
      'other-account-event'
    )
    learningAt += 15000
    expect(await queues[2].claim(credentials[1], 'other-account-worker')).not.toBeNull()
  })
  it('serializes competing learning revisions across independent production pools', async () => {
    const repositories = workers.map(
      (db) => new EnterpriseLearningRepository(new AccountAuthority(db))
    )
    const episode = await repositories[0].recordEpisode(credentials[0], 'customer-A', {
      sourceId: 'human-correction',
      topic: '设备询价',
      startedAt: Date.now(),
      messages: [],
      outcome: 'corrected',
      identityStatus: 'verified'
    })
    const proposal: MemoryProposal = {
      content: {
        kind: 'lesson',
        scenario: '设备询价',
        guidance: '先确认型号和数量',
        rationale: '',
        steps: [],
        pitfalls: [],
        verification: []
      },
      evidence: [{ episodeId: episode.id }],
      source: 'human',
      reason: '合成员工纠正'
    }
    const memory = await repositories[0].propose(credentials[0], 'customer-A', proposal)
    const lock = await holdAccount(root)
    const pending = Promise.allSettled(
      repositories.map((repository, index) =>
        repository.revise(credentials[0], 'customer-A', memory.id, 1, {
          ...proposal,
          content: { ...proposal.content, guidance: `核对型号、数量和用途 ${index}` }
        })
      )
    )
    try {
      await waitForLocks(3)
    } finally {
      await lock.release()
    }
    const results = await pending
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(
      results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason.message)
    ).toEqual(['memory_revision_conflict', 'memory_revision_conflict'])
    expect(await repositories[2].get(credentials[0], 'customer-A', memory.id)).toMatchObject({
      currentRevision: 2,
      activeRevision: null
    })
    expect(await repositories[1].history(credentials[0], 'customer-A', memory.id)).toHaveLength(2)
  })
  it('restricts learning rows by account as well as tenant with the non-bypass application role', async () => {
    const repository = new EnterpriseLearningRepository(new AccountAuthority(workers[0]))
    await repository.recordEpisode(credentials[0], 'customer-A', {
      sourceId: 'account-A-only',
      topic: '设备询价',
      startedAt: Date.now(),
      messages: [],
      outcome: 'corrected'
    })
    const query = async (accountId?: string) =>
      workers[1].transaction('company', async (db) => {
        if (accountId)
          await db.query("SELECT set_config('app.learning_account_id',$1,true)", [accountId])
        return (await db.query('SELECT source_id FROM learning_episodes')).rows
      })
    expect(await query()).toEqual([])
    expect(await query('account-B')).toEqual([])
    expect(await query('account-A')).toEqual([{ source_id: 'account-A-only' }])
    await expect(
      workers[1].transaction('company', async (db) => {
        await db.query("SELECT set_config('app.learning_account_id','account-B',true)")
        await db.query(
          "INSERT INTO learning_settings(tenant_id,account_id,conversation_id,payload) VALUES('company','account-A','','{}')"
        )
      })
    ).rejects.toMatchObject({ code: '42501' })
    expect(
      await new EnterpriseLearningRepository(new AccountAuthority(workers[2])).episodes(
        credentials[2],
        'customer-A'
      )
    ).toEqual([])
  })
  it('rechecks revoked device authority after waiting for a learning mutation account lock', async () => {
    const repository = new EnterpriseLearningRepository(new AccountAuthority(workers[0]))
    const episode = await repository.recordEpisode(credentials[0], 'customer-A', {
      sourceId: 'before-revocation',
      topic: '设备询价',
      startedAt: Date.now(),
      messages: [],
      outcome: 'corrected'
    })
    const lock = await holdAccount(root)
    const pending = Promise.allSettled([
      repository.propose(credentials[0], 'customer-A', {
        content: {
          kind: 'lesson',
          scenario: '设备询价',
          guidance: '先确认型号',
          rationale: '',
          steps: [],
          pitfalls: [],
          verification: []
        },
        evidence: [{ episodeId: episode.id }],
        source: 'human',
        reason: '合成纠正'
      })
    ])
    try {
      await waitForLocks(1)
      await lock.client.query(
        "UPDATE agents SET revoked_at=clock_timestamp() WHERE tenant_id='company' AND id='agent-A'"
      )
    } finally {
      await lock.release()
    }
    expect((await pending)[0]).toMatchObject({ status: 'rejected' })
    expect(
      (await root.query('SELECT count(*)::integer AS n FROM learning_memories')).rows[0].n
    ).toBe(0)
  })
  it('fails admission if its privileged counter owner loses RLS bypass instead of silently undercounting tenants', async () => {
    await root.query(
      'ALTER FUNCTION autoreply.guard_generation_capacity() OWNER TO concurrency_app'
    )
    try {
      await expect(
        workers[0].transaction('company', (db) =>
          insertGeneration(db, { ...tasks[0], taskId: 'bad-owner-task' })
        )
      ).rejects.toMatchObject({ code: '42501' })
      expect(
        (await root.query("SELECT task_id FROM generation_tasks WHERE task_id='bad-owner-task'"))
          .rows
      ).toEqual([])
    } finally {
      await root.query('ALTER FUNCTION autoreply.guard_generation_capacity() OWNER TO postgres')
    }
    await workers[0].transaction('company', (db) =>
      insertGeneration(db, { ...tasks[0], taskId: 'restored-owner-task' })
    )
  })
  it('forces fresh READ COMMITTED snapshots even when a connection defaults to repeatable read', async () => {
    const database = new Postgres(applicationUrl)
    try {
      await database.pool.query("SET default_transaction_isolation='repeatable read'")
      expect(
        await database.transaction(
          'company',
          async (db) => (await db.query('SHOW transaction_isolation')).rows[0].transaction_isolation
        )
      ).toBe('read committed')
    } finally {
      await database.close()
    }
  })
  it('rejects raw repeatable-read admission instead of counting a stale snapshot', async () => {
    await administrator.setModelLimits('company', 'account-A', { dailyAttemptLimit: 1 })
    const client = await workers[0].pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await client.query("SELECT set_config('app.tenant_id','company',true)")
      await expect(
        insertGeneration(client, { ...tasks[0], taskId: 'repeatable-task' })
      ).rejects.toMatchObject({ message: 'generation_isolation_unsupported' })
      await client.query('ROLLBACK')
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await client.query("SELECT set_config('app.tenant_id','company',true)")
      await expect(rawReservation(client, 1)).rejects.toMatchObject({
        message: 'model_call_isolation_unsupported'
      })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    expect(
      (await root.query('SELECT count(*)::integer AS n FROM model_call_attempts')).rows[0].n
    ).toBe(0)
  })
  it('rechecks a task deadline after waiting for the shared admission lock', async () => {
    const holder = await root.connect()
    await holder.query('BEGIN')
    await holder.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('autoreply-generation-capacity:v1',0))"
    )
    const short = {
      ...tasks[0],
      taskId: 'expires-while-waiting',
      createdAt: Date.now(),
      expiresAt: Date.now() + 250
    }
    const pending = Promise.allSettled([
      workers[0].transaction('company', (db) => insertGeneration(db, short))
    ])
    try {
      await waitForLocks(1)
      while (Date.now() <= short.expiresAt) await delay(20)
    } finally {
      await holder.query('COMMIT')
      holder.release()
    }
    expect((await pending)[0]).toMatchObject({
      status: 'rejected',
      reason: { message: 'generation_task_expired' }
    })
    expect(
      (
        await root.query(
          "SELECT task_id FROM generation_tasks WHERE task_id='expires-while-waiting'"
        )
      ).rows
    ).toEqual([])
  })
  it('rejects a third account task across independent GenerationService instances with actual HTTP 429', async () => {
    await root.query(
      "DELETE FROM generation_tasks WHERE tenant_id='company' AND account_id='account-A'"
    )
    const release = deferred<void>(),
      started = deferred<void>()
    let entered = 0
    const { services, evaluate, generator } = await generationServices(async () => {
      if (++entered === 2) started.resolve()
      await release.promise
    })
    const pending = Promise.allSettled([
      services[0].generate(credentials[0], generationInput('first')),
      services[1].generate(credentials[0], generationInput('second'))
    ])
    const authority = new AccountAuthority(workers[2])
    const server = createServer(
      createApplication(authority, {
        execution: new ExecutionAuthority(authority, async (db, scope) => {
          await loadPublication(db, scope)
        }),
        generation: services[2]
      })
    )
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    try {
      await started.promise
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/replies/generate`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credentials[0]}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(generationInput('third'))
        }
      )
      expect(response.status).toBe(429)
      expect(await response.json()).toMatchObject({ error: 'GENERATION_OVERLOADED' })
      expect(evaluate).toHaveBeenCalledTimes(2)
      expect(generator.generate).not.toHaveBeenCalled()
      expect(
        (
          await root.query(
            "SELECT task_id FROM generation_tasks WHERE account_id='account-A' ORDER BY task_id"
          )
        ).rows
      ).toEqual([{ task_id: 'first' }, { task_id: 'second' }])
    } finally {
      release.resolve()
      await new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
    }
    expect((await pending).every((r) => r.status === 'fulfilled')).toBe(true)
    expect((await services[2].generate(credentials[0], generationInput('fourth'))).status).toBe(
      'handoff'
    )
  })

  it('admits only ten of twenty SQL claims across tenants and independent pools', async () => {
    await root.query('DELETE FROM generation_tasks')
    const jobs: ReplyTask[] = []
    for (let i = 0; i < 10; i++) {
      const task = await extraAccount(i)
      jobs.push(task, { ...task, taskId: `${task.taskId}-second` })
    }
    const holder = await root.connect()
    await holder.query('BEGIN')
    await holder.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('autoreply-generation-capacity:v1',0))"
    )
    const pending = Promise.allSettled(
      jobs.map((task, index) =>
        workers[index % 3].transaction(task.identity.tenantId, (db) => insertGeneration(db, task))
      )
    )
    try {
      await waitForLocks(3)
    } finally {
      await holder.query('COMMIT')
      holder.release()
    }
    const results = await pending
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10)
    const errors = results.filter((r) => r.status === 'rejected')
    expect(errors).toHaveLength(10)
    expect(
      errors.every(
        (r) => r.status === 'rejected' && r.reason.message === 'generation_cluster_overloaded'
      )
    ).toBe(true)
    expect(
      (
        await root.query(
          "SELECT count(*)::integer AS n FROM generation_tasks WHERE status='running'"
        )
      ).rows[0].n
    ).toBe(10)
    expect(
      (
        await root.query(
          'SELECT tenant_id,count(*)::integer AS n FROM generation_tasks GROUP BY tenant_id'
        )
      ).rows
    ).toHaveLength(2)
    expect(
      (
        await root.query(
          'SELECT count(*)::integer AS n FROM generation_tasks GROUP BY tenant_id,account_id'
        )
      ).rows.every((r) => r.n <= 2)
    ).toBe(true)
    await expect(
      workers[0].pool.query('SELECT autoreply.guard_generation_capacity()')
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('does not consume cluster capacity or model calls when serving a completed task cache', async () => {
    await root.query('DELETE FROM generation_tasks')
    const { services, evaluate } = await generationServices()
    const input = generationInput('cache-source')
    const result = await services[0].generate(credentials[0], input)
    for (let i = 0; i < 5; i++) {
      const task = await extraAccount(i)
      await workers[0].transaction(task.identity.tenantId, (db) => insertGeneration(db, task))
      await workers[1].transaction(task.identity.tenantId, (db) =>
        insertGeneration(db, { ...task, taskId: `${task.taskId}-second` })
      )
    }
    expect(await services[2].generate(credentials[0], input)).toEqual(result)
    expect(evaluate).toHaveBeenCalledOnce()
    await expect(
      services[2].generate(credentials[0], generationInput('over-full-cluster'))
    ).rejects.toMatchObject({ code: 'GENERATION_OVERLOADED' })
    expect(evaluate).toHaveBeenCalledOnce()
  })

  it('releases expired logical capacity without restarting old tasks or allowing late provider stages', async () => {
    await root.query("DELETE FROM generation_tasks WHERE account_id='account-A'")
    const old = {
      ...tasks[0],
      taskId: 'expiring-task',
      createdAt: Date.now(),
      expiresAt: Date.now() + 250
    }
    tasks[0] = old
    await workers[0].transaction('company', (db) => insertGeneration(db, old))
    await administrator.setModelLimits('company', 'account-A', { dailyAttemptLimit: 5 })
    while (Date.now() <= old.expiresAt) await delay(20)
    const upstream = vi.fn<typeof fetch>(async () => Response.json(jevResponse))
    await expect(provider(0, upstream)()).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' })
    expect(upstream).not.toHaveBeenCalled()
    await expect(
      workers[0].transaction('company', (db) => rawReservation(db, 1))
    ).rejects.toMatchObject({ message: 'model_call_not_authorized' })
    await expect(
      workers[0].transaction('company', (db) =>
        db.query(
          "UPDATE generation_tasks SET status='completed',result_json='{}' WHERE task_id='expiring-task'"
        )
      )
    ).rejects.toMatchObject({ message: 'generation_task_expired' })
    await expect(
      workers[0].transaction('company', (db) =>
        db.query(
          "UPDATE generation_tasks SET expires_at=clock_timestamp()+interval '1 minute' WHERE task_id='expiring-task'"
        )
      )
    ).rejects.toMatchObject({ message: 'generation_task_immutable' })
    const fresh = {
      ...old,
      taskId: 'fresh-task',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60000
    }
    await workers[1].transaction('company', (db) => insertGeneration(db, fresh))
    await workers[2].transaction('company', (db) =>
      insertGeneration(db, { ...fresh, taskId: 'fresh-second' })
    )
    await workers[0].transaction('company', (db) =>
      db.query("UPDATE generation_tasks SET status='failed' WHERE task_id='expiring-task'")
    )
    await expect(
      workers[0].transaction('company', (db) =>
        db.query("UPDATE generation_tasks SET status='running' WHERE task_id='expiring-task'")
      )
    ).rejects.toMatchObject({ message: 'generation_task_not_restartable' })
    expect(
      (await root.query('SELECT count(*)::integer AS n FROM model_call_attempts')).rows[0].n
    ).toBe(0)
  })
  it('shares exactly five reservations across three production pools and eighteen competing HTTP attempts', async () => {
    await administrator.setModelLimits('company', 'account-A', { dailyAttemptLimit: 5 })
    const upstream = vi.fn<typeof fetch>(async () => Response.json(jevResponse))
    const calls = workers.map((_, index) => provider(index, upstream))
    const lock = await holdAccount(root)
    const pending = Promise.allSettled(Array.from({ length: 18 }, (_, index) => calls[index % 3]()))
    try {
      await waitForLocks(3)
      expect(upstream).not.toHaveBeenCalled()
    } finally {
      await lock.release()
    }
    const results = await pending
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5)
    const failures = results.filter((r) => r.status === 'rejected')
    expect(failures).toHaveLength(13)
    expect(
      failures.every((r) => r.status === 'rejected' && r.reason.code === 'LIMIT_REACHED')
    ).toBe(true)
    expect(upstream).toHaveBeenCalledTimes(5)
    const rows = (
      await root.query(
        'SELECT attempt_number,task_hash FROM model_call_attempts ORDER BY attempt_number'
      )
    ).rows
    expect(rows.map((r) => r.attempt_number)).toEqual([1, 2, 3, 4, 5])
    expect(rows.every((r) => r.task_hash === hashContext(tasks[0]))).toBe(true)
    expect(
      (await root.query('SELECT count(*)::integer AS n FROM model_call_results')).rows[0].n
    ).toBe(5)
    expect(await administrator.modelLimits('company', 'account-A')).toMatchObject({
      reservedToday: 5,
      dailyAttemptLimit: 5
    })
  })

  it('enforces the final slot in the SQL trigger even without the service precheck', async () => {
    await administrator.setModelLimits('company', 'account-A', { dailyAttemptLimit: 1 })
    const lock = await holdAccount(root)
    const pending = Promise.allSettled([
      workers[0].transaction('company', (db) => rawReservation(db, 1)),
      workers[1].transaction('company', (db) => rawReservation(db, 2))
    ])
    try {
      await waitForLocks(2)
    } finally {
      await lock.release()
    }
    const results = await pending
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const denied = results.find((r) => r.status === 'rejected')
    expect(denied).toMatchObject({
      status: 'rejected',
      reason: { code: 'P0001', message: 'model_call_limit_reached' }
    })
    expect(
      (await root.query('SELECT count(*)::integer AS n FROM model_call_attempts')).rows[0].n
    ).toBe(1)
  })

  it('rolls back a reservation when its real backend is terminated before commit', async () => {
    await administrator.setModelLimits('company', 'account-A', { dailyAttemptLimit: 1 })
    const inserted = deferred<number>()
    const terminated = deferred<void>()
    const lost = workers[0].transaction('company', async (client) => {
      // The held client receives the actual server disconnect asynchronously.
      client.on('error', () => {})
      await rawReservation(client, 1)
      inserted.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await terminated.promise
      await client.query('SELECT 1')
    })
    const pending = Promise.allSettled([lost])
    const pid = await inserted.promise
    expect(
      (await root.query('SELECT pg_terminate_backend($1) AS stopped', [pid])).rows[0].stopped
    ).toBe(true)
    terminated.resolve()
    expect((await pending)[0].status).toBe('rejected')
    expect(
      (await root.query('SELECT count(*)::integer AS n FROM model_call_attempts')).rows[0].n
    ).toBe(0)
    const upstream = vi.fn<typeof fetch>(async () => Response.json(jevResponse))
    expect(await provider(0, upstream)()).toEqual(jevResponse)
    expect(upstream).toHaveBeenCalledOnce()
    expect(
      (await root.query('SELECT count(*)::integer AS n FROM model_call_results')).rows[0].n
    ).toBe(1)
  })

  it('retains a committed reservation without a result across independent workers', async () => {
    await administrator.setModelLimits('company', 'account-A', { dailyAttemptLimit: 1 })
    await workers[0].transaction('company', (client) => rawReservation(client, 1))
    const upstream = vi.fn<typeof fetch>(async () => Response.json(jevResponse))
    await expect(provider(2, upstream)()).rejects.toMatchObject({ code: 'LIMIT_REACHED' })
    expect(upstream).not.toHaveBeenCalled()
    expect(
      (await root.query('SELECT count(*)::integer AS n FROM model_call_results')).rows[0].n
    ).toBe(0)
    expect(await administrator.modelLimits('company', 'account-A')).toMatchObject({
      reservedToday: 1
    })
    const date = (
      await root.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day")
    ).rows[0].day
    expect(await administrator.modelUsage('company', 'account-A', date)).toMatchObject([
      {
        reserved_attempts: 1,
        unfinished_attempts: 1,
        unknown_usage_attempts: 1,
        known_input_tokens: '0',
        known_output_tokens: '0'
      }
    ])
  })

  it('rejects an actual database lock timeout without dispatch and recovers the rolled-back connection', async () => {
    await administrator.setModelLimits('company', 'account-A', { dailyAttemptLimit: 1 })
    const lock = await holdAccount(root)
    const upstream = vi.fn<typeof fetch>(async () => Response.json(jevResponse))
    const pending = Promise.allSettled([provider(0, upstream)()])
    try {
      await waitForLocks(1)
      expect((await pending)[0]).toMatchObject({
        status: 'rejected',
        reason: { code: 'RECORD_UNAVAILABLE' }
      })
      expect(upstream).not.toHaveBeenCalled()
    } finally {
      await lock.release()
    }
    expect(
      (await root.query('SELECT count(*)::integer AS n FROM model_call_attempts')).rows[0].n
    ).toBe(0)
    expect(await provider(0, upstream)()).toEqual(jevResponse)
    expect(upstream).toHaveBeenCalledOnce()
  })

  it('observes an administrator pause committed while the model reservation is waiting', async () => {
    await administrator.setModelLimits('company', 'account-A', { dailyAttemptLimit: 5 })
    const lock = await holdAccount(adminDb)
    await lock.client.query(
      "UPDATE accounts SET paused=true WHERE tenant_id='company' AND id='account-A'"
    )
    const upstream = vi.fn<typeof fetch>(async () => Response.json(jevResponse))
    const pending = Promise.allSettled([provider(0, upstream)()])
    try {
      await waitForLocks(1)
      expect(upstream).not.toHaveBeenCalled()
    } finally {
      await lock.release()
    }
    expect((await pending)[0]).toMatchObject({
      status: 'rejected',
      reason: { code: 'RECORD_UNAVAILABLE' }
    })
    expect(upstream).not.toHaveBeenCalled()
    expect(
      (await root.query('SELECT count(*)::integer AS n FROM model_call_attempts')).rows[0].n
    ).toBe(0)
  })

  it('rechecks a concurrently changed quota revision before any HTTP dispatch', async () => {
    await administrator.setModelLimits('company', 'account-A', { dailyAttemptLimit: 5 })
    const lock = await holdAccount(adminDb)
    await lock.client.query(
      "UPDATE model_call_limits SET daily_attempt_limit=0,revision=revision+1 WHERE tenant_id='company' AND account_id='account-A'"
    )
    const upstream = vi.fn<typeof fetch>(async () => Response.json(jevResponse))
    const pending = Promise.allSettled([provider(1, upstream)()])
    try {
      await waitForLocks(1)
    } finally {
      await lock.release()
    }
    expect((await pending)[0]).toMatchObject({
      status: 'rejected',
      reason: { code: 'LIMIT_REACHED' }
    })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('does not block another employee account behind a busy account row', async () => {
    await administrator.setModelLimits('company', 'account-A', { dailyAttemptLimit: 1 })
    await administrator.setModelLimits('company', 'account-B', { dailyAttemptLimit: 1 })
    const lock = await holdAccount(root)
    const upstreamA = vi.fn<typeof fetch>(async () => Response.json(jevResponse))
    const upstreamB = vi.fn<typeof fetch>(async () => Response.json(jevResponse))
    const pending = Promise.allSettled([provider(0, upstreamA)()])
    try {
      await waitForLocks(1)
      expect(await provider(1, upstreamB, 1)()).toEqual(jevResponse)
      expect(upstreamA).not.toHaveBeenCalled()
      expect(upstreamB).toHaveBeenCalledOnce()
    } finally {
      await lock.release()
    }
    expect((await pending)[0].status).toBe('fulfilled')
  })

  it('uses real administrator login isolation and rejects service mutation of immutable model history', async () => {
    await administrator.setModelLimits('company', 'account-A', { dailyAttemptLimit: 1 })
    await provider(
      0,
      vi.fn(async () => Response.json(jevResponse))
    )()
    await expect(administrator.modelLimits('other', 'account-C')).rejects.toMatchObject({
      code: 'DENIED'
    })
    await expect(
      adminDb.transaction('other', async (client) => {
        expect((await client.query('SELECT id FROM accounts')).rows).toEqual([])
        await client.query(
          "UPDATE model_call_limits SET daily_attempt_limit=10 WHERE tenant_id='other'"
        )
      })
    ).resolves.toBeUndefined()
    for (const statement of [
      'DELETE FROM model_call_attempts',
      "UPDATE model_call_results SET result_json='{}'",
      'UPDATE model_call_limits SET daily_attempt_limit=100'
    ])
      await expect(
        workers[0].transaction('company', (client) => client.query(statement))
      ).rejects.toMatchObject({ code: '42501' })
    expect(
      (await root.query('SELECT count(*)::integer AS n FROM model_call_results')).rows[0].n
    ).toBe(1)
  })

  it('grants an expired lease to only one of two competing device identities', async () => {
    await root.query(
      "UPDATE account_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id='account-A'"
    )
    await root.query(
      "INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('company','agent-other','account-A','employee-A',$1)",
      [tokenHash('D'.repeat(43))]
    )
    const lock = await holdAccount(root)
    const pending = Promise.allSettled([
      new AccountAuthority(workers[0]).acquireLease(credentials[0], 2, 'first-client'),
      new AccountAuthority(workers[1]).acquireLease('D'.repeat(43), 3, 'second-client')
    ])
    try {
      await waitForLocks(2)
    } finally {
      await lock.release()
    }
    const results = await pending
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'LEASE_CONFLICT' }
    })
    const winner = results.find((r) => r.status === 'fulfilled')
    if (winner?.status !== 'fulfilled') throw new Error('lease_winner_missing')
    expect(winner.value.version).toBe(2)
    const row = (
      await root.query(
        "SELECT agent_id,login_epoch,client_instance_id,version FROM account_leases WHERE tenant_id='company' AND account_id='account-A'"
      )
    ).rows[0]
    expect(row).toEqual({
      agent_id: winner.value.identity.agentId,
      login_epoch: String(winner.value.identity.loginEpoch),
      client_instance_id: winner.value.identity.clientInstanceId,
      version: '2'
    })
  })

  it.each(['seal', 'permit'] as const)(
    'keeps a permanent seal and permission mutually exclusive when %s commits first',
    async (first) => {
      await root.query(
        "UPDATE accounts SET paused=true WHERE tenant_id='company' AND id='account-A'; UPDATE account_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id='account-A'"
      )
      const insert = (client: PoolClient, kind: 'seal' | 'permit') =>
        kind === 'seal'
          ? client.query(
              `INSERT INTO execution_request_seals(tenant_id,account_id,id,agent_id,task_id,execution_id,request_hash,seal_hash,seal_json)
        VALUES('company','account-A','seal-A','agent-A','race-task','execution-A',$1,$2,'{}')`,
              ['1'.repeat(64), '2'.repeat(64)]
            )
          : client.query(
              `INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status)
        VALUES('company','account-A','permit-A','agent-A',1,'race-task',$1,'issued')`,
              ['3'.repeat(64)]
            )
      const holder = await workers[0].pool.connect()
      await holder.query('BEGIN')
      await holder.query("SELECT set_config('app.tenant_id','company',true)")
      const second = first === 'seal' ? 'permit' : 'seal'
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined
      try {
        await insert(holder, first)
        pending = Promise.allSettled([
          workers[1].transaction('company', (client) => insert(client, second))
        ])
        await waitForLocks(1)
        // The losing transaction began before the winner's row was committed.
      } finally {
        await holder.query('COMMIT')
        holder.release()
      }
      expect((await pending!)[0]).toMatchObject({
        status: 'rejected',
        reason: {
          code: 'P0001',
          message: first === 'seal' ? 'execution_request_sealed' : 'request_seal_existing_permit'
        }
      })
      const counts = (
        await root.query(
          `SELECT (SELECT count(*) FROM execution_request_seals)::integer AS seals,(SELECT count(*) FROM execution_permits)::integer AS permits`
        )
      ).rows[0]
      expect(counts).toEqual(first === 'seal' ? { seals: 1, permits: 0 } : { seals: 0, permits: 1 })
    }
  )
})
