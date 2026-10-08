import { useEffect, useState, type FormEvent } from 'react'
import type { DeviceStatus, RegistrationResult } from '../../../../shared/contracts/registration'
import './enterprise.css'
import RuntimeControls from './RuntimeControls'
import ReplyWorkbench from './ReplyWorkbench'
import AdminConsole from './AdminConsole'

const errors: Record<Extract<RegistrationResult, { success: false }>['code'], string> = {
  invalid_input: '请检查服务地址和 43 位登记码。',
  insecure_server: '请填写管理员提供的 HTTPS 服务地址。',
  registration_failed: '登记未确认。请先向管理员查询登记结果，避免重复使用登记码。',
  storage_unavailable: '当前无法保护设备凭据，请检查 Windows 登录状态后重试。',
  already_registering: '正在登记，请稍候。',
  runtime_busy: '正在停止回复任务，请等暂停确认后再登记。'
}

export default function EnterpriseConnection(): React.JSX.Element {
  const [status, setStatus] = useState<DeviceStatus>({ state: 'unregistered' })
  const [serverUrl, setServerUrl] = useState('')
  const [enrollmentCode, setEnrollmentCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const desktop = Boolean(window.agentDesktop)
  useEffect(() => {
    let active = true
    if (window.agentDesktop)
      void window.agentDesktop
        .status()
        .then((value) => {
          if (active) {
            setStatus(value)
            setServerUrl(value.serverUrl ?? '')
          }
        })
        .catch(() => {
          if (active) setError('暂时无法读取设备登记状态。')
        })
    return () => {
      active = false
    }
  }, [])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!window.agentDesktop || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await window.agentDesktop.register({
        serverUrl: serverUrl.trim(),
        enrollmentCode: enrollmentCode.trim()
      })
      if (result.success) {
        setStatus(result.status)
        setEnrollmentCode('')
      } else setError(errors[result.code])
    } catch {
      setError('登记请求未确认，请联系管理员核对。')
    } finally {
      setBusy(false)
    }
  }

  const refresh = async (): Promise<void> => {
    if (!window.agentDesktop || busy) return
    setBusy(true)
    setError('')
    try {
      setStatus(await window.agentDesktop.refresh())
    } catch {
      setError('无法连接企业服务，请检查网络后重试。')
    } finally {
      setBusy(false)
    }
  }
  const label =
    status.state === 'connected'
      ? '已连接'
      : status.state === 'registered'
        ? '已登记，待检查连接'
        : status.state === 'unavailable'
          ? '暂时不可用'
          : '尚未登记'

  return (
    <div className="settings-page enterprise-page">
      <div className="settings-page-header">
        <div>
          <h1>企业连接</h1>
          <p>把这台电脑登记到企业，使用统一的客户回复规则。</p>
        </div>
      </div>
      <section className="card" aria-labelledby="enterprise-device-heading">
        <div className="enterprise-card-heading">
          <h2 id="enterprise-device-heading" className="card-title">
            这台员工电脑
          </h2>
          <span className={`enterprise-badge ${status.state === 'connected' ? 'connected' : ''}`}>
            {label}
          </span>
        </div>
        {status.scope ? (
          <dl className="enterprise-details">
            <div>
              <dt>企业</dt>
              <dd>{status.scope.tenant_id}</dd>
            </div>
            <div>
              <dt>员工</dt>
              <dd>{status.scope.employee_id}</dd>
            </div>
            <div>
              <dt>账号</dt>
              <dd>{status.scope.account_id}</dd>
            </div>
            <div>
              <dt>应用</dt>
              <dd>{status.scope.platform === 'wechat' ? '微信' : '企业微信'}</dd>
            </div>
          </dl>
        ) : (
          <p className="enterprise-copy">向管理员领取登记码，完成这台电脑与员工账号的绑定。</p>
        )}
        {status.serverUrl && <p className="enterprise-server">{status.serverUrl}</p>}
        {status.scope && (
          <button className="btn btn-secondary" disabled={busy} onClick={() => void refresh()}>
            {busy ? '正在检查…' : '检查连接'}
          </button>
        )}
      </section>
      {!status.scope && (
        <section className="card" aria-labelledby="enterprise-connect-heading">
          <h2 id="enterprise-connect-heading" className="card-title">
            登记电脑
          </h2>
          <form onSubmit={(event) => void submit(event)}>
            <div className="form-group">
              <label className="form-label" htmlFor="enterprise-server">
                企业服务地址
              </label>
              <input
                id="enterprise-server"
                className="form-input"
                type="url"
                placeholder="https://reply.example.com"
                required
                maxLength={2048}
                value={serverUrl}
                disabled={busy}
                onChange={(event) => setServerUrl(event.target.value)}
                spellCheck={false}
              />
              <p className="form-hint">使用管理员提供的地址。</p>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="enterprise-code">
                一次性登记码
              </label>
              <input
                id="enterprise-code"
                className="form-input"
                type="password"
                placeholder="粘贴管理员提供的 43 位登记码"
                required
                minLength={43}
                maxLength={43}
                value={enrollmentCode}
                disabled={busy}
                autoComplete="off"
                onChange={(event) => setEnrollmentCode(event.target.value)}
                spellCheck={false}
              />
              <p className="form-hint">登记码有效期 10 分钟，只能使用一次。</p>
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy || !desktop}>
              {busy ? '正在登记…' : '登记这台电脑'}
            </button>
            {!desktop && <p className="form-hint">请在桌面客户端中完成登记。</p>}
          </form>
        </section>
      )}
      {error && (
        <div role="alert" className="enterprise-error">
          {error}
        </div>
      )}
      <RuntimeControls registered={Boolean(status.scope)} />
      <ReplyWorkbench />
      <AdminConsole />
    </div>
  )
}
