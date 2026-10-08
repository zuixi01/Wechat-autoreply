import { useRef, useState } from 'react'
import {
  MemoryContentSchema,
  type MemoryContent,
  type MemoryRecord,
  type MemoryProposal,
  type MemoryScope
} from '../../../../shared/contracts/learning-memory'
import { useLearningOperation } from './use-learning-operation'
import type { LearningTeachingDraft } from './learning-teaching-draft'
import type { LearningSubmissionReceipt } from '../../../../shared/contracts/learning-submissions'

const blank: MemoryContent = {
  kind: 'lesson',
  scenario: '',
  guidance: '',
  rationale: '',
  steps: [],
  pitfalls: [],
  verification: []
}
function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}
export default function LearningMethodEditor({
  scope,
  revision,
  draft,
  onSaved
}: {
  scope: MemoryScope
  revision?: { memory: MemoryRecord; evidence: MemoryProposal['evidence'] }
  draft?: LearningTeachingDraft
  onSaved: (message: string) => void
}): React.JSX.Element {
  const initial = revision?.memory.content ?? draft?.content ?? blank
  const [content, setContent] = useState(initial),
    [steps, setSteps] = useState(initial.steps.join('\n')),
    [pitfalls, setPitfalls] = useState(initial.pitfalls.join('\n')),
    [verification, setVerification] = useState(initial.verification.join('\n')),
    [reason, setReason] = useState(draft?.reason ?? ''),
    [scopeConfirmed, setScopeConfirmed] = useState(false)
  const operation = useLearningOperation(scope)
  const intent = useRef<{ key: string; sourceId: string } | undefined>(undefined)
  const prefix = revision ? 'learning-revise' : 'learning-manual'
  const disabled = operation.busy || Boolean(revision?.memory.pinned)
  const savedMessage = (result: MemoryRecord | LearningSubmissionReceipt | null): string =>
    revision
      ? '修订已保存为候选；现行生效版本继续使用。'
      : result && 'state' in result && result.state === 'pending'
        ? '教导已保存在本机，等待同步；恢复连接后自动重试。'
        : result && 'state' in result && result.state === 'forgotten'
          ? '教导已过期或被遗忘，不会继续同步。'
          : '已保存为候选，请核对后使其生效。'
  async function save(): Promise<void> {
    if (draft && !scopeConfirmed) return
    await operation.execute(
      async () => {
        const value = MemoryContentSchema.parse({
          ...content,
          steps: lines(steps),
          pitfalls: lines(pitfalls),
          verification: lines(verification)
        })
        if (revision)
          return window.learningMemory.act({
            scope,
            action: 'revise',
            id: revision.memory.id,
            expectedRevision: revision.memory.currentRevision,
            content: value,
            evidence: revision.evidence,
            reason: reason.trim()
          })
        const key = JSON.stringify({ scope, content: value, reason: reason.trim() })
        if (intent.current?.key !== key) intent.current = { key, sourceId: crypto.randomUUID() }
        return window.learningSubmissions.submit({
          kind: 'manual',
          input: {
            scope,
            sourceId: intent.current.sourceId,
            content: value,
            reason: reason.trim()
          }
        })
      },
      (result) => {
        if (result && (!('state' in result) || result.state === 'saved')) intent.current = undefined
        onSaved(savedMessage(result))
      },
      savedMessage
    )
  }
  return (
    <details className={revision ? 'learning-method-edit' : 'learning-manual'} open={draft ? true : undefined}>
      <summary>{revision ? '编辑方法并提出修订' : '手动教一个处理方法'}</summary>
      {draft && (
        <label className="form-label">
          <input type="checkbox" id="learning-draft-scope-confirm" checked={scopeConfirmed}
            disabled={disabled} onChange={(event) => setScopeConfirmed(event.target.checked)} />{' '}
          {scope.conversationId
            ? '我已核实所选客户，并确认这份员工教导适用于该客户。旧轨迹不提供客户身份证明。'
            : '我确认这份方法适用于所选账号的通用范围，已移除客户专属信息。'}
        </label>
      )}
      <label className="form-label" htmlFor={`${prefix}-kind`}>
        方法类型
        <select
          id={`${prefix}-kind`}
          className="form-input"
          disabled={disabled}
          value={content.kind}
          onChange={(event) =>
            setContent({ ...content, kind: event.target.value as MemoryContent['kind'] })
          }
        >
          <option value="preference">沟通偏好</option>
          <option value="lesson">处理经验</option>
          <option value="skill">处理技能</option>
        </select>
      </label>
      <label className="form-label" htmlFor={`${prefix}-scenario`}>
        适用场景
        <input
          id={`${prefix}-scenario`}
          className="form-input"
          disabled={disabled}
          value={content.scenario}
          maxLength={1000}
          onChange={(event) => setContent({ ...content, scenario: event.target.value })}
        />
      </label>
      <label className="form-label" htmlFor={`${prefix}-guidance`}>
        正确做法
        <textarea
          id={`${prefix}-guidance`}
          className="form-input"
          disabled={disabled}
          value={content.guidance}
          maxLength={6000}
          onChange={(event) => setContent({ ...content, guidance: event.target.value })}
        />
      </label>
      <label className="form-label" htmlFor={`${prefix}-rationale`}>
        方法依据
        <textarea
          id={`${prefix}-rationale`}
          className="form-input"
          disabled={disabled}
          value={content.rationale}
          maxLength={2000}
          onChange={(event) => setContent({ ...content, rationale: event.target.value })}
        />
      </label>
      <label className="form-label" htmlFor={`${prefix}-steps`}>
        处理步骤（每行一项，最多 30 项）
        <textarea
          id={`${prefix}-steps`}
          className="form-input"
          disabled={disabled}
          value={steps}
          maxLength={30029}
          onChange={(event) => setSteps(event.target.value)}
        />
      </label>
      <label className="form-label" htmlFor={`${prefix}-pitfalls`}>
        常见坑点（每行一项，最多 20 项）
        <textarea
          id={`${prefix}-pitfalls`}
          className="form-input"
          disabled={disabled}
          value={pitfalls}
          maxLength={20019}
          onChange={(event) => setPitfalls(event.target.value)}
        />
      </label>
      <label className="form-label" htmlFor={`${prefix}-verification`}>
        检查项（每行一项，最多 20 项）
        <textarea
          id={`${prefix}-verification`}
          className="form-input"
          disabled={disabled}
          value={verification}
          maxLength={20019}
          onChange={(event) => setVerification(event.target.value)}
        />
      </label>
      <label className="form-label" htmlFor={`${prefix}-reason`}>
        {revision ? '为什么修订' : '为什么教这个方法'}
        <textarea
          id={`${prefix}-reason`}
          className="form-input"
          disabled={disabled}
          value={reason}
          maxLength={2000}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      {revision?.memory.pinned && <p className="form-hint">固定方法需先解除固定，才能提出修订。</p>}
      {operation.error && (
        <p role="alert" className="learning-error">
          {operation.error}
        </p>
      )}
      {operation.notice && <p role="status">{operation.notice}</p>}
      <button
        className="btn btn-primary"
        disabled={
          disabled || (Boolean(draft) && !scopeConfirmed) || !content.scenario.trim() || !content.guidance.trim() || !reason.trim()
        }
        onClick={() => void save()}
      >
        {revision ? '保存修订候选' : '保存候选方法'}
      </button>
    </details>
  )
}
