import { useRef, useState } from 'react'
import type { MemoryScope } from '../../../../shared/contracts/learning-memory'
import { useLearningOperation } from './use-learning-operation'

export default function LearningCorrection({
  scope,
  episodeId,
  draft,
  onSaved
}: {
  scope: MemoryScope
  episodeId: string
  draft: string
  onSaved?: () => void
}): React.JSX.Element {
  const [text, setText] = useState(draft),
    [reason, setReason] = useState('')
  const operation = useLearningOperation(scope)
  const intent = useRef<{ key: string; sourceId: string } | undefined>(undefined)
  async function submit(): Promise<void> {
    if (operation.busy || !text.trim() || !reason.trim()) return
    const input = { scope, episodeId, text: text.trim(), reason: reason.trim() }
    const key = JSON.stringify(input)
    if (intent.current?.key !== key) intent.current = { key, sourceId: crypto.randomUUID() }
    const sourceId = intent.current.sourceId
    await operation.execute(
      () => window.learningSubmissions.submit({ kind: 'correct', input: { ...input, sourceId } }),
      (receipt) => {
        if (receipt.state === 'saved' && intent.current?.sourceId === sourceId)
          intent.current = undefined
        onSaved?.()
      },
      (receipt) =>
        receipt.state === 'saved'
          ? '纠正已保存；开启学习时将自动后台复盘。'
          : receipt.state === 'pending'
            ? '纠正已保存在本机，等待同步；恢复连接后自动重试。'
            : '纠正已过期或被遗忘，不会继续同步。'
    )
  }
  return (
    <details className="learning-correction">
      <summary>纠正回复，让助手学习</summary>
      <label className="form-label">
        正确的回复
        <textarea
          className="form-input"
          value={text}
          maxLength={10000}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <label className="form-label">
        为什么这样改
        <textarea
          className="form-input"
          value={reason}
          maxLength={2000}
          placeholder="例如：报价前还没有确认型号和数量"
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <button
        className="btn btn-primary"
        disabled={operation.busy || !text.trim() || !reason.trim()}
        onClick={() => void submit()}
      >
        {operation.busy ? '保存中…' : '保存纠正并学习'}
      </button>
      {operation.notice && <p role="status">{operation.notice}</p>}
      {operation.error && (
        <p role="alert" className="learning-error">
          {operation.error}
        </p>
      )}
    </details>
  )
}
