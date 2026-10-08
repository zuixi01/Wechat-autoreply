import type { DatabaseSync } from 'node:sqlite'
import {
  RestorePauseReportSchema,
  type RestorePauseReport
} from '../../shared/contracts/restoration'
import { readLedgerRestoreContext } from './ledger-restoration'
import { hashContext } from '../reply/hashes'

function bound(db: DatabaseSync, report: RestorePauseReport): void {
  const context = readLedgerRestoreContext(db)
  if (!context || hashContext(context) !== hashContext(report.challenge.context))
    throw Error('ledger_restore_pause_context_invalid')
}
export function readRestorePauseReport(
  db: DatabaseSync,
  challengeId: string
): RestorePauseReport | null {
  const table = db
    .prepare("SELECT type FROM sqlite_schema WHERE name='ledger_restore_pause_reports'")
    .get()
  if (!table) return null
  if (table.type !== 'table') throw Error('ledger_restore_pause_invalid')
  const row = db
    .prepare(
      'SELECT report_hash,CASE WHEN length(CAST(report_json AS BLOB))<=65536 THEN report_json END AS report_json FROM ledger_restore_pause_reports WHERE challenge_id=?'
    )
    .get(challengeId)
  if (!row) return null
  try {
    if (typeof row.report_json !== 'string') throw Error('invalid')
    const report = RestorePauseReportSchema.parse(JSON.parse(row.report_json))
    if (report.challenge.challengeId !== challengeId || hashContext(report) !== row.report_hash)
      throw Error('invalid')
    bound(db, report)
    return report
  } catch {
    throw Error('ledger_restore_pause_invalid')
  }
}
export function saveRestorePauseReport(db: DatabaseSync, input: unknown): RestorePauseReport {
  if (!db.isTransaction) throw Error('ledger_restore_pause_transaction_required')
  const report = RestorePauseReportSchema.parse(input)
  bound(db, report)
  const old = readRestorePauseReport(db, report.challenge.challengeId)
  if (old) {
    if (hashContext(old) !== hashContext(report)) throw Error('ledger_restore_pause_conflict')
    return old
  }
  db.exec(`CREATE TABLE IF NOT EXISTS ledger_restore_pause_reports(challenge_id TEXT PRIMARY KEY,report_hash TEXT NOT NULL,report_json TEXT NOT NULL) STRICT;
    CREATE TRIGGER IF NOT EXISTS ledger_restore_pause_no_update BEFORE UPDATE ON ledger_restore_pause_reports BEGIN SELECT RAISE(ABORT,'ledger_restore_pause_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_restore_pause_no_delete BEFORE DELETE ON ledger_restore_pause_reports BEGIN SELECT RAISE(ABORT,'ledger_restore_pause_immutable'); END;`)
  db.prepare('INSERT INTO ledger_restore_pause_reports VALUES(?,?,?)').run(
    report.challenge.challengeId,
    hashContext(report),
    JSON.stringify(report)
  )
  return readRestorePauseReport(db, report.challenge.challengeId)!
}
