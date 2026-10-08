import { afterEach, describe, expect, it } from 'vitest'
import { LearningStore } from '../../src/core/memory/learning-store'
import type { LearningValidationCase } from '../../src/shared/contracts/learning-memory'

const scope = { workspaceId: 'profile', platform: 'generic' as const, conversationId: 'customer' }
const stores: LearningStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
const cases: LearningValidationCase[] = [
  {
    caseId: 'human-case',
    conversationId: 'calibration-conversation',
    input: '脱敏客户问题',
    expectedMethod: '先核对型号数量',
    requiredTerms: ['型号', '数量'],
    forbiddenClaims: ['无据承诺'],
    humanLabelled: true,
    labelOrigin: 'human' as const // Simulated human declaration for engineering tests only.
  }
]
function setup() {
  let now = 1000
  const store = new LearningStore(':memory:', () => now)
  stores.push(store)
  return {
    store,
    advance: (value: number) => {
      now += value
    }
  }
}
describe('explicit human calibration sources', () => {
  it('refuses synthetic, model and unclaimed label origins even when human flags are asserted', () => {
    const { store } = setup()
    for (const labelOrigin of ['synthetic', 'model', undefined] as const) {
      expect(() =>
        store.validation.importCalibration(
          scope,
          {
            cases: cases.map((entry) => ({ ...entry, humanLabelled: true, labelOrigin })),
            humanConfirmed: true
          },
          'employee'
        )
      ).toThrow('calibration_human_labels_required')
      expect(store.validation.calibration(scope).cases).toEqual([])
    }
  })
  it('starts empty, imports only explicitly confirmed human labels and keeps exact scope', () => {
    const { store } = setup()
    expect(store.validation.calibration(scope).cases).toEqual([])
    store.validation.importCalibration(
      scope,
      { cases, humanConfirmed: true, modeId: 'mode' },
      'local-employee'
    )
    expect(store.validation.calibration(scope)).toMatchObject({
      cases,
      modeId: 'mode',
      authorId: 'local-employee',
      importedAt: 1000
    })
    expect(store.validation.calibration({ ...scope, conversationId: 'other' }).cases).toEqual([])
    expect(() =>
      store.validation.importCalibration(
        scope,
        { cases: cases.map((item) => ({ ...item, humanLabelled: false })), humanConfirmed: true },
        'local-employee'
      )
    ).toThrow('calibration_human_labels_required')
  })
  it('does not reset the retention clock by importing the same body repeatedly', () => {
    const { store, advance } = setup()
    store.validation.importCalibration(scope, { cases, humanConfirmed: true }, 'employee')
    advance(89 * 86400000)
    store.validation.importCalibration(scope, { cases, humanConfirmed: true }, 'employee')
    expect(store.validation.calibration(scope).importedAt).toBe(1000)
    advance(2 * 86400000)
    expect(store.validation.calibration(scope).cases).toEqual([])
    store.pruneExpiredEpisodes(91 * 86400000 + 1000)
    expect(store.validation.calibration(scope).importedAt).toBeUndefined()
  })
  it('scope forgetting removes labelled bodies and expires the old environment binding', () => {
    const { store } = setup()
    store.validation.importCalibration(scope, { cases, humanConfirmed: true }, 'employee')
    store.forgetScope(scope)
    expect(store.validation.calibration(scope)).toMatchObject({ cases: [] })
  })
})
