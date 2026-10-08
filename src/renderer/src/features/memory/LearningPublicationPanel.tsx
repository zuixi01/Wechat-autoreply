import type { LearningPublicationStatus } from '../../../../shared/contracts/learning-publication-status'

const states = {
  unpublished: '尚未正式发布',
  current: '正式配置已包含当前有效方法',
  outdated: '方法已变化，需要重新准备并发布',
  unavailable: '发布资料不完整，请管理员核查'
}

export default function LearningPublicationPanel({
  status
}: {
  status?: LearningPublicationStatus
}): React.JSX.Element {
  return (
    <section className="learning-card learning-publication" aria-label="企业正式发布">
      <h3>企业正式发布</h3>
      <p role="status">
        {status ? states[status.state] : '暂时无法读取发布状态，请刷新或联系管理员。'}
      </p>
      {status && (
        <>
          <p>
            全账号有效方法 {status.currentMethodCount} 条
            {status.published && ` · 正式配置包含 ${status.published.methodCount} 条`}
            {status.serverPaused && ' · 账号处于暂停状态'}
          </p>
          <p className="form-hint">
            请管理员按当前方法版本准备草案；启用自动回复需完成独立验收后发布。
            发布状态不代表发送权限。
          </p>
          <details>
            <summary>提供给管理员的版本信息</summary>
            <textarea
              aria-label="管理员发布版本信息"
              className="form-input"
              readOnly
              rows={6}
              value={JSON.stringify(
                {
                  tenantId: status.tenantId,
                  accountId: status.accountId,
                  currentMemoryCorpusVersion: status.currentMemoryCorpusVersion,
                  currentMethodCount: status.currentMethodCount,
                  publishedConfigVersion: status.published?.configVersion ?? null,
                  publishedMemoryCorpusVersion: status.published?.memoryCorpusVersion ?? null
                },
                null,
                2
              )}
            />
          </details>
        </>
      )}
    </section>
  )
}
