import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPostgresCentralArchive } from '../../src/core/persistence/postgres-archive'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function tool(failure = '') {
  const root = mkdtempSync(join(tmpdir(), 'autoreply-pgtool-'))
  roots.push(root)
  const script = join(root, 'pgtool.cjs')
  const tables = [
    'accounts',
    'agents',
    'execution_permits',
    'audit_events',
    'generation_publications',
    'learning_memories',
    'ledger_restore_reviews'
  ]
  const toc = tables
    .flatMap((table, i) => [
      `${i + 1}; 1259 42 TABLE autoreply ${table} postgres`,
      `${i + 100}; 0 42 TABLE DATA autoreply ${table} postgres`
    ])
    .join('\n')
  writeFileSync(
    script,
    `const a=process.argv.slice(2); if(a[0]==='--version')process.stdout.write('pg_dump (PostgreSQL) 16.15 (Debian 16.15-1.pgdg13+2)'); else if(a[0]==='--list') { require('node:fs').accessSync(a[1]); process.stdout.write(${JSON.stringify(toc)}) } else { require('node:assert/strict').deepEqual(a,['--format=custom','--no-password','--lock-wait-timeout=5s']); process.stdout.write('PGDMPsynthetic-full-archive'); ${failure} }`
  )
  const executable = { executable: process.execPath, prefix: [script] }
  return { root, central: createPostgresCentralArchive({ dump: executable, restore: executable }) }
}
describe('actual subprocess central archive transport', () => {
  it('streams archive bytes to an exclusive file and verifies the real tool listing', async () => {
    const f = tool(),
      archive = join(f.root, 'central.dump')
    expect(await f.central.exportTo(archive)).toEqual({ toolVersion: 'pg_dump (PostgreSQL) 16.15' })
    expect(readFileSync(archive, 'utf8')).toBe('PGDMPsynthetic-full-archive')
    await expect(f.central.inspect(archive)).resolves.toBeUndefined()
    await expect(f.central.exportTo(archive)).rejects.toThrow('postgres_archive_command_failed')
    expect(readFileSync(archive, 'utf8')).toBe('PGDMPsynthetic-full-archive')
  })
  it.each(["process.stderr.write('postgresql://PRIVATE_CREDENTIAL');", 'process.exitCode=1;'])(
    'rejects stderr warnings and failed exporters with sanitized diagnostics: %s',
    async (failure) => {
      const f = tool(failure)
      await expect(f.central.exportTo(join(f.root, 'central.dump'))).rejects.toMatchObject({
        message: 'postgres_archive_command_failed'
      })
    }
  )
})
