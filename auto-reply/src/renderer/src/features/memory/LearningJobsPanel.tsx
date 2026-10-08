import type { LearningJob } from '../../../../shared/contracts/learning-memory'
import type { LearningUsageReport } from '../../../../shared/contracts/learning-desktop'
const states: Record<LearningJob['state'], string> = {
  pending: '等待空闲',
  running: '正在复盘',
  completed: '已完成',
  failed: '待重试',
  cancelled: '已取消'
}
const reasons: Record<string, string> = {
  review_model_unconfigured: '请配置可用的文本模型和密钥。',
  review_model_unavailable: '指定的复盘模型已不存在，请重新选择。',
  review_text_model_required: '复盘需要支持文本的模型，请检查模型设置。',
  review_timeout: '复盘超时，将按重试上限处理。',
  foreground_preempted: '前台工作优先，复盘稍后重试。',
  review_auth_failed: '模型鉴权失败，请检查连接。',
  review_rate_limited: '模型限流，稍后重试。',
  review_input_over_budget: '案例超过复盘输入上限，请精简后重试。',
  review_outcome_unverified: '结果尚未确认，不能把这次草稿当作成功流程。',
  review_identity_unverified: '客户身份尚未确认，不能据此学习个人偏好。',
  review_duplicate_method: '本次建议重复了实际使用的方法，复盘需改为修订。',
  learning_usage_over_budget: '模型报告的用量超过请求上限，候选未保存，费用已保留。'
}
export default function LearningJobsPanel({
  jobs,
  usage,
  busy,
  onCancel
}: {
  jobs: LearningJob[]
  usage: LearningUsageReport
  busy: boolean
  onCancel: (jobId: string) => void
}): React.JSX.Element {
  return (
    <section aria-label="后台学习任务">
      <div className="learning-usage">
        <strong>今日学习费用 · {usage.day} UTC</strong>
        <p>
          请求 {usage.requests} 次 · 已计费或保守占额 {usage.reservedTokens.toLocaleString()} tokens
        </p>
        <p>
          服务商返回用量 {usage.reportedRequests} 次 · 保守估算 {usage.estimatedRequests} 次 ·
          其他请求用量可能尚未确认
        </p>
        <p>
          输入 {usage.inputTokens.toLocaleString()} · 输出 {usage.outputTokens.toLocaleString()}
          。取消任务不会返还已消耗预算。
        </p>
      </div>
      {!jobs.length && (
        <p className="learning-empty">
          还没有学习任务。员工纠正、明确的处理结果或同问题的重复质量反馈会触发复盘；试答草稿保留为结果未知的案例。
        </p>
      )}
      {jobs.map((job) => (
        <article key={job.id} className="learning-card">
          <strong>
            {states[job.state]} · 尝试 {job.attempts} 次
          </strong>
          <p>
            案例 {job.episodeIds.length} 个 · 候选 {job.proposedIds.length} 条
          </p>
          {job.lastError && <p>{reasons[job.lastError] ?? job.lastError}</p>}
          {['pending', 'running', 'failed'].includes(job.state) && (
            <button className="btn btn-secondary" disabled={busy} onClick={() => onCancel(job.id)}>
              取消任务
            </button>
          )}
        </article>
      ))}
    </section>
  )
}
