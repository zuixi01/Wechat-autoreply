import { z } from 'zod'
import { Id } from '../../../src/shared/contracts/identity'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  PrivateBlindReviewPacketSchema,
  BlindReviewArtifactSchema,
  assertJevBlindReviewFreeze
} from '../../../evals/jev/blind-review'
import { Administration } from '../admin/administration'
import type { Postgres } from '../database/postgres'
import { JevReplayJournal } from './jev-replay-journal'

const RequestSchema = z.strictObject({
  tenantId: Id,
  accountId: Id,
  runId: Id,
  packet: z.unknown(),
  artifacts: z.unknown()
})
const CreateRequestSchema = RequestSchema.pick({
  tenantId: true,
  accountId: true,
  runId: true
}).extend({
  split: z.enum(['calibration', 'holdout'])
})
type Request = z.infer<typeof RequestSchema>
export interface JevBlindPacketSeal {
  packetId: string
  packetHash: string
  artifactSetHash: string
  sealedAt: string
  centralRecordVerified: true
  releaseAuthorized: false
}
/** Called internally after creating a blind package. Verification never creates
 * missing records. Neither operation calls models, approves or grants sending. */
export class JevBlindPacketSeals {
  constructor(
    private readonly db: Postgres,
    private readonly activeTextGeneratorVersion: string
  ) {}
  seal(request: Request): Promise<JevBlindPacketSeal> {
    return this.record(request, true)
  }
  verify(request: Request): Promise<JevBlindPacketSeal> {
    return this.record(request, false)
  }

  /** Reject repeated creation before writing a new random mapping. This is only
   * a preflight: seal() still checks all evidence and concurrent creators. */
  async assertCanCreate(raw: z.infer<typeof CreateRequestSchema>): Promise<void> {
    const request = CreateRequestSchema.parse(structuredClone(raw))
    await this.db.transaction(request.tenantId, async (db) => {
      const scope = (
        await db.query('SELECT * FROM autoreply.authenticate_admin($1)', [request.tenantId])
      ).rows[0]
      if (scope?.tenant_id !== request.tenantId || !scope.actor_id)
        throw new Error('jev_blind_packet_denied')
      const account = await db.query(
        'SELECT id FROM accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [request.tenantId, request.accountId]
      )
      if (!account.rows[0]) throw new Error('jev_blind_packet_account_invalid')
      const execution = (
        await db.query(
          `SELECT x.actor_id,x.login_name,session_user AS current_login,c.packet_id
          FROM jev_replay_executions x LEFT JOIN jev_blind_packet_seals c
          ON (c.tenant_id,c.account_id,c.execution_id)=(x.tenant_id,x.account_id,x.id)
          WHERE x.tenant_id=$1 AND x.account_id=$2 AND x.run_id=$3 AND x.split=$4`,
          [request.tenantId, request.accountId, request.runId, request.split]
        )
      ).rows
      if (execution.length !== 1) throw new Error('jev_blind_packet_execution_missing')
      if (
        execution[0].actor_id !== scope.actor_id ||
        execution[0].login_name !== execution[0].current_login
      )
        throw new Error('jev_blind_packet_denied')
      if (execution[0].packet_id) throw new Error('jev_blind_packet_already_sealed')
    })
  }

  private async record(raw: Request, write: boolean): Promise<JevBlindPacketSeal> {
    const request = RequestSchema.parse(structuredClone(raw))
    const packet = PrivateBlindReviewPacketSchema.parse(request.packet)
    const artifacts = z.array(BlindReviewArtifactSchema).parse(request.artifacts)
    const { packetHash, ...body } = packet
    if (
      hashContext(request.packet) !== hashContext(packet) ||
      hashContext(body) !== packetHash ||
      hashContext(request.artifacts) !== hashContext(artifacts)
    )
      throw new Error('jev_blind_packet_changed')
    const source = await new Administration(
      this.db,
      this.activeTextGeneratorVersion
    ).readFrozenEvaluation(request.tenantId, request.accountId, request.runId)
    assertJevBlindReviewFreeze(source, packet)
    const priors = new Set(packet.priorAnnotations.cases.map((p) => p.caseId))
    if (
      priors.size !== packet.input.cases.length ||
      packet.priorAnnotations.cases.length !== priors.size ||
      packet.input.cases.some((c) => !priors.has(c.caseId))
    )
      throw new Error('jev_blind_packet_priors_incomplete')
    const byAssignment = new Map(artifacts.map((a) => [a.assignmentId, a]))
    const reviews = new Set<string>(),
      assignments = new Set<string>()
    if (packet.mapping.length !== artifacts.length || byAssignment.size !== artifacts.length)
      throw new Error('jev_blind_packet_mapping_invalid')
    for (const m of packet.mapping) {
      const a = byAssignment.get(m.assignmentId)
      if (
        !a ||
        a.caseId !== m.caseId ||
        a.arm !== m.arm ||
        hashContext(a) !== m.artifactHash ||
        reviews.has(m.reviewId) ||
        assignments.has(m.assignmentId)
      )
        throw new Error('jev_blind_packet_mapping_invalid')
      reviews.add(m.reviewId)
      assignments.add(m.assignmentId)
    }
    // This precheck can only reject. Success still requires the full journal
    // verification and another locked recheck below.
    await this.db.transaction(request.tenantId, async (db) => {
      const scope = (
        await db.query('SELECT * FROM autoreply.authenticate_admin($1)', [request.tenantId])
      ).rows[0]
      if (scope?.tenant_id !== request.tenantId || !scope.actor_id)
        throw new Error('jev_blind_packet_denied')
      const account = await db.query(
        'SELECT id FROM accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [request.tenantId, request.accountId]
      )
      if (!account.rows[0]) throw new Error('jev_blind_packet_account_invalid')
      const saved = (
        await db.query(
          `SELECT c.*,session_user AS current_login FROM jev_blind_packet_seals c JOIN jev_replay_executions x
        ON (x.tenant_id,x.account_id,x.id)=(c.tenant_id,c.account_id,c.execution_id)
        WHERE c.tenant_id=$1 AND c.account_id=$2 AND (c.packet_id=$3 OR (x.run_id=$4 AND x.split=$5))`,
          [request.tenantId, request.accountId, packet.packetId, request.runId, packet.input.split]
        )
      ).rows
      if (
        saved.length > 1 ||
        (saved[0] &&
          (saved[0].packet_id !== packet.packetId ||
            saved[0].run_id !== request.runId ||
            saved[0].packet_hash !== packetHash ||
            saved[0].actor_id !== scope.actor_id ||
            saved[0].login_name !== saved[0].current_login))
      )
        throw new Error('jev_blind_packet_changed')
      if (!saved[0] && !write) throw new Error('jev_blind_packet_unsealed')
    })
    const proof = await new JevReplayJournal(
      this.db,
      this.activeTextGeneratorVersion
    ).verifyArtifacts({
      tenantId: request.tenantId,
      accountId: request.accountId,
      runId: request.runId,
      fullRawCases: packet.input,
      artifacts
    })
    return this.db.transaction(request.tenantId, async (db) => {
      const scope = (
        await db.query('SELECT * FROM autoreply.authenticate_admin($1)', [request.tenantId])
      ).rows[0]
      if (scope?.tenant_id !== request.tenantId || !scope.actor_id)
        throw new Error('jev_blind_packet_denied')
      const account = (
        await db.query(
          `SELECT a.employee_id,a.platform,a.enabled,e.enabled AS employee_enabled FROM accounts a JOIN employees e
        ON (e.tenant_id,e.id)=(a.tenant_id,a.employee_id) WHERE a.tenant_id=$1 AND a.id=$2 FOR UPDATE OF a`,
          [request.tenantId, request.accountId]
        )
      ).rows[0]
      if (
        !account?.enabled ||
        !account.employee_enabled ||
        account.employee_id !== source.authenticatedScope.employeeId ||
        account.platform !== source.authenticatedScope.platform
      )
        throw new Error('jev_blind_packet_account_invalid')
      const execution = (
        await db.query(
          `SELECT x.*,r.snapshot_hash AS current_snapshot,r.publication_json AS current_publication,r.plan_json AS current_plan,
        session_user AS current_login FROM jev_replay_executions x JOIN evaluation_runs r ON (r.tenant_id,r.account_id,r.id)=(x.tenant_id,x.account_id,x.run_id)
        WHERE x.tenant_id=$1 AND x.account_id=$2 AND x.id=$3 AND r.created_at<=clock_timestamp() AND r.expires_at>clock_timestamp()`,
          [request.tenantId, request.accountId, proof.executionId]
        )
      ).rows[0]
      if (
        !execution ||
        execution.run_id !== request.runId ||
        execution.actor_id !== scope.actor_id ||
        execution.login_name !== execution.current_login ||
        execution.employee_id !== account.employee_id ||
        execution.platform !== account.platform ||
        execution.current_snapshot !== source.snapshotHash ||
        hashContext(execution.current_publication) !== hashContext(source.publication) ||
        hashContext(execution.current_plan) !== hashContext(source.plan)
      )
        throw new Error('jev_blind_packet_execution_invalid')
      const existing = (
        await db.query(
          'SELECT * FROM jev_blind_packet_seals WHERE tenant_id=$1 AND account_id=$2 AND (packet_id=$3 OR execution_id=$4)',
          [request.tenantId, request.accountId, packet.packetId, proof.executionId]
        )
      ).rows
      let saved = existing[0]
      if (
        existing.length > 1 ||
        (saved &&
          (saved.packet_id !== packet.packetId ||
            saved.execution_id !== proof.executionId ||
            saved.run_id !== request.runId ||
            saved.packet_hash !== packetHash ||
            saved.artifact_set_hash !== proof.artifactSetHash ||
            saved.actor_id !== scope.actor_id ||
            saved.login_name !== execution.current_login))
      )
        throw new Error('jev_blind_packet_changed')
      if (!saved) {
        if (!write) throw new Error('jev_blind_packet_unsealed')
        saved = (
          await db.query(
            `INSERT INTO jev_blind_packet_seals(tenant_id,account_id,packet_id,execution_id,run_id,packet_hash,artifact_set_hash,actor_id,login_name)
          VALUES($1,$2,$3,$4,$5,$6,$7,'','') RETURNING *`,
            [
              request.tenantId,
              request.accountId,
              packet.packetId,
              proof.executionId,
              request.runId,
              packetHash,
              proof.artifactSetHash
            ]
          )
        ).rows[0]
      }
      return {
        packetId: packet.packetId,
        packetHash,
        artifactSetHash: proof.artifactSetHash,
        sealedAt: new Date(saved.sealed_at).toISOString(),
        centralRecordVerified: true,
        releaseAuthorized: false
      }
    })
  }
}
