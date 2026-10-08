import { z } from 'zod'
import {
  MemoryScopeSchema,
  LearningValidationCaseSchema,
  isHumanCalibrationCase,
  type LearningValidationCase,
  type LearningValidationResult,
  type MemoryRevision,
  type LearningRiskSemanticAssessment,
  type MemoryScope,
  type LearningValidationEnvironment
} from '../../shared/contracts/learning-memory'
import type {
  LearningSettings,
  MemoryRecord,
  MemoryActivationGrant
} from '../../shared/contracts/learning-memory'
import type { ValidationSnapshot } from './learning-validation-store'
import { learningHash } from './learning-scope'
import { assessMemoryRisk } from './learning-risk'

const Input = z.strictObject({
  scope: MemoryScopeSchema,
  memoryId: z.string().trim().min(1).max(128),
  revision: z.number().int().positive(),
  cases: z.array(LearningValidationCaseSchema).max(200),
  knowledgeVersion: z.string().trim().min(1).max(128),
  policyVersion: z.string().trim().min(1).max(128)
})
export interface LearningReplayResult {
  text: string
  covered: boolean
  severeErrors: string[]
}
type Awaitable<T> = T | Promise<T>
/** Storage authority may be local synchronous SQLite or an authenticated asynchronous account. */
export interface LearningValidationAuthority {
  settings(scope: MemoryScope): Awaitable<LearningSettings>
  get(scope: MemoryScope, id: string): Awaitable<MemoryRecord>
  validation: {
    capture(scope: MemoryScope, id: string, revision: number): Awaitable<ValidationSnapshot>
    assertCurrent(snapshot: ValidationSnapshot): Awaitable<void>
    setEnvironment(scope: MemoryScope, environment: LearningValidationEnvironment): Awaitable<void>
    issue(
      snapshot: ValidationSnapshot,
      proof: { baselineCovered: number; candidateCovered: number; caseIds: string[] }
    ): Awaitable<MemoryActivationGrant>
  }
}
export interface LearningValidationDependencies {
  replay(
    example: LearningValidationCase,
    candidate: MemoryRevision | null,
    signal: AbortSignal
  ): Promise<LearningReplayResult>
  assessRisk(
    candidate: MemoryRevision,
    signal: AbortSignal
  ): Promise<LearningRiskSemanticAssessment>
  refreshEnvironment?(
    scope: MemoryScope,
    signal: AbortSignal
  ): Promise<LearningValidationEnvironment>
}
export function validationDatasetHash(cases: LearningValidationCase[]): string {
  return learningHash({
    format: 'independent-human-origin-v2',
    cases: cases
      .map((example) => LearningValidationCaseSchema.parse(example))
      .sort((a, b) => a.caseId.localeCompare(b.caseId))
  })
}
const normalize = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{Cf}]/gu, '')
function coverage(example: LearningValidationCase, response: LearningReplayResult): boolean {
  const text = normalize(response.text)
  return (example.requiredTerms ?? [example.expectedMethod]).every((term) =>
    text.includes(normalize(term))
  )
}
function severe(example: LearningValidationCase, response: LearningReplayResult): boolean {
  return (
    response.severeErrors.length > 0 ||
    example.forbiddenClaims.some((claim) => normalize(response.text).includes(normalize(claim)))
  )
}
/** Replay uses temporary context, human expectations and paired baseline; never self-reported coverage. */
export class LearningValidator {
  constructor(
    private readonly store: LearningValidationAuthority,
    private readonly dependencies: LearningValidationDependencies
  ) {}
  async validate(
    raw: z.infer<typeof Input>,
    signal: AbortSignal
  ): Promise<LearningValidationResult> {
    try {
      const input = Input.parse(raw)
      if (signal.aborted) throw new Error('validation_cancelled')
      if ((await this.store.settings(input.scope)).mode === 'off')
        throw new Error('learning_disabled')
      if (
        input.cases.length < 5 ||
        input.cases.some((example) => !isHumanCalibrationCase(example)) ||
        new Set(input.cases.map((example) => example.conversationId)).size < 5 ||
        new Set(input.cases.map((example) => example.caseId)).size !== input.cases.length
      )
        return { status: 'insufficient', reasons: ['independent_human_cases_required'] }
      const snapshot = await this.store.validation.capture(
        input.scope,
        input.memoryId,
        input.revision
      )
      const assertCurrent = async (): Promise<void> => {
        if (signal.aborted) throw new Error('validation_cancelled')
        if (this.dependencies.refreshEnvironment) {
          const environment = await this.dependencies.refreshEnvironment(input.scope, signal)
          await this.store.get(input.scope, input.memoryId)
          if (signal.aborted) throw new Error('validation_cancelled')
          await this.store.validation.setEnvironment(input.scope, environment)
        }
        await this.store.validation.assertCurrent(snapshot)
      }
      if (
        input.cases.some(
          (example) =>
            snapshot.evidenceConversationIds.includes(example.conversationId) ||
            snapshot.revision.evidence.some((ref) => ref.episodeId === example.caseId)
        )
      )
        return { status: 'insufficient', reasons: ['calibration_training_overlap'] }
      if (
        input.knowledgeVersion !== snapshot.environment.knowledgeVersion ||
        input.policyVersion !== snapshot.environment.policyVersion ||
        validationDatasetHash(input.cases) !== snapshot.environment.datasetHash
      )
        throw new Error('validation_environment_changed')
      if (snapshot.revision.content.kind === 'preference')
        return { status: 'insufficient', reasons: ['preference_requires_human'] }
      const risk = assessMemoryRisk(
        snapshot.revision,
        await this.dependencies.assessRisk(structuredClone(snapshot.revision), signal)
      )
      if (signal.aborted) throw new Error('validation_cancelled')
      if (risk.status !== 'passed') return risk
      let baselineCovered = 0,
        candidateCovered = 0
      for (const example of input.cases) {
        await assertCurrent()
        const baseline = await this.dependencies.replay(
          structuredClone(example),
          structuredClone(snapshot.baseline),
          signal
        )
        if (signal.aborted) throw new Error('validation_cancelled')
        await assertCurrent()
        const candidate = await this.dependencies.replay(
          structuredClone(example),
          structuredClone(snapshot.revision),
          signal
        )
        if (signal.aborted) throw new Error('validation_cancelled')
        await assertCurrent()
        if (severe(example, candidate))
          return {
            status: 'failed',
            reasons: ['candidate_severe_error'],
            caseCount: input.cases.length
          }
        if (coverage(example, baseline)) baselineCovered++
        if (coverage(example, candidate)) candidateCovered++
      }
      if (candidateCovered !== input.cases.length || candidateCovered < baselineCovered)
        return {
          status: 'failed',
          reasons: [
            candidateCovered !== input.cases.length
              ? 'candidate_coverage_missing'
              : 'candidate_coverage_regressed'
          ],
          baselineCovered,
          candidateCovered,
          caseCount: input.cases.length
        }
      const grant = await this.store.validation.issue(snapshot, {
        baselineCovered,
        candidateCovered,
        caseIds: input.cases.map((example) => example.caseId)
      })
      return {
        status: 'passed',
        reasons: [],
        grantId: grant.id,
        baselineCovered,
        candidateCovered,
        caseCount: input.cases.length
      }
    } catch (error) {
      const code =
        error instanceof Error && /^[a-z_]{1,100}$/.test(error.message)
          ? error.message
          : 'validation_failed'
      return { status: 'failed', reasons: [code] }
    }
  }
}
