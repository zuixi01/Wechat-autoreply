import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LearningAction,
  LearningWorkbenchSnapshot
} from '../../../../shared/contracts/learning-desktop'
import type {
  LearningEpisode,
  MemoryRecord,
  MemoryRevision,
  MemoryScope
} from '../../../../shared/contracts/learning-memory'
import LearningCorrection from './LearningCorrection'
import MemoryRevisionDiff from './MemoryRevisionDiff'
import LearningJobsPanel from './LearningJobsPanel'
import LearningValidationPanel from './LearningValidationPanel'
import LearningReportsPanel from './LearningReportsPanel'
import LearningEpisodeFeedback from './LearningEpisodeFeedback'
import LearningSettingsPanel from './LearningSettingsPanel'
import LearningMethodEditor from './LearningMethodEditor'
import {
  LearningRequestGuard,
  learningScopeKey,
  learningScopeOptions,
  type LearningRequestToken
} from './learning-view-state'
import './learning-memory.css'
import LearningSubmissionStatus from './LearningSubmissionStatus'
import LearningPublicationPanel from './LearningPublicationPanel'
import { teachingScopeAvailable, type LearningTeachingDraft } from './learning-teaching-draft'

const states = { pending: '待验证', active: '生效中', stale: '待复核', archived: '已归档' }
const kinds = { preference: '沟通偏好', lesson: '处理经验', skill: '处理技能' }
function scopeLabel(scope: MemoryScope): string {
  return `${scope.platform} · ${scope.conversationId ? (scope.conversationId.startsWith('unassigned:') ? `待绑定案例 ${scope.conversationId.slice(-6)}` : `客户 ${scope.conversationId.slice(-8)}`) : '账号通用方法'}`
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请刷新后重试。'
}
export default function LearningMemoryPanel({ draft, onDismissDraft }: {
  draft?: LearningTeachingDraft
  onDismissDraft?: () => void
} = {}): React.JSX.Element {
  const [draftScope, setDraftScope] = useState<{ id: string; key: string }>()
  const [snapshot, setSnapshot] = useState<LearningWorkbenchSnapshot>(),
    [scope, setScope] = useState<MemoryScope>(),
    [view, setView] = useState<'memories' | 'episodes' | 'jobs' | 'validation' | 'reports'>(
      'memories'
    )
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<{ memory: MemoryRecord; history: MemoryRevision[] }>()
  const guard = useRef(new LearningRequestGuard()),
    currentSnapshot = useRef<LearningWorkbenchSnapshot | undefined>(undefined),
    mutation = useRef<LearningRequestToken | null>(null)
  const [detailLoading, setDetailLoading] = useState(''),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState<LearningEpisode[]>(),
    [forgetConfirmed, setForgetConfirmed] = useState(false),
    [privacyEpoch, setPrivacyEpoch] = useState(0)
  const reload = useCallback(async (): Promise<void> => {
    const token = guard.current.begin('snapshot')
    try {
      const data = await window.learningMemory.snapshot(scope ? { scope } : {})
      if (guard.current.accepts(token)) {
        if (scope && learningScopeKey(scope) !== learningScopeKey(data.scope))
          throw new Error('learning_scope_changed')
        const previous = currentSnapshot.current
        if (guard.current.select(data.scope)) {
          setDetail(undefined)
          setDetailLoading('')
          setSearch(undefined)
          setForgetConfirmed(false)
          setQuery('')
          setNotice('')
          mutation.current = null
          setBusy(false)
        }
        const next =
          previous && learningScopeKey(previous.scope) === learningScopeKey(data.scope)
            ? { ...data, scope: previous.scope }
            : data
        currentSnapshot.current = next
        setSnapshot(next)
        setDetail((value) =>
          value &&
          data.memories.some(
            (item) =>
              item.record.id === value.memory.id &&
              item.record.currentRevision === value.memory.currentRevision
          )
            ? value
            : undefined
        )
        setError('')
      }
    } catch (failure) {
      if (guard.current.accepts(token)) {
        currentSnapshot.current = undefined
        setSnapshot(undefined)
        setDetail(undefined)
        setSearch(undefined)
        guard.current.invalidate('detail')
        setDetailLoading('')
        setError(errorText(failure))
        if (
          /DEVICE_SCOPE_CHANGED|learning_scope_unavailable|learning_scope_changed/.test(
            errorText(failure)
          )
        ) {
          guard.current.select(undefined)
          setScope(undefined)
        }
      }
    }
  }, [scope])
  useEffect(() => {
    const current = guard.current
    current.select(scope)
    setDetail(undefined)
    void reload()
    const timer = setInterval(() => {
      if (!mutation.current) void reload()
    }, 5000)
    return () => {
      clearInterval(timer)
      current.invalidateAll()
    }
  }, [reload, scope])
  function chooseScope(value: MemoryScope): void {
    guard.current.select(value)
    currentSnapshot.current = undefined
    mutation.current = null
    setSnapshot(undefined)
    setDetail(undefined)
    setDetailLoading('')
    setSearch(undefined)
    setQuery('')
    setNotice('')
    setError('')
    setBusy(false)
    setForgetConfirmed(false)
    setScope(value)
  }
  async function run<T>(
    work: () => Promise<T>,
    message: string | ((value: T) => string),
    confirmed?: () => void
  ): Promise<void> {
    if (mutation.current) return
    const token = guard.current.begin('mutation')
    mutation.current = token
    guard.current.invalidate('detail')
    setDetailLoading('')
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const value = await work()
      if (!guard.current.accepts(token)) return
      confirmed?.()
      setNotice(typeof message === 'function' ? message(value) : message)
      setDetail(undefined)
      await reload()
    } catch (failure) {
      if (guard.current.accepts(token)) setError(errorText(failure))
    } finally {
      if (mutation.current === token) {
        mutation.current = null
        if (guard.current.accepts(token)) setBusy(false)
      }
    }
  }
  const target = snapshot?.scope
  const scopeKey = learningScopeKey(target)
  const scopes = snapshot ? learningScopeOptions(snapshot) : []
  async function readDetail(memory: MemoryRecord): Promise<void> {
    if (!target) return
    const token = guard.current.begin('detail')
    setDetail(undefined)
    setDetailLoading(memory.id)
    setError('')
    try {
      const value = await window.learningMemory.detail({ scope: target, id: memory.id })
      if (!guard.current.accepts(token)) return
      const current = currentSnapshot.current?.memories.find(
        (item) => item.record.id === memory.id
      )?.record
      if (
        !current ||
        current.currentRevision !== value.memory.currentRevision ||
        value.memory.currentRevision !== memory.currentRevision
      )
        throw new Error('方法版本已改变，请刷新后重新查看。')
      setDetail(value)
    } catch (failure) {
      if (guard.current.accepts(token)) setError(errorText(failure))
    } finally {
      if (guard.current.accepts(token)) setDetailLoading('')
    }
  }
  async function searchCases(): Promise<void> {
    if (!target || !query.trim()) return
    const token = guard.current.begin('detail')
    setSearch(undefined)
    setError('')
    try {
      const value = await window.learningMemory.searchEpisodes({
        scope: target,
        query: query.trim(),
        limit: 10
      })
      if (guard.current.accepts(token)) setSearch(value)
    } catch (failure) {
      if (guard.current.accepts(token)) setError(errorText(failure))
    }
  }
  function act(
    memory: MemoryRecord,
    action: LearningAction['action'],
    extra: Record<string, unknown> = {}
  ): void {
    if (!target) return
    void run(
      () =>
        window.learningMemory.act({
          scope: target,
          action,
          id: memory.id,
          expectedRevision: memory.currentRevision,
          ...extra
        } as LearningAction),
      '操作已保存。'
    )
  }
  return (
    <section className="learning-panel" aria-label="持续学习工作记忆">
      <header>
        <h2>经验与自我学习</h2>
        <p>从案例与员工纠正中学习方法，验证后用于下一次回复。</p>
      </header>
      {error && (
        <p role="alert" className="learning-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="learning-controls">
        <label>
          记忆范围
          <select
            id="learning-scope"
            className="form-input"
            disabled={busy}
            value={target ? JSON.stringify(target) : ''}
            onChange={(event) => {
              const value = scopes.find((item) => JSON.stringify(item) === event.target.value)
              if (value) chooseScope(value)
            }}
          >
            {scopes.map((item) => (
              <option key={JSON.stringify(item)} value={JSON.stringify(item)}>
                {scopeLabel(item)}
              </option>
            ))}
          </select>
        </label>
        {snapshot && (
          <>
            <label>
              <input
                type="checkbox"
                checked={snapshot.settings.memoryEnabled}
                disabled={busy}
                onChange={(event) =>
                  void run(
                    () =>
                      window.learningMemory.settings({
                        scope: target!,
                        patch: { memoryEnabled: event.target.checked }
                      }),
                    '记忆调用设置已保存。'
                  )
                }
              />{' '}
              调用已生效记忆
            </label>
            <label>
              学习方式
              <select
                id="learning-mode"
                className="form-input"
                disabled={busy}
                value={snapshot.settings.mode}
                onChange={(event) =>
                  void run(
                    () =>
                      window.learningMemory.settings({
                        scope: target!,
                        patch: { mode: event.target.value as 'off' | 'suggest' | 'auto' }
                      }),
                    '学习方式已保存。'
                  )
                }
              >
                <option value="off">关闭学习</option>
                <option value="suggest">自动提出建议</option>
                <option value="auto">验证后自动生效</option>
              </select>
            </label>
          </>
        )}
        <button className="btn btn-secondary" disabled={busy} onClick={() => void reload()}>
          刷新
        </button>
      </div>
      <p className="form-hint">
        {target?.tenantId
          ? '当前显示企业授权范围的记忆。企业正式经验由管理员评估发布。'
          : '本机记忆用于本地回复和试答。'}
        客户专属方法需要可信身份；业务事实以有效知识资料为准。
      </p>
      {snapshot && target && target.tenantId && (
        <LearningPublicationPanel status={snapshot.publication} />
      )}
      {snapshot && target && (
        <LearningSubmissionStatus
          key={`submissions:${learningScopeKey(target)}:${privacyEpoch}`}
          scope={target}
          refreshKey={snapshot}
        />
      )}
      {snapshot && target && (
        <LearningSettingsPanel
          key={`${learningScopeKey(target)}:${privacyEpoch}`}
          scope={target}
          settings={snapshot.settings}
          onChanged={() => {
            setNotice('复盘设置已保存。')
            void reload()
          }}
        />
      )}
      <nav className="learning-tabs" aria-label="学习资料">
        <button
          className={`btn ${view === 'memories' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setView('memories')}
        >
          经验与版本
        </button>
        <button
          className={`btn ${view === 'episodes' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setView('episodes')}
        >
          案例与纠正
        </button>
        <button
          className={`btn ${view === 'jobs' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setView('jobs')}
        >
          任务与费用
        </button>
        <button
          className={`btn ${view === 'validation' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setView('validation')}
        >
          校准与验证
        </button>
        <button
          className={`btn ${view === 'reports' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setView('reports')}
        >
          整理与报告
        </button>
      </nav>
      {!snapshot && !error && <p role="status">正在读取工作记忆…</p>}
      {snapshot && view === 'memories' && (
        <>
          {draft && (
            <div className="learning-manual" aria-label="旧资料员工教导">
              <p>旧轨迹和卡片没有可信客户身份。请先选择当前授权范围，再核对内容并确认用途；保存后是待审候选。</p>
              <label>教导保存范围
                <select id="learning-draft-scope" className="form-input" disabled={busy}
                  value={draftScope?.id === draft.id ? draftScope.key : ''}
                  onChange={(event) => {
                    const selected = scopes.find((item) => learningScopeKey(item) === event.target.value && teachingScopeAvailable(item))
                    if (selected) {
                      chooseScope(selected)
                      setDraftScope({ id: draft.id, key: learningScopeKey(selected) })
                    }
                  }}>
                  <option value="">请选择并核对保存范围</option>
                  {scopes.filter(teachingScopeAvailable).map((item) => <option key={learningScopeKey(item)} value={learningScopeKey(item)}>{scopeLabel(item)}</option>)}
                </select>
              </label>
              <button className="btn btn-secondary" onClick={onDismissDraft}>取消旧资料教导</button>
            </div>
          )}
          {(!draft || (draftScope?.id === draft.id && draftScope.key === scopeKey)) && (
          <LearningMethodEditor
            key={`manual:${learningScopeKey(target)}:${privacyEpoch}:${draft?.id ?? ''}`}
            scope={target!}
            draft={draft}
            onSaved={(message) => {
              setNotice(message)
              void reload()
            }}
          />
          )}
          {!snapshot.memories.length && (
            <p className="learning-empty">此范围还没有方法。先试答并纠正，或手动教一个方法。</p>
          )}
          {snapshot.memories.map(({ record, metrics }) => (
            <article className="learning-card" key={record.id}>
              <header>
                <strong>{record.content.scenario}</strong>
                <span>
                  {states[record.state]} · {kinds[record.content.kind]} · 最新 V
                  {record.currentRevision} / 生效{' '}
                  {record.activeRevision ? `V${record.activeRevision}` : '无'}
                </span>
              </header>
              <p>{record.content.guidance}</p>
              {record.content.steps.length > 0 && (
                <ol>
                  {record.content.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              )}
              <p className="form-hint">
                加载 {metrics.loaded} · 员工采纳 {metrics.adopted} · 实质修改{' '}
                {metrics.substantially_corrected} · 事实错误 {metrics.fact_error} · 发送确认{' '}
                {metrics.delivery_confirmed}
              </p>
              <div className="learning-actions">
                <button
                  className="btn btn-secondary"
                  disabled={busy || detailLoading === record.id}
                  onClick={() => void readDetail(record)}
                >
                  查看版本与来源
                </button>
                {record.state !== 'archived' &&
                  record.activeRevision !== record.currentRevision && (
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => act(record, 'activate')}
                    >
                      核对后使 V{record.currentRevision} 生效
                    </button>
                  )}
                <button
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => act(record, 'pin', { pinned: !record.pinned })}
                >
                  {record.pinned ? '取消固定' : '固定方法'}
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => act(record, record.state === 'archived' ? 'restore' : 'archive')}
                >
                  {record.state === 'archived' ? '恢复' : '停用并归档'}
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => act(record, 'forget')}
                >
                  永久遗忘
                </button>
              </div>
              {detail?.memory.id === record.id && (
                <MemoryRevisionDiff
                  key={`${learningScopeKey(detail.memory.scope)}:${detail.memory.id}:${detail.memory.currentRevision}`}
                  memory={detail.memory}
                  history={detail.history}
                  busy={busy}
                  onRollback={(revision) => act(record, 'rollback', { targetRevision: revision })}
                  onChanged={() => {
                    setNotice('修订已保存为候选；现行生效版本继续使用。')
                    void reload()
                  }}
                />
              )}
            </article>
          ))}
          {snapshot.unassigned.length > 0 && (
            <details>
              <summary>旧卡片待整理（{snapshot.unassigned.length}）</summary>
              <p>旧卡片已备份，尚未确定归属，旧引用和发送统计不代表方法有效。</p>
              {snapshot.unassigned.map((item) => (
                <article className="learning-card" key={item.id}>
                  <strong>{item.content.scenario}</strong>
                  <p>{item.content.guidance}</p>
                  <p>
                    旧统计：引用 {item.legacyStats.used} / 发送成功 {item.legacyStats.success}
                  </p>
                  <button
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () =>
                          window.learningMemory.assignLegacy({
                            scope: target!,
                            legacyId: item.id,
                            sourceId: crypto.randomUUID()
                          }),
                        '旧资料已归属为候选，请核对后使其生效。'
                      )
                    }
                  >
                    作为当前范围的候选方法
                  </button>
                </article>
              ))}
            </details>
          )}
        </>
      )}
      {snapshot && view === 'episodes' && (
        <>
          <div className="learning-controls">
            <label htmlFor="learning-case-query">
              查找历史案例
              <input
                id="learning-case-query"
                className="form-input"
                value={query}
                maxLength={240}
                onChange={(event) => {
                  guard.current.invalidate('detail')
                  setSearch(undefined)
                  setQuery(event.target.value)
                }}
              />
            </label>
            <button
              className="btn btn-secondary"
              disabled={busy || !query.trim()}
              onClick={() => void searchCases()}
            >
              搜索案例
            </button>
            {search && (
              <button
                className="btn btn-secondary"
                onClick={() => {
                  guard.current.invalidate('detail')
                  setSearch(undefined)
                }}
              >
                显示最近案例
              </button>
            )}
          </div>
          {search && <p role="status">搜索结果：{search.length}</p>}
          {!snapshot.episodes.length && (
            <p className="learning-empty">此范围还没有案例。知识库试答后可在对应范围查看。</p>
          )}
          {(search ?? snapshot.episodes).map((episode) => (
            <article key={episode.id} className="learning-card" data-learning-episode={episode.id}>
              <strong>{episode.topic}</strong>
              <p>
                {episode.identityStatus === 'unassigned'
                  ? '身份待绑定；不得泛化为所有客户的偏好。'
                  : '来源可追溯'}{' '}
                · {episode.outcome}
              </p>
              {episode.messages.map((message) => (
                <p key={message.sourceId}>
                  {message.role === 'customer' ? '客户：' : '记录：'}
                  {message.text}
                </p>
              ))}
              {episode.draft && <p>原草稿：{episode.draft}</p>}
              {episode.correction && (
                <p>
                  纠正：{episode.correction} · {episode.correctionReason}
                </p>
              )}
              <p className="form-hint">案例编号 {episode.id}</p>
              {episode.draft !== undefined &&
              !/^(manual|legacy-assignment):/.test(episode.sourceId) ? (
                <>
                  <LearningCorrection
                    key={`${scopeKey}:${episode.id}`}
                    scope={target!}
                    episodeId={episode.id}
                    draft={episode.correction ?? episode.draft ?? ''}
                    onSaved={() => void reload()}
                  />
                  <LearningEpisodeFeedback
                    key={`feedback:${scopeKey}:${episode.id}`}
                    scope={target!}
                    episodeId={episode.id}
                    onSaved={() => void reload()}
                  />
                </>
              ) : (
                <p className="form-hint">人工来源案例；通过方法版本管理进行核对与修订。</p>
              )}
              <button
                className="btn btn-secondary"
                disabled={busy || snapshot.settings.mode === 'off'}
                onClick={() =>
                  void run(
                    () =>
                      window.learningMemory.review({
                        scope: target!,
                        episodeId: episode.id,
                        sourceId: crypto.randomUUID()
                      }),
                    (value) =>
                      value.jobId
                        ? '已排入复盘队列。'
                        : '本次未排入复盘队列，请检查学习设置和任务状态。'
                  )
                }
              >
                重新复盘
              </button>
            </article>
          ))}
        </>
      )}
      {snapshot && view === 'jobs' && (
        <LearningJobsPanel
          jobs={snapshot.jobs}
          usage={snapshot.usage}
          busy={busy}
          onCancel={(jobId) =>
            void run(() => window.learningMemory.cancel({ scope: target!, jobId }), '任务已取消。')
          }
        />
      )}
      {snapshot && view === 'validation' && (
        <LearningValidationPanel
          key={`validation:${scopeKey}:${privacyEpoch}`}
          scope={target!}
          memories={snapshot.memories.map((item) => item.record)}
          onChanged={() => void reload()}
        />
      )}
      {snapshot && view === 'reports' && (
        <LearningReportsPanel
          key={`reports:${scopeKey}:${privacyEpoch}`}
          scope={target!}
          onChanged={() => void reload()}
        />
      )}
      {snapshot && (
        <details className="learning-manual">
          <summary>遗忘当前范围的全部学习资料</summary>
          <p>将删除此范围的案例、方法和检索资料，取消相关学习任务。此操作不能通过恢复归档撤回。</p>
          <label>
            <input
              type="checkbox"
              checked={forgetConfirmed}
              disabled={busy}
              onChange={(event) => setForgetConfirmed(event.target.checked)}
            />{' '}
            我确认彻底遗忘当前范围
          </label>
          <div className="learning-actions">
            <button
              className="btn btn-secondary"
              disabled={busy || !forgetConfirmed}
              onClick={() =>
                void run(
                  () => window.learningMemory.forgetScope({ scope: target! }),
                  '当前范围的学习资料已遗忘。',
                  () => {
                    setPrivacyEpoch((value) => value + 1)
                    currentSnapshot.current = undefined
                    setSnapshot(undefined)
                    setSearch(undefined)
                    setQuery('')
                    setForgetConfirmed(false)
                  }
                )
              }
            >
              彻底遗忘当前范围
            </button>
          </div>
        </details>
      )}
    </section>
  )
}
