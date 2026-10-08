import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
const execute = promisify(execFile)
describe('central maintenance CLI', () => {
  it('documents a fresh isolated restore without production cutover', async () => {
    const r = await execute(
      process.execPath,
      ['--import', 'tsx', resolve('scripts/central-recovery.ts'), '--help'],
      { windowsHide: true }
    )
    expect(r.stdout).toContain('restore --backup')
    expect(r.stdout).toContain('PGDATABASE')
    expect(r.stdout).toContain('never overwrites')
  })
  it.each([
    ['restore', '--backup', 'PRIVATE', '--backup', 'PRIVATE', '--output', 'PRIVATE'],
    ['restore', '--backup', 'PRIVATE', '--output', 'PRIVATE', '--database', 'business'],
    ['restore', '--backup', 'PRIVATE', '--output', 'PRIVATE', '--canRelease', 'true']
  ])('rejects duplicate or authority-changing arguments with fixed errors %j', async (...args) => {
    await expect(
      execute(
        process.execPath,
        ['--import', 'tsx', resolve('scripts/central-recovery.ts'), ...args],
        { windowsHide: true }
      )
    ).rejects.toMatchObject({ stderr: 'central_recovery_arguments_invalid\n' })
  })
})
