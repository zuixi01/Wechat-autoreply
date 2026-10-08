import { useEffect, useState } from 'react'
import PersonalWechatBatchControls from './PersonalWechatBatchControls'
import {
  ForegroundStatusSchema,
  type ForegroundStatus
} from '../../../../shared/contracts/foreground-wechat'

const states: Record<ForegroundStatus['state'], string> = {
  idle: '未启动',
  connecting: '正在连接微信',
  running: '等待 Q 的新消息',
  waiting_foreground: '等待微信回到前台',
  generating: '正在生成回复',
  sending: '正在发送并核对回显',
  paused: '已暂停'
}
const reasons: Record<string, string> = {
  none: '',
  user_pause: '已暂停自动回复。',
  target_required: '请输入测试联系人。',
  wechat_window_unavailable: '未找到唯一的个人微信窗口，请先登录微信并关闭多开窗口。',
  wechat_not_logged_in: '请先在微信中完成登录。',
  model_not_configured: '请先在模型配置中填写密钥，并在主页选择视觉模型和回复模型。',
  vision_not_configured: '当前视觉模型不支持截图，请在主页选择支持图片的模型。',
  model_failed: '模型调用失败或超时，请在模型配置中测试连接。',
  model_network_failed:
    '无法连接模型接口，连接可能被关闭或重置。请在模型配置中测试连接，并检查当前中转站地址和网络。尚未自动发送回复。',
  model_timeout: '模型请求超时，请在模型配置中测试连接后重新启动。',
  model_endpoint_invalid: '模型接口地址无效，请检查模型配置。',
  model_response_invalid: '模型未返回有效结果，本次已停止。',
  rules_not_configured: '请先保存回复规则。',
  rules_changed: '回复规则、模型或知识库已更新，请重新启动以使用新配置。',
  target_rules_ambiguous: '对象用户中存在多个同名规则，请先明确要使用的对象。',
  target_auto_reply_disabled: '该对象已关闭自动回复，请先在对象用户中开启。',
  contact_not_unique:
    '搜索结果不完整或包含同名联系人，无法自动确定对象。请在微信中打开要测试的聊天，再点击“接入已打开的聊天”。',
  contact_mismatch: '当前聊天对象不是指定联系人，或无法确认单人聊天，已停止。',
  human_input: '检测到输入框已有人工草稿，已暂停；请处理草稿后重新启动。',
  human_reply: '检测到你已人工回复，已暂停。',
  foreground_lost: '微信已失去前台。回到原聊天后会重新校验并继续；此期间不输入或发送。',
  window_changed: '微信窗口或实例已变化，请重新启动。',
  window_too_small: '微信窗口过小，请放大后重新启动。',
  window_out_of_screen: '请将微信完整放在主显示器内，再重新启动。',
  target_invalid: '联系人名称不能包含换行或控制字符。',
  capture_failed: '无法截取微信窗口，请确保微信正常显示。',
  desktop_input_unavailable: '桌面输入组件不可用，请重新启动项目。',
  message_gap: '可见消息无法与上次读取连续衔接，已停止，请人工核对后重新启动。',
  send_unknown:
    '发送结果无法确认，已停止且不会重发。请在微信中人工核对记录；当前记录不能自动放行。',
  send_cancelled: '发送前检查未通过，未确认发出。请检查微信聊天和输入框后重新启动。',
  visual_evidence_invalid: '截图识别没有提供有效的聊天和输入区域，已停止。',
  visual_response_invalid:
    '视觉模型连续两次返回了不符合读取格式的结果，已暂停；请检查视觉模型后重新接入聊天。',
  read_failed: '读取或识别失败，已停止，请检查微信与视觉模型。',
  windows_required: '个人微信前台模式目前支持 Windows。'
}
export default function PersonalWechatControls({ active }: { active: boolean }): React.JSX.Element {
  const [target, setTarget] = useState('Q'),
    [status, setStatus] = useState<ForegroundStatus>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!active || !window.foregroundWechat) return
    let mounted = true,
      inFlight = false
    const read = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const next = ForegroundStatusSchema.parse(await window.foregroundWechat.status())
        if (mounted) setStatus(next)
      } catch {
        if (mounted) setError('无法读取个人微信运行状态，请重启项目。')
      } finally {
        inFlight = false
      }
    }
    void read()
    const timer = setInterval(() => void read(), 1500)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [active])
  const running =
    status &&
    ['connecting', 'running', 'waiting_foreground', 'generating', 'sending'].includes(status.state)
  const operate = async (start: boolean, currentChat = false): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const value = start
        ? await window.foregroundWechat.start({
            target: target.trim(),
            foregroundConsent: true,
            connectionMode: currentChat ? 'current_chat' : 'search',
            ...(currentChat ? { currentChatSelected: true as const } : {})
          })
        : await window.foregroundWechat.pause()
      setStatus(ForegroundStatusSchema.parse(value))
    } catch {
      setError('操作未确认，请查看微信并刷新运行状态。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <PersonalWechatBatchControls active={active} />
      <details>
        <summary>单联系人调试工具</summary>
        <section className="card enterprise-readiness" aria-labelledby="personal-wechat-heading">
          <h2 id="personal-wechat-heading" className="card-title">
            个人微信前台自动回复
          </h2>
          <p className="enterprise-copy">
            由本项目读取微信并回复指定联系人，使用主页选择的模型和已保存的回复规则。微信在前台时处理消息；切换到其他应用时等待，回到原聊天后重新校验并继续。
          </p>
          <label className="form-label" htmlFor="personal-wechat-target">
            测试联系人备注名
          </label>
          <input
            id="personal-wechat-target"
            className="form-input"
            value={target}
            maxLength={128}
            disabled={Boolean(running) || busy}
            onChange={(event) => setTarget(event.target.value)}
          />
          <p className="form-hint">
            启动时会搜索并打开这个联系人，只回复启动后收到的新文字消息；已有历史消息不自动回复。截图模式只检查这个会话。
          </p>
          <p className="form-hint">
            搜索不完整或有同名联系人时，请先在微信中打开你选定的聊天并清空草稿，再接入已打开的聊天。此操作确认你已选定该对象；项目仍会核对标题和单聊类型，验证通过后才开始监听。
          </p>
          <p role="status" aria-live="polite">
            {status
              ? status.state === 'running'
                ? `等待 ${status.target} 的新消息`
                : states[status.state]
              : '正在读取状态'}
            {status?.reason && status.reason !== 'none'
              ? `：${reasons[status.reason] ?? reasons.read_failed}`
              : ''}
          </p>
          <div className="enterprise-runtime-actions">
            <button
              className="btn btn-primary"
              disabled={!window.foregroundWechat || busy || Boolean(running) || !target.trim()}
              onClick={() => void operate(true)}
            >
              {status?.state === 'connecting' ? '正在连接…' : '启动个人微信自动回复'}
            </button>
            <button
              className="btn btn-secondary"
              disabled={!window.foregroundWechat || busy || Boolean(running) || !target.trim()}
              onClick={() => void operate(true, true)}
            >
              接入已打开的聊天
            </button>
            <button
              className="btn btn-secondary"
              disabled={!window.foregroundWechat || (!running && !busy)}
              onClick={() => void operate(false)}
            >
              暂停个人微信自动回复
            </button>
          </div>
          {error && (
            <p className="enterprise-error" role="alert">
              {error}
            </p>
          )}
          {Boolean(status?.records.length) && (
            <div aria-label="个人微信回复记录" style={{ marginTop: 16 }}>
              <h3>回复记录</h3>
              {status!.records.slice(0, 8).map((row) => (
                <article key={row.id} style={{ marginTop: 12, overflowWrap: 'anywhere' }}>
                  <strong>
                    {row.target} ·{' '}
                    {row.state === 'sent'
                      ? '已确认发送'
                      : row.state === 'unknown'
                        ? '结果待核对'
                        : '未发送'}
                  </strong>
                  <p>收到：{row.question}</p>
                  <p>回复：{row.reply}</p>
                </article>
              ))}
            </div>
          )}
        </section>
      </details>
    </>
  )
}
