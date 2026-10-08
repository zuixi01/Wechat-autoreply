import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AdminConnectionStatus, AdminResult } from '../../../../shared/contracts/admin-gateway'
import type { RuntimeStatusPage } from '../../../../shared/contracts/runtime-monitoring'
import type { BulkPausePage, BulkPauseSummary } from '../../../../shared/contracts/bulk-pause'
import './admin-console.css'

const failure = {
  invalid_input: '请检查管理服务地址、凭据或批次编号。',
  not_connected: '请先连接管理员服务。',
  denied: '管理员权限已失效，请重新连接或联系部署管理员。',
  operation_unconfirmed: '操作未确认。暂停可能已经生效，请保留批次编号查询或重试原批次。',
  journal_unavailable: '暂停记录无法保存，请检查本机存储权限和可用空间，保留原编号后重新连接核对。',
  pause_pending: '已有未确认暂停批次，已恢复原编号，请先查询或重试原批次。',
  operation_busy: '另一项暂停操作正在处理，请稍后刷新连接状态。'
}
const freshness = {
  missing: '尚无上报',
  recent: '最近上报',
  stale: '上报已过期',
  revoked: '设备已撤销',
  invalid: '上报无效'
}
const confirmation = {
  not_requested: '未请求',
  pending: '待声明',
  awaiting_state: '等待当前状态',
  confirmed_runtime: '当前运行时已声明停止',
  stale: '声明已过期',
  revoked: '设备已撤销',
  invalid: '声明无效'
}

export default function AdminConsole(): React.JSX.Element {
  const [connection, setConnection] = useState<AdminConnectionStatus>({ connected: false })
  const [serverUrl, setServerUrl] = useState(''),
    [token, setToken] = useState('')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [runtime, setRuntime] = useState<RuntimeStatusPage | null>(null)
  const [requestId, setRequestId] = useState('')
  const [summary, setSummary] = useState<BulkPauseSummary | null>(null)
  const [accounts, setAccounts] = useState<BulkPausePage | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const working = useRef(false)
  useEffect(() => {
    let active = true
    if (window.adminDesktop)
      void window.adminDesktop
        .status()
        .then((status) => {
          if (active) {
            setConnection(status)
            setServerUrl(status.serverUrl ?? '')
            if (status.latestPause) {
              setRequestId(status.latestPause.requestId)
              setUncertain(!status.latestPause.confirmed)
            }
          }
        })
        .catch(() => {
          if (active) setError('无法读取管理员连接状态。')
        })
    return () => {
      active = false
    }
  }, [])
  const value = <T,>(result: AdminResult<T>): T => {
    if (!result.success) {
      if (result.requestId) {
        setRequestId(result.requestId)
        setUncertain(true)
        setSummary(null)
        setAccounts(null)
      }
      if (result.code === 'denied' || result.code === 'not_connected') {
        setConnection({ connected: false })
        setRuntime(null)
        setAccounts(null)
        setSummary(null)
      }
      throw new Error(failure[result.code])
    }
    return result.value
  }
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (working.current || !window.adminDesktop) return
    working.current = true
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '管理操作未确认。')
    } finally {
      working.current = false
      setBusy(false)
    }
  }
  const connect = (event: FormEvent): void => {
    event.preventDefault()
    if (working.current) return
    const secret = token
    setToken('')
    void run(async () => {
      setRuntime(null)
      setAccounts(null)
      setSummary(null)
      setConnection({ connected: false })
      const status = value(
        await window.adminDesktop.connect({ serverUrl: serverUrl.trim(), token: secret.trim() })
      )
      setConnection(status)
      setRequestId(status.latestPause?.requestId ?? '')
      setUncertain(status.latestPause ? !status.latestPause.confirmed : false)
      setRuntime(value(await window.adminDesktop.runtime({})))
    })
  }
  const loadAccounts = async (id: string, after?: string): Promise<void> => {
    const page = value(
      await window.adminDesktop.pauseAccounts({
        requestId: id,
        page: { limit: 50, ...(after ? { after } : {}) }
      })
    )
    setAccounts(page)
    setSummary(page.summary)
  }
  const pause = (): void => {
    if (working.current) return
    const id = requestId.trim() || crypto.randomUUID()
    setRequestId(id)
    setUncertain(true)
    void run(async () => {
      setAccounts(null)
      const result = value(await window.adminDesktop.pauseAll({ requestId: id }))
      setSummary(result)
      setUncertain(false)
      await loadAccounts(id)
      setRuntime(value(await window.adminDesktop.runtime({})))
    })
  }
  return (
    <details className="card admin-console">
      <summary className="card-title">企业管理员</summary>
      <p className="enterprise-copy">
        查看员工设备状态，并暂停本企业全部账号。需要独立管理员凭据。
      </p>
      {!connection.connected && requestId && (
        <p className="enterprise-copy">上次暂停批次：{requestId}。重新连接后可用此编号查询。</p>
      )}
      {!connection.connected ? (
        <form onSubmit={connect}>
          <div className="form-group">
            <label className="form-label" htmlFor="admin-server">
              管理服务地址
            </label>
            <input
              className="form-input"
              id="admin-server"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://管理服务地址:4783"
              required
              disabled={busy}
              autoComplete="off"
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="admin-token">
              管理员凭据
            </label>
            <input
              className="form-input"
              id="admin-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              minLength={43}
              maxLength={43}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="form-hint">仅用于当前连接，不保存。员工登记码不能用于管理员登录。</p>
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy || !window.adminDesktop}>
            {busy ? '正在连接…' : '连接管理服务'}
          </button>
        </form>
      ) : (
        <>
          <dl className="enterprise-details">
            <div>
              <dt>企业</dt>
              <dd>{connection.identity?.tenantId}</dd>
            </div>
            <div>
              <dt>管理员</dt>
              <dd>{connection.identity?.actorId}</dd>
            </div>
          </dl>
          <div className="enterprise-runtime-actions">
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setRuntime(value(await window.adminDesktop.runtime({})))
                })
              }
            >
              刷新设备状态
            </button>
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setConnection(await window.adminDesktop.disconnect())
                  setRuntime(null)
                  setAccounts(null)
                  setSummary(null)
                })
              }
            >
              断开管理连接
            </button>
          </div>
          {runtime && (
            <section aria-label="员工设备状态">
              <p className="enterprise-copy">
                共 {runtime.totalDevices} 台登记设备，已撤销 {runtime.revokedDevices} 台。当前页{' '}
                {runtime.rows.length} 台；查询时间 {new Date(runtime.serverTime).toLocaleString()}。
              </p>
              <div className="admin-table-scroll">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>员工 / 账号</th>
                      <th>设备</th>
                      <th>最近状态</th>
                      <th>中央暂停</th>
                      <th>停止声明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runtime.rows.map((row) => (
                      <tr key={`${row.accountId}/${row.agentId}`}>
                        <td>
                          {row.employeeId}
                          <br />
                          {row.accountId}
                          <br />
                          {row.platform === 'wechat' ? '微信' : '企业微信'}
                        </td>
                        <td>{row.agentId}</td>
                        <td>
                          {freshness[row.freshness]}
                          <br />
                          {row.receivedAt ? new Date(row.receivedAt).toLocaleString() : '暂无时间'}
                        </td>
                        <td>{row.serverPaused ? '已暂停' : '未暂停'}</td>
                        <td>{confirmation[row.pauseConfirmation]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!runtime.rows.length && <p className="enterprise-copy">当前页没有设备。</p>}
              {runtime.nextCursor && (
                <button
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setRuntime(
                        value(await window.adminDesktop.runtime({ after: runtime.nextCursor! }))
                      )
                    })
                  }
                >
                  下一页设备
                </button>
              )}
            </section>
          )}
          <section className="admin-pause-section" aria-labelledby="admin-pause-heading">
            <h3 id="admin-pause-heading">全员暂停</h3>
            <p className="enterprise-copy">
              暂停本企业在本批次创建时已有的全部账号，包括已禁用账号。已在执行的发送仍需核对。
            </p>
            {connection.latestPause?.recovered &&
              connection.latestPause.requestId === requestId && (
                <p className="enterprise-copy" role="status">
                  已恢复此管理员的上次暂停编号，请查询原批次状态。重新连接不会自动提交暂停。
                </p>
              )}
            {connection.journalUnavailable && (
              <p className="enterprise-error" role="alert">
                本机暂停记录不可用，保存成功前不会提交新暂停。设备状态与历史批次仍可查询。
              </p>
            )}
            <label className="form-label" htmlFor="admin-batch-id">
              暂停批次编号
            </label>
            <input
              className="form-input"
              id="admin-batch-id"
              value={requestId}
              disabled={busy || uncertain}
              onChange={(e) => {
                setRequestId(e.target.value)
                setSummary(null)
                setAccounts(null)
              }}
              placeholder="首次暂停自动生成；查询历史时粘贴批次编号"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="enterprise-runtime-actions">
              <button className="btn btn-secondary" disabled={busy} onClick={pause}>
                {uncertain
                  ? '重试原暂停批次'
                  : summary ||
                      (connection.latestPause?.requestId === requestId &&
                        connection.latestPause.confirmed)
                    ? '核对原暂停批次'
                    : '暂停本企业全部账号'}
              </button>
              <button
                className="btn btn-secondary"
                disabled={busy || !requestId.trim()}
                onClick={() =>
                  void run(async () => {
                    setSummary(
                      value(await window.adminDesktop.pauseSummary({ requestId: requestId.trim() }))
                    )
                    setUncertain(false)
                    await loadAccounts(requestId.trim())
                  })
                }
              >
                查询本批次
              </button>
              {summary && !uncertain && (
                <button
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => {
                    setRequestId('')
                    setSummary(null)
                    setAccounts(null)
                  }}
                >
                  准备新暂停批次
                </button>
              )}
            </div>
            {uncertain && (
              <p className="enterprise-copy" role="status">
                请保留上方编号。请求未确认前，用同一编号查询或重试，避免创建新批次。
              </p>
            )}
            {summary && (
              <>
                <p className="enterprise-copy">
                  原批次 {summary.accountCount} 个账号，当前仍由本批次暂停 {summary.activeAccounts}{' '}
                  个；后来新增 {summary.outsideAccounts} 个账号。原目标 {summary.targetCount}{' '}
                  台设备，已收到 {summary.reportedTargets} 台设备的历史停止声明。
                </p>
                <p className="enterprise-copy">
                  停止声明来自程序，尚未验证设备实际停止。刷新设备状态可核对当前声明是否过期。
                </p>
              </>
            )}
            {accounts && (
              <>
                <div className="admin-table-scroll">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>员工 / 账号</th>
                        <th>本批次暂停</th>
                        <th>设备声明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accounts.rows.map((row) => (
                        <tr key={row.accountId}>
                          <td>
                            {row.employeeId}
                            <br />
                            {row.accountId}
                          </td>
                          <td>{row.active ? '当前有效' : '已被后续状态替代'}</td>
                          <td>
                            {row.reportedTargets} / {row.targetCount}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!accounts.rows.length && <p className="enterprise-copy">此批次没有账号。</p>}
                <div className="enterprise-runtime-actions">
                  <button
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => void run(() => loadAccounts(accounts.summary.requestId))}
                  >
                    返回账号首页
                  </button>
                  {accounts.nextCursor && (
                    <button
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          loadAccounts(accounts.summary.requestId, accounts.nextCursor!)
                        )
                      }
                    >
                      下一页账号
                    </button>
                  )}
                </div>
              </>
            )}
          </section>
        </>
      )}
      {error && (
        <div className="enterprise-error" role="alert">
          {error}
        </div>
      )}
    </details>
  )
}
