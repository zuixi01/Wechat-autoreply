import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { hashContext } from '../../../src/core/reply/hashes'
import type { ReplyTask } from '../../../src/shared/contracts/task'
import type { AccountAuthority, Scope } from '../auth/account-authority'
import type { Postgres } from '../database/postgres'
import {
  ModelCallError,
  ModelCallStartSchema,
  ModelCallResultSchema,
  type ModelStage,
  type ModelCallScope,
  type ModelCallStart,
  type ModelCallHandle
} from './model-call-contracts'
import { recordedTransport } from './model-call-transport'
import { assertEnterpriseLearningTaskCurrent } from '../learning/learning-generation-context'

interface CallContext {
  credential: string
  scope: Scope
  task: ReplyTask
  stage: ModelStage
}

/** A task-bound server context is propagated across HTTP retries without touching renderer APIs. */
export class ModelCallAuthority {
  private readonly context = new AsyncLocalStorage<CallContext>()
  constructor(
    private readonly db: Postgres,
    private readonly authority: AccountAuthority
  ) {}

  forTask(credential: string, scope: Scope, task: ReplyTask): ModelCallScope {
    const captured = structuredClone({ credential, scope, task })
    return { run: (stage, operation) => this.context.run({ ...captured, stage }, operation) }
  }

  transport(
    provider: 'jev' | 'text',
    upstream: typeof fetch = fetch,
    expectedTextModel?: string
  ): typeof fetch {
    return recordedTransport(provider, (start) => this.reserve(start), upstream, expectedTextModel)
  }

  private async reserve(startInput: ModelCallStart): Promise<ModelCallHandle> {
    const context = this.context.getStore()
    if (!context) throw new ModelCallError('CONTEXT_UNAVAILABLE')
    const start = ModelCallStartSchema.parse(startInput),
      { scope, task, stage } = context
    if ((stage === 'text') !== (start.provider === 'text'))
      throw new ModelCallError('CONTEXT_UNAVAILABLE')
    const id = randomUUID(),
      taskHash = hashContext(task)
    try {
      await this.authority.withLockedAccount(context.credential, async (db, authenticated) => {
        if (hashContext(authenticated) !== hashContext(scope))
          throw new ModelCallError('CONTEXT_UNAVAILABLE')
        const generation = await db.query(
          'SELECT agent_id,status,task_json FROM generation_tasks WHERE tenant_id=$1 AND account_id=$2 AND task_id=$3 AND expires_at>clock_timestamp()',
          [scope.tenant_id, scope.account_id, task.taskId]
        )
        const row = generation.rows[0]
        if (
          !row ||
          row.agent_id !== scope.agent_id ||
          row.status !== 'running' ||
          hashContext(row.task_json) !== taskHash
        )
          throw new ModelCallError('CONTEXT_UNAVAILABLE')
        const publication = await db.query(
          'SELECT 1 FROM published_configurations WHERE tenant_id=$1 AND account_id=$2 AND config_version=$3 AND knowledge_version=$4 AND policy_version=$5 AND questions_version=$6',
          [
            scope.tenant_id,
            scope.account_id,
            task.configVersion,
            task.knowledgeVersion,
            task.decisionPolicyVersion,
            task.questionSetVersion
          ]
        )
        if (!publication.rowCount) throw new ModelCallError('CONTEXT_UNAVAILABLE')
        await assertEnterpriseLearningTaskCurrent(db, authenticated, task)
        const lease = await db.query(
          `SELECT 1 FROM account_leases WHERE tenant_id=$1 AND account_id=$2 AND agent_id=$3 AND login_epoch=$4 AND client_instance_id=$5 AND expires_at>clock_timestamp()`,
          [
            scope.tenant_id,
            scope.account_id,
            scope.agent_id,
            task.identity.loginEpoch,
            task.identity.clientInstanceId
          ]
        )
        if (!lease.rowCount) throw new ModelCallError('CONTEXT_UNAVAILABLE')
        const limits = await db.query(
          'SELECT daily_attempt_limit,revision FROM model_call_limits WHERE tenant_id=$1 AND account_id=$2',
          [scope.tenant_id, scope.account_id]
        )
        if (!limits.rows[0]) throw new ModelCallError('LIMIT_UNCONFIGURED')
        const used = await db.query(
          `SELECT count(*)::integer AS used FROM model_call_attempts WHERE tenant_id=$1 AND account_id=$2 AND usage_day=(clock_timestamp() AT TIME ZONE 'UTC')::date`,
          [scope.tenant_id, scope.account_id]
        )
        if (used.rows[0].used >= limits.rows[0].daily_attempt_limit)
          throw new ModelCallError('LIMIT_REACHED')
        const previous = await db.query(
          `SELECT coalesce(max(attempt_number),0)::integer+1 AS next FROM model_call_attempts WHERE tenant_id=$1 AND account_id=$2 AND task_id=$3 AND stage=$4`,
          [scope.tenant_id, scope.account_id, task.taskId, stage]
        )
        await db.query(
          `INSERT INTO model_call_attempts(tenant_id,account_id,id,agent_id,task_id,task_hash,provider,stage,attempt_number,request_hash,requested_model,question_hash,config_version,policy_version,question_set_version,knowledge_version,limit_revision)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            scope.tenant_id,
            scope.account_id,
            id,
            scope.agent_id,
            task.taskId,
            taskHash,
            start.provider,
            stage,
            previous.rows[0].next,
            start.requestHash,
            start.requestedModel,
            start.questionHash ?? null,
            task.configVersion,
            task.decisionPolicyVersion,
            task.questionSetVersion,
            task.knowledgeVersion,
            limits.rows[0].revision
          ]
        )
      })
    } catch (error) {
      if (error instanceof ModelCallError) throw error
      throw new ModelCallError('RECORD_UNAVAILABLE')
    }
    return {
      finish: async (input) => {
        const result = ModelCallResultSchema.parse(structuredClone(input)),
          resultHash = hashContext(result)
        if (Buffer.byteLength(JSON.stringify(result)) > 65536)
          throw new ModelCallError('RECORD_UNAVAILABLE')
        try {
          // Original server-held binding can record a response after pause/revocation.
          // This transaction grants no device authority and never changes a task or permit.
          await this.db.transaction(scope.tenant_id, async (db) => {
            const reserved = await db.query(
              'SELECT agent_id,task_id,task_hash FROM model_call_attempts WHERE tenant_id=$1 AND account_id=$2 AND id=$3',
              [scope.tenant_id, scope.account_id, id]
            )
            const row = reserved.rows[0]
            if (
              !row ||
              row.agent_id !== scope.agent_id ||
              row.task_id !== task.taskId ||
              row.task_hash !== taskHash
            )
              throw new ModelCallError('RECORD_UNAVAILABLE')
            await db.query(
              `INSERT INTO model_call_results(tenant_id,account_id,attempt_id,result_hash,result_json) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
              [scope.tenant_id, scope.account_id, id, resultHash, JSON.stringify(result)]
            )
            const saved = await db.query(
              'SELECT result_hash FROM model_call_results WHERE tenant_id=$1 AND account_id=$2 AND attempt_id=$3',
              [scope.tenant_id, scope.account_id, id]
            )
            if (saved.rows[0]?.result_hash !== resultHash)
              throw new ModelCallError('RECORD_UNAVAILABLE')
          })
        } catch {
          throw new ModelCallError('RECORD_UNAVAILABLE')
        }
      }
    }
  }

  async assertRecorded(scope: Scope, task: ReplyTask, edited: boolean): Promise<void> {
    const rows = await this.db.transaction(scope.tenant_id, (db) =>
      db.query(
        `SELECT a.stage,r.result_json FROM model_call_attempts a LEFT JOIN model_call_results r
      ON (a.tenant_id,a.account_id,a.id)=(r.tenant_id,r.account_id,r.attempt_id)
      WHERE a.tenant_id=$1 AND a.account_id=$2 AND a.agent_id=$3 AND a.task_id=$4 AND a.task_hash=$5`,
        [scope.tenant_id, scope.account_id, scope.agent_id, task.taskId, hashContext(task)]
      )
    )
    if (
      (edited ? ['pre', 'post'] : ['pre', 'text', 'post']).some(
        (stage) =>
          !rows.rows.some((row) => row.stage === stage && row.result_json?.outcome === 'response')
      ) ||
      rows.rows.some((row) => !row.result_json)
    )
      throw new ModelCallError('RECORD_UNAVAILABLE')
  }
}
