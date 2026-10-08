import { useCallback, useEffect, useRef, useState } from 'react'
import {
  KNOWLEDGE_EXTENSIONS,
  KnowledgeSnapshotSchema,
  type KnowledgeDocument,
  type KnowledgeSnapshot,
  type KnowledgeHit,
  type KnowledgeReply
} from '../../../../shared/contracts/knowledge'
import './knowledge.css'
import LearningCorrection from '../memory/LearningCorrection'

type Mode = {
  id: string
  name: string
  prompt: string
  unifiedPrefix: string
  specificObjects: { id: string; name: string; replyRules?: string }[]
}
const states = { processing: '正在解析', ready: '可用', failed: '解析失败' }
export default function KnowledgePanel({
  active,
  modes,
  activeModeId
}: {
  active: boolean
  modes: Mode[]
  activeModeId: string
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot>()
  const [error, setError] = useState('')
  const [view, setView] = useState<'documents' | 'test'>('documents')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [filter, setFilter] = useState('all')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [editor, setEditor] = useState<{
    id?: string
    name: string
    category: string
    content: string
  } | null>(null)
  const [deleting, setDeleting] = useState<KnowledgeDocument>()
  const [question, setQuestion] = useState('')
  const [objectId, setObjectId] = useState('')
  const [hits, setHits] = useState<KnowledgeHit[]>()
  const [answer, setAnswer] = useState<KnowledgeReply>()
  const [resultInput, setResultInput] = useState('')
  const [fallback, setFallback] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<string | undefined>(undefined)
  const operation = useRef(false)
  const load = useCallback(async () => {
    try {
      if (!window.knowledge) throw new Error('请使用桌面客户端管理知识。')
      setSnapshot(KnowledgeSnapshotSchema.parse(await window.knowledge.snapshot()))
    } catch {
      setError('无法读取知识库，请刷新或在桌面客户端重试。')
    }
  }, [])
  useEffect(() => {
    if (!active) return
    void load()
    const timer = setInterval(() => void load(), 2000)
    return () => clearInterval(timer)
  }, [active, load])
  const run = async (label: string, action: () => Promise<void>): Promise<void> => {
    if (operation.current) return
    operation.current = true
    setBusy(label)
    setError('')
    setNotice('')
    try {
      await action()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试。')
    } finally {
      operation.current = false
      setBusy('')
    }
  }
  const documents = snapshot?.documents ?? []
  const categories = [...new Set(documents.map((d) => d.category).filter(Boolean))].sort()
  const filtered = documents.filter(
    (d) =>
      (!search || `${d.name} ${d.category}`.toLowerCase().includes(search.toLowerCase())) &&
      (!category || d.category === category) &&
      (filter === 'all' || (filter === 'disabled' ? !d.enabled : d.state === filter))
  )
  const objectRows = modes.flatMap((mode) =>
    mode.specificObjects.map((object) => ({ mode, object }))
  )
  const selectedObject = objectRows.find((row) => row.object.id === objectId)
  const selectedMode = objectId
    ? selectedObject?.mode
    : modes.find((mode) => mode.id === activeModeId)
  const resultFingerprint = (version: string | undefined): string =>
    JSON.stringify([
      question,
      selectedMode?.id,
      selectedMode?.prompt,
      selectedMode?.unifiedPrefix,
      selectedObject?.object,
      objectId,
      modes.find((mode) => mode.id === activeModeId),
      version
    ])
  const resultKey = resultFingerprint(snapshot?.version)
  const currentResult = resultInput === resultKey
  const upload = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return
    const replace = replaceRef.current
    replaceRef.current = undefined
    await run('上传资料', async () => {
      let succeeded = 0
      const failures: string[] = []
      for (const file of Array.from(files).slice(0, replace ? 1 : 10)) {
        if (file.size > 10485760 || file.size === 0) {
          failures.push(`${file.name}：文件需为非空，且不超过 10 MB。`)
          continue
        }
        const result = await window.knowledge.importFile({
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
          category: category || '',
          ...(replace ? { replaceId: replace } : {})
        })
        if (result.success) succeeded++
        else failures.push(`${file.name}：${result.error || '解析失败'}`)
        await load()
      }
      setNotice(
        `${succeeded} 份资料已加入知识库。${files.length > 10 ? '每批最多 10 份，其余资料请另行上传。' : ''}`
      )
      if (failures.length) setError(failures.join('\n'))
    })
    if (inputRef.current) inputRef.current.value = ''
  }
  return (
    <div className="knowledge-page">
      <header className="knowledge-header">
        <div>
          <h2>让资料成为 AI 的回复依据</h2>
          <p>上传业务资料，让 AI 结合通用规则和用户专属要求回复。</p>
        </div>
        <span className="knowledge-count">
          {documents.filter((d) => d.state === 'ready' && d.enabled).length} 份可用资料 ·{' '}
          {snapshot?.settings.enabled ? '知识库已启用' : '知识库已暂停'}
        </span>
      </header>
      <div className="knowledge-tabs" role="tablist" aria-label="知识管理页面">
        <button
          role="tab"
          id="knowledge-tab-documents"
          aria-selected={view === 'documents'}
          aria-controls="knowledge-documents"
          onClick={() => setView('documents')}
        >
          资料管理
        </button>
        <button
          role="tab"
          id="knowledge-tab-test"
          aria-selected={view === 'test'}
          aria-controls="knowledge-test"
          onClick={() => setView('test')}
        >
          检索与试答
        </button>
      </div>
      {error && (
        <p className="knowledge-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="knowledge-notice" role="status">
          {notice}
        </p>
      )}
      <section
        id="knowledge-documents"
        role="tabpanel"
        aria-labelledby="knowledge-tab-documents"
        hidden={view !== 'documents'}
      >
        <div className="workspace-panel knowledge-library">
          <header className="knowledge-library-heading">
            <div>
              <h3>资料库</h3>
              <p>上传资料或手动录入，解析完成后即可检索。</p>
            </div>
            <div className="knowledge-actions">
              <button
                className="btn btn-secondary"
                disabled={!!busy}
                onClick={() => setEditor({ name: '', category: category || '', content: '' })}
              >
                手动录入
              </button>
              <button
                className="btn btn-primary"
                disabled={!!busy}
                onClick={() => {
                  replaceRef.current = undefined
                  if (inputRef.current) inputRef.current.multiple = true
                  inputRef.current?.click()
                }}
              >
                {busy === '上传资料' ? '正在上传…' : '上传资料'}
              </button>
            </div>
          </header>
          <input
            ref={inputRef}
            type="file"
            hidden
            multiple
            accept={KNOWLEDGE_EXTENSIONS.map((e) => '.' + e).join(',')}
            aria-label="上传知识资料"
            onChange={(event) => void upload(event.target.files)}
          />
          <p className="knowledge-formats">
            支持 TXT、Markdown、CSV、JSON、DOCX、XLSX、含文本的 PDF。每份最多 10
            MB；扫描件请先转为文字。
          </p>
          <div className="knowledge-toolbar">
            <input
              className="form-input"
              aria-label="搜索知识资料"
              placeholder="搜索资料名称或分类"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="form-input"
              aria-label="筛选知识分类"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">全部分类</option>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <select
              className="form-input"
              aria-label="筛选资料状态"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">全部状态</option>
              <option value="ready">可用</option>
              <option value="processing">正在解析</option>
              <option value="failed">解析失败</option>
              <option value="disabled">已停用</option>
            </select>
          </div>
          {filtered.length ? (
            <div className="knowledge-table-scroll">
              <table className="knowledge-table">
                <thead>
                  <tr>
                    <th>资料名称</th>
                    <th>分类</th>
                    <th>状态</th>
                    <th>文字 / 片段</th>
                    <th>更新日期</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <strong>{d.name}</strong>
                        <small>
                          {d.format.toUpperCase()} · 第 {d.version} 版
                        </small>
                        {d.error && <span className="knowledge-document-error">{d.error}</span>}
                      </td>
                      <td title={d.category || '未分类'}>{d.category || '未分类'}</td>
                      <td>
                        <span className={`knowledge-status ${d.enabled ? d.state : 'disabled'}`}>
                          {d.enabled ? states[d.state] : '已停用'}
                        </span>
                      </td>
                      <td>
                        {d.characters.toLocaleString()} 字 / {d.chunks} 段
                      </td>
                      <td>{new Date(d.updatedAt).toLocaleDateString('zh-CN')}</td>
                      <td>
                        <div className="knowledge-row-actions">
                          <button
                            className="btn btn-text"
                            disabled={!!busy || d.state === 'processing'}
                            aria-label={`查看编辑 ${d.name}`}
                            onClick={() =>
                              void run('读取资料', async () => {
                                const detail = await window.knowledge.detail(d.id)
                                setEditor({
                                  id: d.id,
                                  name: d.name,
                                  category: d.category,
                                  content: detail.content
                                })
                              })
                            }
                          >
                            查看 / 编辑
                          </button>
                          {d.state === 'ready' ? (
                            <button
                              className="btn btn-text"
                              disabled={!!busy}
                              onClick={() =>
                                void run('更新状态', async () => {
                                  await window.knowledge.update({ id: d.id, enabled: !d.enabled })
                                  setNotice(
                                    d.enabled ? '资料已停用，不再参与回复检索。' : '资料已启用。'
                                  )
                                })
                              }
                            >
                              {d.enabled ? '停用' : '启用'}
                            </button>
                          ) : (
                            <button
                              className="btn btn-text"
                              disabled={!!busy}
                              onClick={() => {
                                replaceRef.current = d.id
                                if (inputRef.current) inputRef.current.multiple = false
                                inputRef.current?.click()
                              }}
                            >
                              重新上传
                            </button>
                          )}
                          <button
                            className="btn btn-text knowledge-delete"
                            disabled={!!busy || d.state === 'processing'}
                            aria-label={`删除资料 ${d.name}`}
                            onClick={() => setDeleting(d)}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="knowledge-empty">
              <span aria-hidden="true">▤</span>
              <h3>{documents.length ? '没有匹配的资料' : '添加第一份知识资料'}</h3>
              <p>
                {documents.length
                  ? '调整搜索或筛选条件后再试。'
                  : '产品介绍、常见问题、服务政策和表格数据，都可以作为回复依据。'}
              </p>
            </div>
          )}
        </div>
        <details className="workspace-panel knowledge-settings">
          <summary>知识库设置</summary>
          <label className="knowledge-toggle">
            <input
              type="checkbox"
              checked={snapshot?.settings.enabled ?? true}
              disabled={!snapshot || !!busy}
              onChange={(e) =>
                void run('保存设置', async () => {
                  await window.knowledge.settings({
                    ...snapshot!.settings,
                    enabled: e.target.checked
                  })
                  setNotice('知识库设置已保存。')
                })
              }
            />
            启用共享知识库
          </label>
          <label className="form-label" htmlFor="knowledge-fallback">
            没有找到依据时的回复
          </label>
          <textarea
            id="knowledge-fallback"
            className="form-input"
            value={fallback ?? snapshot?.settings.fallbackReply ?? ''}
            maxLength={1000}
            onChange={(e) => setFallback(e.target.value)}
          />
          <button
            className="btn btn-secondary"
            disabled={!!busy || !snapshot || !(fallback ?? snapshot.settings.fallbackReply).trim()}
            onClick={() =>
              void run('保存设置', async () => {
                await window.knowledge.settings({
                  ...snapshot!.settings,
                  fallbackReply: fallback ?? snapshot!.settings.fallbackReply
                })
                setFallback(undefined)
                setNotice('兜底回复已保存。')
              })
            }
          >
            保存设置
          </button>
        </details>
        <details className="workspace-panel knowledge-settings">
          <summary>企业知识发布</summary>
          <p>
            本机资料用于本地回复和试答。企业自动回复使用企业服务已发布的知识版本；将本库导出并由管理员审核发布后，再在主页同步企业规则。上传不会自动覆盖企业已审核的知识。
          </p>
          <button
            className="btn btn-secondary"
            disabled={!!busy}
            onClick={() =>
              void run('导出知识', async () => {
                const data = await window.knowledge.export()
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
                )
                const link = document.createElement('a')
                link.href = url
                link.download = 'autoreply-knowledge.json'
                link.click()
                setTimeout(() => URL.revokeObjectURL(url), 1000)
                setNotice('已导出当前启用的知识资料。')
              })
            }
          >
            导出企业知识包
          </button>
        </details>
      </section>
      <section
        id="knowledge-test"
        role="tabpanel"
        aria-labelledby="knowledge-tab-test"
        hidden={view !== 'test'}
        className="knowledge-test-grid"
      >
        <div className="workspace-panel knowledge-question">
          <h3>检索与试答</h3>
          <p>输入一个客户问题，先检查依据，再试用你的模型和回复规则。</p>
          <label className="form-label" htmlFor="knowledge-question">
            客户问题
          </label>
          <textarea
            id="knowledge-question"
            className="form-input"
            placeholder="例如：你们的服务时间是什么？"
            value={question}
            maxLength={8000}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <p className="form-hint">
            默认使用主页通用规则；选择对象用户后，会结合该用户的专属回复要求。
          </p>
          <label className="form-label" htmlFor="knowledge-object">
            对象用户（可选）
          </label>
          <select
            id="knowledge-object"
            className="form-input"
            value={objectId}
            onChange={(e) => setObjectId(e.target.value)}
          >
            <option value="">不指定对象</option>
            {objectRows.map(({ object: o }) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <div className="knowledge-actions">
            <button
              className="btn btn-secondary"
              disabled={!!busy || !question.trim()}
              onClick={() =>
                void run('检索知识', async () => {
                  const result = await window.knowledge.search(question)
                  setHits(result.hits)
                  setAnswer(undefined)
                  setResultInput(resultFingerprint(result.version))
                })
              }
            >
              {busy === '检索知识' ? '正在检索…' : '只检索知识'}
            </button>
            <button
              className="btn btn-primary"
              disabled={!!busy || !question.trim() || !selectedMode || !snapshot?.settings.enabled}
              onClick={() =>
                void run('生成试答', async () => {
                  setHits(undefined)
                  setAnswer(undefined)
                  const result = await window.knowledge.answer({
                    question,
                    modeId: selectedMode!.id,
                    ...(objectId ? { objectId } : {})
                  })
                  setAnswer(result)
                  setHits(result.hits)
                  setResultInput(resultFingerprint(result.version))
                })
              }
            >
              {busy === '生成试答' ? '正在生成…' : '生成试答'}
            </button>
          </div>
          <p className="form-hint">试答调用主页选定的回复模型，仅显示结果，不向聊天客户端发送。</p>
        </div>
        <div className="knowledge-test-results">
          <section className="workspace-panel knowledge-answer">
            <h3>AI 回复</h3>
            {currentResult && answer ? (
              <>
                <span className="knowledge-status ready">
                  {answer.fallback ? '使用兜底回复' : '根据知识与规则生成'}
                </span>
                <p className="knowledge-answer-text">{answer.text}</p>
                {answer.learning && (
                  <>
                    <p className="form-hint">
                      工作记忆加载 {answer.learning.memoryRefs.length}{' '}
                      条；本次试答已记录为学习案例。
                    </p>
                    <LearningCorrection
                      key={answer.learning.episodeId}
                      scope={answer.learning.scope}
                      episodeId={answer.learning.episodeId}
                      draft={answer.text}
                    />
                  </>
                )}
              </>
            ) : (
              <p className="knowledge-result-empty">
                {busy === '生成试答'
                  ? 'AI 正在结合知识和规则生成回复…'
                  : '生成试答后，回复会显示在这里。'}
              </p>
            )}
          </section>
          <section className="workspace-panel knowledge-evidence">
            <h3>检索依据</h3>
            {currentResult && hits ? (
              hits.length ? (
                hits.map((hit) => (
                  <article key={hit.chunkId}>
                    <header>
                      <strong>{hit.name}</strong>
                      <span>
                        第 {hit.version} 版 · {hit.category || '未分类'}
                      </span>
                    </header>
                    <p>{hit.text}</p>
                  </article>
                ))
              ) : (
                <p className="knowledge-result-empty">
                  没有找到相关的启用资料。请补充资料或调整问题；AI 将使用兜底回复。
                </p>
              )
            ) : (
              <p className="knowledge-result-empty">检索或试答后，这里展示找到的资料片段。</p>
            )}
          </section>
        </div>
      </section>
      {editor && (
        <div
          className="modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setEditor(null)
          }}
        >
          <div
            className="modal-content modal-content-with-footer knowledge-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="knowledge-editor-heading"
          >
            <h2 id="knowledge-editor-heading">{editor.id ? '查看 / 编辑资料' : '手动录入知识'}</h2>
            <div className="modal-body">
              {error && (
                <p role="alert" className="knowledge-error">
                  {error}
                </p>
              )}
              <label className="form-label" htmlFor="knowledge-name">
                资料名称
              </label>
              <input
                id="knowledge-name"
                className="form-input"
                value={editor.name}
                maxLength={240}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              />
              <label className="form-label" htmlFor="knowledge-category">
                分类（可选）
              </label>
              <input
                id="knowledge-category"
                className="form-input"
                value={editor.category}
                maxLength={80}
                placeholder="例如：产品、售后、服务政策"
                onChange={(e) => setEditor({ ...editor, category: e.target.value })}
              />
              <label className="form-label" htmlFor="knowledge-content">
                知识内容
              </label>
              <textarea
                id="knowledge-content"
                className="form-input"
                value={editor.content}
                maxLength={2000000}
                placeholder="写入准确、完整的业务资料或常见问题答案。"
                onChange={(e) => setEditor({ ...editor, content: e.target.value })}
              />
              <p className="form-hint">保存后会重新建立索引，后续回复使用最新内容。</p>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                disabled={!!busy}
                onClick={() => setEditor(null)}
              >
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={!!busy || !editor.name.trim() || !editor.content.trim()}
                onClick={() =>
                  void run('保存资料', async () => {
                    await window.knowledge.save(editor)
                    setEditor(null)
                    setNotice('资料已保存，可用于检索和回复。')
                  })
                }
              >
                {busy === '保存资料' ? '正在保存…' : '保存资料'}
              </button>
            </div>
          </div>
        </div>
      )}
      {deleting && (
        <div className="modal-overlay">
          <div
            className="modal-content"
            role="dialog"
            aria-modal="true"
            aria-labelledby="knowledge-delete-heading"
          >
            <h2 id="knowledge-delete-heading">删除知识资料</h2>
            <p>删除「{deleting.name}」后，后续检索和回复不会再使用它。你上传的原文件不受影响。</p>
            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                disabled={!!busy}
                onClick={() => setDeleting(undefined)}
              >
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={!!busy}
                onClick={() =>
                  void run('删除资料', async () => {
                    await window.knowledge.remove(deleting.id)
                    setDeleting(undefined)
                    setNotice('资料已删除。')
                  })
                }
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
