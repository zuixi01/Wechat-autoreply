import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { AccountAuthority, type Scope } from '../auth/account-authority'
import { sameIdentity } from '../../../src/shared/contracts/identity'
import {
  ReplyTaskSchema,
  ReplyDraftSchema,
  DraftReviewSchema
} from '../../../src/shared/contracts/task'
import {
  ExecutionPermitSchema,
  PermitRequestSchema,
  ExecutionReceiptSchema,
  type ExecutionPermit,
  type ExecutionReceipt,
  type PermitRequest
} from '../../../src/shared/contracts/execution'
import { hashContext, hashDraft } from '../../../src/core/reply/hashes'
import type { ReplyCandidate, AgentConfiguration } from '../../../src/core/agent/reliable-agent'
import { writeConfiguration } from '../generation/configuration-store'
import {
  HumanPermitRequestSchema,
  type HumanPermitRequest
} from '../../../src/shared/contracts/human-confirmation'
import { GenerationResultSchema } from '../../../src/shared/contracts/generation'
import { hasUnappliedRequestSeals } from './request-seal-state'
import { assertEnterpriseLearningTaskCurrent } from '../learning/learning-generation-context'
import {
  sameLearningBinding,
  EMPTY_ENTERPRISE_MEMORY_VERSION
} from '../../../src/shared/contracts/learning-task'

export class ExecutionError extends Error {
  constructor(
    readonly code:
      | 'REVIEW_REQUIRED'
      | 'STALE_REVIEW'
      | 'LEASE_INVALID'
      | 'UNRESOLVED_EXECUTION'
      | 'PERMIT_CONFLICT'
      | 'PERMIT_NOT_FOUND'
      | 'REQUEST_SEALED'
  ) {
    super(code)
    this.name = 'ExecutionError'
  }
}
const Configuration = z.strictObject({
  configVersion: z.string().min(1).max(128),
  knowledgeVersion: z.string().min(1).max(128),
  decisionPolicyVersion: z.string().min(1).max(128),
  questionSetVersion: z.string().min(1).max(128),
  modelResolved: z.string().min(1).max(128),
  automaticEnabled: z.boolean(),
  memoryCorpusVersion: z.string().min(1).max(128).optional()
})

function configMatches(
  task: z.infer<typeof ReplyTaskSchema>,
  modelResolved: string,
  row: Record<string, unknown>,
  automatic = true
): boolean {
  return (
    (!automatic || row.automatic_enabled === true) &&
    row.config_version === task.configVersion &&
    row.knowledge_version === task.knowledgeVersion &&
    row.policy_version === task.decisionPolicyVersion &&
    row.questions_version === task.questionSetVersion &&
    row.model_resolved === modelResolved &&
    row.memory_corpus_version === (task.memoryCorpusVersion ?? EMPTY_ENTERPRISE_MEMORY_VERSION)
  )
}
function belongs(task: z.infer<typeof ReplyTaskSchema>, scope: Scope): boolean {
  const i = task.identity
  return (
    i.tenantId === scope.tenant_id &&
    i.accountId === scope.account_id &&
    i.employeeId === scope.employee_id &&
    i.agentId === scope.agent_id &&
    i.platform === scope.platform
  )
}

/** Trusted management/pipeline methods have no corresponding public HTTP route.
 * A client's assertion that Jev approved its text can never create an approval. */
export class ExecutionAuthority {
  constructor(
    private readonly authority: AccountAuthority,
    private readonly validatePublication: (db: PoolClient, scope: Scope) => Promise<void>
  ) {}

  async publishConfiguration(credential: string, input: AgentConfiguration): Promise<void> {
    const c = Configuration.parse(input)
    await this.authority.withLockedAccount(
      credential,
      async (db, s) => {
        await writeConfiguration(db, s, c)
        await this.audit(db, s, 'configuration_published')
      },
      true
    )
  }

  async recordApprovedCandidate(credential: string, candidate: ReplyCandidate): Promise<void> {
    return this.authority.withLockedAccount(credential, (db, scope) =>
      this.recordApprovedCandidateWithin(db, scope, candidate)
    )
  }

  /** Host pipeline composition; caller already holds this authenticated account transaction. */
  async recordApprovedCandidateWithin(
    db: PoolClient,
    s: Scope,
    candidate: ReplyCandidate
  ): Promise<void> {
    const task = ReplyTaskSchema.parse(candidate.task)
    const draft = ReplyDraftSchema.parse(candidate.draft)
    const review = DraftReviewSchema.parse(candidate.review)
    if (
      !candidate.automaticAllowed ||
      !candidate.factsVerified ||
      review.status !== 'passed' ||
      !['reply', 'clarify'].includes(draft.action) ||
      hashDraft(draft.text) !== draft.draftHash ||
      draft.taskId !== task.taskId ||
      review.taskId !== task.taskId ||
      review.contextHash !== task.contextHash ||
      !sameLearningBinding(task, review) ||
      review.draftHash !== draft.draftHash ||
      review.draftRevision !== draft.draftRevision ||
      review.configVersion !== task.configVersion ||
      review.knowledgeVersion !== task.knowledgeVersion ||
      review.decisionPolicyVersion !== task.decisionPolicyVersion ||
      review.questionSetVersion !== task.questionSetVersion
    )
      throw new ExecutionError('REVIEW_REQUIRED')
    if (!belongs(task, s)) throw new ExecutionError('REVIEW_REQUIRED')
    await this.validatePublication(db, s)
    await assertEnterpriseLearningTaskCurrent(db, s, task)
    const now = await this.now(db)
    const config = await db.query(
      'SELECT * FROM published_configurations WHERE tenant_id=$1 AND account_id=$2',
      [s.tenant_id, s.account_id]
    )
    if (
      task.createdAt > now ||
      review.reviewedAt > now ||
      task.expiresAt <= now ||
      review.expiresAt <= now ||
      !configMatches(task, review.modelResolved, config.rows[0] ?? {})
    )
      throw new ExecutionError('STALE_REVIEW')
    const saved = await db.query(
      `INSERT INTO reviewed_replies(tenant_id,account_id,task_id,agent_id,task_hash,task_json,draft_hash,draft_revision,review_json,expires_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,to_timestamp($10/1000.0)) ON CONFLICT DO NOTHING RETURNING task_id`,
      [
        s.tenant_id,
        s.account_id,
        task.taskId,
        s.agent_id,
        hashContext(task),
        JSON.stringify(task),
        draft.draftHash,
        draft.draftRevision,
        JSON.stringify(review),
        Math.min(task.expiresAt, review.expiresAt)
      ]
    )
    if (!saved.rowCount) {
      const old = await db.query(
        'SELECT task_hash,draft_hash,draft_revision,review_json FROM reviewed_replies WHERE tenant_id=$1 AND account_id=$2 AND task_id=$3',
        [s.tenant_id, s.account_id, task.taskId]
      )
      const r = old.rows[0]
      if (
        !r ||
        r.task_hash !== hashContext(task) ||
        r.draft_hash !== draft.draftHash ||
        Number(r.draft_revision) !== draft.draftRevision ||
        hashContext(r.review_json) !== hashContext(review)
      )
        throw new ExecutionError('PERMIT_CONFLICT')
    }
  }

  async issue(credential: string, input: PermitRequest): Promise<ExecutionPermit> {
    const request = PermitRequestSchema.parse(input)
    if (request.purpose === 'human') throw new ExecutionError('REVIEW_REQUIRED')
    return this.issuePermit(credential, request)
  }

  async issueHuman(credential: string, input: HumanPermitRequest): Promise<ExecutionPermit> {
    const request = HumanPermitRequestSchema.parse(structuredClone(input))
    const c = request.confirmation
    if (
      c.taskId !== request.task.taskId ||
      c.sourceTaskId === request.task.taskId ||
      c.taskHash !== hashContext(request.task) ||
      c.draftHash !== request.draft.draftHash ||
      c.draftRevision !== request.draft.draftRevision ||
      request.draft.taskId !== request.task.taskId ||
      hashDraft(request.draft.text) !== request.draft.draftHash ||
      !['reply', 'clarify'].includes(request.draft.action)
    )
      throw new ExecutionError('REVIEW_REQUIRED')
    return this.issuePermit(
      credential,
      {
        taskId: request.task.taskId,
        taskHash: c.taskHash,
        draftHash: c.draftHash,
        draftRevision: c.draftRevision,
        loginEpoch: request.task.identity.loginEpoch,
        clientInstanceId: request.task.identity.clientInstanceId,
        leaseVersion: request.leaseVersion,
        purpose: 'human',
        confirmationId: c.confirmationId
      },
      request
    )
  }

  private async issuePermit(
    credential: string,
    request: PermitRequest,
    human?: HumanPermitRequest
  ): Promise<ExecutionPermit> {
    return this.authority.withLockedAccount(credential, async (db, s) => {
      const sealed = await db.query(
        'SELECT 1 FROM execution_request_seals WHERE tenant_id=$1 AND account_id=$2 AND task_id=$3',
        [s.tenant_id, s.account_id, request.taskId]
      )
      if (sealed.rowCount) throw new ExecutionError('REQUEST_SEALED')
      if (await hasUnappliedRequestSeals(db, s.tenant_id, s.account_id))
        throw new ExecutionError('UNRESOLVED_EXECUTION')
      await this.validatePublication(db, s)
      const prior = await db.query(
        'SELECT * FROM execution_permits WHERE tenant_id=$1 AND account_id=$2 AND task_id=$3',
        [s.tenant_id, s.account_id, request.taskId]
      )
      if (prior.rows[0]) {
        const p = prior.rows[0]
        if (
          p.agent_id !== s.agent_id ||
          p.purpose !== (request.purpose ?? 'automatic') ||
          (p.confirmation_id ?? undefined) !== request.confirmationId ||
          p.task_hash !== request.taskHash ||
          p.draft_hash !== request.draftHash ||
          Number(p.draft_revision) !== request.draftRevision ||
          Number(p.login_epoch) !== request.loginEpoch ||
          p.client_instance_id !== request.clientInstanceId ||
          Number(p.lease_version) !== request.leaseVersion
        )
          throw new ExecutionError('PERMIT_CONFLICT')
        if (human) {
          const old = await db.query(
            'SELECT confirmation_json,task_json,request_hash FROM human_confirmations WHERE tenant_id=$1 AND account_id=$2 AND id=$3',
            [s.tenant_id, s.account_id, request.confirmationId]
          )
          if (
            !old.rows[0] ||
            hashContext(old.rows[0].confirmation_json) !== hashContext(human.confirmation) ||
            hashContext(old.rows[0].task_json) !== hashContext(human.task) ||
            old.rows[0].request_hash !== hashContext(human)
          )
            throw new ExecutionError('PERMIT_CONFLICT')
        }
        // A lost issuance response is never permission to repeat a physical send.
        return this.toPermit(p, s, false)
      }
      const pending = await db.query(
        `SELECT 1 FROM execution_permits p WHERE tenant_id=$1 AND account_id=$2 AND status IN ('issued','unknown')
        AND NOT EXISTS(SELECT 1 FROM reconciliation_decisions d JOIN reconciliation_applied a
        ON (a.tenant_id,a.account_id,a.decision_id)=(d.tenant_id,d.account_id,d.id)
        WHERE (d.tenant_id,d.account_id,d.permit_id)=(p.tenant_id,p.account_id,p.id)) LIMIT 1`,
        [s.tenant_id, s.account_id]
      )
      if (pending.rowCount) throw new ExecutionError('UNRESOLVED_EXECUTION')
      const lease = await db.query(
        `SELECT *,floor(extract(epoch from expires_at)*1000)::text AS expires_ms FROM account_leases
        WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE`,
        [s.tenant_id, s.account_id]
      )
      const l = lease.rows[0]
      if (
        !l ||
        l.agent_id !== s.agent_id ||
        Number(l.version) !== request.leaseVersion ||
        Number(l.login_epoch) !== request.loginEpoch ||
        l.client_instance_id !== request.clientInstanceId
      )
        throw new ExecutionError('LEASE_INVALID')
      let task: z.infer<typeof ReplyTaskSchema>,
        review: z.infer<typeof DraftReviewSchema> | undefined
      if (human) {
        task = human.task
        if (
          !belongs(task, s) ||
          human.confirmation.employeeId !== s.employee_id ||
          task.createdAt > (await this.now(db)) ||
          task.expiresAt - task.createdAt > 60000
        )
          throw new ExecutionError('REVIEW_REQUIRED')
        const source = await db.query(
          "SELECT * FROM generation_tasks WHERE tenant_id=$1 AND account_id=$2 AND task_id=$3 AND agent_id=$4 AND status='completed'",
          [s.tenant_id, s.account_id, human.confirmation.sourceTaskId, s.agent_id]
        )
        const row = source.rows[0]
        if (!row) throw new ExecutionError('REVIEW_REQUIRED')
        const assessment = GenerationResultSchema.parse(row.result_json),
          original = assessment.task,
          draft = assessment.draft
        if (
          !draft ||
          hashContext(original) !== hashContext(row.task_json) ||
          !sameIdentity(original.identity, task.identity) ||
          original.conversationId !== task.conversationId ||
          original.bindingVersion !== task.bindingVersion ||
          original.contextHash !== task.contextHash ||
          !sameLearningBinding(original, task) ||
          hashContext(original.inboundRange) !== hashContext(task.inboundRange) ||
          (
            [
              'configVersion',
              'knowledgeVersion',
              'decisionPolicyVersion',
              'questionSetVersion'
            ] as const
          ).some((k) => original[k] !== task[k]) ||
          draft.draftHash !== request.draftHash ||
          hashDraft(draft.text) !== request.draftHash ||
          draft.text !== human.draft.text ||
          draft.action !== human.draft.action ||
          draft.draftRevision !== request.draftRevision ||
          hashContext(draft.evidenceIds) !== hashContext(human.draft.evidenceIds)
        )
          throw new ExecutionError('REVIEW_REQUIRED')
        await assertEnterpriseLearningTaskCurrent(db, s, original)
      } else {
        const approved = await db.query(
          'SELECT * FROM reviewed_replies WHERE tenant_id=$1 AND account_id=$2 AND task_id=$3',
          [s.tenant_id, s.account_id, request.taskId]
        )
        const a = approved.rows[0]
        if (
          !a ||
          a.task_hash !== request.taskHash ||
          a.draft_hash !== request.draftHash ||
          Number(a.draft_revision) !== request.draftRevision
        )
          throw new ExecutionError('REVIEW_REQUIRED')
        task = ReplyTaskSchema.parse(a.task_json)
        review = DraftReviewSchema.parse(a.review_json)
        if (!sameLearningBinding(task, review)) throw new ExecutionError('REVIEW_REQUIRED')
        await assertEnterpriseLearningTaskCurrent(db, s, task)
      }
      if (
        !belongs(task, s) ||
        !sameIdentity(task.identity, {
          ...task.identity,
          loginEpoch: request.loginEpoch,
          clientInstanceId: request.clientInstanceId
        })
      )
        throw new ExecutionError('REVIEW_REQUIRED')
      const config = await db.query(
        'SELECT * FROM published_configurations WHERE tenant_id=$1 AND account_id=$2',
        [s.tenant_id, s.account_id]
      )
      const now = await this.now(db)
      const expires = Math.min(
        task.expiresAt,
        human ? human.confirmation.expiresAt : review!.expiresAt,
        Number(l.expires_ms),
        now + 5000
      )
      if (Number(l.expires_ms) <= now) throw new ExecutionError('LEASE_INVALID')
      if (
        expires <= now ||
        (human && human.confirmation.confirmedAt > now) ||
        !configMatches(
          task,
          human ? human.confirmation.modelResolved : review!.modelResolved,
          config.rows[0] ?? {},
          !human
        )
      )
        throw new ExecutionError('STALE_REVIEW')
      if (human) {
        const saved = await db.query(
          `INSERT INTO human_confirmations(tenant_id,account_id,id,agent_id,task_id,source_task_id,task_hash,draft_hash,draft_revision,confirmation_json,task_json,expires_at,request_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,to_timestamp($12/1000.0),$13) ON CONFLICT DO NOTHING RETURNING id`,
          [
            s.tenant_id,
            s.account_id,
            human.confirmation.confirmationId,
            s.agent_id,
            task.taskId,
            human.confirmation.sourceTaskId,
            request.taskHash,
            request.draftHash,
            request.draftRevision,
            JSON.stringify(human.confirmation),
            JSON.stringify(task),
            expires,
            hashContext(human)
          ]
        )
        if (!saved.rowCount) throw new ExecutionError('PERMIT_CONFLICT')
        await this.audit(db, s, 'human_reply_confirmed')
      }
      const row = await db.query(
        `INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status,task_hash,conversation_id,draft_revision,login_epoch,client_instance_id,expires_at,purpose,confirmation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,'issued',$8,$9,$10,$11,$12,to_timestamp($13/1000.0),$14,$15) RETURNING *`,
        [
          s.tenant_id,
          s.account_id,
          randomUUID(),
          s.agent_id,
          request.leaseVersion,
          task.taskId,
          request.draftHash,
          request.taskHash,
          task.conversationId,
          request.draftRevision,
          request.loginEpoch,
          request.clientInstanceId,
          expires,
          request.purpose ?? 'automatic',
          request.confirmationId ?? null
        ]
      )
      await this.audit(db, s, 'execution_issued')
      return this.toPermit(row.rows[0], s, true)
    })
  }

  async settle(
    credential: string,
    input: ExecutionReceipt
  ): Promise<{ status: ExecutionReceipt['status'] }> {
    const receipt = ExecutionReceiptSchema.parse(input)
    return this.authority.withLockedAccount(
      credential,
      async (db, s) => {
        const found = await db.query(
          'SELECT * FROM execution_permits WHERE tenant_id=$1 AND account_id=$2 AND id=$3 FOR UPDATE',
          [s.tenant_id, s.account_id, receipt.permitId]
        )
        const p = found.rows[0]
        if (!p || p.agent_id !== s.agent_id) throw new ExecutionError('PERMIT_NOT_FOUND')
        const hash = hashContext(receipt)
        if (p.draft_hash !== receipt.draftHash) throw new ExecutionError('PERMIT_CONFLICT')
        if (p.status !== 'issued') {
          if (p.status !== receipt.status || p.settlement_hash !== hash)
            throw new ExecutionError('PERMIT_CONFLICT')
          return { status: receipt.status }
        }
        await db.query(
          `UPDATE execution_permits SET status=$3,settlement_hash=$4,settled_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
          [s.tenant_id, p.id, receipt.status, hash]
        )
        await this.audit(db, s, `execution_${receipt.status}`)
        return { status: receipt.status }
      },
      true
    ) // Pausing prevents new sends, but must not prevent durable settlement.
  }

  private toPermit(p: Record<string, unknown>, s: Scope, newlyIssued: boolean): ExecutionPermit {
    return permitFromRow(p, s, newlyIssued)
  }
  private async now(db: PoolClient): Promise<number> {
    return Number(
      (await db.query('SELECT floor(extract(epoch from clock_timestamp())*1000)::text AS now'))
        .rows[0].now
    )
  }
  private async audit(db: PoolClient, s: Scope, kind: string): Promise<void> {
    await db.query(
      'INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id) VALUES($1,$2,$3,$4,$5)',
      [s.tenant_id, randomUUID(), s.agent_id, kind, s.account_id]
    )
  }
}

export function permitFromRow(
  p: Record<string, unknown>,
  s: Scope,
  newlyIssued: boolean
): ExecutionPermit {
  return ExecutionPermitSchema.parse({
    permitId: p.id,
    identity: {
      tenantId: s.tenant_id,
      employeeId: s.employee_id,
      accountId: s.account_id,
      agentId: s.agent_id,
      platform: s.platform,
      loginEpoch: Number(p.login_epoch),
      clientInstanceId: p.client_instance_id
    },
    taskId: p.task_id,
    conversationId: p.conversation_id,
    taskHash: p.task_hash,
    draftHash: p.draft_hash,
    draftRevision: Number(p.draft_revision),
    leaseVersion: Number(p.lease_version),
    issuedAt: new Date(p.issued_at as string).getTime(),
    expiresAt: new Date(p.expires_at as string).getTime(),
    status: p.status,
    newlyIssued,
    ...(p.purpose === 'human' ? { purpose: 'human', confirmationId: p.confirmation_id } : {})
  })
}
