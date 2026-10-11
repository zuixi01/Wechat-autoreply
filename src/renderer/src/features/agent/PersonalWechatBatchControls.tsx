import { useEffect, useState } from 'react'
import { BatchStatusSchema, type BatchStatus } from '../../../../shared/contracts/foreground-batch'

const states: Record<BatchStatus['state'], string> = {
  idle: '未启动',
  connecting: '正在连接微信',
  scanning: '自动扫描会话列表',
  recovering: '等待接口恢复后继续',
  processing: '正在处理客户消息',
  waiting_foreground: '等待微信回到前台',
  paused: '已暂停'
}
const reasons: Record<string, string> = {
  unread_boundary_ambiguous: '首次红点接入时较早消息的已读边界不明，待本人查看',
  owner_decision_required: '需要本人决定，已保留待处理',
  media_requires_owner: '需要本人查看的非文字消息',
  none: '',
  user_pause: '已停止批量回复。',
  foreground_lost: '切回微信后继续处理，无需重新启动。',
  screen_obscured: '聊天被通知或其他窗口遮挡，移开后自动继续。',
  send_verifying: '回复已尝试发送，正在核对回显，不会重复发送。',
  list_changed: '列表有新消息或排序变化，正在重新扫描。',
  list_incomplete: '暂时无法确认列表完整性，等待重新核对；请放大微信并保持普通聊天列表可见。',
  list_limit: '本轮扫描达到上限，未确认完整覆盖。请缩小联系人范围并检查列表。',
  list_unavailable: '请关闭微信弹窗、搜索结果或通讯录，回到普通聊天列表。',
  human_input: '输入框中有人工草稿，请处理草稿后重新启动。',
  human_reply: '检测到人工回复，该联系人已暂停处理。',
  contact_not_unique: '列表中有同名会话，无法确定唯一联系人。',
  contact_mismatch: '聊天标题或单聊验证未通过。',
  unread_message_unverified: '未读数量、摘要或完整消息无法对应，请人工核对。',
  target_not_found: '当前会话列表中没有找到该联系人。',
  message_gap: '可见消息无法连续衔接，请人工核对。',
  send_unknown: '发送结果无法确认，全部停止且不会重发，请核对微信中的回复。',
  send_cancelled: '发送前核对未通过，该联系人已暂停处理，请检查草稿。',
  model_not_configured: '请在主页选择已配置密钥的视觉模型和回复模型。',
  model_network_failed: '模型连接暂时失败，保留当前消息，恢复后继续。',
  model_timeout: '模型暂时超时，保留当前消息，恢复后继续。',
  model_busy: '模型服务繁忙，等待后继续。',
  rules_not_configured: '请先保存回复规则。',
  rules_changed: '规则或模型配置已变化，请重新启动。',
  reply_identity_invalid: '回复包含 AI 或虚拟身份的自我描述，已拦截且未发送，请检查规则。',
  window_changed: '微信窗口实例已变化，请重新启动。',
  wechat_window_unavailable: '未找到唯一的微信窗口，请先登录并关闭多开窗口。',
  visual_response_invalid: '识别结果无法核对，保留进度后重新读取。'
}
const reason = (value: string): string =>
  reasons[value] ?? '读取或校验失败，请检查微信窗口、模型配置和回复规则。'
const savedTargets = (): string => {
  try {
    return localStorage.getItem('personal-wechat-batch-targets')?.slice(0, 64500) || ''
  } catch {
    return ''
  }
}
export default function PersonalWechatBatchControls({
  active
}: {
  active: boolean
}): React.JSX.Element {
  const [names, setNames] = useState(savedTargets),
    [status, setStatus] = useState<BatchStatus>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  useEffect(() => {
    if (!active || !window.foregroundWechat?.batchStatus) return
    let live = true,
      reading = false
    const read = async (): Promise<void> => {
      if (reading) return
      reading = true
      try {
        const next = BatchStatusSchema.parse(await window.foregroundWechat.batchStatus())
        if (live) setStatus(next)
      } catch {
        if (live) setError('无法读取批量运行状态，请重新启动项目。')
      } finally {
        reading = false
      }
    }
    void read()
    const timer = setInterval(() => void read(), 1500)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [active])
  const running = Boolean(status && !['idle', 'paused'].includes(status.state))
  const operate = async (start: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const targets = [
        ...new Set(
          names
            .split(/\r?\n/)
            .map((name) => name.trim())
            .filter(Boolean)
        )
      ]
      if (
        start &&
        (!targets.length ||
          targets.length > 500 ||
          targets.some(
            (name) =>
              name.length > 128 ||
              Array.from(name).some(
                (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
              )
          ))
      ) {
        setError('每行填写一个完整备注名，最多 500 个，每个不超过 128 字。')
        return
      }
      const next = start
        ? await window.foregroundWechat.batchStart({
            targets,
            foregroundConsent: true,
            processUnread: true
          })
        : await window.foregroundWechat.batchPause()
      setStatus(BatchStatusSchema.parse(next))
      if (start) {
        try {
          localStorage.setItem('personal-wechat-batch-targets', targets.join('\n'))
        } catch {
          /* The running target scope remains in the main process. */
        }
      }
    } catch {
      setError('操作未确认，请查看运行状态并检查微信、模型及回复规则。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="card enterprise-readiness" aria-labelledby="personal-wechat-batch-heading">
      <h2 id="personal-wechat-batch-heading" className="card-title">
        个人微信批量自动回复
      </h2>
      <p className="enterprise-copy">
        名单配置一次，启动后自动扫描会话中的未读数字和小红点，依次切换到对应聊天并回复新文字。无需逐个手动打开联系人。
      </p>
      <label className="form-label" htmlFor="personal-wechat-batch-targets">
        允许自动回复的联系人（每行一个完整备注名）
      </label>
      <textarea
        id="personal-wechat-batch-targets"
        className="form-input"
        rows={4}
        maxLength={64500}
        value={names}
        disabled={running || busy}
        onChange={(event) => setNames(event.target.value)}
      />
      <p className="form-hint">
        启用后会处理名单中已有及新收到的未读文字，使用主页的模型和回复规则。请为联系人设置唯一完整备注名；群聊、同名或无法核对的消息会跳过并显示原因。
      </p>
      <p className="form-hint">
        此模式需要专用电脑或微信处于前台，会自动切换聊天和滚动列表。切换其他应用时等待，回到微信后继续。截图不能提供稳定客户和消息编号，未确认列表完整时不会发出批量回复。
      </p>
      <p role="status" aria-live="polite">
        {status ? states[status.state] : '正在读取状态'}
        {status?.current ? ` · ${status.current}` : ''}
        {status?.reason && status.reason !== 'none' ? `：${reason(status.reason)}` : ''}
      </p>
      {status && (
        <p className="form-hint">
          已发现 {status.discovered} 个会话 · 扫描 {status.pages} 页 · 待处理 {status.pending} 个 ·{' '}
          {status.scanComplete ? '本轮列表遍历完成' : '尚未确认本轮列表覆盖'}
          （列表覆盖不代表消息全部处理完成）
        </p>
      )}
      <div className="enterprise-runtime-actions">
        <button
          className="btn btn-primary"
          disabled={!window.foregroundWechat?.batchStart || running || busy || !names.trim()}
          onClick={() => void operate(true)}
        >
          启动批量自动回复
        </button>
        <button
          className="btn btn-secondary"
          disabled={!window.foregroundWechat?.batchPause || (!running && !busy)}
          onClick={() => void operate(false)}
        >
          暂停批量自动回复
        </button>
      </div>
      {error && (
        <p className="enterprise-error" role="alert">
          {error}
        </p>
      )}
      {Boolean(status?.issues.length) && (
        <div aria-label="批量回复异常">
          <h3>需要处理的联系人</h3>
          {status!.issues.map((issue) => (
            <p key={issue.target}>
              {issue.target}：{reason(issue.reason)}
            </p>
          ))}
        </div>
      )}
      {Boolean(status?.records.length) && (
        <div aria-label="批量微信回复记录">
          <h3>回复记录</h3>
          {status!.records
            .slice(
              0,
              Math.max(
                8,
                status!.records.filter(
                  (record) =>
                    record.state === 'unknown' ||
                    (record.state === 'handoff' && record.handledAt === undefined)
                ).length
              )
            )
            .map((record) => (
              <article key={record.id} style={{ marginTop: 12, overflowWrap: 'anywhere' }}>
                <strong>
                  {record.target} ·{' '}
                  {record.state === 'sent'
                    ? '已确认发送'
                    : record.state === 'unknown'
                      ? '结果待核对'
                      : record.state === 'handoff'
                        ? record.handledAt === undefined
                          ? '待本人处理'
                          : '本人已处理'
                        : '未发送'}
                </strong>
                <p>收到：{record.question}</p>
                <p>回复：{record.reply}</p>
                {record.state === 'handoff' && record.handledAt === undefined && (
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true)
                      void window.foregroundWechat
                        .acknowledgeHandoff(record.id)
                        .then(() => window.foregroundWechat.batchStatus())
                        .then((value) => setStatus(BatchStatusSchema.parse(value)))
                        .catch(() => setError('处理状态未保存，请重试。'))
                        .finally(() => setBusy(false))
                    }}
                  >
                    已由本人处理
                  </button>
                )}
              </article>
            ))}
        </div>
      )}
    </section>
  )
}
