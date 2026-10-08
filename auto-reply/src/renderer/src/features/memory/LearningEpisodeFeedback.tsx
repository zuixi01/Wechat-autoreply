import { useRef, useState } from 'react'
import type {
  LearningHumanFeedbackInput,
  LearningResultInput,
  MemoryScope
} from '../../../../shared/contracts/learning-memory'
import { useLearningOperation } from './use-learning-operation'

export default function LearningEpisodeFeedback({
  scope,
  episodeId,
  onSaved
}: {
  scope: MemoryScope
  episodeId: string
  onSaved: () => void
}): React.JSX.Element {
  const operation = useLearningOperation(scope)
  const [outcome, setOutcome] = useState<LearningResultInput['outcome'] | ''>(''),
    [kind, setKind] = useState<LearningHumanFeedbackInput['kind']>('adopted'),
    [reason, setReason] = useState('')
  const intent = useRef<{ key: string; sourceId: string } | undefined>(undefined)
  function sourceId(key: string): string {
    if (intent.current?.key !== key) intent.current = { key, sourceId: crypto.randomUUID() }
    return intent.current.sourceId
  }
  function save(type: 'result' | 'feedback'): void {
    const input = { scope, episodeId, reason: reason.trim() }
    const key = JSON.stringify({ ...input, type, choice: type === 'result' ? outcome : kind })
    const source = sourceId(key)
    void operation.execute(
      async () => {
        if (type === 'result' && outcome)
          return window.learningSubmissions.submit({
            kind: 'result',
            input: { ...input, sourceId: source, outcome }
          })
        else if (type === 'feedback')
          return window.learningSubmissions.submit({
            kind: 'feedback',
            input: { ...input, sourceId: source, kind }
          })
        else throw new Error('请选择明确的处理结果。')
      },
      (receipt) => {
        if (receipt.state === 'saved') intent.current = undefined
        onSaved()
      },
      (receipt) =>
        receipt.state === 'pending'
          ? '反馈已保存在本机，等待同步；恢复连接后自动重试。'
          : receipt.state === 'forgotten'
            ? '反馈已过期或被遗忘，不会继续同步。'
            : type === 'result'
              ? '处理结果已保存。'
              : '反馈已保存。'
    )
  }
  return (
    <details className="learning-feedback">
      <summary>确认结果或记录质量反馈</summary>
      <label className="form-label">
        说明
        <textarea
          className="form-input"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={2000}
        />
      </label>
      <div className="learning-controls">
        <label>
          处理结果
          <select
            className="form-input"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value as typeof outcome)}
          >
            <option value="">结果未确认</option>
            <option value="resolved">已解决</option>
            <option value="failed">未解决</option>
            <option value="handoff">转交人工</option>
          </select>
        </label>
        <button
          className="btn btn-secondary"
          disabled={operation.busy || !outcome || !reason.trim()}
          onClick={() => save('result')}
        >
          记录处理结果
        </button>
        <label>
          反馈类型
          <select
            className="form-input"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="adopted">员工明确采纳</option>
            <option value="fact_error">事实错误</option>
            <option value="repeated_question">重复问询</option>
            <option value="improper_commitment">不当承诺</option>
          </select>
        </label>
        <button
          className="btn btn-secondary"
          disabled={operation.busy || !reason.trim()}
          onClick={() => save('feedback')}
        >
          记录质量反馈
        </button>
      </div>
      {operation.notice && <p role="status">{operation.notice}</p>}
      {operation.error && (
        <p role="alert" className="learning-error">
          {operation.error}
        </p>
      )}
    </details>
  )
}
