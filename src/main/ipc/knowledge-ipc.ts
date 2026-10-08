import { ipcMain } from 'electron'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { rendererTrust } from './trusted-ipc'
import { KnowledgeStore } from '../../core/knowledge/knowledge-store'
import { KnowledgeReplyService } from '../../core/knowledge/knowledge-reply'
import { KnowledgeSettingsSchema } from '../../shared/contracts/knowledge'
import type { KnowledgeUpload, KnowledgeDocument } from '../../shared/contracts/knowledge'

export function registerKnowledgeIpc(
  rendererFile: string,
  userData: string,
  developerOrigin: string | undefined,
  answer: (
    question: string,
    modeId: string,
    objectId: string | undefined,
    service: KnowledgeReplyService
  ) => Promise<unknown>
): KnowledgeStore {
  const storePath = join(userData, 'knowledge', 'knowledge.sqlite')
  const store = new KnowledgeStore(storePath)
  const service = new KnowledgeReplyService(store)
  const trusted = rendererTrust(rendererFile, developerOrigin)
  const id = z.string().uuid()
  let importing = false
  const index = (
    documentId: string,
    data: { name?: string; bytes?: Uint8Array; content?: string }
  ): Promise<KnowledgeDocument> =>
    new Promise((resolve, reject) => {
      let settled = false
      const worker = new Worker(join(__dirname, 'knowledge-parser.js'), {
        workerData: { storePath, documentId, ...data },
        resourceLimits: { maxOldGenerationSizeMb: 256 }
      })
      const fail = async (message: string): Promise<void> => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        await worker.terminate()
        reject(new Error(message))
      }
      const timer = setTimeout(() => void fail('解析与索引超过 30 秒，请拆分资料后重试。'), 30000)
      worker.once('message', (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void worker.terminate()
        result.success ? resolve(result.document) : reject(new Error(result.error))
      })
      worker.once('error', () => {
        void fail('资料处理失败，请检查格式或拆分后重试。')
      })
      worker.once('exit', () => {
        void fail('资料处理进程退出，请重试。')
      })
    })
  const handle = (channel: string, run: (input: unknown) => unknown): void => {
    ipcMain.handle(`knowledge:${channel}`, (event, input: unknown) => {
      trusted(event)
      return run(input)
    })
  }
  handle('snapshot', () => store.snapshot())
  handle('detail', (input) => store.detail(id.parse(input)))
  handle('search', (input) => store.search(z.string().trim().min(1).max(8000).parse(input)))
  handle('settings', (input) => store.settings(KnowledgeSettingsSchema.parse(input)))
  handle('export', () => store.export())
  handle('update', (input) => {
    const patch = z
      .strictObject({
        id,
        enabled: z.boolean().optional(),
        category: z.string().max(80).optional()
      })
      .parse(input)
    store.update(patch.id, patch)
  })
  handle('remove', (input) => {
    if (importing) throw new Error('资料正在解析，请稍后操作。')
    store.remove(id.parse(input))
  })
  handle('save', async (input) => {
    if (importing) throw new Error('资料正在解析，请稍后操作。')
    const item = z
      .strictObject({
        id: id.optional(),
        name: z.string().trim().min(1).max(240),
        category: z.string().max(80),
        content: z.string().trim().min(1).max(2000000)
      })
      .parse(input)
    const document = store.begin(item.name, 'manual', item.category, item.id)
    importing = true
    try {
      return await index(document.id, { content: item.content })
    } catch (error) {
      store.fail(document.id, '录入内容无效，请重新编辑。')
      throw error
    } finally {
      importing = false
    }
  })
  handle('answer', (input) => {
    const request = z
      .strictObject({
        question: z.string().trim().min(1).max(8000),
        modeId: z.string().min(1),
        objectId: id.optional()
      })
      .parse(input)
    return answer(request.question, request.modeId, request.objectId, service)
  })
  handle('import', async (input) => {
    if (importing) return { success: false, error: '正在解析上一份资料，请稍候。' }
    const file = input as KnowledgeUpload
    if (
      !file ||
      typeof file.name !== 'string' ||
      !(file.bytes instanceof Uint8Array) ||
      !file.bytes.length ||
      file.bytes.length > 10485760
    )
      return { success: false, error: '请选择不超过 10 MB 的非空资料文件。' }
    const name = file.name.split(/[\\/]/).at(-1)!
    const category = z
      .string()
      .max(80)
      .parse(file.category ?? '')
    const replace = file.replaceId ? id.parse(file.replaceId) : undefined
    importing = true
    let document
    try {
      document = store.begin(name, name.split('.').at(-1)!.toLowerCase(), category, replace)
      return { success: true, document: await index(document.id, { name, bytes: file.bytes }) }
    } catch (error) {
      const message = error instanceof Error ? error.message : '资料解析失败。'
      if (document) store.fail(document.id, message)
      return { success: false, error: message }
    } finally {
      importing = false
    }
  })
  return store
}
