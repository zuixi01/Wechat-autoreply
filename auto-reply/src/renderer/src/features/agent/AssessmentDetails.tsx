import type { AssessmentExplanation } from '../../../../shared/contracts/assessment-explanation'
import type { WorkbenchRow } from '../../../../shared/contracts/workbench'
import ReferenceViewer from './ReferenceViewer'

const intents = {
  faq: '产品或服务咨询',
  price: '价格与报价',
  order: '订单与交付',
  aftersales: '售后处理',
  other: '其他或尚不明确'
}
const recommendations = {
  automatic: '按当前建议自动回复',
  review: '核对草稿后由员工确认发送',
  handoff: '由员工继续处理'
}
function date(value: number): string {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleString('zh-CN', { hour12: false })
    : '日期不可用'
}
export default function AssessmentDetails({
  explanation,
  asOf,
  row
}: {
  explanation?: AssessmentExplanation
  asOf: number
  row: WorkbenchRow
}): React.JSX.Element {
  if (!explanation)
    return (
      <>
        <p className="enterprise-copy">这条记录未保存完整评估说明，请核对客户消息和业务资料。</p>
        {row.canReadEvidence && <ReferenceViewer row={row} asOf={asOf} />}
      </>
    )
  return (
    <div className="enterprise-assessment">
      <p className="enterprise-task-text">
        <span>识别到的诉求</span>
        {explanation.intents.length
          ? explanation.intents.map((intent) => intents[intent]).join('、')
          : '尚未可靠识别，请人工确认。'}
      </p>
      <p className="enterprise-task-text">
        <span>生成时的处理建议</span>
        {recommendations[explanation.recommendation]}
      </p>
      <p className="enterprise-copy">
        {explanation.factsVerified
          ? '事实检查：草稿与经审核的知识原文一致。'
          : '业务事实仍需员工核实，不能仅凭模型审核认为内容正确。'}
      </p>
      <details className="enterprise-evidence">
        <summary>草稿引用的业务依据（{explanation.totalReferences} 条）</summary>
        {explanation.evidence.length === 0 && (
          <p className="enterprise-copy">未保存可展示的有效业务依据，请人工核实。</p>
        )}
        {explanation.evidence.map((evidence) => (
          <div className="enterprise-evidence-item" key={evidence.evidenceId}>
            <p className="enterprise-task-text">
              <span>
                {evidence.kind === 'approved_faq' ? '经审核的业务知识' : '已核实的业务记录'}
              </span>
              {evidence.source}
            </p>
            <p className="enterprise-task-text">
              <span>资料摘录{evidence.excerptTruncated ? '（已截取，需核对完整资料）' : ''}</span>
              {evidence.excerpt}
            </p>
            <p className="form-hint">
              资料标注有效期：{date(evidence.validFrom)} 至 {date(evidence.expiresAt)}。
              {asOf >= evidence.expiresAt ? '资料已过期，请重新核实。' : ''}
            </p>
          </div>
        ))}
        {explanation.unavailableReferences > 0 && (
          <p className="enterprise-copy">
            有 {explanation.unavailableReferences}{' '}
            条引用未通过本任务的适用范围或有效期检查，未展示其内容。
          </p>
        )}
        {explanation.omittedReferences > 0 && (
          <p className="enterprise-copy">
            另有 {explanation.omittedReferences} 条有效引用未在此展开，请核对完整业务资料。
          </p>
        )}
        {row.canReadEvidence && <ReferenceViewer row={row} asOf={asOf} />}
      </details>
      <p className="form-hint">
        以上是生成时保存的评估和资料摘录，仅供核对；编辑、会话变化或资料过期后，需要重新审核。
      </p>
    </div>
  )
}
