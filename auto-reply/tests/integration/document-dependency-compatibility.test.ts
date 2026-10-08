import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { parseKnowledgeDocument } from '../../src/core/knowledge/parse-document'

const require = createRequire(import.meta.url)
const AdmZip = require('adm-zip')
describe('patched document dependencies with the production reader', () => {
  it('resolves Mammoth to argparse 2 without sprintf-js and preserves its command-line help', async () => {
    const mammothPackage = require.resolve('mammoth/package.json')
    const mammothRequire = createRequire(mammothPackage)
    expect(mammothRequire('argparse/package.json').version).toBe('2.0.1')
    expect(() => mammothRequire.resolve('sprintf-js')).toThrow()
    const stdout = await new Promise<string>((done, reject) => {
      execFile(
        process.execPath,
        [join(dirname(mammothPackage), 'bin/mammoth'), '--help'],
        { windowsHide: true, timeout: 3000 },
        (error, output) => (error ? reject(error) : done(output))
      )
    })
    expect(stdout).toContain('docx-path')
    expect(stdout).toContain('--output-format')
  })
  it('reads Chinese XLSX facts with conditional-format UUID generation', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('产品资料')
    sheet.addRow(['产品', '金额', '备注'])
    sheet.addRow(['标准套餐', 128, '月度续费'])
    sheet.addConditionalFormatting({
      ref: 'B2',
      rules: [
        { type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], gradient: true, priority: 1 }
      ]
    })
    const input = await workbook.xlsx.writeBuffer()
    expect(await parseKnowledgeDocument('业务.xlsx', new Uint8Array(input))).toBe(
      '工作表：产品资料\n产品：标准套餐；金额：128；备注：月度续费'
    )
  })
  it('reads literal Chinese DOCX content through the patched XML parser', async () => {
    const zip = new AdmZip()
    zip.addFile(
      '[Content_Types].xml',
      Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
      )
    )
    zip.addFile(
      'word/document.xml',
      Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>仅以已批准报价为准。</w:t></w:r></w:p></w:body></w:document>'
      )
    )
    expect(await parseKnowledgeDocument('政策.docx', zip.toBuffer())).toBe(
      '仅以已批准报价为准。\n\n'
    )
  })
  it('rejects malformed binary documents without returning guessed facts', async () => {
    await expect(parseKnowledgeDocument('损坏.xlsx', Buffer.from('not an xlsx'))).rejects.toThrow()
    await expect(parseKnowledgeDocument('损坏.docx', Buffer.from('not a docx'))).rejects.toThrow()
  })
})
