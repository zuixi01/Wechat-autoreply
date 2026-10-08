import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { Scope } from '../auth/account-authority'
import {
  LearningCalibrationInputSchema,
  isHumanCalibrationCase,
  LearningValidationEnvironmentSchema,
  type LearningCalibrationInput,
  type LearningCalibrationSet,
  type LearningValidationEnvironment,
  type MemoryActivationGrant,
  type MemoryRecord,
  type MemoryScope,
  type LearningValidationReport,
  type LearningValidationResult
} from '../../../src/shared/contracts/learning-memory'
import type { ValidationSnapshot } from '../../../src/core/memory/learning-validation-store'
import {
  validationDatasetHash,
  type LearningValidationAuthority
} from '../../../src/core/memory/learning-validation'
import { learningHash, memoryScopeKey } from '../../../src/core/memory/learning-scope'
import { EnterpriseLearningRepository, enterpriseMemoryScope } from './learning-repository'
import {
  withLearningAccount,
  effectiveLearningSettings,
  type LearningAccountAuthority
} from './learning-account'

type Proof = { baselineCovered: number; candidateCovered: number; caseIds: string[] }
export type EnterpriseValidationGuard = (db: PoolClient, scope: Scope, at: number) => Promise<void>
const Identifier = z.string().trim().min(1).max(128)
/** Human import is an authenticated operation; only the trusted worker can issue/consume grants. */
export class EnterpriseLearningValidationStore {
  private readonly repository: EnterpriseLearningRepository<LearningAccountAuthority>
  constructor(
    readonly authority: LearningAccountAuthority,
    private readonly options: { now?: () => number; validatorVersion: string }
  ) {
    Identifier.parse(options.validatorVersion)
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
  private keys(scope: Scope, conversation: string): [string, string, string] {
    return [scope.tenant_id, scope.account_id, conversation]
  }
  private async calibrationWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    at: number
  ): Promise<LearningCalibrationSet> {
    const row = (
      await db.query(
        'SELECT payload,imported_at FROM learning_calibration_sets WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
        this.keys(scope, conversation)
      )
    ).rows[0]
    const settings = await effectiveLearningSettings(db, scope, conversation)
    if (!row || Number(row.imported_at) + settings.caseRetentionDays * 86400000 <= at)
      return { cases: [] }
    return row.payload as LearningCalibrationSet
  }
  calibration(reference: string, conversationId: string | null): Promise<LearningCalibrationSet> {
    return this.locked(reference, conversationId, (db, scope, conversation, at) =>
      this.calibrationWithin(db, scope, conversation, at)
    )
  }
  async importCalibration(
    reference: string,
    conversationId: string | null,
    raw: LearningCalibrationInput
  ): Promise<LearningCalibrationSet> {
    const input = LearningCalibrationInputSchema.parse(raw)
    if (input.cases.some((example) => !isHumanCalibrationCase(example)))
      throw new Error('calibration_human_labels_required')
    if (new Set(input.cases.map((entry) => entry.caseId)).size !== input.cases.length)
      throw new Error('calibration_duplicate_case')
    const inputHash = learningHash({
      cases: [...input.cases].sort((a, b) => a.caseId.localeCompare(b.caseId)),
      modeId: input.modeId
    })
    return this.locked(reference, conversationId, async (db, scope, conversation, at) => {
      const previous = (
        await db.query(
          'SELECT input_hash FROM learning_calibration_sets WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
          this.keys(scope, conversation)
        )
      ).rows[0]
      if (previous?.input_hash === inputHash)
        return this.calibrationWithin(db, scope, conversation, at)
      const dataset: LearningCalibrationSet = {
        cases: input.cases,
        ...(input.modeId ? { modeId: input.modeId } : {}),
        authorId: scope.employee_id,
        importedAt: at
      }
      await db.query(
        `INSERT INTO learning_calibration_sets VALUES($1,$2,$3,$4::jsonb,$5,$6)
         ON CONFLICT(tenant_id,account_id,conversation_id) DO UPDATE SET payload=excluded.payload,input_hash=excluded.input_hash,imported_at=excluded.imported_at`,
        [...this.keys(scope, conversation), JSON.stringify(dataset), inputHash, at]
      )
      return dataset
    })
  }
  clearCalibration(reference: string, conversationId: string | null): Promise<void> {
    return this.locked(reference, conversationId, async (db, scope, conversation) => {
      await db.query(
        'DELETE FROM learning_calibration_sets WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
        this.keys(scope, conversation)
      )
    })
  }
  pruneCalibration(reference: string, conversationId: string | null): Promise<void> {
    return this.locked(reference, conversationId, async (db, scope, conversation, at) => {
      const settings = await effectiveLearningSettings(db, scope, conversation)
      await db.query(
        'DELETE FROM learning_calibration_sets WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND imported_at<=$4',
        [...this.keys(scope, conversation), at - settings.caseRetentionDays * 86400000]
      )
    })
  }
  private async environmentWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    at: number
  ): Promise<{ value: LearningValidationEnvironment; epoch: number }> {
    const publication = (
      await db.query(
        'SELECT knowledge_version,policy_version FROM published_configurations WHERE tenant_id=$1 AND account_id=$2',
        [scope.tenant_id, scope.account_id]
      )
    ).rows[0]
    if (!publication) throw new Error('validation_environment_missing')
    const dataset = await this.calibrationWithin(db, scope, conversation, at)
    const value = LearningValidationEnvironmentSchema.parse({
      knowledgeVersion: publication.knowledge_version,
      policyVersion: publication.policy_version,
      validatorVersion: this.options.validatorVersion,
      datasetHash: validationDatasetHash(dataset.cases)
    })
    await db.query(
      `INSERT INTO learning_validation_environments VALUES($1,$2,$3,$4::jsonb,1)
       ON CONFLICT(tenant_id,account_id,conversation_id) DO UPDATE SET payload=excluded.payload,epoch=learning_validation_environments.epoch+1
       WHERE learning_validation_environments.payload IS DISTINCT FROM excluded.payload`,
      [...this.keys(scope, conversation), JSON.stringify(value)]
    )
    const row = (
      await db.query(
        'SELECT epoch FROM learning_validation_environments WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
        this.keys(scope, conversation)
      )
    ).rows[0]
    return { value, epoch: Number(row.epoch) }
  }
  private async captureWithin(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    id: string,
    revision: number,
    at: number
  ): Promise<ValidationSnapshot> {
    const account = (
      await db.query('SELECT paused FROM accounts WHERE tenant_id=$1 AND id=$2', [
        scope.tenant_id,
        scope.account_id
      ])
    ).rows[0]
    if (!account || account.paused) throw new Error('account_paused')
    if ((await effectiveLearningSettings(db, scope, conversation)).mode === 'off')
      throw new Error('learning_disabled')
    const basis = await this.repository.validationCaptureWithin(
      db,
      scope,
      conversation,
      id,
      revision,
      at
    )
    const environment = await this.environmentWithin(db, scope, conversation, at)
    return { ...basis, environment: environment.value, environmentEpoch: environment.epoch }
  }
  private assertSame(current: ValidationSnapshot, snapshot: ValidationSnapshot): void {
    if (
      current.environmentEpoch !== snapshot.environmentEpoch ||
      learningHash(current.environment) !== learningHash(snapshot.environment)
    )
      throw new Error('validation_environment_changed')
    if (
      current.revision.contentHash !== snapshot.revision.contentHash ||
      current.evidenceHash !== snapshot.evidenceHash ||
      current.corpusVersion !== snapshot.corpusVersion ||
      current.memory.state !== snapshot.memory.state ||
      current.memory.activeRevision !== snapshot.memory.activeRevision
    )
      throw new Error('validation_context_changed')
  }
  /** Scope here is a checked descriptor. Every operation reauthorizes the captured reference. */
  bind(
    reference: string,
    conversationId: string | null,
    guard?: EnterpriseValidationGuard
  ): Promise<LearningValidationAuthority & { scope: MemoryScope }> {
    return this.locked(reference, conversationId, async (_db, account, conversation) => {
      const scope = enterpriseMemoryScope(account, conversation || null)
      const assertScope = (requested: MemoryScope): void => {
        if (memoryScopeKey(requested) !== memoryScopeKey(scope))
          throw new Error('learning_scope_mismatch')
      }
      return {
        scope,
        settings: (requested) => {
          assertScope(requested)
          return this.repository.settings(reference, conversationId)
        },
        get: (requested, id) => {
          assertScope(requested)
          return this.repository.get(reference, conversationId, id)
        },
        validation: {
          capture: (requested, id, revision) => {
            assertScope(requested)
            return this.locked(reference, conversationId, async (db, account, conversation, at) => {
              await guard?.(db, account, at)
              return this.captureWithin(db, account, conversation, id, revision, at)
            })
          },
          assertCurrent: (snapshot) => {
            assertScope(snapshot.scope)
            return this.locked(reference, conversationId, async (db, account, conversation, at) => {
              await guard?.(db, account, at)
              this.assertSame(
                await this.captureWithin(
                  db,
                  account,
                  conversation,
                  snapshot.memory.id,
                  snapshot.revision.revision,
                  at
                ),
                snapshot
              )
            })
          },
          setEnvironment: (requested, raw) => {
            assertScope(requested)
            return this.locked(reference, conversationId, async (db, account, conversation, at) => {
              await guard?.(db, account, at)
              const environment = await this.environmentWithin(db, account, conversation, at)
              if (
                learningHash(environment.value) !==
                learningHash(LearningValidationEnvironmentSchema.parse(raw))
              )
                throw new Error('validation_environment_changed')
            })
          },
          issue: (snapshot, proof) => {
            assertScope(snapshot.scope)
            return this.locked(reference, conversationId, async (db, account, conversation, at) => {
              await guard?.(db, account, at)
              const current = await this.captureWithin(
                db,
                account,
                conversation,
                snapshot.memory.id,
                snapshot.revision.revision,
                at
              )
              this.assertSame(current, snapshot)
              const dataset = await this.calibrationWithin(db, account, conversation, at)
              this.assertProof(current, dataset, proof)
              const grant: MemoryActivationGrant = {
                validationPolicyVersion: 'independent-human-origin-v2',
                ...current.environment,
                id: randomUUID(),
                scope,
                memoryId: current.memory.id,
                revision: current.revision.revision,
                contentHash: current.revision.contentHash,
                evidenceHash: current.evidenceHash,
                corpusVersion: current.corpusVersion,
                environmentEpoch: current.environmentEpoch,
                result: 'passed',
                issuedAt: at,
                expiresAt: at + 86400000,
                ...proof,
                usedAt: null
              }
              await db.query(
                'INSERT INTO learning_activation_grants VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,NULL)',
                [
                  ...this.keys(account, conversation),
                  grant.id,
                  grant.memoryId,
                  grant.revision,
                  JSON.stringify(grant)
                ]
              )
              return grant
            })
          }
        }
      }
    })
  }
  private assertProof(
    snapshot: ValidationSnapshot,
    dataset: LearningCalibrationSet,
    proof: Proof
  ): void {
    const selected = dataset.cases.filter((entry) => proof.caseIds.includes(entry.caseId))
    if (
      snapshot.revision.content.kind === 'preference' ||
      selected.length < 5 ||
      selected.some(
        (entry) =>
          !isHumanCalibrationCase(entry) ||
          snapshot.evidenceConversationIds.includes(entry.conversationId) ||
          snapshot.revision.evidence.some((ref) => ref.episodeId === entry.caseId)
      ) ||
      new Set(selected.map((entry) => entry.conversationId)).size < 5 ||
      new Set(proof.caseIds).size !== proof.caseIds.length ||
      selected.length !== proof.caseIds.length ||
      proof.candidateCovered !== selected.length ||
      !Number.isInteger(proof.baselineCovered) ||
      proof.baselineCovered < 0 ||
      proof.baselineCovered > proof.candidateCovered
    )
      throw new Error('validation_proof_invalid')
  }
  grants(
    reference: string,
    conversationId: string | null,
    memoryId: string
  ): Promise<MemoryActivationGrant[]> {
    return this.locked(reference, conversationId, async (db, account, conversation) =>
      (
        await db.query(
          'SELECT payload,used_at FROM learning_activation_grants WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND memory_id=$4 ORDER BY id',
          [...this.keys(account, conversation), Identifier.parse(memoryId)]
        )
      ).rows.map((row) => ({
        ...(row.payload as MemoryActivationGrant),
        usedAt: row.used_at === null ? null : Number(row.used_at)
      }))
    )
  }
  activateValidated(
    reference: string,
    conversationId: string | null,
    memoryId: string,
    revision: number,
    grantId: string,
    guard?: EnterpriseValidationGuard
  ): Promise<MemoryRecord> {
    return this.locked(reference, conversationId, async (db, account, conversation, at) => {
      await guard?.(db, account, at)
      const row = (
        await db.query(
          'SELECT payload,used_at FROM learning_activation_grants WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=$4 FOR UPDATE',
          [...this.keys(account, conversation), z.uuid().parse(grantId)]
        )
      ).rows[0]
      if (!row) throw new Error('validation_grant_missing')
      const grant = row.payload as MemoryActivationGrant
      if (row.used_at !== null) throw new Error('validation_grant_used')
      if (grant.validationPolicyVersion !== 'independent-human-origin-v2')
        throw new Error('validation_proof_invalid')
      if (grant.memoryId !== memoryId || grant.revision !== revision)
        throw new Error('validation_grant_mismatch')
      if (grant.expiresAt <= at) throw new Error('validation_grant_expired')
      if ((await effectiveLearningSettings(db, account, conversation)).mode !== 'auto')
        throw new Error('automatic_activation_disabled')
      const current = await this.captureWithin(db, account, conversation, memoryId, revision, at)
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
      this.assertProof(current, await this.calibrationWithin(db, account, conversation, at), grant)
      const result = await this.repository.activateValidationWithin(
        db,
        account,
        conversation,
        memoryId,
        revision,
        at
      )
      await db.query(
        'UPDATE learning_activation_grants SET used_at=$5 WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=$4',
        [...this.keys(account, conversation), grantId, at]
      )
      return result
    })
  }
  recordReport(
    reference: string,
    conversationId: string | null,
    memoryId: string,
    revision: number,
    result: LearningValidationResult,
    guard?: EnterpriseValidationGuard
  ): Promise<void> {
    return this.locked(reference, conversationId, async (db, account, conversation, at) => {
      await guard?.(db, account, at)
      const report: LearningValidationReport = {
        id: randomUUID(),
        memoryId,
        revision,
        result,
        createdAt: at
      }
      await db.query(
        'INSERT INTO learning_validation_reports VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
        [...this.keys(account, conversation), report.id, memoryId, revision, JSON.stringify(report)]
      )
    })
  }
}
