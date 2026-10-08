// Offline design entry only; never bundled with the production desktop UI.
import type { KnowledgeDesktopApi, KnowledgeDocument } from '../shared/contracts/knowledge'
import { knowledgeTerms, splitKnowledge } from '../core/knowledge/retrieval'
type Entry = { document: KnowledgeDocument; content: string }
const now = Date.now()
let records: Entry[] = []
let settings = {
  enabled: true,
  fallbackReply: '目前资料中没有这方面的信息，我先核实一下再回复您。'
}
let version = crypto.randomUUID()
const find = (id: string): Entry => {
  const row = records.find((r) => r.document.id === id)
  if (!row) throw new Error('资料不存在。')
  return row
}
const save = (input: {
  id?: string
  name: string
  category: string
  content: string
  format?: string
}): KnowledgeDocument => {
  const previous = input.id ? find(input.id).document : undefined
  const content = input.content.trim()
  if (!content) throw new Error('资料没有可读取的文字。')
  const document: KnowledgeDocument = {
    id: previous?.id ?? crypto.randomUUID(),
    name: input.name,
    category: input.category,
    format: input.format ?? 'manual',
    state: 'ready',
    enabled: previous?.enabled ?? true,
    characters: content.length,
    chunks: splitKnowledge(content).length,
    createdAt: previous?.createdAt ?? now,
    updatedAt: Date.now(),
    version: (previous?.version ?? 0) + 1
  }
  records = records.filter((r) => r.document.id !== document.id)
  records.push({ document, content })
  version = crypto.randomUUID()
  return structuredClone(document)
}
save({
  name: '服务介绍与常见问题.md',
  category: '服务政策',
  format: 'md',
  content:
    '服务时间：周一至周五 09:00—18:00，节假日以公告为准。\n售后支持：请提供产品名称和问题描述，我们会安排工作人员协助处理。'
})
export const previewKnowledge: KnowledgeDesktopApi = {
  async snapshot() {
    return structuredClone({ version, settings, documents: records.map((r) => r.document) })
  },
  async save(input) {
    return save(input)
  },
  async detail(id) {
    return structuredClone(find(id))
  },
  async update(input) {
    Object.assign(find(input.id).document, input, { updatedAt: Date.now() })
    version = crypto.randomUUID()
  },
  async remove(id) {
    find(id)
    records = records.filter((r) => r.document.id !== id)
    version = crypto.randomUUID()
  },
  async settings(input) {
    settings = structuredClone(input)
    version = crypto.randomUUID()
  },
  async search(query) {
    const terms = knowledgeTerms(query)
    const hits = settings.enabled
      ? records
          .filter((r) => r.document.enabled)
          .flatMap((r) =>
            splitKnowledge(r.content).map((text, index) => ({
              documentId: r.document.id,
              name: r.document.name,
              category: r.document.category,
              chunkId: `${r.document.id}:${index}`,
              text,
              score: terms.filter((term) => knowledgeTerms(text).includes(term)).length,
              version: r.document.version
            }))
          )
          .filter((h) => h.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 8)
      : []
    return { version, hits }
  },
  async answer(input) {
    const result = await this.search(input.question)
    return {
      ...result,
      text: result.hits.length
        ? '【离线演示，未调用模型】\n' + result.hits[0].text
        : settings.fallbackReply,
      fallback: !result.hits.length
    }
  },
  async export() {
    return structuredClone({
      schema: 'autoreply-knowledge-v1',
      version,
      settings,
      documents: records
        .filter((r) => r.document.enabled)
        .map((r) => ({
          id: r.document.id,
          name: r.document.name,
          category: r.document.category,
          content: r.content,
          version: r.document.version
        }))
    })
  },
  async importFile(input) {
    const format = input.name.split('.').at(-1)?.toLowerCase() ?? ''
    if (!['txt', 'md', 'csv', 'json'].includes(format))
      return { success: false, error: '离线预览只解析文本；PDF、DOCX 和 XLSX 请在桌面客户端上传。' }
    try {
      return {
        success: true,
        document: save({
          id: input.replaceId,
          name: input.name,
          category: input.category ?? '',
          content: new TextDecoder('utf-8', { fatal: true }).decode(input.bytes),
          format
        })
      }
    } catch {
      return { success: false, error: '没有可解析的 UTF-8 文本。' }
    }
  }
}
