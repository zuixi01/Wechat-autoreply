import { useState } from 'react'
import type { LearningEpisode, MemoryScope } from '../../../../shared/contracts/learning-memory'
import { useLearningOperation } from './use-learning-operation'

const outcomes = {
  unknown: '结果未确认',
  corrected: '已提供纠正',
  resolved: '已确认解决',
  failed: '未解决',
  handoff: '已转人工'
}
const roles = { customer: '客户', employee: '员工', assistant: '助手' }
export default function LearningSourceDetails({
  scope,
  episodeId,
  redacted
}: {
  scope: MemoryScope
  episodeId: string
  redacted: boolean
}): React.JSX.Element {
  const operation = useLearningOperation(scope)
  const [episode, setEpisode] = useState<LearningEpisode>()
  async function open(): Promise<void> {
    setEpisode(undefined)
    await operation.execute(
      () => window.learningMemory.episode({ scope, episodeId }),
      (value) => setEpisode(value)
    )
  }
  return (
    <div className="learning-source">
      <span>案例 {episodeId}</span>{' '}
      {redacted ? (
        <span>来源已删除</span>
      ) : (
        <button className="btn btn-secondary" disabled={operation.busy} onClick={() => void open()}>
          查看案例
        </button>
      )}
      {operation.error && (
        <p role="alert" className="learning-error">
          来源不可用、已过期或已遗忘：{operation.error}
        </p>
      )}
      {!redacted && episode && (
        <article aria-label="方法来源案例">
          <strong>{episode.topic}</strong>
          <p>
            {/^manual:/.test(episode.sourceId)
              ? '员工手动教导来源；不代表生产问题已解决。'
              : outcomes[episode.outcome]}
          </p>
          {episode.messages.map((message) => (
            <p key={message.sourceId}>
              <strong>{roles[message.role]}：</strong>
              {message.text}
            </p>
          ))}
          {episode.draft && <p>原草稿：{episode.draft}</p>}
          {episode.correction && <p>正确回复：{episode.correction}</p>}
          {episode.correctionReason && <p>修改依据：{episode.correctionReason}</p>}
          <p>来源时间：{new Date(episode.startedAt).toLocaleString()}</p>
          <button className="btn btn-secondary" onClick={() => setEpisode(undefined)}>
            收起来源
          </button>
        </article>
      )}
    </div>
  )
}
