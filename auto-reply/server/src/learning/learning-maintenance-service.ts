import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { Scope } from '../auth/account-authority'
import type {
  LearningCurationReport,
  LearningFeedback,
  LearningEpisode,
  MemoryRecord,
  MemoryRevision,
  RetentionReport
} from '../../../src/shared/contracts/learning-memory'
import {
  planLearningCuration,
  selectLearningCurationMerge
} from '../../../src/core/memory/learning-curation-plan'
import { learningHash } from '../../../src/core/memory/learning-scope'
import {
  effectiveLearningSettings,
  withLearningAccount,
  type LearningAccountAuthority
} from './learning-account'
import { expireLearningLeaseWithin, learningForegroundWithin } from './learning-background'
import { EnterpriseLearningRepository, enterpriseMemoryScope } from './learning-repository'
import {
  EnterpriseLearningCurationMerge,
  type EnterpriseCurationMergeOptions,
  type PreparedCurationMerge
} from './learning-curation-merge'
import type { EnterpriseValidationRun } from './learning-validation-budget'
import {
  closeIdleEnterpriseEpisodesWithin,
  type EnterpriseEpisodeClosure
} from './learning-episode-closure'

export interface EnterpriseMaintenanceResult {
  closedEpisodes: EnterpriseEpisodeClosure[]
  curation: (LearningCurationReport & { conversationId: string | null })[]
  retention: (RetentionReport & { conversationId: string | null; deletedCalibrationSets: number })[]
}
const Options = z.strictObject({ dryRun: z.boolean().default(false) })
/** Deterministic maintenance commits inside the same account lock used by every background admission. */
export class EnterpriseLearningMaintenanceService {
  drain(): Promise<void> {
    return this.options.merge?.budget.drain() ?? Promise.resolve()
  }
  private readonly repository: EnterpriseLearningRepository<LearningAccountAuthority>
  constructor(
    private readonly authority: LearningAccountAuthority,
    private readonly options: { now?: () => number; merge?: EnterpriseCurationMergeOptions } = {}
  ) {
    this.repository = new EnterpriseLearningRepository(authority, options)
  }
  private locked<T>(
    reference: string,
    conversationId: string | null,
    operation: (db: PoolClient, scope: Scope, conversation: string, at: number) => Promise<T>
  ): Promise<T> {
    return withLearningAccount(
      this.authority,
      reference,
      conversationId,
      operation,
      this.options.now
    )
  }
  private cancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('curation_cancelled')
  }
  private keys(scope: Scope, conversation: string): [string, string, string] {
    return [scope.tenant_id, scope.account_id, conversation]
  }
  private async backgroundReason(
    db: PoolClient,
    scope: Scope,
    at: number
  ): Promise<string | undefined> {
    if (
      (
        await db.query('SELECT paused FROM accounts WHERE tenant_id=$1 AND id=$2', [
          scope.tenant_id,
          scope.account_id
        ])
      ).rows[0]?.paused
    )
      return 'account_paused'
    const lease = (
      await db.query(
        'SELECT claim_token,lease_until FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2',
        [scope.tenant_id, scope.account_id]
      )
    ).rows[0]
    if (lease && Number(lease.lease_until) > at) return 'learning_background_busy'
    if (lease) {
      await expireLearningLeaseWithin(db, scope, String(lease.claim_token), at)
      await db.query(
        'DELETE FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2',
        [scope.tenant_id, scope.account_id]
      )
    }
    return undefined
  }
  private async scopesWithin(db: PoolClient, scope: Scope): Promise<string[]> {
    const rows = (
      await db.query(
        `SELECT conversation_id FROM learning_memories WHERE tenant_id=$1 AND account_id=$2
       UNION SELECT conversation_id FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2
       UNION SELECT conversation_id FROM learning_settings WHERE tenant_id=$1 AND account_id=$2
       UNION SELECT conversation_id FROM learning_calibration_sets WHERE tenant_id=$1 AND account_id=$2
       UNION SELECT conversation_id FROM learning_curation_state WHERE tenant_id=$1 AND account_id=$2
       ORDER BY conversation_id`,
        [scope.tenant_id, scope.account_id]
      )
    ).rows
    return [...new Set(['', ...rows.map((row) => String(row.conversation_id))])]
  }
  private async basisWithin(db: PoolClient, scope: Scope, conversation: string): Promise<string> {
    const keys = this.keys(scope, conversation)
    const versions = (
      await db.query(
        'SELECT conversation_id,version FROM learning_versions WHERE tenant_id=$1 AND account_id=$2 ORDER BY conversation_id',
        keys.slice(0, 2)
      )
    ).rows
    const rows = (
      await db.query(
        `SELECT m.*,r.payload FROM learning_memories m JOIN learning_revisions r ON
      (m.tenant_id,m.account_id,m.id,m.current_revision)=(r.tenant_id,r.account_id,r.memory_id,r.revision)
      WHERE m.tenant_id=$1 AND m.account_id=$2 AND m.conversation_id=$3 ORDER BY m.id`,
        keys
      )
    ).rows
    const feedback = (
      await db.query(
        'SELECT payload FROM learning_feedback WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 ORDER BY source_id',
        keys
      )
    ).rows
    const state = (
      await db.query(
        'SELECT * FROM learning_curation_state WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
        keys
      )
    ).rows[0]
    return learningHash({
      versions,
      rows,
      feedback,
      state: state ? { observed_at: state.observed_at, last_run_at: state.last_run_at } : null,
      settings: await effectiveLearningSettings(db, scope, conversation),
      foreground: await learningForegroundWithin(db, scope)
    })
  }
  private async applyWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    report: LearningCurationReport,
    at: number,
    signal: AbortSignal
  ): Promise<void> {
    for (const item of report.items) {
      this.cancelled(signal)
      if (item.action !== 'archive' && item.action !== 'stale') continue
      await db.query(
        'UPDATE learning_memories SET state=$5 WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=$4 AND current_revision=$6',
        [
          ...this.keys(scope, conversation),
          item.memoryId,
          item.action === 'archive' ? 'archived' : 'stale',
          item.beforeRevision
        ]
      )
      // A maintenance transition does not count as actual use or reset the inactivity anchor.
      await db.query('INSERT INTO learning_mutations VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
        ...this.keys(scope, conversation),
        randomUUID(),
        item.memoryId,
        item.action === 'archive' ? 'curator_archive' : 'curator_stale',
        item.beforeRevision,
        scope.employee_id,
        at
      ])
    }
    this.cancelled(signal)
    await db.query(
      'UPDATE learning_curation_state SET last_run_at=$4 WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
      [...this.keys(scope, conversation), at]
    )
    await this.recordWithin(db, scope, conversation, report)
    this.cancelled(signal)
  }
  async curate(
    reference: string,
    conversationId: string | null,
    options: { dryRun?: boolean } = {},
    signal: AbortSignal = new AbortController().signal
  ): Promise<LearningCurationReport> {
    const { dryRun } = Options.parse(options)
    this.cancelled(signal)
    let prepared: PreparedCurationMerge | undefined
    const report = await this.locked<LearningCurationReport>(
      reference,
      conversationId,
      async (db, scope, conversation, at) => {
        this.cancelled(signal)
        const report: LearningCurationReport = {
          runId: randomUUID(),
          dryRun,
          status: 'waiting',
          createdAt: at,
          items: []
        }
        const settings = await effectiveLearningSettings(db, scope, conversation)
        if (settings.mode === 'off' || !settings.curationEnabled)
          return { ...report, reason: 'learning_disabled' }
        if (conversation && !(await this.scopesWithin(db, scope)).includes(conversation))
          return { ...report, reason: 'curation_scope_empty' }
        // A preview must not reclaim leases or modify scheduling state.
        const account = [scope.tenant_id, scope.account_id]
        if (dryRun) {
          const lease = (
            await db.query(
              'SELECT lease_until FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2',
              account
            )
          ).rows[0]
          if (lease && Number(lease.lease_until) > at)
            return { ...report, reason: 'learning_background_busy' }
          if (
            (await db.query('SELECT paused FROM accounts WHERE tenant_id=$1 AND id=$2', account))
              .rows[0]?.paused
          )
            return { ...report, reason: 'account_paused' }
        } else {
          const reason = await this.backgroundReason(db, scope, at)
          if (reason) return { ...report, reason }
        }
        const foreground = await learningForegroundWithin(db, scope)
        if (foreground.running) return { ...report, reason: 'curation_idle_required' }
        const state = (
          await db.query(
            'SELECT * FROM learning_curation_state WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
            this.keys(scope, conversation)
          )
        ).rows[0]
        const rows = (
          await db.query(
            `SELECT m.*,r.payload FROM learning_memories m JOIN learning_revisions r ON
         (m.tenant_id,m.account_id,m.id,m.current_revision)=(r.tenant_id,r.account_id,r.memory_id,r.revision)
         WHERE m.tenant_id=$1 AND m.account_id=$2 AND m.conversation_id=$3 ORDER BY m.id`,
            this.keys(scope, conversation)
          )
        ).rows
        if (!state || state.observed_at === null) {
          report.status = 'initialized'
          report.items = rows.map((row) => ({
            memoryId: String(row.id),
            beforeRevision: Number(row.current_revision),
            action: 'keep',
            reason: 'curation_first_observation'
          }))
          if (!dryRun) {
            this.cancelled(signal)
            await db.query(
              `INSERT INTO learning_curation_state(tenant_id,account_id,conversation_id,observed_at,last_run_at) VALUES($1,$2,$3,$4,$4)
             ON CONFLICT(tenant_id,account_id,conversation_id) DO UPDATE SET observed_at=$4,last_run_at=$4 WHERE learning_curation_state.observed_at IS NULL`,
              [...this.keys(scope, conversation), at]
            )
            await this.recordWithin(db, scope, conversation, report)
            this.cancelled(signal)
          }
          return report
        }
        if (at < Number(state.last_run_at ?? state.observed_at) + 7 * 86400000)
          return { ...report, reason: 'curation_interval_required' }
        if (at < Math.max(Number(state.observed_at), foreground.at) + 7200000)
          return { ...report, reason: 'curation_idle_required' }
        const feedback = (
          await db.query(
            'SELECT payload FROM learning_feedback WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
            this.keys(scope, conversation)
          )
        ).rows.map((row) => row.payload as LearningFeedback)
        const methods = rows.map((row) => {
          const revision = row.payload as MemoryRevision
          const memory: MemoryRecord = {
            id: String(row.id),
            scope: enterpriseMemoryScope(scope, conversation || null),
            state: row.state as MemoryRecord['state'],
            currentRevision: Number(row.current_revision),
            activeRevision: row.active_revision === null ? null : Number(row.active_revision),
            pinned: Boolean(row.pinned),
            content: revision.content,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at)
          }
          return { memory, revision }
        })
        report.status = 'completed'
        report.items = planLearningCuration(methods, feedback, at)
        report.basisHash = await this.basisWithin(db, scope, conversation)
        const group = settings.curatorMergeEnabled
          ? selectLearningCurationMerge(methods, report.items, at)
          : []
        if (group.length) {
          const ids = new Set(group.map(({ memory }) => memory.id))
          report.items = report.items.map((item) =>
            ids.has(item.memoryId)
              ? { ...item, action: 'propose_merge', reason: 'curation_same_scenario' }
              : item
          )
          if (dryRun) return report
          if (!this.options.merge)
            return { ...report, status: 'waiting', reason: 'curation_merge_unconfigured' }
          const episodes = (
            await db.query(
              'SELECT payload FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND created_at>$4 ORDER BY id',
              [...this.keys(scope, conversation), at - settings.caseRetentionDays * 86400000]
            )
          ).rows.map((row) => ({
            ...(row.payload as LearningEpisode),
            scope: enterpriseMemoryScope(scope, conversation || null)
          }))
          prepared = {
            report,
            basisHash: report.basisHash,
            fingerprint: this.options.merge.fingerprint(),
            settings,
            methods: group,
            episodes
          }
          this.cancelled(signal)
          return report
        }
        if (!dryRun) await this.applyWithin(db, scope, conversation, report, at, signal)
        return report
      }
    )
    if (!prepared || !this.options.merge) return report
    const plan = prepared,
      merge = this.options.merge
    const current = async (
      db: PoolClient,
      scope: Scope,
      conversation: string,
      run: EnterpriseValidationRun,
      at: number
    ): Promise<void> => {
      this.cancelled(signal)
      if (merge.fingerprint() !== plan.fingerprint) throw new Error('curation_model_changed')
      await merge.budget.assertCurrentWithin(db, scope, run, at)
      if ((await this.basisWithin(db, scope, conversation)) !== plan.basisHash)
        throw new Error('curation_context_changed')
      this.cancelled(signal)
    }
    return new EnterpriseLearningCurationMerge(merge).run(
      reference,
      conversationId,
      plan,
      {
        assertCurrent: (run) =>
          this.locked(reference, conversationId, (db, scope, conversation, at) =>
            current(db, scope, conversation, run, at)
          ),
        commit: (run, proposal, result) =>
          this.locked(reference, conversationId, async (db, scope, conversation, at) => {
            await current(db, scope, conversation, run, at)
            const candidate = await this.repository.proposeCurationWithin(
              db,
              scope,
              conversation,
              proposal,
              plan.methods.map(({ memory }) => ({
                memoryId: memory.id,
                revision: memory.currentRevision
              })),
              at
            )
            result.items = result.items.map((item) =>
              item.action === 'propose_merge' ? { ...item, proposedId: candidate.id } : item
            )
            await this.applyWithin(db, scope, conversation, result, at, signal)
            if (merge.fingerprint() !== plan.fingerprint) throw new Error('curation_model_changed')
          }),
        recordFailure: (run, result) =>
          this.locked(reference, conversationId, async (db, scope, conversation, at) => {
            await current(db, scope, conversation, run, at)
            await this.recordWithin(db, scope, conversation, result)
            this.cancelled(signal)
            if (merge.fingerprint() !== plan.fingerprint) throw new Error('curation_model_changed')
          })
      },
      signal
    )
  }
  private async recordWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    report: LearningCurationReport
  ): Promise<void> {
    await db.query('INSERT INTO learning_curation_reports VALUES($1,$2,$3,$4,$5,$6::jsonb)', [
      ...this.keys(scope, conversation),
      report.runId,
      report.createdAt,
      JSON.stringify(report)
    ])
    await db.query(
      `DELETE FROM learning_curation_reports WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3
      AND id NOT IN(SELECT id FROM learning_curation_reports WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 ORDER BY created_at DESC,id DESC LIMIT 100)`,
      this.keys(scope, conversation)
    )
  }
  reports(reference: string, conversationId: string | null): Promise<LearningCurationReport[]> {
    return this.locked(reference, conversationId, async (db, scope, conversation) =>
      (
        await db.query(
          'SELECT payload FROM learning_curation_reports WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 ORDER BY created_at DESC,id DESC LIMIT 100',
          this.keys(scope, conversation)
        )
      ).rows.map((row) => row.payload as LearningCurationReport)
    )
  }
  async runOnce(
    reference: string,
    signal: AbortSignal = new AbortController().signal
  ): Promise<EnterpriseMaintenanceResult> {
    this.cancelled(signal)
    const scopes = await this.locked(reference, null, (db, scope) => this.scopesWithin(db, scope))
    const result: EnterpriseMaintenanceResult = { curation: [], retention: [], closedEpisodes: [] }
    for (const conversation of scopes) {
      this.cancelled(signal)
      const retention = await this.locked(
        reference,
        conversation || null,
        async (db, scope, boundConversation, at) => {
          this.cancelled(signal)
          if (conversation && !(await this.scopesWithin(db, scope)).includes(conversation))
            return null
          if (await this.backgroundReason(db, scope, at)) return null
          const foreground = await learningForegroundWithin(db, scope)
          const settings = await effectiveLearningSettings(db, scope, boundConversation)
          if (foreground.running || at < foreground.at + settings.idleDelayMs) return null
          const closedEpisodes = await closeIdleEnterpriseEpisodesWithin(
            db,
            scope,
            boundConversation,
            at,
            signal
          )
          const state = (
            await db.query(
              'SELECT last_retention_at FROM learning_curation_state WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
              this.keys(scope, boundConversation)
            )
          ).rows[0]
          if (
            state?.last_retention_at !== null &&
            state?.last_retention_at !== undefined &&
            at < Number(state.last_retention_at) + 3600000
          )
            return { closedEpisodes, retention: null }
          const report = await this.repository.pruneExpiredWithin(db, scope, boundConversation, at)
          const calibration = await db.query(
            'DELETE FROM learning_calibration_sets WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND imported_at<=$4',
            [...this.keys(scope, boundConversation), at - settings.caseRetentionDays * 86400000]
          )
          this.cancelled(signal)
          await db.query(
            `INSERT INTO learning_curation_state(tenant_id,account_id,conversation_id,last_retention_at) VALUES($1,$2,$3,$4)
          ON CONFLICT(tenant_id,account_id,conversation_id) DO UPDATE SET last_retention_at=$4`,
            [...this.keys(scope, boundConversation), at]
          )
          this.cancelled(signal)
          return {
            closedEpisodes,
            retention: {
              ...report,
              conversationId: conversation || null,
              deletedCalibrationSets: calibration.rowCount ?? 0
            }
          }
        }
      )
      if (retention) {
        result.closedEpisodes.push(...retention.closedEpisodes)
        if (retention.retention) result.retention.push(retention.retention)
      }
      const curation = await this.curate(reference, conversation || null, {}, signal)
      if (curation.status !== 'waiting')
        result.curation.push({ ...curation, conversationId: conversation || null })
    }
    return result
  }
}
