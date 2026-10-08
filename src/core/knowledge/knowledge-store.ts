import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  KnowledgeBundle,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeSettings,
  KnowledgeSnapshot
} from '../../shared/contracts/knowledge'
import { KnowledgeSettingsSchema } from '../../shared/contracts/knowledge'
import { knowledgeTerms, splitKnowledge } from './retrieval'

const DEFAULT_SETTINGS: KnowledgeSettings = {
  enabled: true,
  fallbackReply: '目前资料中没有这方面的信息，我先核实一下再回复您。'
}
export class KnowledgeStore {
  private readonly db: DatabaseSync
  constructor(path: string, recoverInterrupted = true) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS knowledge_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_documents (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, content TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks USING fts5(document_id UNINDEXED, chunk_id UNINDEXED, content UNINDEXED, terms);
    `)
    this.db.prepare('INSERT OR IGNORE INTO knowledge_meta VALUES(?,?)').run('version', randomUUID())
    this.db
      .prepare('INSERT OR IGNORE INTO knowledge_meta VALUES(?,?)')
      .run('settings', JSON.stringify(DEFAULT_SETTINGS))
    if (recoverInterrupted)
      for (const document of this.snapshot().documents.filter((d) => d.state === 'processing'))
        this.fail(document.id, '上次解析中断，请重新上传。')
  }
  close(): void {
    this.db.close()
  }
  snapshot(): KnowledgeSnapshot {
    return {
      version: this.version(),
      settings: this.settings(),
      documents: this.db
        .prepare('SELECT metadata FROM knowledge_documents')
        .all()
        .map((row) => JSON.parse(String(row.metadata)) as KnowledgeDocument)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    }
  }
  version(): string {
    return String(
      this.db.prepare('SELECT value FROM knowledge_meta WHERE key=?').get('version')!.value
    )
  }
  settings(input?: KnowledgeSettings): KnowledgeSettings {
    if (input)
      this.transaction(() => {
        this.db
          .prepare('UPDATE knowledge_meta SET value=? WHERE key=?')
          .run(JSON.stringify(KnowledgeSettingsSchema.parse(input)), 'settings')
        this.bump()
      })
    return KnowledgeSettingsSchema.parse(
      JSON.parse(
        String(
          this.db.prepare('SELECT value FROM knowledge_meta WHERE key=?').get('settings')!.value
        )
      )
    )
  }
  detail(id: string): { document: KnowledgeDocument; content: string } {
    const row = this.db.prepare('SELECT * FROM knowledge_documents WHERE id=?').get(id)
    if (!row) throw new Error('资料不存在，请刷新列表。')
    return { document: JSON.parse(String(row.metadata)), content: String(row.content) }
  }
  begin(name: string, format: string, category: string, replaceId?: string): KnowledgeDocument {
    if (!name.trim() || name.length > 240 || category.length > 80)
      throw new Error('名称或分类长度不正确。')
    const previous = replaceId ? this.detail(replaceId).document : undefined
    if (!previous && this.snapshot().documents.length >= 200)
      throw new Error('知识库最多保存 200 份资料，请先整理已有资料。')
    const now = Date.now()
    const document: KnowledgeDocument = {
      id: previous?.id ?? randomUUID(),
      name: name.trim(),
      category: category.trim(),
      format,
      state: 'processing',
      enabled: previous?.enabled ?? true,
      characters: 0,
      chunks: 0,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      version: (previous?.version ?? 0) + 1
    }
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO knowledge_documents VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,content=excluded.content'
        )
        .run(document.id, JSON.stringify(document), '')
      this.db.prepare('DELETE FROM knowledge_chunks WHERE document_id=?').run(document.id)
      this.bump()
    })
    return document
  }
  finish(id: string, content: string): KnowledgeDocument {
    const clean = content.replaceAll(String.fromCharCode(0), '').trim()
    if (!clean) throw new Error('没有可读取的文字；扫描件请先转换为含文本的 PDF 或手动录入。')
    if (clean.length > 2000000) throw new Error('解析后的文字超过 200 万字，请拆分资料后上传。')
    const chunks = splitKnowledge(clean)
    const document = {
      ...this.detail(id).document,
      state: 'ready' as const,
      characters: clean.length,
      chunks: chunks.length,
      updatedAt: Date.now(),
      error: undefined
    }
    this.transaction(() => {
      this.db
        .prepare('UPDATE knowledge_documents SET metadata=?,content=? WHERE id=?')
        .run(JSON.stringify(document), clean, id)
      this.db.prepare('DELETE FROM knowledge_chunks WHERE document_id=?').run(id)
      const insert = this.db.prepare(
        'INSERT INTO knowledge_chunks(document_id,chunk_id,content,terms) VALUES(?,?,?,?)'
      )
      chunks.forEach((chunk, index) =>
        insert.run(
          id,
          `${id}:${document.version}:${index}`,
          chunk,
          knowledgeTerms(document.name + ' ' + document.category + ' ' + chunk).join(' ')
        )
      )
      this.bump()
    })
    return document
  }
  fail(id: string, error: string): void {
    this.transaction(() => {
      const document = {
        ...this.detail(id).document,
        state: 'failed',
        error,
        updatedAt: Date.now()
      }
      this.db
        .prepare('UPDATE knowledge_documents SET metadata=? WHERE id=?')
        .run(JSON.stringify(document), id)
      this.db.prepare('DELETE FROM knowledge_chunks WHERE document_id=?').run(id)
      this.bump()
    })
  }
  update(id: string, patch: { enabled?: boolean; category?: string }): void {
    const current = this.detail(id)
    if (current.document.state === 'processing') throw new Error('资料正在解析，请稍后再操作。')
    if (patch.category !== undefined && patch.category.length > 80) throw new Error('分类过长。')
    const document = { ...current.document, ...patch, updatedAt: Date.now() }
    this.transaction(() => {
      this.db
        .prepare('UPDATE knowledge_documents SET metadata=? WHERE id=?')
        .run(JSON.stringify(document), id)
      if (patch.category !== undefined && document.state === 'ready') {
        const chunks = this.db
          .prepare('SELECT rowid,content FROM knowledge_chunks WHERE document_id=?')
          .all(id)
        const update = this.db.prepare('UPDATE knowledge_chunks SET terms=? WHERE rowid=?')
        for (const chunk of chunks)
          update.run(
            knowledgeTerms(document.name + ' ' + document.category + ' ' + chunk.content).join(' '),
            chunk.rowid
          )
      }
      this.bump()
    })
  }
  remove(id: string): void {
    this.detail(id)
    this.transaction(() => {
      this.db.prepare('DELETE FROM knowledge_documents WHERE id=?').run(id)
      this.db.prepare('DELETE FROM knowledge_chunks WHERE document_id=?').run(id)
      this.bump()
    })
  }
  search(query: string): { hits: KnowledgeHit[]; version: string } {
    const version = this.version()
    if (!this.settings().enabled) return { hits: [], version }
    const terms = knowledgeTerms(query).slice(0, 80)
    if (!terms.length) return { hits: [], version }
    const documents = new Map(
      this.snapshot()
        .documents.filter((d) => d.state === 'ready' && d.enabled)
        .map((d) => [d.id, d])
    )
    const found = this.db
      .prepare(
        `SELECT document_id,chunk_id,knowledge_chunks.content,bm25(knowledge_chunks) AS rank FROM knowledge_chunks JOIN knowledge_documents ON knowledge_documents.id=knowledge_chunks.document_id WHERE knowledge_chunks MATCH ? AND json_extract(metadata,'$.enabled')=1 AND json_extract(metadata,'$.state')='ready' ORDER BY rank`
      )
      .iterate(terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR '))
    const hits: KnowledgeHit[] = []
    const perDocument = new Map<string, number>()
    for (const row of found) {
      const document = documents.get(String(row.document_id))
      if (!document || (perDocument.get(document.id) ?? 0) >= 3) continue
      perDocument.set(document.id, (perDocument.get(document.id) ?? 0) + 1)
      hits.push({
        documentId: document.id,
        name: document.name,
        category: document.category,
        chunkId: String(row.chunk_id),
        text: String(row.content),
        score: -Number(row.rank),
        version: document.version
      })
      if (hits.length === 8) break
    }
    return { hits, version }
  }
  export(): KnowledgeBundle {
    return {
      schema: 'autoreply-knowledge-v1',
      version: this.version(),
      settings: this.settings(),
      documents: this.snapshot()
        .documents.filter((d) => d.state === 'ready' && d.enabled)
        .map((d) => ({
          id: d.id,
          name: d.name,
          category: d.category,
          content: this.detail(d.id).content,
          version: d.version
        }))
    }
  }
  private bump(): void {
    this.db.prepare('UPDATE knowledge_meta SET value=? WHERE key=?').run(randomUUID(), 'version')
  }
  private transaction(action: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      action()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
