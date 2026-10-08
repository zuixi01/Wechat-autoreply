import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
const execute = promisify(execFile)
describe('private joint recovery command', () => {
  it('documents only backup, verification and non-activating staging', async () => {
    const result = await execute(
      process.execPath,
      ['--import', 'tsx', resolve('scripts/joint-recovery.ts'), '--help'],
      { windowsHide: true }
    )
    expect(result.stdout).toContain('backup --profile')
    expect(result.stdout).toContain('stage --backup')
    expect(result.stdout).toContain('PGDATABASE')
    expect(result.stdout).toContain('does not activate')
  })
  it('rejects duplicate options and extra authority fields without exposing argument contents', async () => {
    await expect(
      execute(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('scripts/joint-recovery.ts'),
          'backup',
          '--profile',
          'PRIVATE_VALUE',
          '--profile',
          'PRIVATE_VALUE',
          '--output',
          'PRIVATE_VALUE'
        ],
        { windowsHide: true }
      )
    ).rejects.toMatchObject({ stderr: 'joint_recovery_arguments_invalid\n' })
    await expect(
      execute(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('scripts/joint-recovery.ts'),
          'stage',
          '--backup',
          'PRIVATE_VALUE',
          '--output',
          'PRIVATE_VALUE',
          '--canRelease',
          'true'
        ],
        { windowsHide: true }
      )
    ).rejects.toMatchObject({ stderr: 'joint_recovery_arguments_invalid\n' })
  })
})
