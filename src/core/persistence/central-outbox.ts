import type { DatabaseSync } from 'node:sqlite'
import {
  RequestSealInputSchema,
  RequestSealAckSchema,
  parseRequestSealResult,
  type RequestSealInput,
  type RequestSealResult,
  type RequestSealAck
} from '../../shared/contracts/request-seal'
import { requestNonDispatchProof } from '../sending/request-seal-proof'
import { sameIdentity, type Identity } from '../../shared/contracts/identity'
import {
  PermitRequestSchema,
  ExecutionPermitSchema,
  ExecutionReceiptSchema,
  type PermitRequest,
  type ExecutionPermit,
  type ExecutionReceipt
} from '../../shared/contracts/execution'
import {
  ConfirmedDeliverySchema,
  NotSentDeliverySchema,
  type DeliveryResult
} from '../../shared/contracts/delivery'
import type { SendRecord } from './ledger'
import { conversationKey, deliveryScope } from './ledger'
import { hashContext } from '../reply/hashes'
import {
  DeviceReconciliationReportSchema,
  parseDeviceReconciliationReport,
  ReconciliationAcknowledgmentSchema,
  type ReconciliationChallenge,
  type DeviceReconciliationReport,
  type ReconciliationAcknowledgment
} from '../../shared/contracts/reconciliation'
import {
  parseReconciliationDecision,
  ReconciliationDecisionSchema,
  ReconciliationAppliedAckSchema,
  type ReconciliationDecision,
  type ReconciliationAppliedAck
} from '../../shared/contracts/reconciliation'

export interface CentralAttempt {
  executionId: string
  phase: 'requesting' | 'issued' | 'dispatching' | 'receipt_pending' | 'settled' | 'unresolved'
  request: PermitRequest
  permit?: ExecutionPermit
  receipt?: ExecutionReceipt
  send: SendRecord
}
/** Same SQLite connection: receipts and handled inbound commit atomically. No credentials. */
export class CentralOutbox {
  constructor(
    private readonly db: DatabaseSync,
    private readonly getSend: (id: string) => SendRecord | undefined
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS central_attempts (
      execution_id TEXT PRIMARY KEY REFERENCES sends(execution_id),
      phase TEXT NOT NULL CHECK(phase IN ('requesting','issued','dispatching','receipt_pending','settled','unresolved')),
      request_json TEXT NOT NULL, permit_id TEXT UNIQUE, permit_json TEXT, receipt_json TEXT,
      baseline_sequence INTEGER, updated_at INTEGER NOT NULL
    );`)
    if (
      !db
        .prepare('PRAGMA table_info(central_attempts)')
        .all()
        .some((column) => column.name === 'baseline_sequence')
    )
      db.exec('ALTER TABLE central_attempts ADD COLUMN baseline_sequence INTEGER')
    db.exec('CREATE INDEX IF NOT EXISTS central_pending ON central_attempts(phase,updated_at)')
    db.exec(`CREATE TABLE IF NOT EXISTS central_reconciliation_reports (
      execution_id TEXT PRIMARY KEY REFERENCES central_attempts(execution_id),case_id TEXT NOT NULL UNIQUE,
      report_json TEXT NOT NULL,report_hash TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS central_reconciliation_decisions (
      execution_id TEXT PRIMARY KEY REFERENCES central_reconciliation_reports(execution_id),
      decision_id TEXT NOT NULL UNIQUE,decision_json TEXT NOT NULL,decision_hash TEXT NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS central_request_seals (
      execution_id TEXT PRIMARY KEY REFERENCES central_attempts(execution_id),
      input_json TEXT NOT NULL,input_hash TEXT NOT NULL,result_json TEXT,result_hash TEXT,
      acknowledged INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
    )`)
  }

  requestSeal(
    executionId: string
  ): { input: RequestSealInput; result?: RequestSealResult; acknowledged: boolean } | undefined {
    const row = this.db
      .prepare('SELECT * FROM central_request_seals WHERE execution_id=?')
      .get(executionId)
    if (!row) return undefined
    const input = RequestSealInputSchema.parse(JSON.parse(String(row.input_json)))
    if (hashContext(input) !== row.input_hash || input.executionId !== executionId)
      throw new Error('request_seal_corrupted')
    let result: RequestSealResult | undefined
    if (row.result_json !== null) {
      result = parseRequestSealResult(
        JSON.parse(String(row.result_json)),
        input,
        hashContext(input)
      )
      if (
        hashContext(result) !== row.result_hash ||
        (result.status === 'request_sealed' &&
          hashContext(result.seal.input) !== hashContext(input))
      )
        throw new Error('request_seal_corrupted')
    }
    return { input, result, acknowledged: row.acknowledged === 1 }
  }
  canSealRequest(executionId: string): boolean {
    const a = this.get(executionId),
      baseline = this.db
        .prepare('SELECT baseline_sequence FROM central_attempts WHERE execution_id=?')
        .get(executionId)?.baseline_sequence
    return (
      !!a &&
      a.phase === 'unresolved' &&
      !a.permit &&
      !a.receipt &&
      baseline === null &&
      a.request.taskId === a.send.task.taskId &&
      a.request.taskHash === hashContext(a.send.task) &&
      a.request.draftHash === a.send.draftHash &&
      ['unknown', 'cancelled'].includes(a.send.status)
    )
  }
  prepareRequestSeal(
    executionId: string,
    stopped: RequestSealInput['stopped'],
    now: number
  ): RequestSealInput {
    if (!this.canSealRequest(executionId)) throw new Error('request_seal_non_dispatch_unproven')
    const old = this.requestSeal(executionId)
    if (old) return old.input
    const a = this.get(executionId)!,
      base = { executionId, identity: a.send.task.identity, request: a.request }
    const input = RequestSealInputSchema.parse({
      ...base,
      stopped,
      verificationProofHash: requestNonDispatchProof(base)
    })
    if (input.stopped.stoppedAt > now) throw new Error('request_seal_invalid_stop')
    this.db
      .prepare(
        'INSERT INTO central_request_seals(execution_id,input_json,input_hash,created_at,updated_at) VALUES(?,?,?,?,?)'
      )
      .run(executionId, JSON.stringify(input), hashContext(input), now, now)
    return input
  }
  applyRequestSeal(executionId: string, value: RequestSealResult, now: number): RequestSealResult {
    return this.transaction(() => {
      const saved = this.requestSeal(executionId)
      if (!saved) throw new Error('request_seal_missing')
      const result = parseRequestSealResult(
        structuredClone(value),
        saved.input,
        hashContext(saved.input)
      )
      if (
        result.status === 'request_sealed' &&
        hashContext(result.seal.input) !== hashContext(saved.input)
      )
        throw new Error('request_seal_mismatch')
      if (saved.result) {
        if (hashContext(saved.result) !== hashContext(result))
          throw new Error('request_seal_changed')
        return saved.result
      }
      if (!this.canSealRequest(executionId)) throw new Error('request_seal_non_dispatch_unproven')
      const a = this.get(executionId)!
      if (
        hashContext(a.request) !== hashContext(saved.input.request) ||
        !sameIdentity(a.send.task.identity, saved.input.identity) ||
        a.request.taskHash !== hashContext(a.send.task) ||
        a.request.draftHash !== a.send.draftHash ||
        (result.status === 'existing_permit' && !this.matches(a, result.permit))
      )
        throw new Error('request_seal_attempt_mismatch')
      this.db
        .prepare(
          'UPDATE central_request_seals SET result_json=?,result_hash=?,updated_at=? WHERE execution_id=?'
        )
        .run(JSON.stringify(result), hashContext(result), now, executionId)
      if (result.status === 'existing_permit') {
        // Read-only lookup, never issued(): the requesting->issued transition
        // and all physical dispatch paths stay unreachable.
        this.db
          .prepare(
            'UPDATE central_attempts SET permit_id=?,permit_json=?,updated_at=? WHERE execution_id=?'
          )
          .run(result.permit.permitId, JSON.stringify(result.permit), now, executionId)
        return result
      }
      this.db
        .prepare(
          "UPDATE sends SET status='cancelled',reason='request_sealed_not_dispatched',evidence=?,updated_at=? WHERE execution_id=?"
        )
        .run(saved.input.verificationProofHash, now, executionId)
      this.db
        .prepare(
          `UPDATE messages SET handled_execution=? WHERE scope=? AND sequence BETWEEN ? AND ?
        AND json_extract(payload,'$.direction')='inbound' AND handled_execution IS NULL`
        )
        .run(
          executionId,
          conversationKey(a.send.task.identity, a.send.task.conversationId),
          a.send.task.inboundRange.from,
          a.send.task.inboundRange.to
        )
      const scope = deliveryScope(a.send.task.identity, a.send.task.conversationId)
      this.db
        .prepare(
          'INSERT OR IGNORE INTO conversation_controls(delivery_scope,human_owned) VALUES(?,0)'
        )
        .run(scope)
      this.db
        .prepare(
          'UPDATE conversation_controls SET human_owned=1,revision=revision+1 WHERE delivery_scope=? AND human_owned=0'
        )
        .run(scope)
      return result
    })
  }
  acknowledgeRequestSeal(executionId: string, value: RequestSealAck, now: number): void {
    const ack = RequestSealAckSchema.parse(value),
      result = this.requestSeal(executionId)?.result
    if (
      result?.status !== 'request_sealed' ||
      ack.sealId !== result.seal.sealId ||
      ack.executionId !== executionId ||
      ack.requestHash !== result.seal.requestHash ||
      ack.sealHash !== hashContext(result.seal)
    )
      throw new Error('request_seal_ack_mismatch')
    this.db
      .prepare('UPDATE central_request_seals SET acknowledged=1,updated_at=? WHERE execution_id=?')
      .run(now, executionId)
  }
  pendingRequestSealApplications(
    identity?: Omit<Identity, 'loginEpoch' | 'clientInstanceId'>
  ): CentralAttempt[] {
    return this.db
      .prepare(
        "SELECT execution_id FROM central_request_seals WHERE acknowledged=0 AND json_extract(result_json,'$.status')='request_sealed' ORDER BY created_at,execution_id"
      )
      .all()
      .map((r) => this.get(String(r.execution_id))!)
      .filter(
        (a) =>
          !identity ||
          ['tenantId', 'employeeId', 'accountId', 'agentId', 'platform'].every(
            (k) =>
              a.send.task.identity[k as keyof typeof identity] ===
              identity[k as keyof typeof identity]
          )
      )
  }

  get(executionId: string): CentralAttempt | undefined {
    const row = this.db
      .prepare('SELECT * FROM central_attempts WHERE execution_id=?')
      .get(executionId)
    if (!row) return undefined
    const send = this.getSend(executionId)
    if (!send) throw new Error('central_send_missing')
    return {
      executionId,
      phase: row.phase as CentralAttempt['phase'],
      send,
      request: PermitRequestSchema.parse(JSON.parse(String(row.request_json))),
      permit:
        row.permit_json === null
          ? undefined
          : ExecutionPermitSchema.parse(JSON.parse(String(row.permit_json))),
      receipt:
        row.receipt_json === null
          ? undefined
          : ExecutionReceiptSchema.parse(JSON.parse(String(row.receipt_json)))
    }
  }

  reconciliationReport(executionId: string): DeviceReconciliationReport | undefined {
    const row = this.db
      .prepare(
        'SELECT report_json,report_hash FROM central_reconciliation_reports WHERE execution_id=?'
      )
      .get(executionId)
    if (!row) return undefined
    const report = DeviceReconciliationReportSchema.parse(JSON.parse(String(row.report_json)))
    if (hashContext(report) !== row.report_hash) throw new Error('reconciliation_report_corrupted')
    return report
  }
  saveReconciliationReport(
    executionId: string,
    challenge: ReconciliationChallenge,
    input: DeviceReconciliationReport,
    now: number
  ): DeviceReconciliationReport {
    const report = parseDeviceReconciliationReport(structuredClone(input), challenge),
      row = this.get(executionId)
    if (
      !row ||
      !(row.phase === 'unresolved' || row.receipt?.status === 'unknown') ||
      !['unknown', 'cancelled'].includes(row.send.status) ||
      !this.matches(row, challenge.permit) ||
      report.observation.executionId !== executionId ||
      hashContext(row.request) !== hashContext(report.request)
    )
      throw new Error('reconciliation_attempt_mismatch')
    if (report.observation.status === 'confirmed') {
      const baseline = this.db
        .prepare('SELECT baseline_sequence FROM central_attempts WHERE execution_id=?')
        .get(executionId)?.baseline_sequence
      if (baseline === null || baseline === undefined)
        throw new Error('reconciliation_dispatch_unproven')
      const echo = this.db
        .prepare('SELECT sequence FROM messages WHERE scope=? AND source_id=?')
        .get(
          conversationKey(row.send.task.identity, row.send.task.conversationId),
          report.observation.sourceMessageId
        )
      if (echo && Number(echo.sequence) <= Number(baseline))
        throw new Error('reconciliation_old_echo')
    }
    const old = this.reconciliationReport(executionId)
    if (old) {
      if (hashContext(old) !== hashContext(report)) throw new Error('reconciliation_report_changed')
      return old
    }
    this.db
      .prepare(
        'INSERT INTO central_reconciliation_reports(execution_id,case_id,report_json,report_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)'
      )
      .run(executionId, report.caseId, JSON.stringify(report), hashContext(report), now, now)
    return report
  }
  acknowledgeReconciliation(
    executionId: string,
    input: ReconciliationAcknowledgment,
    now: number
  ): void {
    const acknowledgment = ReconciliationAcknowledgmentSchema.parse(input),
      report = this.reconciliationReport(executionId)
    if (
      !report ||
      report.caseId !== acknowledgment.caseId ||
      hashContext(report) !== acknowledgment.reportHash
    )
      throw new Error('reconciliation_acknowledgment_mismatch')
    this.db
      .prepare(
        'UPDATE central_reconciliation_reports SET acknowledged=1,updated_at=? WHERE execution_id=?'
      )
      .run(now, executionId)
  }

  reconciliationDecision(executionId: string): ReconciliationDecision | undefined {
    const row = this.db
      .prepare(
        'SELECT decision_json,decision_hash FROM central_reconciliation_decisions WHERE execution_id=?'
      )
      .get(executionId)
    if (!row) return undefined
    const decision = ReconciliationDecisionSchema.parse(JSON.parse(String(row.decision_json)))
    if (hashContext(decision) !== row.decision_hash)
      throw new Error('reconciliation_decision_corrupted')
    return decision
  }

  applyReconciliation(executionId: string, input: ReconciliationDecision, now: number): void {
    this.transaction(() => {
      const report = this.reconciliationReport(executionId),
        attempt = this.get(executionId)
      if (!report || !attempt) throw new Error('reconciliation_report_missing')
      const decision = parseReconciliationDecision(
        structuredClone(input),
        report,
        hashContext(report)
      )
      const old = this.reconciliationDecision(executionId)
      if (old) {
        if (hashContext(old) !== hashContext(decision))
          throw new Error('reconciliation_decision_changed')
        return
      }
      if (
        !['unknown', 'cancelled'].includes(attempt.send.status) ||
        report.observation.executionId !== executionId ||
        hashContext(attempt.request) !== hashContext(report.request)
      )
        throw new Error('reconciliation_attempt_mismatch')
      this.db
        .prepare(
          'INSERT INTO central_reconciliation_decisions(execution_id,decision_id,decision_json,decision_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)'
        )
        .run(
          executionId,
          decision.decisionId,
          JSON.stringify(decision),
          hashContext(decision),
          now,
          now
        )
      this.db
        .prepare('UPDATE sends SET status=?,reason=?,evidence=?,updated_at=? WHERE execution_id=?')
        .run(
          decision.outcome === 'confirmed' ? 'confirmed' : 'cancelled',
          'administrator_reconciled',
          report.observation.verificationProofHash,
          now,
          executionId
        )
      // Both outcomes consume exactly the original inbound range. A no-action
      // decision must not cause that same customer question to be auto-replayed.
      this.db
        .prepare(
          `UPDATE messages SET handled_execution=? WHERE scope=? AND sequence BETWEEN ? AND ?
        AND json_extract(payload,'$.direction')='inbound' AND handled_execution IS NULL`
        )
        .run(
          executionId,
          conversationKey(attempt.send.task.identity, attempt.send.task.conversationId),
          attempt.send.task.inboundRange.from,
          attempt.send.task.inboundRange.to
        )
      const scope = deliveryScope(attempt.send.task.identity, attempt.send.task.conversationId)
      this.db
        .prepare(
          'INSERT OR IGNORE INTO conversation_controls(delivery_scope,human_owned) VALUES(?,0)'
        )
        .run(scope)
      // An unsent reply remains the employee's responsibility after resolution.
      if (decision.outcome === 'not_sent')
        this.db
          .prepare(
            'UPDATE conversation_controls SET human_owned=1,revision=revision+1 WHERE delivery_scope=? AND human_owned=0'
          )
          .run(scope)
    })
  }

  acknowledgeReconciliationApplied(
    executionId: string,
    input: ReconciliationAppliedAck,
    now: number
  ): void {
    const ack = ReconciliationAppliedAckSchema.parse(input),
      decision = this.reconciliationDecision(executionId)
    if (
      !decision ||
      decision.decisionId !== ack.decisionId ||
      hashContext(decision) !== ack.decisionHash
    )
      throw new Error('reconciliation_applied_ack_mismatch')
    this.db
      .prepare(
        'UPDATE central_reconciliation_decisions SET acknowledged=1,updated_at=? WHERE execution_id=?'
      )
      .run(now, executionId)
  }

  pendingReconciliationApplications(
    identity?: Omit<Identity, 'loginEpoch' | 'clientInstanceId'>
  ): CentralAttempt[] {
    return this.db
      .prepare(
        'SELECT execution_id FROM central_reconciliation_decisions WHERE acknowledged=0 ORDER BY created_at,execution_id'
      )
      .all()
      .map((row) => this.get(String(row.execution_id))!)
      .filter(
        (attempt) =>
          !identity ||
          ['tenantId', 'employeeId', 'accountId', 'agentId', 'platform'].every(
            (key) =>
              attempt.send.task.identity[key as keyof typeof identity] ===
              identity[key as keyof typeof identity]
          )
      )
  }

  begin(executionId: string, input: PermitRequest, now: number): boolean {
    const request = PermitRequestSchema.parse(structuredClone(input))
    const send = this.getSend(executionId)
    if (
      !send ||
      send.status !== 'dispatching' ||
      request.taskId !== send.task.taskId ||
      request.taskHash !== hashContext(send.task) ||
      request.draftHash !== send.draftHash ||
      request.loginEpoch !== send.task.identity.loginEpoch ||
      request.clientInstanceId !== send.task.identity.clientInstanceId
    )
      throw new Error('central_task_mismatch')
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO central_attempts(execution_id,phase,request_json,updated_at) VALUES(?,'requesting',?,?)"
        )
        .run(executionId, JSON.stringify(request), now).changes === 1
    )
  }

  issued(executionId: string, input: ExecutionPermit, now: number): boolean {
    const permit = ExecutionPermitSchema.parse(structuredClone(input))
    const row = this.get(executionId)
    if (!row || row.phase !== 'requesting' || !this.matches(row, permit))
      throw new Error('central_permit_mismatch')
    const usable = permit.newlyIssued && permit.status === 'issued'
    this.db
      .prepare(
        'UPDATE central_attempts SET phase=?,permit_id=?,permit_json=?,updated_at=? WHERE execution_id=?'
      )
      .run(
        usable ? 'issued' : 'unresolved',
        permit.permitId,
        JSON.stringify(permit),
        now,
        executionId
      )
    return usable
  }

  dispatching(executionId: string, now: number): boolean {
    const row = this.get(executionId)
    if (!row) return false
    const baseline = Number(
      this.db
        .prepare('SELECT max(sequence) AS sequence FROM messages WHERE scope=?')
        .get(conversationKey(row.send.task.identity, row.send.task.conversationId))?.sequence ?? 0
    )
    return (
      this.db
        .prepare(
          "UPDATE central_attempts SET phase='dispatching',baseline_sequence=?,updated_at=? WHERE execution_id=? AND phase='issued' AND receipt_json IS NULL"
        )
        .run(baseline, now, executionId).changes === 1
    )
  }

  unresolved(executionId: string, now: number): void {
    this.db
      .prepare(
        "UPDATE central_attempts SET phase='unresolved',updated_at=? WHERE execution_id=? AND phase='requesting'"
      )
      .run(now, executionId)
  }

  recordReceipt(
    executionId: string,
    input: ExecutionReceipt,
    now: number,
    delivery?: DeliveryResult
  ): void {
    const receipt = ExecutionReceiptSchema.parse(structuredClone(input))
    this.transaction(() => this.writeReceipt(executionId, receipt, now, delivery))
  }

  acknowledge(executionId: string, receipt: ExecutionReceipt, now: number): boolean {
    const row = this.get(executionId)
    if (
      !row?.receipt ||
      hashContext(row.receipt) !== hashContext(ExecutionReceiptSchema.parse(receipt))
    )
      throw new Error('central_receipt_mismatch')
    return (
      this.db
        .prepare(
          "UPDATE central_attempts SET phase='settled',updated_at=? WHERE execution_id=? AND phase='receipt_pending'"
        )
        .run(now, executionId).changes === 1
    )
  }

  pending(
    identity?: Omit<Identity, 'loginEpoch' | 'clientInstanceId'>,
    maximum = 50
  ): CentralAttempt[] {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 100)
      throw new Error('invalid_outbox_limit')
    const results: CentralAttempt[] = []
    for (const row of this.db
      .prepare(
        "SELECT execution_id FROM central_attempts WHERE phase='receipt_pending' ORDER BY updated_at,execution_id"
      )
      .iterate()) {
      const attempt = this.get(String(row.execution_id))!
      if (
        !identity ||
        ['tenantId', 'employeeId', 'accountId', 'agentId', 'platform'].every(
          (key) =>
            attempt.send.task.identity[key as keyof typeof identity] ===
            identity[key as keyof typeof identity]
        )
      )
        results.push(attempt)
      if (results.length >= maximum) break
    }
    return results
  }

  recover(now: number): void {
    this.transaction(() => {
      for (const row of this.db
        .prepare(
          "SELECT execution_id FROM central_attempts WHERE phase IN ('requesting','issued','dispatching')"
        )
        .all()) {
        const attempt = this.get(String(row.execution_id))!
        if (attempt.phase === 'requesting') {
          this.db
            .prepare(
              "UPDATE central_attempts SET phase='unresolved',updated_at=? WHERE execution_id=?"
            )
            .run(now, attempt.executionId)
          continue
        }
        if (!attempt.permit) throw new Error('central_permit_missing')
        const receipt: ExecutionReceipt =
          attempt.phase === 'issued'
            ? {
                permitId: attempt.permit.permitId,
                draftHash: attempt.send.draftHash,
                status: 'not_sent',
                dispatchStarted: false,
                quiescent: true,
                verificationProofHash: hashContext({
                  kind: 'restarted_before_physical_dispatch',
                  executionId: attempt.executionId,
                  permitId: attempt.permit.permitId,
                  request: attempt.request
                })
              }
            : {
                permitId: attempt.permit.permitId,
                draftHash: attempt.send.draftHash,
                status: 'unknown'
              }
        this.writeReceipt(attempt.executionId, receipt, now)
      }
    })
  }

  requiresReconciliation(identity?: Omit<Identity, 'loginEpoch' | 'clientInstanceId'>): boolean {
    for (const row of this.db
      .prepare(
        `SELECT execution_id FROM central_attempts t WHERE (phase='unresolved' OR json_extract(receipt_json,'$.status')='unknown')
        AND NOT EXISTS(SELECT 1 FROM central_reconciliation_decisions d WHERE d.execution_id=t.execution_id AND d.acknowledged=1)
        AND NOT EXISTS(SELECT 1 FROM central_request_seals s WHERE s.execution_id=t.execution_id AND s.acknowledged=1 AND json_extract(s.result_json,'$.status')='request_sealed')`
      )
      .iterate()) {
      const attempt = this.get(String(row.execution_id))!
      if (
        !identity ||
        ['tenantId', 'employeeId', 'accountId', 'agentId', 'platform'].every(
          (key) =>
            attempt.send.task.identity[key as keyof typeof identity] ===
            identity[key as keyof typeof identity]
        )
      )
        return true
    }
    return false
  }

  private matches(row: CentralAttempt, permit: ExecutionPermit): boolean {
    return (
      sameIdentity(row.send.task.identity, permit.identity) &&
      permit.taskId === row.request.taskId &&
      permit.conversationId === row.send.task.conversationId &&
      permit.taskHash === row.request.taskHash &&
      permit.draftHash === row.request.draftHash &&
      permit.draftRevision === row.request.draftRevision &&
      permit.leaseVersion === row.request.leaseVersion &&
      (permit.purpose ?? 'automatic') === (row.request.purpose ?? 'automatic') &&
      permit.confirmationId === row.request.confirmationId
    )
  }
  reconciliationRequired(executionId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM central_attempts t WHERE execution_id=?
      AND (phase='unresolved' OR json_extract(receipt_json,'$.status')='unknown')
      AND NOT EXISTS(SELECT 1 FROM central_reconciliation_decisions d WHERE d.execution_id=t.execution_id AND d.acknowledged=1)
      AND NOT EXISTS(SELECT 1 FROM central_request_seals s WHERE s.execution_id=t.execution_id AND s.acknowledged=1 AND json_extract(s.result_json,'$.status')='request_sealed')`
      )
      .get(executionId)
  }

  private writeReceipt(
    executionId: string,
    receipt: ExecutionReceipt,
    now: number,
    delivery?: DeliveryResult
  ): void {
    const row = this.get(executionId)
    if (
      !row?.permit ||
      receipt.permitId !== row.permit.permitId ||
      receipt.draftHash !== row.send.draftHash
    )
      throw new Error('central_receipt_mismatch')
    if (row.receipt) {
      if (hashContext(row.receipt) !== hashContext(receipt))
        throw new Error('central_receipt_changed')
      return
    }
    if (
      !['issued', 'dispatching'].includes(row.phase) ||
      !['dispatching', 'unknown'].includes(row.send.status)
    )
      throw new Error('central_phase_invalid')
    if (receipt.status === 'not_sent' && row.phase !== 'issued') {
      const parsed = NotSentDeliverySchema.safeParse(delivery)
      if (
        !parsed.success ||
        parsed.data.executionId !== executionId ||
        !sameIdentity(parsed.data.identity, row.send.task.identity) ||
        parsed.data.conversationId !== row.send.task.conversationId ||
        parsed.data.draftHash !== row.send.draftHash ||
        parsed.data.verificationProofHash !== receipt.verificationProofHash
      )
        throw new Error('no_action_proof_required')
    }
    let evidence: string | null = null
    if (receipt.status === 'confirmed') {
      const parsed = ConfirmedDeliverySchema.safeParse(delivery)
      if (
        row.phase !== 'dispatching' ||
        !parsed.success ||
        parsed.data.executionId !== executionId ||
        !sameIdentity(parsed.data.identity, row.send.task.identity) ||
        parsed.data.conversationId !== row.send.task.conversationId ||
        parsed.data.draftHash !== row.send.draftHash ||
        parsed.data.proof?.sourceMessageId !== receipt.sourceMessageId ||
        parsed.data.proof?.verificationProofHash !== receipt.verificationProofHash
      )
        throw new Error('confirmation_proof_required')
      evidence = parsed.data.evidence
      const old = this.db
        .prepare('SELECT sequence FROM messages WHERE scope=? AND source_id=?')
        .get(
          conversationKey(row.send.task.identity, row.send.task.conversationId),
          receipt.sourceMessageId
        )
      const baseline = this.db
        .prepare('SELECT baseline_sequence FROM central_attempts WHERE execution_id=?')
        .get(executionId)
      if (old && Number(old.sequence) <= Number(baseline?.baseline_sequence ?? 0))
        throw new Error('old_echo_is_not_confirmation')
    }
    this.db
      .prepare(
        "UPDATE central_attempts SET phase='receipt_pending',receipt_json=?,updated_at=? WHERE execution_id=?"
      )
      .run(JSON.stringify(receipt), now, executionId)
    this.db
      .prepare('UPDATE sends SET status=?,reason=?,evidence=?,updated_at=? WHERE execution_id=?')
      .run(
        receipt.status === 'confirmed'
          ? 'confirmed'
          : receipt.status === 'not_sent'
            ? 'cancelled'
            : 'unknown',
        receipt.status === 'confirmed'
          ? null
          : receipt.status === 'not_sent'
            ? 'central_not_dispatched'
            : 'central_delivery_unknown',
        evidence,
        now,
        executionId
      )
    if (receipt.status === 'confirmed') {
      this.db
        .prepare(
          `UPDATE messages SET handled_execution=? WHERE scope=? AND sequence BETWEEN ? AND ?
        AND json_extract(payload,'$.direction')='inbound' AND handled_execution IS NULL`
        )
        .run(
          executionId,
          conversationKey(row.send.task.identity, row.send.task.conversationId),
          row.send.task.inboundRange.from,
          row.send.task.inboundRange.to
        )
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
