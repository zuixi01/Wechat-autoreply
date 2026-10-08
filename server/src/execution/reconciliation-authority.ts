import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { AccountAuthority, type Scope } from '../auth/account-authority'
import { PermitRequestSchema, type PermitRequest } from '../../../src/shared/contracts/execution'
import {
  DeviceReconciliationReportSchema,
  parseDeviceReconciliationReport,
  parseReconciliationChallenge,
  type DeviceReconciliationReport,
  type ReconciliationChallenge,
  type ReconciliationAcknowledgment
} from '../../../src/shared/contracts/reconciliation'
import {
  ReconciliationLookupSchema,
  ReconciliationAppliedSchema,
  parseReconciliationDecision,
  type ReconciliationDecision,
  type ReconciliationAppliedAck
} from '../../../src/shared/contracts/reconciliation'
import { hashContext } from '../../../src/core/reply/hashes'
import { ReconciliationSnapshotSchema } from '../admin/reconciliation'

export class ReconciliationError extends Error {
  constructor(
    readonly code:
      | 'RECONCILIATION_NOT_FOUND'
      | 'RECONCILIATION_NOT_READY'
      | 'RECONCILIATION_CONFLICT'
      | 'RECONCILIATION_INCOMPLETE'
  ) {
    super(code)
    this.name = 'ReconciliationError'
  }
}
/** A separate evidence channel. Ordinary unknown receipts are never upgraded. */
export class ReconciliationAuthority {
  constructor(private readonly authority: AccountAuthority) {}
  async challenge(credential: string, input: PermitRequest): Promise<ReconciliationChallenge> {
    const request = PermitRequestSchema.parse(input)
    return this.authority.withLockedAccount(credential, (db, s) => this.load(db, s, request), true)
  }
  async report(
    credential: string,
    input: DeviceReconciliationReport
  ): Promise<ReconciliationAcknowledgment> {
    const request = DeviceReconciliationReportSchema.parse(input)
    return this.authority.withLockedAccount(
      credential,
      async (db, s) => {
        const challenge = await this.load(db, s, request.request)
        let report: DeviceReconciliationReport
        try {
          report = parseDeviceReconciliationReport(request, challenge)
        } catch {
          throw new ReconciliationError('RECONCILIATION_CONFLICT')
        }
        const reportHash = hashContext(report)
        const old = await db.query(
          'SELECT agent_id,report_hash FROM device_reconciliation_reports WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3',
          [s.tenant_id, s.account_id, challenge.caseId]
        )
        if (old.rows[0]) {
          if (old.rows[0].agent_id !== s.agent_id || old.rows[0].report_hash !== reportHash)
            throw new ReconciliationError('RECONCILIATION_CONFLICT')
        } else {
          const now = Number(
            (
              await db.query(
                'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'
              )
            ).rows[0].now
          )
          if (report.observation.observedAt > now)
            throw new ReconciliationError('RECONCILIATION_CONFLICT')
          await db.query(
            `INSERT INTO device_reconciliation_reports(tenant_id,account_id,case_id,agent_id,snapshot_hash,report_hash,report_json)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            [
              s.tenant_id,
              s.account_id,
              challenge.caseId,
              s.agent_id,
              challenge.snapshotHash,
              reportHash,
              JSON.stringify(report)
            ]
          )
          await db.query(
            `INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id,details_json)
          VALUES($1,$2,$3,'reconciliation_device_evidence_recorded',$4,$5::jsonb)`,
            [
              s.tenant_id,
              randomUUID(),
              s.agent_id,
              s.account_id,
              JSON.stringify({
                caseId: challenge.caseId,
                snapshotHash: challenge.snapshotHash,
                reportHash,
                status: report.observation.status
              })
            ]
          )
        }
        return { caseId: challenge.caseId, reportHash, status: 'evidence_recorded' }
      },
      true
    )
  }

  async decision(credential: string, input: unknown): Promise<ReconciliationDecision | null> {
    const lookup = ReconciliationLookupSchema.parse(input)
    return this.authority.withLockedAccount(
      credential,
      async (db, s) => {
        const evidence = await this.boundReport(db, s, lookup)
        const row = await db.query(
          'SELECT decision_json FROM reconciliation_decisions WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3',
          [s.tenant_id, s.account_id, lookup.caseId]
        )
        return row.rows[0]
          ? parseReconciliationDecision(row.rows[0].decision_json, evidence, lookup.reportHash)
          : null
      },
      true
    )
  }

  async applied(credential: string, input: unknown): Promise<ReconciliationAppliedAck> {
    const lookup = ReconciliationAppliedSchema.parse(input)
    return this.authority.withLockedAccount(
      credential,
      async (db, s) => {
        const evidence = await this.boundReport(db, s, lookup)
        const row = await db.query(
          'SELECT decision_json FROM reconciliation_decisions WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3',
          [s.tenant_id, s.account_id, lookup.caseId]
        )
        if (!row.rows[0]) throw new ReconciliationError('RECONCILIATION_NOT_FOUND')
        const decision = parseReconciliationDecision(
          row.rows[0].decision_json,
          evidence,
          lookup.reportHash
        )
        if (
          decision.decisionId !== lookup.decisionId ||
          hashContext(decision) !== lookup.decisionHash
        )
          throw new ReconciliationError('RECONCILIATION_CONFLICT')
        const old = await db.query(
          'SELECT agent_id,decision_hash FROM reconciliation_applied WHERE tenant_id=$1 AND account_id=$2 AND decision_id=$3',
          [s.tenant_id, s.account_id, decision.decisionId]
        )
        if (old.rows[0]) {
          if (
            old.rows[0].agent_id !== s.agent_id ||
            old.rows[0].decision_hash !== lookup.decisionHash
          )
            throw new ReconciliationError('RECONCILIATION_CONFLICT')
        } else {
          const a = await db.query('SELECT paused FROM accounts WHERE tenant_id=$1 AND id=$2', [
            s.tenant_id,
            s.account_id
          ])
          if (!a.rows[0]?.paused) throw new ReconciliationError('RECONCILIATION_NOT_READY')
          await db.query(
            'INSERT INTO reconciliation_applied(tenant_id,account_id,decision_id,agent_id,decision_hash) VALUES($1,$2,$3,$4,$5)',
            [s.tenant_id, s.account_id, decision.decisionId, s.agent_id, lookup.decisionHash]
          )
          await db.query(
            `INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id,details_json) VALUES($1,$2,$3,'reconciliation_resolution_applied',$4,$5::jsonb)`,
            [
              s.tenant_id,
              randomUUID(),
              s.agent_id,
              s.account_id,
              JSON.stringify({ decisionId: decision.decisionId, decisionHash: lookup.decisionHash })
            ]
          )
        }
        return {
          decisionId: decision.decisionId,
          decisionHash: lookup.decisionHash,
          status: 'resolution_applied'
        }
      },
      true
    )
  }

  private async boundReport(
    db: PoolClient,
    s: Scope,
    lookup: ReturnType<typeof ReconciliationLookupSchema.parse>
  ): Promise<DeviceReconciliationReport> {
    const c = await this.load(db, s, lookup.request, false)
    const row = await db.query(
      'SELECT agent_id,report_hash,report_json FROM device_reconciliation_reports WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3',
      [s.tenant_id, s.account_id, lookup.caseId]
    )
    if (!row.rows[0]) throw new ReconciliationError('RECONCILIATION_NOT_FOUND')
    const r = row.rows[0],
      report = parseDeviceReconciliationReport(r.report_json, c)
    if (
      r.agent_id !== s.agent_id ||
      c.caseId !== lookup.caseId ||
      c.snapshotHash !== lookup.snapshotHash ||
      r.report_hash !== lookup.reportHash ||
      hashContext(report) !== lookup.reportHash
    )
      throw new ReconciliationError('RECONCILIATION_CONFLICT')
    return report
  }

  private async load(
    db: PoolClient,
    s: Scope,
    request: PermitRequest,
    requireStopped = true
  ): Promise<ReconciliationChallenge> {
    const found = await db.query(
      `SELECT p.*,c.id AS case_id,c.snapshot_hash,c.snapshot_json,c.opened_at,
      a.paused,p.expires_at<=clock_timestamp() AS expired,
      EXISTS(SELECT 1 FROM account_leases l WHERE l.tenant_id=p.tenant_id AND l.account_id=p.account_id AND l.expires_at>clock_timestamp()) AS lease_live
      FROM execution_permits p JOIN accounts a ON (a.tenant_id,a.id)=(p.tenant_id,p.account_id)
      JOIN reconciliation_cases c ON (c.tenant_id,c.account_id,c.permit_id)=(p.tenant_id,p.account_id,p.id)
      WHERE p.tenant_id=$1 AND p.account_id=$2 AND p.agent_id=$3 AND p.task_id=$4`,
      [s.tenant_id, s.account_id, s.agent_id, request.taskId]
    )
    const p = found.rows[0]
    if (!p) throw new ReconciliationError('RECONCILIATION_NOT_FOUND')
    if (requireStopped && (!p.paused || !p.expired || p.lease_live))
      throw new ReconciliationError('RECONCILIATION_NOT_READY')
    try {
      const snapshot = ReconciliationSnapshotSchema.parse(p.snapshot_json)
      if (
        hashContext(snapshot) !== p.snapshot_hash ||
        snapshot.tenantId !== s.tenant_id ||
        snapshot.accountId !== s.account_id ||
        snapshot.permitId !== p.id ||
        snapshot.agentId !== s.agent_id ||
        snapshot.taskId !== p.task_id ||
        snapshot.taskHash !== p.task_hash ||
        snapshot.draftHash !== p.draft_hash ||
        snapshot.draftRevision !== Number(p.draft_revision) ||
        snapshot.loginEpoch !== Number(p.login_epoch) ||
        snapshot.clientInstanceId !== p.client_instance_id ||
        snapshot.conversationId !== p.conversation_id ||
        snapshot.leaseVersion !== Number(p.lease_version) ||
        snapshot.purpose !== p.purpose ||
        snapshot.confirmationId !== p.confirmation_id ||
        snapshot.issuedAt !== new Date(p.issued_at).getTime() ||
        snapshot.expiresAt !== new Date(p.expires_at).getTime()
      )
        throw new Error('snapshot_changed')
      const identity = {
        tenantId: s.tenant_id,
        employeeId: s.employee_id,
        accountId: s.account_id,
        agentId: s.agent_id,
        platform: s.platform,
        loginEpoch: Number(p.login_epoch),
        clientInstanceId: p.client_instance_id
      }
      return parseReconciliationChallenge(
        {
          caseId: p.case_id,
          snapshotHash: p.snapshot_hash,
          openedAt: new Date(p.opened_at).getTime(),
          permit: {
            permitId: p.id,
            identity,
            taskId: p.task_id,
            conversationId: p.conversation_id,
            taskHash: p.task_hash,
            draftHash: p.draft_hash,
            draftRevision: Number(p.draft_revision),
            leaseVersion: Number(p.lease_version),
            issuedAt: new Date(p.issued_at).getTime(),
            expiresAt: new Date(p.expires_at).getTime(),
            status: p.status,
            newlyIssued: false,
            ...(p.purpose === 'human'
              ? { purpose: 'human', confirmationId: p.confirmation_id }
              : {})
          }
        },
        request,
        identity
      )
    } catch {
      throw new ReconciliationError('RECONCILIATION_INCOMPLETE')
    }
  }
}
