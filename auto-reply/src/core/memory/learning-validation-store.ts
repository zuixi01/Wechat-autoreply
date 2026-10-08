import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DatabaseSync } from 'node:sqlite'
import {
  LearningValidationEnvironmentSchema,
  LearningCalibrationInputSchema,
  isHumanCalibrationCase,
  MemoryScopeSchema,
  type LearningCalibrationInput,
  type LearningCalibrationSet,
  type MemoryScope,
  type MemoryRecord,
  type MemoryRevision,
  type MemoryActivationGrant,
  type LearningValidationEnvironment,
  type LearningValidationResult,
  type LearningValidationReport
} from '../../shared/contracts/learning-memory'
import type { LearningStore } from './learning-store'
import { learningHash, memoryScopeKey } from './learning-scope'
import { validationDatasetHash } from './learning-validation'

type Transaction = <T>(work: () => T) => T
export interface ValidationSnapshot {
  scope: MemoryScope
  memory: MemoryRecord
  revision: MemoryRevision
  baseline: MemoryRevision | null
  /** Enterprise merge replay compares the complete old group against its replacement. */
  replacements?: MemoryRevision[]
  environment: LearningValidationEnvironment
  environmentEpoch: number
  corpusVersion: string
  evidenceHash: string
  evidenceConversationIds: string[]
}
/** Only the trusted validator calls issue(); no renderer grant creation endpoint exists. */
export class LearningValidationStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: Transaction,
    private readonly store: LearningStore,
    private readonly now: () => number
  ) {}
  calibration(scope: MemoryScope): LearningCalibrationSet {
    const row = this.db
      .prepare('SELECT payload,imported_at FROM learning_calibration_sets WHERE scope_key=?')
      .get(memoryScopeKey(scope))
    if (
      !row ||
      Number(row.imported_at) + this.store.settings(scope).caseRetentionDays * 86400000 <=
        this.now()
    )
      return { cases: [] }
    return JSON.parse(String(row.payload)) as LearningCalibrationSet
  }
  importCalibration(
    scope: MemoryScope,
    raw: LearningCalibrationInput,
    authorId: string
  ): LearningCalibrationSet {
    const input = LearningCalibrationInputSchema.parse(raw)
    z.string().trim().min(1).max(128).parse(authorId)
    if (input.cases.some((example) => !isHumanCalibrationCase(example)))
      throw new Error('calibration_human_labels_required')
    if (new Set(input.cases.map((example) => example.caseId)).size !== input.cases.length)
      throw new Error('calibration_duplicate_case')
    const key = memoryScopeKey(scope),
      inputHash = learningHash({
        cases: [...input.cases].sort((a, b) => a.caseId.localeCompare(b.caseId)),
        modeId: input.modeId
      })
    return this.transaction(() => {
      const previous = this.db
        .prepare('SELECT input_hash FROM learning_calibration_sets WHERE scope_key=?')
        .get(key)
      if (previous?.input_hash === inputHash) return this.calibration(scope)
      const dataset: LearningCalibrationSet = {
        cases: input.cases,
        modeId: input.modeId,
        authorId,
        importedAt: this.now()
      }
      this.db
        .prepare(
          `INSERT INTO learning_calibration_sets VALUES(?,?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET
        payload=excluded.payload,input_hash=excluded.input_hash,imported_at=excluded.imported_at`
        )
        .run(
          key,
          JSON.stringify(MemoryScopeSchema.parse(scope)),
          JSON.stringify(dataset),
          inputHash,
          this.now()
        )
      this.refreshDatasetBinding(scope, validationDatasetHash(input.cases), true)
      return dataset
    })
  }
  private refreshDatasetBinding(scope: MemoryScope, datasetHash: string, forceEpoch = false): void {
    const key = memoryScopeKey(scope),
      row = this.db
        .prepare('SELECT payload FROM learning_validation_environment WHERE scope_key=?')
        .get(key)
    if (!row) return
    const environment = LearningValidationEnvironmentSchema.parse(JSON.parse(String(row.payload)))
    if (forceEpoch || environment.datasetHash !== datasetHash)
      this.db
        .prepare(
          'UPDATE learning_validation_environment SET payload=?,epoch=epoch+1 WHERE scope_key=?'
        )
        .run(JSON.stringify({ ...environment, datasetHash }), key)
  }
  clearCalibration(scope: MemoryScope): void {
    this.transaction(() => {
      this.db
        .prepare('DELETE FROM learning_calibration_sets WHERE scope_key=?')
        .run(memoryScopeKey(scope))
      this.refreshDatasetBinding(scope, validationDatasetHash([]))
    })
  }
  pruneCalibration(at: number): void {
    for (const row of this.db
      .prepare('SELECT scope_json,imported_at FROM learning_calibration_sets')
      .all()) {
      const scope = MemoryScopeSchema.parse(JSON.parse(String(row.scope_json)))
      if (Number(row.imported_at) + this.store.settings(scope).caseRetentionDays * 86400000 <= at)
        this.clearCalibration(scope)
    }
  }
  setEnvironment(scope: MemoryScope, raw: LearningValidationEnvironment): void {
    const environment = LearningValidationEnvironmentSchema.parse(raw),
      key = memoryScopeKey(scope)
    this.transaction(() =>
      this.db
        .prepare(
          `INSERT INTO learning_validation_environment VALUES(?,?,1)
      ON CONFLICT(scope_key) DO UPDATE SET payload=excluded.payload,epoch=epoch+1 WHERE payload!=excluded.payload`
        )
        .run(key, JSON.stringify(environment))
    )
  }
  private environment(scope: MemoryScope): { value: LearningValidationEnvironment; epoch: number } {
    const row = this.db
      .prepare('SELECT * FROM learning_validation_environment WHERE scope_key=?')
      .get(memoryScopeKey(scope))
    if (!row) throw new Error('validation_environment_missing')
    return {
      value: LearningValidationEnvironmentSchema.parse(JSON.parse(String(row.payload))),
      epoch: Number(row.epoch)
    }
  }
  environmentStamp(scope: MemoryScope): string {
    return learningHash(this.environment(scope))
  }
  capture(scope: MemoryScope, id: string, revision: number): ValidationSnapshot {
    const memory = this.store.get(scope, id)
    if (memory.currentRevision !== revision) throw new Error('memory_revision_conflict')
    if (memory.state === 'archived') throw new Error('memory_archived')
    if (memory.pinned) throw new Error('memory_pinned')
    const history = this.store.history(scope, id),
      candidate = history.find((entry) => entry.revision === revision)
    if (!candidate) throw new Error('memory_revision_not_found')
    this.assertNotQuarantined(scope, id, revision)
    if (candidate.expiresAt !== undefined && candidate.expiresAt <= this.now())
      throw new Error('memory_expired')
    const evidence = candidate.evidence.map((ref) => this.store.episode(scope, ref.episodeId))
    const environment = this.environment(scope)
    return {
      scope,
      memory,
      revision: candidate,
      baseline:
        memory.state === 'active' && memory.activeRevision !== null
          ? (history.find((entry) => entry.revision === memory.activeRevision) ?? null)
          : null,
      environment: environment.value,
      environmentEpoch: environment.epoch,
      corpusVersion: this.store.corpusVersion(scope),
      evidenceHash: learningHash(evidence),
      evidenceConversationIds: [
        ...new Set(
          evidence.flatMap((episode) =>
            episode.scope.conversationId ? [episode.scope.conversationId] : []
          )
        )
      ]
    }
  }
  assertCurrent(snapshot: ValidationSnapshot): void {
    const current = this.capture(snapshot.scope, snapshot.memory.id, snapshot.revision.revision)
    if (
      current.environmentEpoch !== snapshot.environmentEpoch ||
      learningHash(current.environment) !== learningHash(snapshot.environment)
    )
      throw new Error('validation_environment_changed')
    if (
      current.revision.contentHash !== snapshot.revision.contentHash ||
      current.evidenceHash !== snapshot.evidenceHash ||
      current.corpusVersion !== snapshot.corpusVersion ||
      current.memory.state !== snapshot.memory.state
    )
      throw new Error('validation_context_changed')
  }
  issue(
    snapshot: ValidationSnapshot,
    proof: { baselineCovered: number; candidateCovered: number; caseIds: string[] }
  ): MemoryActivationGrant {
    return this.transaction(() => {
      this.assertCurrent(snapshot)
      if (this.store.settings(snapshot.scope).mode === 'off') throw new Error('learning_disabled')
      if (
        proof.caseIds.length < 5 ||
        new Set(proof.caseIds).size !== proof.caseIds.length ||
        proof.candidateCovered !== proof.caseIds.length ||
        proof.baselineCovered > proof.candidateCovered
      )
        throw new Error('validation_proof_invalid')
      const grant: MemoryActivationGrant = {
        ...snapshot.environment,
        validationPolicyVersion: 'independent-human-origin-v2',
        id: randomUUID(),
        scope: snapshot.scope,
        memoryId: snapshot.memory.id,
        revision: snapshot.revision.revision,
        contentHash: snapshot.revision.contentHash,
        evidenceHash: snapshot.evidenceHash,
        corpusVersion: snapshot.corpusVersion,
        environmentEpoch: snapshot.environmentEpoch,
        result: 'passed',
        issuedAt: this.now(),
        expiresAt: this.now() + 86400000,
        ...proof,
        usedAt: null
      }
      this.db
        .prepare('INSERT INTO learning_activation_grants VALUES(?,?,?,?)')
        .run(grant.id, memoryScopeKey(snapshot.scope), snapshot.memory.id, JSON.stringify(grant))
      return grant
    })
  }
  grant(scope: MemoryScope, id: string): MemoryActivationGrant {
    const row = this.db
      .prepare('SELECT payload FROM learning_activation_grants WHERE scope_key=? AND id=?')
      .get(memoryScopeKey(scope), id)
    if (!row) throw new Error('validation_grant_missing')
    return JSON.parse(String(row.payload)) as MemoryActivationGrant
  }
  activate(scope: MemoryScope, id: string, revision: number, grantId: string): MemoryRecord {
    return this.transaction(() => {
      const grant = this.grant(scope, grantId)
      if (this.store.settings(scope).mode !== 'auto')
        throw new Error('automatic_activation_disabled')
      if (grant.expiresAt <= this.now()) throw new Error('validation_grant_expired')
      if (grant.memoryId !== id || grant.revision !== revision)
        throw new Error('validation_grant_mismatch')
      if (grant.usedAt !== null) throw new Error('validation_grant_used')
      if (grant.validationPolicyVersion !== 'independent-human-origin-v2')
        throw new Error('validation_proof_invalid')
      const current = this.capture(scope, id, revision)
      if (
        current.environmentEpoch !== grant.environmentEpoch ||
        learningHash(current.environment) !==
          learningHash({
            knowledgeVersion: grant.knowledgeVersion,
            policyVersion: grant.policyVersion,
            validatorVersion: grant.validatorVersion,
            datasetHash: grant.datasetHash
          })
      )
        throw new Error('validation_environment_changed')
      if (
        current.revision.contentHash !== grant.contentHash ||
        current.evidenceHash !== grant.evidenceHash ||
        current.corpusVersion !== grant.corpusVersion
      )
        throw new Error('validation_context_changed')
      const result = this.store.activate(scope, id, revision)
      grant.usedAt = this.now()
      this.db
        .prepare('UPDATE learning_activation_grants SET payload=? WHERE id=?')
        .run(JSON.stringify(grant), grantId)
      return result
    })
  }
  assertNotQuarantined(scope: MemoryScope, id: string, revision: number): void {
    if (
      this.db
        .prepare(
          'SELECT 1 FROM learning_revision_quarantines WHERE scope_key=? AND memory_id=? AND revision=?'
        )
        .get(memoryScopeKey(scope), id, revision)
    )
      throw new Error('memory_revision_quarantined')
  }
  recordReport(
    scope: MemoryScope,
    id: string,
    revision: number,
    result: LearningValidationResult
  ): void {
    const memory = this.store.get(scope, id)
    if (memory.currentRevision !== revision) return
    const report: LearningValidationReport = {
      id: randomUUID(),
      memoryId: id,
      revision,
      result,
      createdAt: this.now()
    }
    this.db
      .prepare('INSERT INTO learning_validation_reports VALUES(?,?,?,?,?)')
      .run(report.id, memoryScopeKey(scope), id, revision, JSON.stringify(report))
  }
  reports(scope: MemoryScope, id: string): LearningValidationReport[] {
    this.store.get(scope, id)
    return this.db
      .prepare(
        'SELECT payload FROM learning_validation_reports WHERE scope_key=? AND memory_id=? ORDER BY rowid DESC LIMIT 100'
      )
      .all(memoryScopeKey(scope), id)
      .map((row) => JSON.parse(String(row.payload)) as LearningValidationReport)
  }
  reportsForScope(scope: MemoryScope): LearningValidationReport[] {
    return this.db
      .prepare(
        'SELECT payload FROM learning_validation_reports WHERE scope_key=? ORDER BY rowid DESC LIMIT 100'
      )
      .all(memoryScopeKey(scope))
      .map((row) => JSON.parse(String(row.payload)) as LearningValidationReport)
  }
}
