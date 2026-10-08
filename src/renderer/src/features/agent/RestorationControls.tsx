import { useEffect, useRef, useState } from 'react'
import { RestorationInventorySubmitResultSchema } from '../../../../shared/contracts/restore-inventory'
import {
  RestorationStatusSchema,
  RestorationSubmitResultSchema,
  RestorationApplyResultSchema,
  type RestorationStatus,
  type RestorationSubmitResult
} from '../../../../shared/contracts/restoration'

const failures: Record<Extract<RestorationSubmitResult, { success: false }>['code'], string> = {
  invalid_input: '暂时无法提交，请重新打开客户端后重试。',
  unavailable: '尚未提交，请确认管理员已建立恢复核对单，并检查企业连接后重试。',
  execution_pending: '暂停尚未确认，请稍后重试。',
  device_changed: '企业连接已变化，请重新确认连接后提交。',
  local_storage_unavailable: '本地恢复记录无法读取或保存，请联系管理员。'
}
async function bounded<T>(request: Promise<T>, waitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('restoration_result_unconfirmed')), waitMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export default function RestorationControls({
  registered
}: {
  registered: boolean
}): React.JSX.Element | null {
  const [status, setStatus] = useState<RestorationStatus>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const active = useRef(false)
  const pending = useRef(false)
  const version = useRef(0)

  useEffect(() => {
    active.current = true
    let polling = false
    const refresh = async (): Promise<void> => {
      if (!window.agentRestoration || polling || pending.current) return
      polling = true
      const request = ++version.current
      try {
        const value = RestorationStatusSchema.parse(
          await bounded(window.agentRestoration.status(), 5000)
        )
        if (active.current && request === version.current) {
          setStatus(value)
          setReadError('')
        }
      } catch {
        if (active.current && request === version.current) {
          setStatus({ state: 'context_unavailable' })
          setReadError('暂时无法确认恢复状态，请稍后重试或联系管理员。')
        }
      } finally {
        polling = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => {
      active.current = false
      clearInterval(timer)
    }
  }, [])

  const submit = async (): Promise<void> => {
    if (!window.agentRestoration || pending.current || !registered) return
    pending.current = true
    const request = ++version.current
    setBusy(true)
    setError('')
    try {
      const result = RestorationSubmitResultSchema.parse(
        await bounded(window.agentRestoration.submitPause(), 30000)
      )
      if (!active.current || request !== version.current) return
      if (result.success) setStatus({ state: 'pause_report_recorded' })
      else setError(failures[result.code])
    } catch {
      if (active.current && request === version.current)
        setError('提交结果尚未确认，请稍后重试。自动回复仍保持暂停。')
    } finally {
      if (request === version.current) {
        pending.current = false
        if (active.current) setBusy(false)
      }
    }
  }
  const submitInventory = async (): Promise<void> => {
    if (!window.agentRestoration || pending.current || !registered) return
    pending.current = true
    const request = ++version.current
    setBusy(true)
    setError('')
    try {
      const result = RestorationInventorySubmitResultSchema.parse(
        await bounded(window.agentRestoration.submitInventory(), 900000)
      )
      if (!active.current || request !== version.current) return
      if (result.success) setStatus({ state: 'inventory_received' })
      else setError(failures[result.code])
    } catch {
      if (active.current && request === version.current)
        setError('清单接收结果尚未确认，请稍后重试。自动回复仍保持暂停。')
    } finally {
      if (request === version.current) {
        pending.current = false
        if (active.current) setBusy(false)
      }
    }
  }
  const applyDecision = async (): Promise<void> => {
    if (!window.agentRestoration || pending.current || !registered) return
    pending.current = true
    const request = ++version.current
    setBusy(true)
    setError('')
    try {
      const result = RestorationApplyResultSchema.parse(
        await bounded(window.agentRestoration.applyDecision(), 30000)
      )
      if (!active.current || request !== version.current) return
      if (result.success) setStatus({ state: 'quarantine_recorded' })
      else
        setError(
          result.code === 'unavailable'
            ? '暂时无法应用，请确认管理员已完成本次清单核对，再重试。'
            : failures[result.code]
        )
    } catch {
      if (active.current && request === version.current)
        setError('应用结果尚未确认，可稍后重试。自动回复仍保持暂停。')
    } finally {
      if (request === version.current) {
        pending.current = false
        if (active.current) setBusy(false)
      }
    }
  }

  if (!status || status.state === 'not_required') return null
  return (
    <div className="enterprise-copy enterprise-runtime-reason" aria-label="恢复记录核对">
      <p role="status" aria-live="polite">
        {status.state === 'quarantine_recorded'
          ? '旧消息隔离已完成并已记录。仍需管理员核对遗漏记录与发送结果。'
          : status.state === 'inventory_received'
            ? '完整恢复清单已接收，等待管理员核对。'
            : status.state === 'pause_report_recorded'
              ? '已提交暂停状态，等待管理员核对。'
              : status.state === 'context_unavailable'
                ? '恢复记录暂时无法核验，请联系管理员。'
                : '检测到恢复记录，需要核对后才能启动自动回复。'}
      </p>
      <p className="form-hint">提交后继续保持暂停。原消息和发送结果仍需管理员核对。</p>
      <button
        className="btn btn-secondary btn-sm"
        disabled={
          !registered ||
          busy ||
          status.state === 'context_unavailable' ||
          status.state === 'quarantine_recorded'
        }
        onClick={() => void submit()}
      >
        {busy ? '正在提交…' : '提交暂停状态'}
      </button>
      <button
        className="btn btn-secondary btn-sm"
        disabled={
          !registered ||
          busy ||
          status.state === 'context_unavailable' ||
          status.state === 'quarantine_recorded' ||
          status.state === 'inventory_received'
        }
        onClick={() => void submitInventory()}
      >
        {busy ? '正在提交…' : '提交恢复清单'}
      </button>
      <button
        className="btn btn-secondary btn-sm"
        disabled={
          !registered ||
          busy ||
          status.state === 'context_unavailable' ||
          status.state === 'quarantine_recorded'
        }
        onClick={() => void applyDecision()}
      >
        {busy ? '正在处理…' : '应用管理员核对结果'}
      </button>
      {!registered && <p className="form-hint">请先确认企业连接。</p>}
      {error && (
        <p role="alert" className="enterprise-error">
          {error}
        </p>
      )}
      {readError && (
        <p role="alert" className="enterprise-error">
          {readError}
        </p>
      )}
    </div>
  )
}
