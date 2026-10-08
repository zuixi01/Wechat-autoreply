import { useCallback, useEffect, useRef, useState } from 'react'
import { RuntimeStatusSchema, type RuntimeStatus } from '../../../../shared/contracts/runtime'
import RestorationControls from './RestorationControls'

const states: Record<RuntimeStatus['state'], string> = {
  paused: '已暂停',
  starting: '正在启动',
  running: '运行中',
  pausing: '正在停止',
  blocked: '暂时无法启动',
  closed: '已关闭'
}
const reasons: Record<RuntimeStatus['reason'], string> = {
  none: '',
  not_registered: '请先登记这台员工电脑。',
  capability_unverified: '后台收发能力尚未验证，自动回复暂时不能启动。',
  execution_path_unverified: '发送流程尚未验证，请联系管理员。',
  identity_unverified: '无法确认登录账号或客户身份，请联系管理员核验。',
  configuration_unavailable: '无法取得有效回复规则，请检查企业服务连接。',
  lease_lost: '当前电脑的执行权已失效。网络恢复后需要手动启动。',
  start_cancelled: '本次启动已取消。',
  observer_failed: '消息读取已停止，请检查聊天客户端后重新启动。',
  user_pause: '已收到暂停请求，以暂停确认结果为准。',
  locked: '电脑锁屏后已请求暂停，解锁后需要手动启动。',
  suspended: '电脑休眠后已请求暂停，恢复后需要手动启动。',
  shutdown: '客户端正在关闭。',
  settlement_pending: '发送回执尚未提交成功。请同步规则重试提交；系统不会重发消息。',
  execution_reconciliation_required: '存在需要核对的执行记录，请联系管理员处理后再启动。',
  local_storage_unavailable: '本地记录无法保存，已关闭自动执行。请修复存储问题后手动启动。'
}
type Action = 'synchronize' | 'start' | 'pause'

async function boundedStatus(
  request: Promise<RuntimeStatus>,
  waitMs: number
): Promise<RuntimeStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('runtime_result_unconfirmed')), waitMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export default function RuntimeControls({
  registered,
  onOpenConnection,
  headingId = 'enterprise-reply-heading',
  title = '客户自动回复',
  description = '回复规则由企业服务统一管理，员工无需填写 Jev 密钥。'
}: {
  registered: boolean
  onOpenConnection?: () => void
  headingId?: string
  title?: string
  description?: string
}): React.JSX.Element {
  const [status, setStatus] = useState<RuntimeStatus>()
  const [busy, setBusy] = useState<Action>()
  const [error, setError] = useState('')
  const version = useRef(0)
  const active = useRef(false)
  const action = useRef<Action | undefined>(undefined)
  const desktop = Boolean(window.agentRuntime)

  useEffect(() => {
    active.current = true
    let mounted = true
    let polling = false
    const refresh = async (): Promise<void> => {
      if (!window.agentRuntime || polling || action.current) return
      polling = true
      const request = ++version.current
      try {
        const value = RuntimeStatusSchema.parse(
          await boundedStatus(window.agentRuntime.status(), 5000)
        )
        if (mounted && request === version.current) {
          setStatus(value)
          setError('')
        }
      } catch {
        if (mounted && request === version.current) {
          setStatus(undefined)
          setError('暂时无法确认运行状态，可以点击暂停重新确认。')
        }
      } finally {
        polling = false
      }
    }
    void refresh()
    // Read-only status polling never probes chat windows or starts work.
    const timer = setInterval(() => void refresh(), 2000)
    return () => {
      mounted = false
      active.current = false
      clearInterval(timer)
    }
  }, [])

  const operate = useCallback(async (next: Action): Promise<void> => {
    const api = window.agentRuntime
    if (!api || (action.current && (next !== 'pause' || action.current === 'pause'))) return
    const request = ++version.current
    action.current = next
    setBusy(next)
    setError('')
    // Keep uncertainty visible until the main process acknowledges the new command.
    setStatus(undefined)
    try {
      // A UI timeout means uncertainty, never acknowledgment or cancellation of main work.
      const value = RuntimeStatusSchema.parse(await boundedStatus(api[next](), 30000))
      if (active.current && request === version.current) setStatus(value)
    } catch {
      if (active.current && request === version.current)
        setError('操作结果尚未确认，请点击暂停重新确认运行状态。')
    } finally {
      if (request === version.current) {
        action.current = undefined
        if (active.current) setBusy(undefined)
      }
    }
  }, [])

  const registrationReady = status?.readiness?.registered ?? registered
  const platformReady =
    !status?.readiness || (status.readiness.backgroundRead && status.readiness.nonInterferingSend)
  const canStart =
    desktop &&
    registrationReady &&
    platformReady &&
    !busy &&
    status &&
    ['paused', 'blocked'].includes(status.state)
  const canSynchronize = desktop && registrationReady && !busy && status?.state !== 'closed'
  const startConditionsId = `${headingId}-conditions`

  return (
    <section className="card enterprise-readiness" aria-labelledby={headingId}>
      <h2 id={headingId} className="card-title">
        {title}
      </h2>
      <p className="enterprise-copy">{description}</p>
      <div className="enterprise-runtime-status" role="status" aria-live="polite">
        <div className="enterprise-readiness-row">
          <span>运行状态</span>
          <strong className={status?.state === 'running' ? 'enterprise-running' : ''}>
            {!desktop
              ? '请使用桌面客户端'
              : status
                ? states[status.state]
                : busy === 'pause'
                  ? '正在请求暂停'
                  : busy === 'start'
                    ? '正在请求启动'
                    : busy === 'synchronize'
                      ? '正在同步规则'
                      : '状态待确认'}
          </strong>
        </div>
        <div className="enterprise-readiness-row">
          <span>企业规则</span>
          <strong>{status?.configurationVersion ?? '未同步'}</strong>
        </div>
        <div className="enterprise-readiness-row">
          <span>暂停确认</span>
          <strong>
            {status?.pauseAcknowledged
              ? '已确认停止'
              : status?.state === 'running'
                ? '自动回复已运行'
                : '尚未确认停止'}
          </strong>
        </div>
        {status && reasons[status.reason] && (
          <p className="enterprise-copy enterprise-runtime-reason">{reasons[status.reason]}</p>
        )}
        {status?.collection && (
          <div className="enterprise-copy" aria-label="会话采集进度">
            <p>
              会话列表：
              {
                {
                  not_started: '尚未检查',
                  scanning: '正在检查',
                  complete: '本轮列表检查完成',
                  incomplete: '本轮检查不完整，仍需补查'
                }[status.collection.coverage]
              }
            </p>
            <p>
              已发现 {status.collection.knownConversations} 个会话； 待读取{' '}
              {status.collection.pendingReads} 个； 读取异常需人工核对{' '}
              {status.collection.needsHuman} 个。
            </p>
            <p className="form-hint">列表检查完成不代表消息全部处理完成，以回复记录为准。</p>
          </div>
        )}
      </div>
      {desktop && status && (!registrationReady || !platformReady) && (
        <div
          className="enterprise-copy enterprise-runtime-reason"
          id={startConditionsId}
          aria-label="自动回复启动条件"
          role="status"
        >
          {!registrationReady && (
            <p>尚未连接回复服务，无法启动自动回复。请在企业连接中登记这台电脑。</p>
          )}
          {!platformReady && (
            <p>
              当前版本尚未接通微信或企业微信的真实收发，暂时无法自动回复。完成电脑登记也不会自动接通微信。
            </p>
          )}
          {!registrationReady && onOpenConnection && (
            <button className="btn btn-secondary btn-sm" onClick={onOpenConnection}>
              打开企业连接
            </button>
          )}
        </div>
      )}
      <RestorationControls registered={registrationReady} />
      <div className="enterprise-runtime-actions">
        <button
          className="btn btn-secondary"
          disabled={!canSynchronize}
          onClick={() => void operate('synchronize')}
        >
          {busy === 'synchronize' ? '正在同步…' : '同步企业规则'}
        </button>
        <button
          className="btn btn-primary"
          disabled={!canStart}
          aria-describedby={!registrationReady || !platformReady ? startConditionsId : undefined}
          title={
            !registrationReady
              ? '尚未连接回复服务'
              : !platformReady
                ? '微信或企业微信真实收发尚未接通'
                : undefined
          }
          onClick={() => void operate('start')}
        >
          {busy === 'start' ? '正在启动…' : '启动自动回复'}
        </button>
        <button
          className="btn btn-secondary"
          disabled={!desktop || busy === 'pause' || status?.state === 'closed'}
          onClick={() => void operate('pause')}
        >
          {busy === 'pause' ? '正在暂停…' : '暂停自动回复'}
        </button>
      </div>
      {error && (
        <p role="alert" className="enterprise-error">
          {error}
        </p>
      )}
      <p className="form-hint">
        登记、账号身份和后台收发能力验证通过后才能启动。锁屏、休眠或断网后需要手动恢复。
      </p>
    </section>
  )
}
