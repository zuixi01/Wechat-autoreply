import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowledgeStore } from '../../src/core/knowledge/knowledge-store'
import { KnowledgeReplyService } from '../../src/core/knowledge/knowledge-reply'
import { KnowledgeProvider } from '../../src/core/knowledge/knowledge-provider'
import { knowledgeTerms, splitKnowledge } from '../../src/core/knowledge/retrieval'
import type { ProviderAdapter } from '../../src/core/session-types'

const stores: KnowledgeStore[] = []
const directories: string[] = []
const store = (): KnowledgeStore => {
  const db = new KnowledgeStore(':memory:')
  stores.push(db)
  return db
}
const add = (db: KnowledgeStore, name: string, content: string) =>
  db.finish(db.begin(name, 'txt', '产品').id, content)
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  directories.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
describe('persistent shared knowledge', () => {
  it('retrieves additional sources when a long matching document occupies the leading ranks', () => {
    const db = store()
    add(db, 'billing', ('billing ' + 'other '.repeat(130) + '\n').repeat(300))
    const second = add(db, 'Second guide', 'different '.repeat(200) + 'billing details')
    expect(db.search('billing').hits.some((hit) => hit.documentId === second.id)).toBe(true)
  })
  it('allows an indexing worker to open the database without recovering a live import', () => {
    const directory = mkdtempSync(join(tmpdir(), 'knowledge-worker-'))
    directories.push(directory)
    const path = join(directory, 'knowledge.sqlite')
    const main = new KnowledgeStore(path)
    stores.push(main)
    const item = main.begin('导入中', 'txt', '')
    const worker = new KnowledgeStore(path, false)
    stores.push(worker)
    expect(main.detail(item.id).document.state).toBe('processing')
    worker.finish(item.id, '营业时间是九点。')
    expect(main.search('营业时间').hits[0]?.documentId).toBe(item.id)
  })
  it('reindexes a changed category and removes the previous category terms', () => {
    const db = store()
    const doc = add(db, '资料', '营业时间是九点。')
    db.update(doc.id, { category: '航天装备' })
    expect(db.search('航天装备').hits[0]?.category).toBe('航天装备')
    expect(db.search('产品').hits).toEqual([])
  })
  it('indexes Chinese and English content and excludes unrelated data', () => {
    const db = store()
    const doc = add(db, '营业说明', '营业时间：周一至周五早上九点到下午六点。')
    add(db, 'Product specs', 'The Atlas device supports Bluetooth connectivity.')
    expect(db.search('请问营业时间是什么').hits[0]).toMatchObject({
      documentId: doc.id,
      text: expect.stringContaining('九点')
    })
    expect(db.search('Bluetooth').hits[0].name).toBe('Product specs')
    expect(db.search('量子火箭推进器').hits).toEqual([])
    expect(knowledgeTerms('请问')).toEqual([])
  })
  it('immediately excludes disabled, deleted, failed and overwritten knowledge', () => {
    const db = store()
    const first = add(db, '价格', '旗舰套餐价格是 199 元。')
    const version = db.version()
    db.update(first.id, { enabled: false })
    expect(db.search('旗舰套餐价格').hits).toEqual([])
    expect(db.version()).not.toBe(version)
    db.update(first.id, { enabled: true })
    expect(db.search('旗舰套餐价格').hits).toHaveLength(1)
    const next = db.begin('价格更新', 'txt', '产品', first.id)
    expect(db.search('旗舰套餐价格').hits).toEqual([])
    db.finish(next.id, '旗舰套餐价格是 299 元。')
    expect(db.search('旗舰套餐价格').hits[0].text).toContain('299')
    expect(db.search('旗舰套餐价格').hits[0].version).toBe(2)
    db.remove(first.id)
    expect(db.search('旗舰套餐价格').hits).toEqual([])
    const failed = db.begin('失败资料', 'pdf', '')
    db.fail(failed.id, '扫描件')
    expect(db.snapshot().documents[0]).toMatchObject({ state: 'failed', error: '扫描件' })
    expect(db.export().documents).toEqual([])
  })
  it('persists documents, settings and index across restarts and recovers interrupted parsing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'knowledge-'))
    directories.push(directory)
    const path = join(directory, 'knowledge.sqlite')
    const db = new KnowledgeStore(path)
    const doc = add(db, '发票说明', '发票申请请联系工作人员。')
    db.settings({ enabled: true, fallbackReply: '稍后核实。' })
    db.begin('中断资料', 'pdf', '')
    db.close()
    const reopened = new KnowledgeStore(path)
    stores.push(reopened)
    expect(reopened.search('发票申请').hits[0].documentId).toBe(doc.id)
    expect(reopened.settings().fallbackReply).toBe('稍后核实。')
    expect(reopened.snapshot().documents.find((d) => d.name === '中断资料')?.state).toBe('failed')
  })
  it('chunks long documents and respects retrieval budgets', () => {
    const db = store()
    const content = Array.from(
      { length: 80 },
      (_, i) => `售后维修流程${i}：请先联系技术人员并准备产品信息。`
    ).join('\n')
    const doc = add(db, '售后说明', content)
    expect(doc.chunks).toBeGreaterThan(1)
    expect(splitKnowledge(content).every((c) => c.length <= 900)).toBe(true)
    expect(db.search('售后维修流程').hits.length).toBeLessThanOrEqual(3)
  })
  it('does not let disabled matching content crowd enabled retrieval out', () => {
    const db = store()
    const disabled = add(db, '停用资料', '特价产品售后说明。\n'.repeat(20000))
    db.update(disabled.id, { enabled: false })
    const active = add(db, '启用资料', '特价产品售后说明：联系客服。')
    expect(db.search('特价产品售后说明').hits.map((h) => h.documentId)).toEqual([active.id])
  })
  it('pauses all knowledge use and exports only enabled ready data', () => {
    const db = store()
    add(db, '价格', '套餐价格 199 元。')
    db.settings({ ...db.settings(), enabled: false })
    expect(db.search('套餐价格').hits).toEqual([])
    expect(db.export().settings.enabled).toBe(false)
  })
})
describe('knowledge and rules in replies', () => {
  it('supplies relevant knowledge and rules to the model and uses a configurable fallback without a call', async () => {
    const db = store()
    add(db, '服务说明', '服务时间为周一至周五 09:00—18:00。')
    const service = new KnowledgeReplyService(db)
    const model = vi.fn<(system: string, question: string) => Promise<string>>(
      async () => '王经理您好，服务时间为周一至周五 09:00—18:00。'
    )
    const result = await service.answer('服务时间是什么？', '称呼对方王经理，回复简洁。', model)
    expect(result.hits).toHaveLength(1)
    expect(result.text).toContain('王经理')
    expect(model.mock.calls[0][0]).toContain('称呼对方王经理')
    expect(model.mock.calls[0][0]).toContain('09:00—18:00')
    model.mockClear()
    expect((await service.answer('火箭燃料成分？', '简洁', model)).fallback).toBe(true)
    expect(model).not.toHaveBeenCalled()
  })
  it('rejects a model result when data changes during generation', async () => {
    const db = store()
    const doc = add(db, '服务说明', '服务时间是上午九点。')
    await expect(
      new KnowledgeReplyService(db).answer('服务时间', '简洁', async () => {
        db.remove(doc.id)
        return '上午九点。'
      })
    ).rejects.toThrow('已更新')
  })
  it('rejects missing model text and a paused library', async () => {
    const db = store()
    add(db, '服务', '服务时间是九点。')
    const service = new KnowledgeReplyService(db)
    await expect(service.answer('服务时间', '简洁', async () => null)).rejects.toThrow('有效回复')
    db.settings({ ...db.settings(), enabled: false })
    await expect(service.answer('服务时间', '简洁', async () => null)).rejects.toThrow('已暂停')
  })
  it('injects retrieval into existing local reply providers without altering rules', async () => {
    const db = store()
    add(db, '服务', '服务时间是九点。')
    let seen = ''
    const provider: ProviderAdapter = {
      async *run(input) {
        seen = input.customPrompt!
        yield { type: 'reply_text', content: '九点。' }
      }
    }
    const events = []
    for await (const event of new KnowledgeProvider(provider, db, async () => '服务时间').run({
      screenshot: '',
      appType: 'wechat',
      extractedText: '服务时间',
      customPrompt: '称呼王经理'
    }))
      events.push(event)
    expect(seen).toContain('称呼王经理')
    expect(seen).toContain('知识依据')
    expect(seen).toContain('九点')
    expect(events[0]).toEqual({ type: 'reply_text', content: '九点。' })
  })
})
