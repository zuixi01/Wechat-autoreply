/** Chinese word segmentation plus bigrams, shared by the local index and central retrieval. */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const stopWords = new Set([
  '请问',
  '你好',
  '你们',
  '我们',
  '这个',
  '可以',
  '什么',
  '如何',
  '一下',
  '没有',
  '是否',
  '以及',
  '谢谢',
  'the',
  'and',
  'you',
  'for',
  'are',
  'can',
  'with'
])
export function knowledgeTerms(text: string): string[] {
  const clean = text.toLowerCase().normalize('NFKC')
  const terms = new Set<string>()
  for (const match of clean.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0]
    if (!/[\u3400-\u9fff]/u.test(word)) {
      if (word.length > 1) terms.add(word)
      continue
    }
    for (const segment of segmenter.segment(word))
      if (segment.isWordLike && segment.segment.length > 1) terms.add(segment.segment)
    for (let i = 0; i < word.length - 1; i++) terms.add(word.slice(i, i + 2))
  }
  return [...terms].filter((term) => !stopWords.has(term)).slice(0, 4000)
}
export function splitKnowledge(content: string, size = 900): string[] {
  const clean = content.replace(/\r\n?/g, '\n').replaceAll(String.fromCharCode(0), '').trim()
  const result: string[] = []
  let offset = 0
  while (offset < clean.length) {
    let end = Math.min(offset + size, clean.length)
    if (end < clean.length) {
      const boundary = clean.lastIndexOf('\n', end)
      if (boundary > offset + size / 2) end = boundary + 1
    }
    const part = clean.slice(offset, end).trim()
    if (part) result.push(part)
    if (end === clean.length) break
    offset = Math.max(offset + 1, end - 80)
  }
  return result
}
export function relevance(query: string, content: string): number {
  const terms = knowledgeTerms(query).slice(0, 80)
  const available = new Set(knowledgeTerms(content))
  return terms.length ? terms.filter((term) => available.has(term)).length / terms.length : 0
}
