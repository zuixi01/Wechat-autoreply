import { useEffect, useState } from 'react'
import type { LearningReports } from '../../../../shared/contracts/learning-management'
import type {
  LearningCurationReport,
  MemoryScope
} from '../../../../shared/contracts/learning-memory'
import { useLearningOperation } from './use-learning-operation'

const curationLabels = {
  initialized: '已初始化',
  waiting: '等待整理条件',
  completed: '已完成',
  failed: '失败'
}
export default function LearningReportsPanel({
  scope,
  onChanged
}: {
  scope: MemoryScope
  onChanged: () => void
}): React.JSX.Element {
  const operation = useLearningOperation(scope),
    [reports, setReports] = useState<LearningReports>(),
    [preview, setPreview] = useState<LearningCurationReport>()
  const { execute } = operation
  useEffect(() => {
    void execute(() => window.learningMemory.reports({ scope }), setReports)
  }, [execute, scope])
  function curate(dryRun: boolean): void {
    void execute(
      () => window.learningMemory.curate({ scope, dryRun }),
      (value) => {
        setPreview(value)
        if (!value.dryRun)
          setReports((previous) => ({
            validation: previous?.validation ?? [],
            curation: [
              value,
              ...(previous?.curation ?? []).filter((item) => item.runId !== value.runId)
            ]
          }))
        onChanged()
      }
    )
  }
  function report(value: LearningCurationReport): React.JSX.Element {
    return (
      <article className="learning-card" key={value.runId}>
        <strong>
          {value.dryRun ? '整理预览' : '整理报告'} · {curationLabels[value.status]}
        </strong>
        {value.reason && <p>{value.reason}</p>}
        <p className="form-hint">
          {new Date(value.createdAt).toLocaleString()} · {value.runId}
        </p>
        {!value.items.length && <p>本次没有待处理的方法。</p>}
        <ul>
          {value.items.map((item) => (
            <li key={item.memoryId}>
              {item.memoryId} V{item.beforeRevision} · {item.action}：{item.reason}
            </li>
          ))}
        </ul>
      </article>
    )
  }
  return (
    <section aria-label="整理与报告">
      <p>预览不修改方法。整理保护人工教导和固定项；归档可以恢复，遗忘会删除资料。</p>
      {operation.error && (
        <p role="alert" className="learning-error">
          {operation.error}
        </p>
      )}
      <div className="learning-actions">
        <button
          className="btn btn-secondary"
          disabled={operation.busy}
          onClick={() => curate(true)}
        >
          预览整理
        </button>
        <button className="btn btn-primary" disabled={operation.busy} onClick={() => curate(false)}>
          执行整理
        </button>
        <button
          className="btn btn-secondary"
          disabled={operation.busy}
          onClick={() => void execute(() => window.learningMemory.reports({ scope }), setReports)}
        >
          刷新报告
        </button>
      </div>
      {preview && report(preview)}
      <h3>验证报告</h3>
      {!reports?.validation.length && <p>此范围还没有验证报告。</p>}
      {reports?.validation.map((value) => (
        <article className="learning-card" key={value.id}>
          <strong>
            {value.memoryId} V{value.revision} ·{' '}
            {
              { passed: '验证通过', failed: '验证失败', insufficient: '证据不足' }[
                value.result.status
              ]
            }
          </strong>
          <p>{new Date(value.createdAt).toLocaleString()}</p>
          <ul>
            {value.result.reasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
        </article>
      ))}
      <h3>历史整理报告</h3>
      {!reports?.curation.length && <p>此范围还没有整理报告。</p>}
      {reports?.curation.filter((value) => value.runId !== preview?.runId).map(report)}
    </section>
  )
}
