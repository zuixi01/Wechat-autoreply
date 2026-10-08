import { parentPort, workerData } from 'node:worker_threads'
import { parseKnowledgeDocument } from '../core/knowledge/parse-document'
import { KnowledgeStore } from '../core/knowledge/knowledge-store'

async function processDocument(): Promise<void> {
  let store: KnowledgeStore | undefined
  try {
    const content =
      typeof workerData.content === 'string'
        ? workerData.content
        : await parseKnowledgeDocument(workerData.name, workerData.bytes)
    // Only the main app recovers interrupted imports; a worker must preserve its live record.
    store = new KnowledgeStore(workerData.storePath, false)
    const document = store.finish(workerData.documentId, content)
    store.close()
    store = undefined
    parentPort?.postMessage({ success: true, document })
  } catch {
    store?.close()
    parentPort?.postMessage({
      success: false,
      error:
        '无法解析或建立知识索引。请检查文件格式、加密及内容；扫描 PDF 需要先转换为文字，过大资料请拆分。'
    })
  }
}
void processDocument()
