import { useCallback, useEffect, useState } from 'react'
import {
  LearningSettingsPatchSchema,
  type LearningSettings,
  type MemoryScope
} from '../../../../shared/contracts/learning-memory'
import {
  LearningModelDirectorySchema,
  type LearningModelDirectory
} from '../../../../shared/contracts/learning-model-directory'
import { useLearningOperation } from './use-learning-operation'

interface SettingsFields {
  reviewModelId: string
  budget: string
  retention: string
  curationEnabled: boolean
  curatorMergeEnabled: boolean
}
function fields(settings: LearningSettings): SettingsFields {
  return {
    reviewModelId: settings.reviewModelId,
    budget: String(settings.dailyReviewTokenBudget),
    retention: String(settings.caseRetentionDays),
    curationEnabled: settings.curationEnabled,
    curatorMergeEnabled: settings.curatorMergeEnabled
  }
}
export default function LearningSettingsPanel({
  scope,
  settings,
  onChanged
}: {
  scope: MemoryScope
  settings: LearningSettings
  onChanged: () => void
}): React.JSX.Element {
  const operation = useLearningOperation(scope)
  const [directory, setDirectory] = useState<LearningModelDirectory>(),
    [editor, setEditor] = useState<{
      value: SettingsFields
      sourceKey: string
      dirty: boolean
    } | null>(null)
  const settingsKey = JSON.stringify(fields(settings))
  const draft =
    editor && (editor.dirty || editor.sourceKey === settingsKey) ? editor.value : fields(settings)
  const { execute } = operation
  const loadModels = useCallback(
    () =>
      execute(
        () => window.learningMemory.modelDirectory({ scope }),
        (value) => setDirectory(LearningModelDirectorySchema.parse(value))
      ),
    [execute, scope]
  )
  useEffect(() => {
    void loadModels()
  }, [loadModels])
  function change(patch: Partial<typeof draft>): void {
    setEditor((current) => ({
      value: {
        ...(current && (current.dirty || current.sourceKey === settingsKey)
          ? current.value
          : fields(settings)),
        ...patch
      },
      sourceKey: settingsKey,
      dirty: true
    }))
  }
  const available =
    !draft.reviewModelId || Boolean(directory?.some((model) => model.id === draft.reviewModelId))
  async function save(): Promise<void> {
    await execute(
      async () => {
        if (!draft.budget.trim() || !draft.retention.trim())
          throw new Error('请填写每日预算和保留天数。')
        const patch = LearningSettingsPatchSchema.parse({
          reviewModelId: draft.reviewModelId,
          dailyReviewTokenBudget: Number(draft.budget),
          caseRetentionDays: Number(draft.retention),
          curationEnabled: draft.curationEnabled,
          curatorMergeEnabled: draft.curatorMergeEnabled
        })
        return window.learningMemory.settings({ scope, patch })
      },
      (value) => {
        setEditor({ value: fields(value), sourceKey: settingsKey, dirty: false })
        onChanged()
      },
      '复盘设置已保存。'
    )
  }
  return (
    <details id="learning-settings" className="learning-settings">
      <summary>复盘模型、预算与保留期</summary>
      <div className="learning-controls">
        <label htmlFor="learning-review-model">
          复盘模型
          <select
            id="learning-review-model"
            className="form-input"
            disabled={operation.busy || directory === undefined}
            value={draft.reviewModelId}
            onChange={(event) => change({ reviewModelId: event.target.value })}
          >
            <option value="">继承主机默认复盘模型</option>
            {!available && (
              <option value={draft.reviewModelId} disabled>
                已不可用：{draft.reviewModelId}
              </option>
            )}
            {directory?.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="learning-daily-budget">
          每日后台 token 上限
          <input
            id="learning-daily-budget"
            className="form-input"
            type="number"
            min={0}
            max={1000000}
            step={1}
            disabled={operation.busy}
            value={draft.budget}
            onChange={(event) => change({ budget: event.target.value })}
          />
        </label>
        <label htmlFor="learning-retention-days">
          案例保留天数
          <input
            id="learning-retention-days"
            className="form-input"
            type="number"
            min={7}
            max={365}
            step={1}
            disabled={operation.busy}
            value={draft.retention}
            onChange={(event) => change({ retention: event.target.value })}
          />
        </label>
      </div>
      <label>
        <input
          type="checkbox"
          disabled={operation.busy}
          checked={draft.curationEnabled}
          onChange={(event) => change({ curationEnabled: event.target.checked })}
        />{' '}
        整理过期方法
      </label>{' '}
      <label>
        <input
          type="checkbox"
          disabled={operation.busy}
          checked={draft.curatorMergeEnabled}
          onChange={(event) => change({ curatorMergeEnabled: event.target.checked })}
        />{' '}
        允许模型提出合并建议
      </label>
      <p className="form-hint">
        复盘、验证和模型整理共享账号预算；设为 0 会停止新的后台模型调用。保留期为 7–365
        天。模型目录由当前主机提供。
      </p>
      {directory?.length === 0 && (
        <p className="form-hint">
          当前没有可单独选择的复盘模型；继承选项使用主机默认配置，未配置时任务会报告不可用。
        </p>
      )}
      {!available && (
        <p role="alert" className="learning-error">
          原复盘模型已不可用，请重新选择后保存。
        </p>
      )}
      {operation.error && (
        <p role="alert" className="learning-error">
          {operation.error}
        </p>
      )}
      {operation.notice && <p role="status">{operation.notice}</p>}
      <div className="learning-controls">
        <button
          className="btn btn-secondary"
          disabled={operation.busy}
          onClick={() => void loadModels()}
        >
          刷新模型目录
        </button>
        <button
          className="btn btn-primary"
          disabled={operation.busy || directory === undefined || !available}
          onClick={() => void save()}
        >
          保存复盘设置
        </button>
      </div>
    </details>
  )
}
