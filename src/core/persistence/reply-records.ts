import type { DatabaseSync } from 'node:sqlite'
import { hashContext } from '../reply/hashes'
import {
  LocalReplyRecordSchema,
  workbenchScopeOf,
  type LocalReplyRecord,
  type WorkbenchScope
} from '../../shared/contracts/workbench'
import type { ReplyTask } from '../../shared/contracts/task'

function ownerKey(scope: WorkbenchScope): string {
  return hashContext(workbenchScopeOf(scope))
}
/** Shares the ledger connection. This catalogue never grants send authority. */
export class ReplyRecords {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS reply_records (
      owner_key TEXT NOT NULL,task_id TEXT NOT NULL,payload TEXT NOT NULL,
      status TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(owner_key,task_id)
    );CREATE INDEX IF NOT EXISTS reply_records_recent ON reply_records(owner_key,updated_at DESC);
    CREATE INDEX IF NOT EXISTS reply_records_conversation ON reply_records(owner_key,
      json_extract(payload,'$.task.conversationId'),json_extract(payload,'$.task.conversationRevision'));`)
  }
  begin(task: ReplyTask, inbound: string[], now: number): void {
    const record = LocalReplyRecordSchema.parse({
      task,
      status: 'generating',
      inboundPreview: inbound.join('\n').slice(0, 400),
      revision: 1,
      updatedAt: now
    })
    this.db
      .prepare(
        'INSERT INTO reply_records(owner_key,task_id,payload,status,updated_at) VALUES(?,?,?,?,?)'
      )
      .run(ownerKey(task.identity), task.taskId, JSON.stringify(record), record.status, now)
  }
  get(scope: WorkbenchScope, taskId: string): LocalReplyRecord | undefined {
    const row = this.db
      .prepare('SELECT payload FROM reply_records WHERE owner_key=? AND task_id=?')
      .get(ownerKey(scope), taskId)
    return row ? LocalReplyRecordSchema.parse(JSON.parse(String(row.payload))) : undefined
  }
  /** Prevent a read-only periodic sweep from generating the same completed suggestion again. */
  hasAssessment(
    identity: ReplyTask['identity'],
    conversationId: string,
    revision: number,
    configuration: Pick<
      ReplyTask,
      'configVersion' | 'knowledgeVersion' | 'decisionPolicyVersion' | 'questionSetVersion'
    >
  ): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM reply_records WHERE owner_key=?
      AND status IN ('ready','needs_human') AND json_extract(payload,'$.assessmentComplete')=1
      AND json_extract(payload,'$.task.conversationId')=?
      AND json_extract(payload,'$.task.conversationRevision')=?
      AND json_extract(payload,'$.task.identity.loginEpoch')=?
      AND json_extract(payload,'$.task.identity.clientInstanceId')=?
      AND json_extract(payload,'$.task.configVersion')=?
      AND json_extract(payload,'$.task.knowledgeVersion')=?
      AND json_extract(payload,'$.task.decisionPolicyVersion')=?
      AND json_extract(payload,'$.task.questionSetVersion')=? LIMIT 1`
        )
        .get(
          ownerKey(identity),
          conversationId,
          revision,
          identity.loginEpoch,
          identity.clientInstanceId,
          configuration.configVersion,
          configuration.knowledgeVersion,
          configuration.decisionPolicyVersion,
          configuration.questionSetVersion
        )
    )
  }
  list(scope: WorkbenchScope): LocalReplyRecord[] {
    return this.db
      .prepare(
        'SELECT payload FROM reply_records WHERE owner_key=? ORDER BY updated_at DESC,task_id LIMIT 100'
      )
      .all(ownerKey(scope))
      .map((row) => LocalReplyRecordSchema.parse(JSON.parse(String(row.payload))))
  }
  update(
    scope: WorkbenchScope,
    taskId: string,
    patch: Pick<LocalReplyRecord, 'status'> &
      Partial<
        Pick<
          LocalReplyRecord,
          | 'draft'
          | 'review'
          | 'edited'
          | 'reasons'
          | 'assessmentComplete'
          | 'humanConfirmation'
          | 'explanation'
        >
      >,
    now: number
  ): boolean {
    const old = this.get(scope, taskId)
    if (!old || ['sent', 'unknown', 'skipped', 'obsolete', 'not_sent'].includes(old.status))
      return false
    const next = LocalReplyRecordSchema.parse({
      ...old,
      ...patch,
      revision: old.revision + 1,
      updatedAt: now
    })
    this.db
      .prepare(
        'UPDATE reply_records SET payload=?,status=?,updated_at=? WHERE owner_key=? AND task_id=?'
      )
      .run(JSON.stringify(next), next.status, now, ownerKey(scope), taskId)
    return true
  }
  invalidate(now: number, scope?: WorkbenchScope): void {
    const records = scope
      ? this.listActive(scope)
      : this.db
          .prepare(
            "SELECT payload FROM reply_records WHERE status IN ('generating','ready','needs_human')"
          )
          .all()
          .map((row) => LocalReplyRecordSchema.parse(JSON.parse(String(row.payload))))
    for (const record of records)
      this.update(record.task.identity, record.task.taskId, { status: 'obsolete' }, now)
  }
  private listActive(scope: WorkbenchScope): LocalReplyRecord[] {
    return this.db
      .prepare(
        "SELECT payload FROM reply_records WHERE owner_key=? AND status IN ('generating','ready','needs_human')"
      )
      .all(ownerKey(scope))
      .map((row) => LocalReplyRecordSchema.parse(JSON.parse(String(row.payload))))
  }
}
