import { useRef, useState } from 'react'
import type { WorkbenchLearningInput, WorkbenchRow } from '../../../../shared/contracts/workbench'

type Kind =
  | 'correction'
  | 'adopted'
  | 'resolved'
  | 'failed'
  | 'handoff'
  | 'fact_error'
  | 'repeated_question'
  | 'improper_commitment'
export default function WorkbenchLearning({
  row,
  busy,
  submit
}: {
  row: WorkbenchRow
  busy: boolean
  submit(input: WorkbenchLearningInput): Promise<void>
}): React.JSX.Element | null {
  const [kind, setKind] = useState<Kind>('correction'),
    [text, setText] = useState(row.replyText ?? ''),
    [reason, setReason] = useState('')
  const attempt = useRef<{ content: string; sourceId: string } | undefined>(undefined)
  if (!row.canLearn) return null
  const save = async (): Promise<void> => {
    if (busy || !reason.trim() || (kind === 'correction' && !text.trim())) return
    const content = JSON.stringify({
      taskId: row.taskId,
      replyText: row.replyText,
      kind,
      text: kind === 'correction' ? text.trim() : '',
      reason: reason.trim()
    })
    if (!attempt.current || attempt.current.content !== content)
      attempt.current = { content, sourceId: crypto.randomUUID() }
    const base = { taskId: row.taskId, expectedVersion: row.version },
      sourceId = attempt.current.sourceId
    await submit(
      kind === 'correction'
        ? { ...base, kind, input: { sourceId, text: text.trim(), reason: reason.trim() } }
        : ['resolved', 'failed', 'handoff'].includes(kind)
          ? {
              ...base,
              kind: 'result',
              input: {
                sourceId,
                outcome: kind as 'resolved' | 'failed' | 'handoff',
                reason: reason.trim()
              }
            }
          : {
              ...base,
              kind: 'feedback',
              input: {
                sourceId,
                kind: kind as
                  | 'adopted'
                  | 'fact_error'
                  | 'repeated_question'
                  | 'improper_commitment',
                reason: reason.trim()
              }
            }
    )
  }
  return (
    <details className="enterprise-edit" aria-label="教给助手与处理反馈">
      <summary>教给助手 / 反馈处理结果</summary>
      <p className="form-hint">反馈会用于学习。方法是否生效，可在工作记忆中查看。</p>
      {row.learningPending && (
        <p role="status" className="enterprise-copy">
          反馈已保存在本机，等待同步。连接恢复后会继续提交。
        </p>
      )}
      <label className="form-label" htmlFor={`learning-kind-${row.taskId}`}>
        记录类型
      </label>
      <select
        className="form-input"
        id={`learning-kind-${row.taskId}`}
        value={kind}
        disabled={busy}
        onChange={(event) => setKind(event.target.value as Kind)}
      >
        <option value="correction">纠正当前回复</option>
        <option value="adopted">明确采纳当前回复</option>
        <option value="resolved">确认问题已解决</option>
        <option value="failed">确认问题处理失败</option>
        <option value="handoff">确认已转交人工</option>
        <option value="fact_error">报告事实错误</option>
        <option value="repeated_question">报告重复询问</option>
        <option value="improper_commitment">报告不当承诺</option>
      </select>
      {kind === 'correction' && (
        <>
          <label className="form-label" htmlFor={`learning-text-${row.taskId}`}>
            正确的回复或处理方法
          </label>
          <textarea
            className="form-input enterprise-edit-text"
            id={`learning-text-${row.taskId}`}
            maxLength={10000}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
          />
        </>
      )}
      <label className="form-label" htmlFor={`learning-reason-${row.taskId}`}>
        原因或处理依据
      </label>
      <textarea
        className="form-input"
        id={`learning-reason-${row.taskId}`}
        maxLength={2000}
        value={reason}
        disabled={busy}
        onChange={(event) => setReason(event.target.value)}
        placeholder="说明哪里需要改进，或如何确认处理结果"
      />
      <button
        className="btn btn-secondary"
        disabled={busy || !reason.trim() || (kind === 'correction' && !text.trim())}
        onClick={() => void save()}
      >
        {busy ? '正在保存…' : kind === 'correction' ? '保存纠正并学习' : '保存反馈'}
      </button>
    </details>
  )
}
