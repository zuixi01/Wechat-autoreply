import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { createRequire } from 'node:module'
import { parseKnowledgeDocument } from '../../src/core/knowledge/parse-document'
import { knowledgePdf } from '../fixtures/knowledge-pdf'
const require = createRequire(import.meta.url)
const AdmZip = require('adm-zip')
describe('knowledge document parsing', () => {
  it('extracts the text layer from a real PDF', async () => {
    expect(await parseKnowledgeDocument('business.pdf', knowledgePdf())).toContain('09:00 to 18:00')
  }, 15000)
  it('reads text, Markdown, JSON and CSV while preserving data relationships', async () => {
    expect(await parseKnowledgeDocument('政策.txt', Buffer.from('服务时间为九点。'))).toContain(
      '九点'
    )
    expect(await parseKnowledgeDocument('说明.md', Buffer.from('# 产品\n说明'))).toContain('# 产品')
    expect(await parseKnowledgeDocument('data.json', Buffer.from('{"价格":199}'))).toContain('199')
    expect(
      await parseKnowledgeDocument(
        'data.csv',
        Buffer.from('产品,价格,说明\r\n套餐,199,"包含,服务"')
      )
    ).toBe('产品：套餐；价格：199；说明：包含,服务')
    await expect(parseKnowledgeDocument('bad.csv', Buffer.from('a,b\n"open'))).rejects.toThrow(
      '引号'
    )
  })
  it('extracts DOCX paragraphs instead of interpreting document markup as instructions', async () => {
    const zip = new AdmZip()
    zip.addFile(
      '[Content_Types].xml',
      Buffer.from(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
      )
    )
    zip.addFile(
      'word/document.xml',
      Buffer.from(
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>售后服务时间为九点至六点。</w:t></w:r></w:p></w:body></w:document>'
      )
    )
    expect(await parseKnowledgeDocument('售后.docx', zip.toBuffer())).toContain('售后服务时间')
  })
  it('extracts spreadsheet cells with header names', async () => {
    const book = new ExcelJS.Workbook()
    const sheet = book.addWorksheet('商品目录')
    sheet.addRow(['产品', '价格'])
    sheet.addRow(['基础套餐', 199])
    sheet.addRow(['企业套餐', 399])
    const text = await parseKnowledgeDocument(
      '商品.xlsx',
      new Uint8Array((await book.xlsx.writeBuffer()) as ArrayBuffer)
    )
    expect(text).toContain('产品：基础套餐；价格：199')
    expect(text).toContain('企业套餐')
  })
  it('rejects unsupported, empty and oversized files', async () => {
    await expect(parseKnowledgeDocument('旧版.doc', Buffer.from('data'))).rejects.toThrow('支持')
    await expect(parseKnowledgeDocument('空.txt', Buffer.alloc(0))).rejects.toThrow('非空')
    await expect(parseKnowledgeDocument('大.txt', Buffer.alloc(10485761))).rejects.toThrow('10 MB')
  })
})
