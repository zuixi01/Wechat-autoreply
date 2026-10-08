import { extname } from 'node:path'
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'

export async function parseKnowledgeDocument(name: string, input: Uint8Array): Promise<string> {
  if (!input.length || input.length > 10 * 1024 * 1024)
    throw new Error('每份资料需为非空文件，且不超过 10 MB。')
  const extension = extname(name).slice(1).toLowerCase()
  const buffer = Buffer.from(input)
  if (extension === 'docx') return (await mammoth.extractRawText({ buffer })).value
  if (extension === 'xlsx') {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer as never)
    const parts: string[] = []
    let cells = 0
    for (const sheet of workbook.worksheets) {
      parts.push(`工作表：${sheet.name}`)
      const header = sheet.getRow(1).values as ExcelJS.CellValue[]
      sheet.eachRow((row, number) => {
        if (number === 1) return
        const values: string[] = []
        row.eachCell((cell, column) => {
          if (++cells > 100000) throw new Error('表格超过 10 万个非空单元格，请拆分后上传。')
          const heading = header[column] ?? `列${column}`
          values.push(`${String(heading)}：${cell.text}`)
        })
        if (values.length) parts.push(values.join('；'))
      })
      if (sheet.rowCount === 1) parts.push(sheet.getRow(1).values.toString())
    }
    return parts.join('\n')
  }
  if (extension === 'pdf') {
    const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loading = pdf.getDocument({
      data: new Uint8Array(input),
      useSystemFonts: false,
      disableFontFace: true
    })
    try {
      const document = await loading.promise
      if (document.numPages > 500) throw new Error('PDF 超过 500 页，请拆分后上传。')
      const pages: string[] = []
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number)
        const text = await page.getTextContent()
        pages.push(
          text.items
            .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
            .join('')
        )
        page.cleanup()
      }
      return pages.join('\n\n')
    } finally {
      await loading.destroy()
    }
  }
  if (!['txt', 'md', 'csv', 'json'].includes(extension))
    throw new Error('支持 TXT、Markdown、CSV、JSON、DOCX、XLSX 和含文本的 PDF；请先转换其他格式。')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input)
  } catch {
    text = new TextDecoder('gb18030', { fatal: true }).decode(input)
  }
  if (extension === 'json') return JSON.stringify(JSON.parse(text), null, 2)
  if (extension === 'csv') {
    const rows: string[][] = []
    let row: string[] = []
    let value = ''
    let quoted = false
    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      if (char === '"') {
        if (quoted && text[i + 1] === '"') {
          value += '"'
          i++
        } else quoted = !quoted
      } else if (char === ',' && !quoted) {
        row.push(value)
        value = ''
      } else if ((char === '\n' || char === '\r') && !quoted) {
        if (char === '\r' && text[i + 1] === '\n') i++
        row.push(value)
        rows.push(row)
        row = []
        value = ''
      } else value += char
    }
    if (quoted) throw new Error('CSV 引号未闭合，请检查文件格式。')
    if (value || row.length) {
      row.push(value)
      rows.push(row)
    }
    const header = rows.shift() ?? []
    return (
      rows
        .map((values) => values.map((v, i) => `${header[i] || `列${i + 1}`}：${v}`).join('；'))
        .join('\n') || header.join('；')
    )
  }
  return text
}
