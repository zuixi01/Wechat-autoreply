import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const reportGroups = [
  'windows-dev-build',
  'desktop-smoke',
  'native-publish',
  'packaged-native-smoke',
  'knowledge-smoke',
  'learning-smoke',
  'learning-restart',
  'learning-publication',
  'learning-iteration',
  'workbench-presentation',
  'dependency-audit',
  'server-release'
]
export interface ArtifactPlan {
  root: string
  paths: string[]
  bytes: number
  keptBuilds: string[]
}

async function entries(path: string): Promise<{ name: string; modified: number }[]> {
  try {
    const rows = await readdir(path, { withFileTypes: true })
    const values = await Promise.all(
      rows
        .filter((row) => row.isDirectory() && !row.isSymbolicLink())
        .map(async (row) => ({
          name: row.name,
          modified: (await lstat(join(path, row.name))).mtimeMs
        }))
    )
    return values.sort((a, b) => b.modified - a.modified)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
async function pointer(path: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    const id = value.id ?? value.taskId ?? value.reportId
    return typeof id === 'string' && uuid.test(id) ? id : undefined
  } catch {
    return undefined
  }
}
async function contained(root: string, path: string): Promise<void> {
  const part = relative(root, resolve(path))
  if (
    !part ||
    isAbsolute(part) ||
    part === '..' ||
    part.startsWith('..\\') ||
    part.startsWith('../')
  )
    throw new Error('artifact_path_invalid')
  let current = resolve(path)
  while (current !== root) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('artifact_link_invalid')
    current = dirname(current)
  }
}
async function bytes(path: string): Promise<number> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) return 0
  if (!info.isDirectory()) return info.size
  let size = 0
  for (const row of await readdir(path)) size += await bytes(join(path, row))
  return size
}
/** Only generated UUID build/test directories are eligible; never profiles, source,
 * toolchains, databases, personal acceptance reports, or dependency installations. */
export async function planArtifacts(
  workspace: string,
  minimumAgeMs = 3600000
): Promise<ArtifactPlan> {
  const root = resolve(workspace)
  if ((await realpath(root)).toLowerCase() !== root.toLowerCase())
    throw new Error('artifact_root_invalid')
  const package_ = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (package_.name !== 'autoreply-desktop-agent') throw new Error('artifact_project_invalid')
  const candidates = new Set<string>(),
    cutoff = Date.now() - minimumAgeMs
  const buildReport = join(root, '.local', 'reports', 'windows-dev-build')
  const successful: string[] = []
  for (const entry of await entries(buildReport)) {
    if (!uuid.test(entry.name)) continue
    try {
      if (
        JSON.parse(await readFile(join(buildReport, entry.name, 'result.json'), 'utf8')).passed ===
        true
      )
        successful.push(entry.name)
    } catch {
      /* Incomplete builds are eligible after the grace period. */
    }
  }
  const kept = new Set(successful.slice(0, 2))
  const latest = await pointer(join(buildReport, 'latest.json'))
  if (latest) kept.add(latest)
  for (const [base, pattern, id] of [
    ['dist', /^windows-dev-([a-f0-9-]{36})$/i, (name: string) => name.slice(12)],
    ['.local/release-build', uuid, (name: string) => name]
  ] as const) {
    for (const row of await entries(join(root, base))) {
      if (
        pattern.test(row.name) &&
        uuid.test(id(row.name)) &&
        !kept.has(id(row.name)) &&
        row.modified < cutoff
      )
        candidates.add(join(base, row.name))
    }
  }
  const previous = (await entries(join(root, '.local', 'native'))).filter(
    (row) => /^previous-/.test(row.name) && uuid.test(row.name.slice(9))
  )
  for (const row of previous.slice(1))
    if (row.modified < cutoff) candidates.add(join('.local', 'native', row.name))
  for (const group of reportGroups) {
    const base = join('.local', 'reports', group),
      rows = (await entries(join(root, base))).filter((row) => uuid.test(row.name))
    const latestReport = await pointer(join(root, base, 'latest.json'))
    const protected_ = new Set(rows.slice(0, 2).map((row) => row.name))
    if (latestReport) protected_.add(latestReport)
    if (group === 'windows-dev-build') for (const id of kept) protected_.add(id)
    for (const row of rows)
      if (!protected_.has(row.name) && row.modified < cutoff) candidates.add(join(base, row.name))
  }
  let total = 0
  for (const path of candidates) {
    await contained(root, join(root, path))
    total += await bytes(join(root, path))
  }
  return { root, paths: [...candidates], bytes: total, keptBuilds: [...kept] }
}
export async function pruneArtifacts(
  plan: ArtifactPlan
): Promise<{ removed: string[]; failed: string[] }> {
  // Recompute the allowlist immediately before mutation; a caller cannot turn
  // a serialized dry-run plan into an arbitrary recursive deletion request.
  const fresh = await planArtifacts(plan.root, 0),
    allowed = new Set(fresh.paths)
  const removed: string[] = [],
    failed: string[] = []
  for (const path of plan.paths) {
    if (!allowed.has(path)) throw new Error('artifact_path_invalid')
    const target = join(plan.root, path)
    await contained(plan.root, target)
    try {
      await rm(target, { recursive: true, force: false })
      removed.push(path)
    } catch {
      failed.push(path)
    }
  }
  return { removed, failed }
}
