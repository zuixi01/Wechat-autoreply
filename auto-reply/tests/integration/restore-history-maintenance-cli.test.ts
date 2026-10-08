import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
const execute = promisify(execFile)
const run = (args: string[], env = process.env) =>
  execute(
    process.execPath,
    ['--import', 'tsx', resolve('server/scripts/restore-history-maintenance.ts'), ...args],
    { windowsHide: true, env, timeout: 5000 }
  )
it('documents independent maintenance authority and physical review without any database connection', async () => {
  const result = await run(['--help'])
  expect(result.stdout).toContain('RESTORE_HISTORY_MAINTENANCE_DATABASE_URL')
  expect(result.stdout).toContain('Authenticate before opening input')
  expect(result.stdout).toContain('No source seeding, resume')
})
it.each([
  [
    'register',
    '--file',
    'private',
    '--file',
    'second',
    '--database',
    'synthetic',
    '--output',
    '.local/test.json'
  ],
  [
    'register',
    '--database',
    'synthetic',
    '--file',
    'private',
    '--output',
    '.local/test.json',
    '--canRelease',
    'true'
  ],
  ['register', '--help'],
  ['unknown']
])('rejects malformed maintenance arguments before connecting %j', async (...args) => {
  await expect(run(args)).rejects.toMatchObject({ stderr: 'maintenance_arguments_invalid\n' })
})
it('requires separate maintenance credentials before reading input, with no administrator or service fallback', async () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: 'postgresql://PRIVATE_SERVICE',
    ADMIN_DATABASE_URL: 'postgresql://PRIVATE_ADMIN'
  }
  delete env.RESTORE_HISTORY_MAINTENANCE_DATABASE_URL
  await expect(
    run(
      [
        'register',
        '--database',
        'synthetic',
        '--file',
        'missing-private-file',
        '--output',
        '.local/test.json'
      ],
      env
    )
  ).rejects.toMatchObject({ stderr: 'maintenance_credentials_required\n' })
})
