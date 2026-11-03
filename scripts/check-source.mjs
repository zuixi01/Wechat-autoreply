import { execFileSync } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

/** Return a reason without reading or printing the contents of private files. */
export function privateSourceReason(path) {
  const normalized = path.toLowerCase()
  const parts = normalized.split('/')
  const name = parts.at(-1)
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example'))
    return 'private_environment_file'
  if (
    parts.some((part) => ['.local', '.private', '.ssh', '.aws', 'node_modules'].includes(part)) ||
    normalized.startsWith('evals/private/') ||
    ['.npmrc', '.netrc', '_netrc'].includes(name)
  )
    return 'private_local_file'
  if (
    /\.(?:pem|key|pfx|p12|keystore|jks)$/i.test(name) ||
    /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\..*)?$/.test(name) ||
    /^(?:credentials|secrets)(?:[.-].*)?$/.test(name)
  )
    return 'private_key_file'
  if (/\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/i.test(name) || /\.(?:dump|backup)$/i.test(name))
    return 'private_database_file'
  if (
    /^(?:dist|out|coverage|test-results)\//.test(normalized) ||
    /^(?:tests\/)?native\/.+\/(?:bin|obj)\//.test(normalized) ||
    /(?:^|\/)(?:\.cache|__pycache__)\//.test(normalized) ||
    /\.(?:exe|dll|pdb|tsbuildinfo|pyc|pyo)$/i.test(name) ||
    /\.log(?:[.-].*)?$/i.test(name) ||
    ['.eslintcache', '.ds_store', 'thumbs.db'].includes(name)
  )
    return 'generated_local_file'
  return null
}

function maskProseExamples(text) {
  let fence = null
  const lines = text.split('\n').map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (marker && !fence) {
      fence = marker[1]
      return ' '.repeat(line.length)
    }
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
      return ' '.repeat(line.length)
    }
    return line
  })
  return lines
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, (value) => value.replace(/[^\n]/g, ' '))
    .replace(/(`+)[\s\S]*?\1/g, (value) => value.replace(/[^\n]/g, ' '))
}

function escapedAt(text, index) {
  let slashes = 0
  for (let before = index - 1; before >= 0 && text[before] === '\\'; before--) slashes++
  return slashes % 2 === 1
}

/** Inline links/images, reference definitions and HTML links used by GitHub Markdown. */
function markdownLinks(text) {
  const prose = maskProseExamples(text)
  const links = []
  const add = (target, offset) => {
    links.push({ target, line: prose.slice(0, offset).split('\n').length })
  }
  for (const match of prose.matchAll(/\]\(/g)) {
    if (escapedAt(prose, match.index)) continue
    let cursor = match.index + 2
    while (/\s/.test(prose[cursor] || '') && cursor < prose.length) cursor++
    const start = cursor
    if (prose[cursor] === '<') {
      cursor++
      while (cursor < prose.length && (prose[cursor] !== '>' || escapedAt(prose, cursor))) cursor++
      if (cursor < prose.length) add(prose.slice(start + 1, cursor), match.index)
      continue
    }
    let depth = 0
    while (cursor < prose.length) {
      const char = prose[cursor]
      if (char === '\\' && cursor + 1 < prose.length) {
        cursor += 2
        continue
      }
      if (char === '(') depth++
      if (char === ')') {
        if (!depth) break
        depth--
      }
      if (/\s/.test(char) && !depth) break
      cursor++
    }
    if (cursor > start) add(prose.slice(start, cursor), match.index)
  }
  for (const match of prose.matchAll(
    /^ {0,3}\[[^\]\n]+\]:[ \t]*(?:<([^>\n]+)>|((?:\\.|[^\s])+))/gm
  ))
    add(match[1] ?? match[2], match.index)
  for (const match of prose.matchAll(
    /<(?:a|img|source|video|audio)\b[^>]*?\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
  ))
    add(match[1] ?? match[2], match.index)
  return links
}

function linkTarget(source, target) {
  const unescaped = target.replace(/\\([\\`*{}[\]()#+\-.!_> ])/g, '$1')
  if (/^(?:[a-z]:[\\/]|file:)/i.test(unescaped) || unescaped.startsWith('\\'))
    return { code: 'markdown_local_absolute_path' }
  if (!unescaped || unescaped.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(unescaped))
    return { skipped: true }
  const pathname = unescaped.split(/[?#]/, 1)[0]
  if (!pathname) return { skipped: true }
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { code: 'markdown_link_invalid_encoding' }
  }
  if (/^(?:[a-z]:[\\/]|file:)/i.test(decoded) || decoded.startsWith('\\'))
    return { code: 'markdown_local_absolute_path' }
  if (decoded.includes('\\') || [...decoded].some((char) => char.charCodeAt(0) < 32))
    return { code: 'markdown_link_invalid_path' }
  const path = posix.normalize(
    decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(source), decoded)
  )
  if (path === '..' || path.startsWith('../')) return { code: 'markdown_link_outside_repository' }
  return { path: path.replace(/\/$/, '') }
}

function isTemplate(path) {
  return /^\.github\/(?:ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE(?:\/|\.md$))/i.test(path)
}

/** Check Git's index and new, non-ignored source files without installing dependencies. */
export async function checkSource(root) {
  const files = [
    ...new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
      })
        .split('\0')
        .filter(Boolean)
    )
  ].sort()
  const known = new Set(files)
  const issues = []
  const add = (code, path, details = {}) => issues.push({ code, path, ...details })
  for (const path of files) {
    const reason = privateSourceReason(path)
    if (reason) add(reason, path)
  }
  for (const path of ['LICENSE', 'NOTICE', 'package.json', 'package-lock.json', '.node-version']) {
    try {
      if (!known.has(path) || !(await lstat(resolve(root, path))).isFile())
        add('required_source_missing', path)
    } catch {
      add('required_source_missing', path)
    }
  }

  async function json(path) {
    try {
      return JSON.parse(await readFile(resolve(root, path), 'utf8'))
    } catch {
      add('source_json_unreadable', path)
      return null
    }
  }
  const pkg = await json('package.json')
  const lock = await json('package-lock.json')
  if (pkg) {
    if (pkg.private !== true) add('package_private_required', 'package.json')
    if (!pkg.name || !pkg.version || !pkg.license) add('package_metadata_missing', 'package.json')
    if (
      typeof pkg.homepage !== 'string' ||
      !/^https:\/\/[^\s?#]+[^/]$/.test(pkg.homepage) ||
      pkg.repository?.type !== 'git' ||
      pkg.repository?.url !== `${pkg.homepage}.git` ||
      pkg.bugs?.url !== `${pkg.homepage}/issues`
    )
      add('package_repository_metadata_invalid', 'package.json')
    try {
      const version = (await readFile(resolve(root, '.node-version'), 'utf8')).trim()
      if (
        !/^\d+\.\d+\.\d+$/.test(version) ||
        pkg.engines?.node !== `>=${version} <${Number(version.split('.')[0]) + 1}`
      )
        add('package_node_version_mismatch', 'package.json')
    } catch {
      add('node_version_unreadable', '.node-version')
    }
  }
  if (pkg && lock) {
    const locked = lock.packages?.['']
    if (lock.lockfileVersion !== 3 || !locked)
      add('package_lock_format_invalid', 'package-lock.json')
    else {
      for (const field of ['name', 'version'])
        if (pkg[field] !== lock[field]) add(`package_lock_${field}_mismatch`, 'package-lock.json')
      for (const field of ['name', 'version', 'license', 'engines'])
        if (!isDeepStrictEqual(pkg[field], locked[field]))
          add(`package_lock_root_${field}_mismatch`, 'package-lock.json')
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'])
        if (!isDeepStrictEqual(pkg[field] ?? {}, locked[field] ?? {}))
          add(`package_lock_${field}_mismatch`, 'package-lock.json')
    }
  }
  let markdownChecked = 0
  for (const source of files.filter(
    (path) => /\.(?:md|markdown)$/i.test(path) && !isTemplate(path)
  )) {
    // Do not inspect files already rejected as private or generated data.
    if (privateSourceReason(source)) continue
    let text
    try {
      if (!(await lstat(resolve(root, source))).isFile()) throw new Error('not_regular_markdown')
      text = await readFile(resolve(root, source), 'utf8')
    } catch {
      add('markdown_source_unreadable', source)
      continue
    }
    markdownChecked++
    for (const link of markdownLinks(text)) {
      const target = linkTarget(source, link.target)
      if (target.skipped) continue
      if (target.code) add(target.code, source, { line: link.line })
      else if (target.path !== '.') {
        let exists =
          known.has(target.path) || files.some((path) => path.startsWith(`${target.path}/`))
        if (exists) {
          try {
            const info = await lstat(resolve(root, target.path))
            exists = info.isFile() || info.isDirectory()
          } catch {
            exists = false
          }
        }
        if (!exists) add('markdown_link_missing', source, { line: link.line, target: target.path })
      }
    }
  }
  return { filesChecked: files.length, markdownChecked, issues }
}

async function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  try {
    const result = await checkSource(root)
    for (const issue of result.issues)
      console.error(
        `${issue.code}: ${issue.path}${issue.line ? `:${issue.line}` : ''}${issue.target ? ` -> ${issue.target}` : ''}`
      )
    console.log(
      `Source check: ${result.filesChecked} files, ${result.markdownChecked} Markdown documents, ${result.issues.length} issues.`
    )
    if (result.issues.length) process.exitCode = 1
  } catch {
    console.error('source_check_unavailable: run from a Git checkout with readable source files.')
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
