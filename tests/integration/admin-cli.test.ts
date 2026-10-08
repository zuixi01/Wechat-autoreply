import { execFile } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { textGeneratorVersion } from '../../server/src/generation/text-generator'

function run(
  args: string[],
  extra: Record<string, string> = {}
): Promise<{ code: string | number; stdout: string; stderr: string }> {
  return new Promise((resolve) =>
    execFile(
      process.execPath,
      ['--import', 'tsx', 'server/scripts/admin.ts', ...args],
      {
        timeout: 5000,
        windowsHide: true,
        env: {
          ...process.env,
          ADMIN_DATABASE_URL: '',
          DATABASE_URL: 'postgresql://user:synthetic_password@127.0.0.1:1/db',
          TEXT_MODEL_API_KEY: '',
          TYPESAFE_API_KEY: '',
          TEXT_MODEL_BASE_URL: '',
          TEXT_MODEL_ID: '',
          TEXT_MODEL_EXPECTED_ID: '',
          ...extra
        }
      },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })
    )
  )
}
describe('actual administrator CLI process with synthetic environment', () => {
  it('offers help without database or provider credentials', async () => {
    const result = await run(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('ADMIN_DATABASE_URL only')
    expect(result.stdout).toContain('open-reconciliation')
    expect(result.stdout).toContain('open-restore-review')
    expect(result.stdout).toContain('restore reviews never resume devices')
    expect(result.stdout).toContain('restore-pause-reports --case ID')
    expect(result.stdout).toContain('restore-pause-report --case ID --challenge ID')
    expect(result.stdout).toContain('restore-permit-audit --case ID')
    expect(result.stdout).toContain('expired issuance is unresolved')
    expect(result.stdout).toContain(
      'Historical receipts do not prove current or all-device physical stop'
    )
    expect(result.stdout).toContain('notes do not settle permits or acknowledge device stop')
    expect(result.stderr).toBe('')
  })
  it('refuses falling back to normal service credentials and does not log them', async () => {
    const result = await run(['accounts', '--tenant', 'synthetic-company'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({ success: false, code: 'DENIED' })
    expect(result.stderr).not.toContain('synthetic_password')
    expect(result.stderr).not.toContain('postgresql://')
  })
  it.each(['restore-pause-report', 'restore-pause-reports', 'restore-permit-audit'])(
    'requires independent administrator credentials for %s',
    async (command) => {
      const id = '11111111-1111-4111-8111-111111111111'
      const result = await run([
        command,
        '--tenant',
        'A',
        '--account',
        'account',
        '--case',
        id,
        ...(command === 'restore-pause-report' ? ['--challenge', id] : [])
      ])
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(JSON.parse(result.stderr)).toEqual({ success: false, code: 'DENIED' })
      expect(result.stderr).not.toContain('synthetic_password')
      expect(result.stderr).not.toContain('postgresql://')
    }
  )
  it('requires the separate administrator credential before reading a restore input file', async () => {
    const result = await run([
      'open-restore-review',
      '--tenant',
      'A',
      '--account',
      'a',
      '--file',
      'does-not-exist.json'
    ])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({ success: false, code: 'DENIED' })
    expect(result.stderr).not.toContain('synthetic_password')
  })
  it('prints the active generator fingerprint without requiring a database or making a model request', async () => {
    const config = {
      baseUrl: 'https://provider.example/v1',
      model: 'synthetic-requested',
      expectedModel: 'synthetic-resolved'
    }
    const result = await run(['generator-version'], {
      TEXT_MODEL_BASE_URL: config.baseUrl,
      TEXT_MODEL_ID: config.model,
      TEXT_MODEL_EXPECTED_ID: config.expectedModel
    })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      textGeneratorVersion: textGeneratorVersion(config)
    })
    expect(result.stderr).toBe('')
  })
  it('requires independent administrator credentials for reconciliation and masks failures', async () => {
    const result = await run([
      'open-reconciliation',
      '--tenant',
      'synthetic-company',
      '--account',
      'a',
      '--permit',
      'p'
    ])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({ success: false, code: 'DENIED' })
    expect(result.stderr).not.toContain('synthetic_password')
  })
})
