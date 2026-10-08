import { useCallback, useEffect, useRef, useState } from 'react'
import {
  WorkbenchSnapshotSchema,
  WorkbenchResultSchema,
  WorkbenchReconciliationResultSchema,
  WorkbenchLearningResultSchema,
  type WorkbenchLearningInput,
  type WorkbenchSnapshot,
  type WorkbenchRow,
  type WorkbenchAction,
  type WorkbenchResult
} from '../../../../shared/contracts/workbench'
import AssessmentDetails from './AssessmentDetails'
import WorkbenchLearning from './WorkbenchLearning'
import { useWorkbenchPresentation } from './useWorkbenchPresentation'

const statuses: Record<WorkbenchRow['status'], string> = {
  generating: '正在生成',
  sending: '正在发送',
  ready: '回复待执行',
  needs_human: '需要人工处理',
  sent: '已确认发送',
  not_sent: '未发送',
  unknown: '发送结果待核对',
  skipped: '已跳过',
  obsolete: '旧任务已失效'
}
const errors: Record<Extract<WorkbenchResult, { success: false }>['code'], string> = {
  invalid_input: '操作参数无效，请刷新后重试。',
  unavailable: '当前账号或任务不可操作，请检查设备登记。',
  task_changed: '任务或会话已有变化，请刷新后重新选择。',
  execution_pending: '发送仍在处理中或需要核对，暂时不能交还自动处理。',
  storage_unavailable: '本地记录无法保存，已请求暂停自动回复。',
  review_unavailable: '本次审核未完成，草稿已失效。请刷新后重新处理。',
  send_rejected: '发送请求未通过或结果尚待核对，请刷新记录后处理。'
}
const reviewReasons: Record<string, string> = {
  freeform_requires_human: '改写的业务事实需要人工核实。',
  explicit_human_request: '客户明确要求人工处理。',
  human_requested_or_uncertain: '客户需要人工处理，或需求尚不明确。',
  evidence_missing: '缺少可用的业务依据。',
  evidence_reference_invalid: '原业务依据不适用于这份草稿。',
  evidence_expired: '业务依据已过期。',
  decision_or_generation_failed: '本次审核未完成。',
  model_call_limit_reached: '本账号今日模型请求额度已用完，请由员工处理。',
  model_call_limit_unconfigured: '管理员尚未配置模型请求额度，请由员工处理。',
  model_call_record_unavailable: '模型调用记录未能确认，本次回复需要员工处理。',
  intent_outside_scope: '客户诉求超出当前业务范围。',
  shadow_mode: '当前仅评估回复，不执行自动发送。',
  evaluation_not_approved: '当前版本尚未通过业务验收。',
  edited_review_pending: '修改后的草稿正在等待审核。',
  intent_uncertain: '客户主要诉求尚不明确。',
  intent_conflict: '主要诉求与其他判断不一致，需要人工确认。',
  secondary_intent_uncertain: '客户可能还有其他诉求，需要人工确认。',
  audit_supported: '审核未能确认草稿中的事实或承诺有充分依据。',
  audit_within_scope: '草稿可能超出已授权的业务处理范围。',
  audit_covers_requests: '草稿可能没有覆盖客户的全部待处理问题。',
  audit_appropriate_tone: '草稿表达或承诺需要员工核对。',
  audit_resists_instructions: '草稿未通过聊天指令干扰检查，需要员工核对。',
  policy_changed: '本任务使用的业务规则已有变化。',
  model_drift: '本次审核使用的模型与当前发布不一致。',
  invalid_intent: '本次意图识别结果不完整。',
  invalid_contract: '本次任务数据不完整，不能自动回复。',
  task_obsolete: '客户消息、任务或运行状态已有变化。',
  cancelled: '本次处理已取消。',
  generation_failed: '本次生成或审核未完成，需要人工处理。',
  queue_overloaded: '待处理会话过多，本轮需要员工接管。'
}
async function bounded<T>(promise: Promise<T>, maximumMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('unconfirmed')), maximumMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
export default function ReplyWorkbench(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>(),
    [error, setError] = useState(''),
    [readError, setReadError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState<string>(),
    [showHistory, setShowHistory] = useState(false)
  const [editor, setEditor] = useState<{ taskId: string; version: string; text: string }>()
  const [asOf, setAsOf] = useState(() => Date.now())
  const mounted = useRef(false),
    version = useRef(0),
    working = useRef(false),
    polling = useRef(false)
  const refresh = useCallback(async (manual = false): Promise<void> => {
    if (!window.agentWorkbench || polling.current || working.current) return
    if (manual) {
      setError('')
      setNotice('')
    }
    polling.current = true
    const request = ++version.current
    try {
      const next = WorkbenchSnapshotSchema.parse(await bounded(window.agentWorkbench.snapshot()))
      if (mounted.current && request === version.current) {
        setSnapshot(next)
        setAsOf(Date.now())
        setReadError('')
      }
    } catch {
      if (mounted.current && request === version.current) {
        setSnapshot(undefined)
        setReadError('暂时无法读取回复记录，请刷新重试。')
      }
    } finally {
      polling.current = false
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => {
      mounted.current = false
      // This ref is a numeric request epoch, not a DOM node captured by cleanup.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      version.current++
      clearInterval(timer)
    }
  }, [refresh])
  const operate = async (row: WorkbenchRow, action: WorkbenchAction['action']): Promise<void> => {
    if (!window.agentWorkbench || working.current) return
    working.current = true
    const request = ++version.current
    setBusy(row.taskId)
    setError('')
    setNotice('')
    try {
      const result = WorkbenchResultSchema.parse(
        await bounded(
          window.agentWorkbench.act({ taskId: row.taskId, expectedVersion: row.version, action })
        )
      )
      if (!mounted.current || request !== version.current) return
      if (result.success) {
        setSnapshot(result.snapshot)
        setAsOf(Date.now())
        setNotice(
          action === 'takeover'
            ? result.stopAcknowledged
              ? '该会话已交给人工处理。'
              : '已接管会话，发送停止尚待确认，请先核对聊天记录。'
            : action === 'release'
              ? '已交还自动处理；整体暂停状态不变。'
              : '已跳过本轮消息。'
        )
      } else {
        setError(errors[result.code])
        setSnapshot(undefined)
      }
    } catch {
      if (mounted.current && request === version.current) {
        setSnapshot(undefined)
        setError('操作结果尚未确认。请刷新记录，避免重复操作。')
      }
    } finally {
      working.current = false
      if (mounted.current) setBusy(undefined)
    }
  }
  const rows =
    snapshot?.rows.filter(
      (row) =>
        showHistory ||
        row.humanOwned ||
        row.learningPending ||
        row.reconciliationRequired ||
        ['generating', 'ready', 'needs_human', 'sending', 'unknown'].includes(row.status)
    ) ?? []
  useWorkbenchPresentation(rows, editor?.taskId)
  const teach = async (input: WorkbenchLearningInput): Promise<void> => {
    if (!window.agentWorkbench || working.current) return
    working.current = true
    const request = ++version.current
    setBusy(input.taskId)
    setError('')
    setNotice('')
    try {
      const result = WorkbenchLearningResultSchema.parse(
        await bounded(window.agentWorkbench.learn(input), 7000)
      )
      if (!mounted.current || request !== version.current) return
      if (result.success) {
        setNotice(
          result.state === 'saved'
            ? '反馈已保存。开启学习后，助手会据此复盘；候选方法可在工作记忆中查看。'
            : '反馈已保存在本机，等待同步。连接恢复后会继续提交。'
        )
      } else {
        const messages = {
          invalid_input: '请检查反馈内容和原因。',
          unavailable: '账号或设备已有变化，请刷新记录后重试。',
          task_changed: '任务已有变化，请刷新后重新选择。',
          storage_unavailable: '反馈无法保存，已请求暂停自动回复。',
          event_conflict: '这次反馈的内容已有变化，请重新填写后保存。',
          event_unavailable: '学习来源已过期或被遗忘，请使用新的实际案例。'
        }
        setError(messages[result.code])
      }
      try {
        const next = WorkbenchSnapshotSchema.parse(await bounded(window.agentWorkbench.snapshot()))
        if (mounted.current && request === version.current) {
          setSnapshot(next)
          setAsOf(Date.now())
          setReadError('')
        }
      } catch {
        if (mounted.current && request === version.current)
          setReadError('反馈状态已确认，但回复记录暂时无法刷新。请刷新列表查看最新状态。')
      }
    } catch {
      if (mounted.current && request === version.current)
        setError('反馈结果尚未确认。请刷新记录；重试同一份反馈会保留原提交编号。')
    } finally {
      working.current = false
      if (mounted.current) setBusy(undefined)
    }
  }

  const reviewEdited = async (row: WorkbenchRow): Promise<void> => {
    if (
      !window.agentWorkbench ||
      working.current ||
      !editor ||
      editor.taskId !== row.taskId ||
      editor.version !== row.version
    )
      return
    working.current = true
    const request = ++version.current
    setBusy(row.taskId)
    setError('')
    setNotice('')
    try {
      const result = WorkbenchResultSchema.parse(
        await bounded(
          window.agentWorkbench.reviewEdited({
            taskId: row.taskId,
            expectedVersion: editor.version,
            text: editor.text
          }),
          60000
        )
      )
      if (!mounted.current || request !== version.current) return
      if (result.success) {
        setSnapshot(result.snapshot)
        setAsOf(Date.now())
        setEditor(undefined)
        setNotice('已对修改后的草稿重新审核，结果见新记录。会话仍由人工处理，尚未发送。')
      } else {
        setError(errors[result.code])
        setSnapshot(undefined)
        setEditor(undefined)
      }
    } catch {
      if (mounted.current && request === version.current) {
        setSnapshot(undefined)
        setEditor(undefined)
        setError('审核结果尚未确认，请刷新记录后处理。')
      }
    } finally {
      working.current = false
      if (mounted.current) setBusy(undefined)
    }
  }
  const confirmSend = async (row: WorkbenchRow): Promise<void> => {
    if (!window.agentWorkbench || working.current || editor) return
    working.current = true
    const request = ++version.current
    setBusy(row.taskId)
    setError('')
    setNotice('')
    try {
      const result = WorkbenchResultSchema.parse(
        await bounded(
          window.agentWorkbench.confirmSend({ taskId: row.taskId, expectedVersion: row.version })
        )
      )
      if (!mounted.current || request !== version.current) return
      if (result.success) {
        setSnapshot(result.snapshot)
        setAsOf(Date.now())
        setNotice('已更新发送记录，请查看任务状态。')
      } else {
        setSnapshot(undefined)
        setError(errors[result.code])
      }
    } catch {
      if (mounted.current && request === version.current) {
        setSnapshot(undefined)
        setError('发送结果尚未确认。请刷新记录并核对聊天，避免重复发送。')
      }
    } finally {
      working.current = false
      if (mounted.current) setBusy(undefined)
    }
  }
  const reconcile = async (row: WorkbenchRow): Promise<void> => {
    if (!window.agentWorkbench?.reconcile || working.current || !row.canReconcile) return
    working.current = true
    const request = ++version.current
    setBusy(row.taskId)
    setError('')
    setNotice('')
    try {
      const result = WorkbenchReconciliationResultSchema.parse(
        await bounded(
          window.agentWorkbench.reconcile({ taskId: row.taskId, expectedVersion: row.version }),
          30000
        )
      )
      if (!mounted.current || request !== version.current) return
      if (!result.success) {
        setError(
          result.code === 'unavailable'
            ? '核对未完成，请检查管理员核对单和设备状态，再刷新重试。'
            : errors[result.code]
        )
        return
      }
      const next = WorkbenchSnapshotSchema.parse(await bounded(window.agentWorkbench.snapshot()))
      if (!mounted.current || request !== version.current) return
      setSnapshot(next)
      setNotice(
        result.resolution
          ? result.applicationAcknowledged
            ? result.resolution === 'confirmed'
              ? '已核实原回复发送成功。核对完成时自动回复仍暂停，需手动启动。'
              : '已核实原回复未发送，客户仍由你处理。核对完成时自动回复仍暂停。'
            : '结案结果已保存，服务器确认尚待同步。本次核对时自动回复仍暂停。'
          : '核对证据已提交，等待管理员结案。本次核对时自动回复仍暂停。'
      )
    } catch {
      if (mounted.current && request === version.current)
        setError('核对结果尚未确认，请刷新记录。核对不会重复发送原回复。')
    } finally {
      working.current = false
      if (mounted.current) setBusy(undefined)
    }
  }
  return (
    <section className="card enterprise-workbench" aria-labelledby="reply-workbench-heading">
      <div className="enterprise-card-heading">
        <h2 className="card-title" id="reply-workbench-heading">
          客户回复记录
        </h2>
        <button
          className="btn btn-secondary"
          disabled={!window.agentWorkbench || Boolean(busy)}
          onClick={() => void refresh(true)}
        >
          刷新记录
        </button>
      </div>
      <p className="enterprise-copy">查看回复建议，或把当前会话交给自己处理。</p>
      <label className="enterprise-history">
        <input
          type="checkbox"
          checked={showHistory}
          onChange={(event) => setShowHistory(event.target.checked)}
        />
        显示最近处理记录
      </label>
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
      {notice && (
        <p role="status" className="enterprise-copy">
          {notice}
        </p>
      )}
      {!window.agentWorkbench ? (
        <p className="enterprise-copy">请在桌面客户端查看客户回复记录。</p>
      ) : snapshot?.state === 'not_registered' ? (
        <p className="enterprise-copy">登记电脑后，可查看当前员工账号的回复记录。</p>
      ) : snapshot?.state === 'closed' ? (
        <p className="enterprise-copy">客户端已停止，记录暂不可操作。</p>
      ) : snapshot?.state === 'unavailable' ? (
        <p className="enterprise-error" role="alert">
          本地记录无法读取，已请求暂停自动回复。
        </p>
      ) : !snapshot ? (
        <p className="enterprise-copy">记录尚待确认。</p>
      ) : rows.length === 0 ? (
        <p className="enterprise-copy">暂无待处理任务。消息读取启动后，新任务会显示在这里。</p>
      ) : (
        <ul className="enterprise-task-list">
          {rows.map((row) => (
            <li
              key={row.taskId}
              className="enterprise-task"
              data-workbench-task={row.taskId}
              data-workbench-version={row.version}
              data-workbench-status={row.status}
            >
              <div className="enterprise-task-heading">
                <strong>会话：{row.conversationId}</strong>
                <span className="enterprise-badge">{statuses[row.status]}</span>
              </div>
              <p className="enterprise-task-text" data-workbench-inbound>
                <span>客户消息</span>
                {row.inboundPreview || '暂无文本消息'}
              </p>
              {row.replyText && (
                <p className="enterprise-task-text" data-workbench-reply>
                  <span>回复建议</span>
                  {row.replyText}
                </p>
              )}
              {row.reviewStatus && editor?.taskId !== row.taskId && (
                <p className="enterprise-copy">
                  {row.reviewStatus === 'passed'
                    ? '保存的草稿已通过审核。'
                    : row.reviewStatus === 'invalid'
                      ? '原审核已失效，不能据此自动发送。'
                      : '保存的草稿未通过全部审核，需要人工处理。'}
                </p>
              )}
              {Boolean(row.reviewReasons?.length) && editor?.taskId !== row.taskId && (
                <p className="enterprise-copy">
                  {[
                    ...new Set(
                      row.reviewReasons!.map(
                        (reason) => reviewReasons[reason] ?? '尚未满足自动回复条件，请员工核对。'
                      )
                    )
                  ].join(' ')}
                </p>
              )}
              {editor?.taskId !== row.taskId && (
                <AssessmentDetails
                  key={`${row.taskId}:${row.version}`}
                  row={row}
                  explanation={row.explanation}
                  asOf={asOf}
                />
              )}
              {editor?.taskId !== row.taskId && (
                <WorkbenchLearning row={row} busy={Boolean(busy)} submit={teach} />
              )}
              {editor?.taskId === row.taskId && (
                <div className="enterprise-edit">
                  <label className="form-label" htmlFor={`edited-${row.taskId}`}>
                    修改回复
                  </label>
                  <textarea
                    id={`edited-${row.taskId}`}
                    className="form-input enterprise-edit-text"
                    value={editor.text}
                    maxLength={10000}
                    disabled={Boolean(busy)}
                    onChange={(event) => setEditor({ ...editor, text: event.target.value })}
                  />
                  <p className="form-hint">
                    修改中的内容尚未审核。重新审核会生成新版本，原审核不能用于修改后的内容。
                  </p>
                  {editor.version !== row.version && (
                    <p role="alert" className="enterprise-error">
                      会话或任务已有变化，请取消编辑后重新选择。
                    </p>
                  )}
                  <div className="enterprise-runtime-actions">
                    <button
                      className="btn btn-primary"
                      disabled={
                        Boolean(busy) ||
                        !row.canReview ||
                        editor.version !== row.version ||
                        !editor.text.trim()
                      }
                      onClick={() => void reviewEdited(row)}
                    >
                      {busy === row.taskId ? '正在重新审核…' : '重新审核'}
                    </button>
                    <button
                      className="btn btn-secondary"
                      disabled={Boolean(busy)}
                      onClick={() => setEditor(undefined)}
                    >
                      取消编辑
                    </button>
                  </div>
                </div>
              )}
              <p className="enterprise-copy">
                {row.humanOwned
                  ? row.stopAcknowledged
                    ? '由人工处理'
                    : '人工已接管，停止待确认'
                  : '尚未人工接管'}
              </p>
              {(row.status === 'unknown' || row.reconciliationRequired) && (
                <p className="form-hint">
                  核对会暂停本机自动回复，提交原执行证据并等待管理员结案，不会重发。
                  {!row.canReconcile && '当前设备尚不能取证，请联系管理员处理。'}
                </p>
              )}
              <div className="enterprise-runtime-actions">
                {(row.status === 'unknown' || row.reconciliationRequired) && (
                  <button
                    className="btn btn-secondary"
                    disabled={
                      Boolean(busy) ||
                      !row.canReconcile ||
                      !window.agentWorkbench?.reconcile ||
                      !!editor
                    }
                    onClick={() => void reconcile(row)}
                  >
                    {busy === row.taskId ? '正在核对…' : '核对发送结果'}
                  </button>
                )}
                <button
                  className="btn btn-primary"
                  disabled={Boolean(busy) || !!editor || !row.canConfirm}
                  onClick={() => void confirmSend(row)}
                >
                  我已核对，确认发送
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={Boolean(busy) || !row.canReview || !!editor}
                  onClick={() =>
                    setEditor({
                      taskId: row.taskId,
                      version: row.version,
                      text: row.replyText ?? ''
                    })
                  }
                >
                  编辑并重新审核
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={Boolean(busy) || row.humanOwned}
                  onClick={() => void operate(row, 'takeover')}
                >
                  人工接管
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={Boolean(busy) || !row.canRelease}
                  onClick={() => void operate(row, 'release')}
                >
                  交还自动处理
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={Boolean(busy) || !row.canSkip}
                  onClick={() => void operate(row, 'skip')}
                >
                  跳过本轮
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="form-hint">
        人工发送以当前显示的回复为准，点击确认表示你已核对客户和内容。
        接管会保留到你主动交还。跳过只处理当前任务，后续新消息仍会保留；发送结果不明的任务需要管理员核对。
      </p>
    </section>
  )
}
