import { useEffect, useState } from 'react'
import {
  LearningCalibrationInputSchema,
  type LearningCalibrationSet,
  type LearningValidationResult,
  type MemoryRecord,
  type MemoryScope
} from '../../../../shared/contracts/learning-memory'
import { useLearningOperation } from './use-learning-operation'

const resultLabels = { passed: '验证通过', failed: '验证失败', insufficient: '证据不足' }
export default function LearningValidationPanel({
  scope,
  memories,
  onChanged
}: {
  scope: MemoryScope
  memories: MemoryRecord[]
  onChanged: () => void
}): React.JSX.Element {
  const operation = useLearningOperation(scope)
  const [calibration, setCalibration] = useState<LearningCalibrationSet>(),
    [source, setSource] = useState(''),
    [confirmed, setConfirmed] = useState(false)
  const [result, setResult] = useState<{
    id: string
    revision: number
    value: LearningValidationResult
  }>()
  const { execute } = operation
  useEffect(() => {
    void execute(
      () => window.learningMemory.calibration({ scope }),
      (value) => {
        setCalibration(value)
        setSource(
          JSON.stringify(
            { cases: value.cases, ...(value.modeId ? { modeId: value.modeId } : {}) },
            null,
            2
          )
        )
      }
    )
  }, [execute, scope])
  return (
    <section aria-label="校准与验证">
      <p>
        使用独立人工标注的案例检查候选方法。来源重叠、未标注或数量不足时保留为候选；验证不代表企业正式发布。
      </p>
      {operation.error && (
        <p role="alert" className="learning-error">
          {operation.error}
        </p>
      )}
      {operation.notice && <p role="status">{operation.notice}</p>}
      <article className="learning-card">
        <h3>校准资料</h3>
        <p>
          已保存 {calibration?.cases.length ?? 0} 条
          {calibration?.importedAt ? ` · ${new Date(calibration.importedAt).toLocaleString()}` : ''}
        </p>
        <label className="form-label" htmlFor="learning-calibration-json">
          校准案例 JSON
        </label>
        <textarea
          id="learning-calibration-json"
          disabled={operation.busy || calibration === undefined}
          className="form-input"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          maxLength={2 * 1024 * 1024}
          spellCheck={false}
        />
        <p className="form-hint">
          格式为 cases 数组，可带 modeId。每条包含
          caseId、conversationId、input、expectedMethod、forbiddenClaims、humanLabelled 和
          labelOrigin。 labelOrigin 须为
          human；synthetic（模拟）、model（模型标注）及未声明来源不能用于自动生效。导入最多 200
          条；自动生效至少需要 5 个独立会话的有效人工案例。
        </p>
        <label>
          <input
            id="learning-calibration-confirmed"
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />{' '}
          我已核对资料来源和人工标注情况
        </label>
        <div className="learning-actions">
          <button
            className="btn btn-primary"
            disabled={operation.busy || !confirmed || !source.trim()}
            onClick={() =>
              void execute(
                async () => {
                  const input = LearningCalibrationInputSchema.parse({
                    ...JSON.parse(source),
                    humanConfirmed: true
                  })
                  return window.learningMemory.importCalibration({ scope, input })
                },
                (value) => {
                  setCalibration(value)
                  setConfirmed(false)
                  onChanged()
                },
                '校准资料已保存。'
              )
            }
          >
            导入校准资料
          </button>
        </div>
      </article>
      {!memories.length && <p>此范围还没有候选方法。</p>}
      {memories.map((memory) => (
        <article className="learning-card" key={memory.id}>
          <strong>{memory.content.scenario}</strong>
          <p>
            最新 V{memory.currentRevision} · 生效{' '}
            {memory.activeRevision ? `V${memory.activeRevision}` : '无'}
          </p>
          <button
            className="btn btn-secondary"
            disabled={operation.busy || memory.state === 'archived'}
            onClick={() =>
              void execute(
                () =>
                  window.learningMemory.validate({
                    scope,
                    id: memory.id,
                    expectedRevision: memory.currentRevision
                  }),
                (value) => {
                  setResult({ id: memory.id, revision: memory.currentRevision, value })
                  onChanged()
                }
              )
            }
          >
            验证 V{memory.currentRevision}
          </button>
          {result?.id === memory.id && (
            <div role="status">
              <p>
                V{result.revision}：{resultLabels[result.value.status]}
                {result.value.activated ? ' · 已验证生效' : ''}
              </p>
              <ul>
                {result.value.reasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
        </article>
      ))}
    </section>
  )
}
