import { describe, expect, it, vi } from 'vitest'
import { parseAdminCommand, executeAdminCommand } from '../../server/src/admin/command'
import type { Administration } from '../../server/src/admin/administration'

describe('strict administrator command boundary', () => {
  it('routes full-tenant pause and frozen account pages and rejects accidental account-scoped options', async () => {
    const id = '9b25db37-e792-4a82-9a10-d706df27cff6',
      admin = { requestPauseAll: vi.fn(), pauseAllRequest: vi.fn(), pauseAllAccounts: vi.fn() },
      read = vi.fn()
    await executeAdminCommand(
      admin as unknown as Administration,
      parseAdminCommand(['request-pause-all', '--tenant', 'A', '--request', id]),
      read
    )
    await executeAdminCommand(
      admin as unknown as Administration,
      parseAdminCommand(['pause-all-request', '--tenant', 'A', '--request', id]),
      read
    )
    await executeAdminCommand(
      admin as unknown as Administration,
      parseAdminCommand([
        'pause-all-accounts',
        '--tenant',
        'A',
        '--request',
        id,
        '--limit',
        '100',
        '--after',
        'cursor'
      ]),
      read
    )
    expect(admin.requestPauseAll).toHaveBeenCalledWith('A', id)
    expect(admin.pauseAllRequest).toHaveBeenCalledWith('A', id)
    expect(admin.pauseAllAccounts).toHaveBeenCalledWith('A', id, { limit: 100, after: 'cursor' })
    expect(read).not.toHaveBeenCalled()
    for (const args of [
      ['request-pause-all', '--tenant', 'A', '--account', 'wrong'],
      ['pause-all-request', '--tenant', 'A'],
      ['pause-all-accounts', '--tenant', 'A', '--request', id, '--limit', '101'],
      ['request-pause-all', '--tenant', 'A', '--request', id, '--request', id]
    ])
      expect(() => parseAdminCommand(args)).toThrow()
  })
  it('routes a purpose-bound pause and its read-only summary with an explicit request UUID', async () => {
    const id = '9b25db37-e792-4a82-9a10-d706df27cff6',
      summary = { requestId: id, physicalStopVerified: false },
      admin = {
        requestPause: vi.fn(async () => summary),
        pauseRequest: vi.fn(async () => summary)
      },
      read = vi.fn()
    for (const command of ['request-pause', 'pause-request'])
      expect(
        await executeAdminCommand(
          admin as unknown as Administration,
          parseAdminCommand([command, '--tenant', 'A', '--account', 'a', '--request', id]),
          read
        )
      ).toEqual(summary)
    expect(admin.requestPause).toHaveBeenCalledWith('A', 'a', id)
    expect(admin.pauseRequest).toHaveBeenCalledWith('A', 'a', id)
    expect(read).not.toHaveBeenCalled()
    for (const args of [
      ['request-pause', '--tenant', 'A', '--request', id],
      ['request-pause', '--tenant', 'A', '--account', 'a', '--request', 'invalid'],
      ['pause-request', '--tenant', 'A', '--account', 'a', '--request', id, '--request', id],
      ['pause-request', '--tenant', 'A', '--account', 'a', '--file', 'unused']
    ])
      expect(() => parseAdminCommand(args)).toThrow()
  })
  it('writes a prepared learning publication privately and returns only its summary', async () => {
    const publication = { privateEvidence: 'private-body' }
    const summary = { publicationHash: 'bound-hash', methodCount: 1 }
    const prepareLearningPublication = vi.fn(async () => ({ publication, summary }))
    const write = vi.fn(async () => {})
    const command = parseAdminCommand([
      'prepare-learning',
      '--tenant',
      'A',
      '--account',
      'a',
      '--file',
      'template.json',
      '--out',
      '.local/prepared.json'
    ])
    const result = await executeAdminCommand(
      { prepareLearningPublication } as unknown as Administration,
      command,
      async () => ({ template: true }),
      write
    )
    expect(prepareLearningPublication).toHaveBeenCalledWith('A', 'a', { template: true })
    expect(write).toHaveBeenCalledWith('.local/prepared.json', publication)
    expect(result).toEqual(summary)
    expect(JSON.stringify(result)).not.toContain('private-body')
  })
  it('requires a writer before preparing and rejects missing, repeated or unrelated output options', async () => {
    const prepareLearningPublication = vi.fn()
    const command = parseAdminCommand([
      'prepare-learning',
      '--tenant',
      'A',
      '--account',
      'a',
      '--file',
      'template.json',
      '--out',
      '.local/prepared.json'
    ])
    await expect(
      executeAdminCommand(
        { prepareLearningPublication } as unknown as Administration,
        command,
        async () => ({})
      )
    ).rejects.toThrow('private_admin_writer_required')
    expect(prepareLearningPublication).not.toHaveBeenCalled()
    for (const args of [
      ['prepare-learning', '--tenant', 'A', '--account', 'a', '--file', 'template.json'],
      [
        'prepare-learning',
        '--tenant',
        'A',
        '--account',
        'a',
        '--file',
        'template.json',
        '--out',
        'one',
        '--out',
        'two'
      ],
      ['publish', '--tenant', 'A', '--account', 'a', '--file', 'template.json', '--out', 'unused']
    ])
      expect(() => parseAdminCommand(args)).toThrow()
  })
  it('routes model limits and read-only usage commands through independent scoped administration', async () => {
    const admin = {
      setModelLimits: vi.fn(),
      modelLimits: vi.fn(),
      modelRuns: vi.fn(),
      modelUsage: vi.fn()
    }
    const read = vi.fn(async () => ({ dailyAttemptLimit: 30 }))
    await executeAdminCommand(
      admin as unknown as Administration,
      parseAdminCommand([
        'set-model-limits',
        '--tenant',
        'A',
        '--account',
        'a',
        '--file',
        'limits.json'
      ]),
      read
    )
    expect(admin.setModelLimits).toHaveBeenCalledWith('A', 'a', { dailyAttemptLimit: 30 })
    await executeAdminCommand(
      admin as unknown as Administration,
      parseAdminCommand(['model-limits', '--tenant', 'A', '--account', 'a']),
      read
    )
    await executeAdminCommand(
      admin as unknown as Administration,
      parseAdminCommand(['model-runs', '--tenant', 'A', '--account', 'a', '--task', 'task']),
      read
    )
    await executeAdminCommand(
      admin as unknown as Administration,
      parseAdminCommand(['model-usage', '--tenant', 'A', '--account', 'a', '--date', '2026-10-02']),
      read
    )
    expect(admin.modelLimits).toHaveBeenCalledWith('A', 'a')
    expect(admin.modelRuns).toHaveBeenCalledWith('A', 'a', 'task')
    expect(admin.modelUsage).toHaveBeenCalledWith('A', 'a', '2026-10-02')
    expect(read).toHaveBeenCalledOnce()
  })
  it('rejects malformed usage dates, undeclared model authority and duplicated options', () => {
    for (const args of [
      ['model-usage', '--tenant', 'A', '--account', 'a', '--date', '2026-02-30'],
      ['model-runs', '--tenant', 'A', '--account', 'a', '--task', 't', '--credential', 'secret'],
      ['model-limits', '--tenant', 'A', '--account', 'a', '--file', 'limits.json'],
      ['set-model-limits', '--tenant', 'A', '--account', 'a', '--file', 'one', '--file', 'two']
    ])
      expect(() => parseAdminCommand(args)).toThrow()
  })
  it('routes reviewed final decisions only through an explicit file and scoped administrator command', async () => {
    const decideReconciliation = vi.fn(async () => ({ decisionId: 'synthetic' })),
      read = vi.fn(async () => ({ synthetic: true })),
      caseId = 'fca55e8a-0bb4-40cc-a3c0-d4e6eb647a21'
    const command = parseAdminCommand([
      'decide-reconciliation',
      '--tenant',
      'A',
      '--account',
      'a',
      '--case',
      caseId,
      '--file',
      'reviewed.json'
    ])
    await executeAdminCommand({ decideReconciliation } as unknown as Administration, command, read)
    expect(decideReconciliation).toHaveBeenCalledWith('A', 'a', caseId, { synthetic: true })
    expect(() =>
      parseAdminCommand([
        'decide-reconciliation',
        '--tenant',
        'A',
        '--account',
        'a',
        '--case',
        caseId,
        '--status',
        'confirmed'
      ])
    ).toThrow()
  })
  it('rejects unused, duplicated, missing and credential-in-argv options', () => {
    for (const args of [
      ['accounts', '--tenant', 'A', '--account', 'account-A'],
      ['pause', '--tenant', 'A'],
      ['accounts', '--tenant', 'A', '--tenant', 'B'],
      ['accounts', '--tenant', 'A', '--credential', 'synthetic-secret'],
      ['publish', '--tenant', 'A', '--account', 'account-A', '--file', 'rules.json', 'extra'],
      ['resolve', '--tenant', 'A', '--account', 'account-A']
    ])
      expect(() => parseAdminCommand(args)).toThrow()
  })
  it('uses canonical IDs and rejects forged role fields', () => {
    expect(
      parseAdminCommand([
        'provision',
        '--tenant',
        ' A ',
        '--account',
        ' account-A ',
        '--employee',
        ' employee-A ',
        '--platform',
        'wework'
      ])
    ).toEqual({
      command: 'provision',
      tenant: 'A',
      account: 'account-A',
      employee: 'employee-A',
      platform: 'wework'
    })
    expect(() =>
      parseAdminCommand([
        'provision',
        '--tenant',
        'A',
        '--account',
        'a',
        '--employee',
        'e',
        '--platform',
        'wework',
        '--role',
        'admin'
      ])
    ).toThrow()
  })
  it('keeps central pause distinct from device acknowledgment and avoids reading files', async () => {
    const pause = vi.fn(async () => {}),
      read = vi.fn(async () => ({}))
    const result = await executeAdminCommand(
      { pause } as unknown as Administration,
      parseAdminCommand(['pause', '--tenant', 'A', '--account', 'a']),
      read
    )
    expect(pause).toHaveBeenCalledWith('A', 'a')
    expect(result).toMatchObject({ success: true, devicePauseAcknowledged: null })
    expect(read).not.toHaveBeenCalled()
  })
  it('does not call publication storage when an operator file violates the full contract', async () => {
    const publish = vi.fn(async () => {})
    await expect(
      executeAdminCommand(
        { publish } as unknown as Administration,
        parseAdminCommand(['publish', '--tenant', 'A', '--account', 'a', '--file', 'file.json']),
        async () => ({ automaticEnabled: true })
      )
    ).rejects.toThrow()
    expect(publish).not.toHaveBeenCalled()
  })
  it('routes evaluation commands to the scoped administrator without reusing device credentials', async () => {
    const freezeEvaluation = vi.fn(async () => ({ runId: 'run-A' })),
      approveEvaluation = vi.fn(async () => ({ evaluationApprovalId: 'approval-A' })),
      revokeEvaluation = vi.fn(async () => {}),
      evaluations = vi.fn(async () => []),
      read = vi.fn(async () => ({ privateFixture: true }))
    const admin = {
      freezeEvaluation,
      approveEvaluation,
      revokeEvaluation,
      evaluations
    } as unknown as Administration
    await executeAdminCommand(
      admin,
      parseAdminCommand([
        'freeze-evaluation',
        '--tenant',
        'A',
        '--account',
        'a',
        '--file',
        'freeze.json'
      ]),
      read
    )
    await executeAdminCommand(
      admin,
      parseAdminCommand([
        'approve-evaluation',
        '--tenant',
        'A',
        '--account',
        'a',
        '--run',
        'r',
        '--file',
        'result.json'
      ]),
      read
    )
    const revoked = await executeAdminCommand(
      admin,
      parseAdminCommand([
        'revoke-evaluation',
        '--tenant',
        'A',
        '--account',
        'a',
        '--approval',
        'p'
      ]),
      read
    )
    await executeAdminCommand(
      admin,
      parseAdminCommand(['evaluations', '--tenant', 'A', '--account', 'a']),
      read
    )
    expect(freezeEvaluation).toHaveBeenCalledWith('A', 'a', { privateFixture: true })
    expect(approveEvaluation).toHaveBeenCalledWith('A', 'a', 'r', { privateFixture: true })
    expect(revokeEvaluation).toHaveBeenCalledWith('A', 'a', 'p')
    expect(revoked).toMatchObject({ devicePauseAcknowledged: null })
    expect(evaluations).toHaveBeenCalledWith('A', 'a')
    expect(read).toHaveBeenCalledTimes(2)
    expect(() =>
      parseAdminCommand([
        'approve-evaluation',
        '--tenant',
        'A',
        '--account',
        'a',
        '--file',
        'result.json'
      ])
    ).toThrow()
    expect(() =>
      parseAdminCommand([
        'revoke-evaluation',
        '--tenant',
        'A',
        '--account',
        'a',
        '--approval',
        'p',
        '--file',
        'unused.json'
      ])
    ).toThrow()
  })
  it('routes reconciliation metadata commands and refuses outcome/authority arguments', async () => {
    const caseId = 'fca55e8a-0bb4-40cc-a3c0-d4e6eb647a21'
    const openReconciliation = vi.fn(async () => ({ caseId, devicePauseAcknowledged: null })),
      reconciliations = vi.fn(async () => []),
      reconciliation = vi.fn(async () => ({ case: { caseId }, notes: [] })),
      recordReconciliationNote = vi.fn(async () => ({ noteId: 'note' })),
      read = vi.fn(async () => ({ privateMetadataFixture: true }))
    const admin = {
      openReconciliation,
      reconciliations,
      reconciliation,
      recordReconciliationNote
    } as unknown as Administration
    const opened = await executeAdminCommand(
      admin,
      parseAdminCommand([
        'open-reconciliation',
        '--tenant',
        'A',
        '--account',
        'a',
        '--permit',
        'p'
      ]),
      read
    )
    await executeAdminCommand(
      admin,
      parseAdminCommand(['reconciliations', '--tenant', 'A', '--account', 'a']),
      read
    )
    await executeAdminCommand(
      admin,
      parseAdminCommand(['reconciliation', '--tenant', 'A', '--account', 'a', '--case', caseId]),
      read
    )
    expect(read).not.toHaveBeenCalled()
    await executeAdminCommand(
      admin,
      parseAdminCommand([
        'record-reconciliation-note',
        '--tenant',
        'A',
        '--account',
        'a',
        '--case',
        caseId,
        '--file',
        'note.json'
      ]),
      read
    )
    expect(opened).toMatchObject({ devicePauseAcknowledged: null })
    expect(openReconciliation).toHaveBeenCalledWith('A', 'a', 'p')
    expect(reconciliations).toHaveBeenCalledWith('A', 'a')
    expect(reconciliation).toHaveBeenCalledWith('A', 'a', caseId)
    expect(recordReconciliationNote).toHaveBeenCalledWith('A', 'a', caseId, {
      privateMetadataFixture: true
    })
    for (const args of [
      ['open-reconciliation', '--tenant', 'A', '--account', 'a'],
      ['reconciliation', '--tenant', 'A', '--account', 'a', '--case', 'not-uuid'],
      ['reconciliations', '--tenant', 'A', '--account', 'a', '--file', 'unused'],
      [
        'record-reconciliation-note',
        '--tenant',
        'A',
        '--account',
        'a',
        '--case',
        caseId,
        '--file',
        'note.json',
        '--status',
        'confirmed'
      ],
      [
        'open-reconciliation',
        '--tenant',
        'A',
        '--account',
        'a',
        '--permit',
        'p',
        '--quiescent',
        'true'
      ],
      [
        'record-reconciliation-note',
        '--tenant',
        'A',
        '--account',
        'a',
        '--case',
        caseId,
        '--file',
        'note.json',
        '--case',
        caseId
      ]
    ])
      expect(() => parseAdminCommand(args)).toThrow()
  })
})
