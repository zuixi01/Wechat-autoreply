import type { MemoryRecord, MemoryRevision } from '../../../../shared/contracts/learning-memory'
import LearningMethodEditor from './LearningMethodEditor'
import LearningSourceDetails from './LearningSourceDetails'
import { learningScopeKey } from './learning-view-state'
function RevisionContent({ revision }: { revision?: MemoryRevision }): React.JSX.Element {
  if (!revision) return <p>尚未生效，回复不会调用这条方法。</p>
  const content = revision.content
  return (
    <>
      <p>适用场景：{content.scenario}</p>
      <p>{content.guidance}</p>
      {content.rationale && <p>方法依据：{content.rationale}</p>}
      {content.steps.length > 0 && (
        <>
          <strong>处理步骤</strong>
          <ol>
            {content.steps.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ol>
        </>
      )}
      {content.pitfalls.length > 0 && (
        <>
          <strong>常见坑点</strong>
          <ul>
            {content.pitfalls.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {content.verification.length > 0 && (
        <>
          <strong>检查项</strong>
          <ul>
            {content.verification.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}
export default function MemoryRevisionDiff({
  memory,
  history,
  busy,
  onRollback,
  onChanged
}: {
  memory: MemoryRecord
  history: MemoryRevision[]
  busy: boolean
  onRollback: (revision: number) => void
  onChanged: () => void
}): React.JSX.Element {
  const current = history.find((revision) => revision.revision === memory.currentRevision),
    active = history.find((revision) => revision.revision === memory.activeRevision)
  return (
    <section className="learning-revisions" aria-label="记忆版本与差异">
      <h4>版本与修改依据</h4>
      <div className="learning-diff">
        <article>
          <strong>当前生效 {active ? `V${active.revision}` : '无'}</strong>
          <RevisionContent revision={active} />
        </article>
        <article>
          <strong>最新版本 V{memory.currentRevision}</strong>
          <RevisionContent revision={current} />
          <p>{current?.reason}</p>
        </article>
      </div>
      {history.map((revision) => (
        <article key={revision.revision} className="learning-version">
          <strong>
            V{revision.revision} · {revision.activatedAt === null ? '候选' : '曾生效'}
          </strong>
          <p>{revision.reason}</p>
          <p>证据案例：</p>
          {revision.evidence.map((evidence) => (
            <LearningSourceDetails
              key={`${learningScopeKey(memory.scope)}:${revision.revision}:${evidence.episodeId}`}
              scope={memory.scope}
              episodeId={evidence.episodeId}
              redacted={Boolean(revision.redactedEvidenceIds?.includes(evidence.episodeId))}
            />
          ))}
          {revision.activatedAt !== null && revision.revision !== memory.activeRevision && (
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => onRollback(revision.revision)}
            >
              恢复 V{revision.revision} 的内容
            </button>
          )}
        </article>
      ))}
      {current && (
        <LearningMethodEditor
          key={`${learningScopeKey(memory.scope)}:${memory.id}:${memory.currentRevision}`}
          scope={memory.scope}
          revision={{ memory, evidence: current.evidence }}
          onSaved={onChanged}
        />
      )}
    </section>
  )
}
