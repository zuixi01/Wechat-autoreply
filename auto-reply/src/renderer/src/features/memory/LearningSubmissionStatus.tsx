import { useEffect, useRef, useState } from 'react'
import type { MemoryScope } from '../../../../shared/contracts/learning-memory'
import type { LearningSubmissionReceipt } from '../../../../shared/contracts/learning-submissions'
import { learningScopeKey } from './learning-view-state'
import { receiptAuthority, retainedConfirmedReceipts } from './learning-receipt-state'
import { LearningSubmissionReadResultSchema } from '../../../../shared/contracts/learning-submission-desktop'

const states = { pending: '待同步', saved: '已保存', forgotten: '已遗忘或过期' }
const kinds = { manual: '教导', correct: '纠正', result: '处理结果', feedback: '质量反馈' }
const errors = {
  network_unavailable: '连接或服务暂时不可用，稍后自动重试',
  permission_revoked: '当前授权已失效',
  source_unavailable: '来源已失效，请重新核对',
  submission_conflict: '提交内容冲突，请核对原提交',
  retention_expired: '资料已超过保留期'
}
export default function LearningSubmissionStatus({
  scope,
  refreshKey
}: {
  scope: MemoryScope
  refreshKey: object
}): React.JSX.Element {
  const [result, setResult] = useState<{ key: string; rows: LearningSubmissionReceipt[]; stale: boolean }>({ key: '', rows: [], stale: false }),
    [error, setError] = useState('')
  const scopeKey = learningScopeKey(scope)
  const confirmed = useRef<{ key: string; authority: string; rows: LearningSubmissionReceipt[] } | undefined>(undefined)
  const rows = result.key === scopeKey ? result.rows : []
  useEffect(() => {
    let current = true
    if (confirmed.current?.key !== scopeKey) confirmed.current = undefined
    const authority = async (): Promise<string | undefined> => receiptAuthority(scope,
      scope.tenantId || scope.accountId || scope.workspaceId.startsWith('enterprise:')
        ? await window.agentDesktop.status() : undefined)
    void (async () => {
      let before: string | undefined
      try {
        before = await authority()
        if (!before) throw new Error('learning_scope_unavailable')
        const value = LearningSubmissionReadResultSchema.parse(await window.learningSubmissions.readSubmissions({ scope }))
        const after = await authority()
        if (!after || after !== before) throw new Error('learning_scope_changed')
        if (current) {
          if (value.status === 'available') {
            confirmed.current = { key: scopeKey, authority: after, rows: value.receipts }
            setResult({ key: scopeKey, rows: value.receipts, stale: false })
            setError('')
          } else {
            const old = confirmed.current
            const kept = retainedConfirmedReceipts(old?.rows ?? [], old?.key === scopeKey ? old.authority : undefined, after, value)
            confirmed.current = kept.length ? { key: scopeKey, authority: after, rows: kept } : undefined
            setResult({ key: scopeKey, rows: kept, stale: kept.length > 0 })
            setError('提交状态暂时不可读取，请检查连接和当前授权。')
          }
        }
      } catch {
        if (current) {
          confirmed.current = undefined
          setResult({ key: scopeKey, rows: [], stale: false })
          setError('提交状态暂时不可读取，请检查连接和当前授权。')
        }
      }
    })()
    return () => {
      current = false
    }
    // Canonical scope is stable across snapshot polls; cleanup rejects late responses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, refreshKey])
  return (
    <details aria-label="学习提交状态" className="learning-submissions">
      <summary>
        学习提交状态{rows.some((row) => row.state === 'pending') ? ' · 有待同步项' : ''}
      </summary>
      <p className="form-hint">
        已提交的教导、纠正和反馈保存在本机，恢复连接后自动同步；重启应用后继续处理。
      </p>
      {error && (
        <p role="alert" className="learning-error">
          {error}
        </p>
      )}
      {result.key === scopeKey && result.stale && <p role="status">上次已确认，本次状态未刷新；以下仅显示已确认保存的记录。</p>}
      {!error && !rows.length && <p>当前范围没有提交记录。</p>}
      <ul>
        {rows.map((row) => (
          <li key={row.sourceId}>
            {kinds[row.kind]} · {states[row.state]} · {row.sourceId.slice(-8)}
            {row.errorCode ? ` · ${errors[row.errorCode]}` : ''}
          </li>
        ))}
      </ul>
    </details>
  )
}
