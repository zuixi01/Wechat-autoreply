import { useCallback, useEffect, useState } from 'react'
import RuntimeControls from '../agent/RuntimeControls'
import PersonalWechatControls from '../agent/PersonalWechatControls'
import type { DeviceStatus } from '../../../../shared/contracts/registration'
import {
  WorkbenchSnapshotSchema,
  type WorkbenchRow,
  type WorkbenchSnapshot
} from '../../../../shared/contracts/workbench'

const statuses: Record<WorkbenchRow['status'], string> = {
  generating: '正在生成',
  ready: '等待发送',
  sending: '发送中',
  needs_human: '需要人工处理',
  sent: '已发送',
  not_sent: '未发送',
  unknown: '结果待核对',
  skipped: '已跳过',
  obsolete: '已结束'
}

export default function AutomationConsole({
  active,
  onOpenConnection
}: {
  active: boolean
  onOpenConnection: () => void
}): React.JSX.Element {
  const [enterpriseExpanded, setEnterpriseExpanded] = useState(false)
  const [device, setDevice] = useState<DeviceStatus>()
  const [deviceError, setDeviceError] = useState('')
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>()
  const [recordsError, setRecordsError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => {
    if (!active || !enterpriseExpanded) return
    let mounted = true
    void window.agentDesktop
      ?.status()
      .then((value) => {
        if (mounted) {
          setDevice(value)
          setDeviceError('')
        }
      })
      .catch(() => {
        if (mounted) {
          setDevice(undefined)
          setDeviceError('无法读取连接状态，请到企业连接页重试。')
        }
      })
    return () => {
      mounted = false
    }
  }, [active, enterpriseExpanded])

  const refresh = useCallback(async (): Promise<void> => {
    if (!window.agentWorkbench) return
    setRefreshing(true)
    try {
      setSnapshot(WorkbenchSnapshotSchema.parse(await window.agentWorkbench.snapshot()))
      setRecordsError('')
    } catch {
      setRecordsError('暂时无法读取回复记录，请重试。')
    } finally {
      setRefreshing(false)
    }
  }, [])
  useEffect(() => {
    if (!active || !enterpriseExpanded) return
    let mounted = true
    let inFlight = false
    const read = async (): Promise<void> => {
      if (!window.agentWorkbench || inFlight) return
      inFlight = true
      try {
        const value = WorkbenchSnapshotSchema.parse(await window.agentWorkbench.snapshot())
        if (mounted) {
          setSnapshot(value)
          setRecordsError('')
        }
      } catch {
        if (mounted) setRecordsError('暂时无法读取回复记录，请重试。')
      } finally {
        inFlight = false
      }
    }
    void read()
    const timer = setInterval(() => void read(), 2000)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [active, enterpriseExpanded])
  const rows = [...(snapshot?.rows || [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)
  const connectionLabel =
    device?.state === 'connected'
      ? '已连接'
      : device?.scope
        ? '已登记'
        : device
          ? '未登记'
          : '按需连接'
  return (
    <div className="automation-console">
      <section className="workspace-panel automation-intro" aria-labelledby="home-console-heading">
        <div className="automation-intro-icon" aria-hidden="true">
          AI
        </div>
        <div>
          <h2 id="home-console-heading">让 AI 直接处理新消息</h2>
          <p>启动后自动生成并发送回复，你可以随时暂停。</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={onOpenConnection}>
          企业服务：{connectionLabel}
          <span aria-hidden="true"> ↗</span>
        </button>
        {deviceError && (
          <p className="automation-connection-error" role="alert">
            {deviceError}
          </p>
        )}
      </section>
      <div className="home-native-control">
        <PersonalWechatControls active={active} />
        <details
          style={{ marginTop: 16 }}
          onToggle={(event) => setEnterpriseExpanded(event.currentTarget.open)}
        >
          <summary>企业服务后台自动回复</summary>
          {enterpriseExpanded && (
            <RuntimeControls
              registered={Boolean(device?.scope)}
              onOpenConnection={onOpenConnection}
              headingId="home-automation-heading"
              title="自动回复控制"
              description="按已同步的规则，收到新消息后自动生成并发送回复。"
            />
          )}
        </details>
      </div>
      {enterpriseExpanded && (
        <section
          className="workspace-panel automation-activity"
          aria-labelledby="home-activity-heading"
        >
          <header className="panel-heading">
            <div>
              <h3 id="home-activity-heading">企业服务回复记录</h3>
              <span className="panel-description">显示实际处理状态，已发送的回复可在这里查看</span>
            </div>
            <button
              className="btn btn-text"
              disabled={!window.agentWorkbench || refreshing}
              onClick={() => void refresh()}
            >
              {refreshing ? '刷新中…' : '刷新记录'}
            </button>
          </header>
          {recordsError && (
            <p role="alert" className="automation-connection-error">
              {recordsError}
            </p>
          )}
          {!recordsError && rows.length === 0 && (
            <div className="automation-records-empty">
              <span className="automation-empty-symbol" aria-hidden="true">
                ↗
              </span>
              <h4>
                {snapshot?.state === 'not_registered'
                  ? '企业服务尚未连接'
                  : snapshot?.state === 'unavailable' || snapshot?.state === 'closed'
                    ? '回复记录暂不可用'
                    : !snapshot
                      ? '正在读取回复记录'
                      : '还没有回复记录'}
              </h4>
              <p>
                {snapshot?.state === 'not_registered'
                  ? '个人微信的回复记录显示在上方控制区。企业服务需在企业连接中登记电脑后使用。'
                  : '实际收到消息并处理后，这里会显示回复记录。'}
              </p>
            </div>
          )}
          <div className="automation-records">
            {rows.map((row) => (
              <article key={row.taskId} className="automation-record">
                <header>
                  <span className={`automation-record-status ${row.status}`}>
                    {statuses[row.status]}
                  </span>
                  <time dateTime={new Date(row.updatedAt).toISOString()}>
                    {new Date(row.updatedAt).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </time>
                </header>
                <p className="automation-inbound">{row.inboundPreview || '收到一条客户消息'}</p>
                {row.status === 'sent' && row.replyText && (
                  <p className="automation-sent-text">{row.replyText}</p>
                )}
                {(row.status === 'needs_human' || row.status === 'unknown') && (
                  <button className="btn btn-text" onClick={onOpenConnection}>
                    去处理
                  </button>
                )}
              </article>
            ))}
          </div>
          <footer className="automation-activity-footer">
            <span>仅显示最近 8 条记录</span>
            <button className="btn btn-text" onClick={onOpenConnection}>
              查看全部记录 ↗
            </button>
          </footer>
        </section>
      )}
    </div>
  )
}
