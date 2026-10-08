import { useEffect, useRef, useState } from 'react'
import {
  WorkbenchEvidenceResultSchema,
  type WorkbenchRow
} from '../../../../shared/contracts/workbench'
import type { AssessmentEvidencePage } from '../../../../shared/contracts/assessment-evidence'

function date(value: number): string {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleString('zh-CN', { hour12: false })
    : '日期不可用'
}

/** One full reference at a time; read only, with no model, send, or automatic refresh. */
export default function ReferenceViewer({
  row,
  asOf
}: {
  row: WorkbenchRow
  asOf: number
}): React.JSX.Element {
  const [page, setPage] = useState<AssessmentEvidencePage>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const mounted = useRef(false),
    working = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const load = async (offset: number): Promise<void> => {
    if (!window.agentWorkbench?.evidence || working.current) return
    working.current = true
    setBusy(true)
    setError('')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = WorkbenchEvidenceResultSchema.parse(
        await Promise.race([
          window.agentWorkbench.evidence({
            taskId: row.taskId,
            expectedVersion: row.version,
            offset
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), 6000)
          })
        ])
      )
      if (!mounted.current) return
      if (result.success) setPage(result.page)
      else {
        setPage(undefined)
        setError(
          result.code === 'task_changed'
            ? '任务已有变化，请刷新记录后重新查看。'
            : '暂时无法读取完整资料，请稍后重试。'
        )
      }
    } catch {
      if (mounted.current) {
        setPage(undefined)
        setError('暂时无法读取完整资料，请稍后重试。')
      }
    } finally {
      if (timer) clearTimeout(timer)
      working.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <div className="enterprise-reference-viewer">
      <div className="enterprise-runtime-actions">
        <button
          className="btn btn-secondary"
          disabled={busy || !window.agentWorkbench?.evidence}
          onClick={() => void load(0)}
        >
          {busy ? '正在读取资料…' : page ? '重新查看完整引用' : '查看完整引用资料'}
        </button>
        {page && page.offset > 0 && (
          <button
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void load(page.offset - 1)}
          >
            上一条资料
          </button>
        )}
        {page?.nextOffset !== undefined && (
          <button
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void load(page.nextOffset!)}
          >
            下一条资料
          </button>
        )}
      </div>
      {error && (
        <p className="enterprise-copy" role="alert">
          {error}
        </p>
      )}
      {page && (
        <div className="enterprise-reference-page" aria-live="polite">
          <p className="form-hint">
            {page.totalAvailable
              ? `第 ${page.offset + 1} / ${page.totalAvailable} 条可查看资料`
              : '没有可查看的有效引用资料'}
            。
            {page.unavailableReferences > 0
              ? `有 ${page.unavailableReferences} 条引用不适用于这次评估，未展示内容。`
              : ''}
          </p>
          {page.evidence.map((item) => (
            <div key={item.evidenceId}>
              <p className="enterprise-task-text">
                <span>原引用资料来源</span>
                {item.source}
              </p>
              <div
                className="enterprise-reference-original"
                tabIndex={0}
                aria-label="引用资料完整正文"
              >
                <p className="enterprise-task-text">{item.content}</p>
              </div>
              <p className="form-hint">
                资料标注有效期：
                {date(item.validFrom)} 至 {date(item.expiresAt)}。
                {asOf >= item.expiresAt ? '资料已过期，请重新核实。' : ''}
              </p>
            </div>
          ))}
          <p className="form-hint">
            这里展示原评估引用的知识版本，后续发布可能已更新。完整正文来自已发布的业务资料，不代表当前事实或发送授权。
          </p>
        </div>
      )}
    </div>
  )
}
