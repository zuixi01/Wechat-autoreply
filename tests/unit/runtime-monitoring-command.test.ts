import { describe, expect, it, vi } from 'vitest'
import { parseAdminCommand, executeAdminCommand } from '../../server/src/admin/command'
import type { Administration } from '../../server/src/admin/administration'

describe('read-only runtime monitoring command', () => {
  it('routes the bounded filter and cursor without reading private publication files', async () => {
    const runtimeStatus = vi.fn(async () => ({ rows: [], nextCursor: null })),
      read = vi.fn()
    const command = parseAdminCommand([
      'runtime-status',
      '--tenant',
      'A',
      '--account',
      'account',
      '--after',
      'synthetic-cursor',
      '--limit',
      '100'
    ])
    expect(
      await executeAdminCommand({ runtimeStatus } as unknown as Administration, command, read)
    ).toEqual({ rows: [], nextCursor: null })
    expect(runtimeStatus).toHaveBeenCalledWith('A', {
      accountId: 'account',
      after: 'synthetic-cursor',
      limit: 100
    })
    expect(read).not.toHaveBeenCalled()
  })
  it.each([
    ['runtime-status', '--tenant', 'A', '--limit', '101'],
    ['runtime-status', '--tenant', 'A', '--limit', '0'],
    ['runtime-status', '--tenant', 'A', '--limit', '1', '--limit', '2'],
    ['runtime-status', '--tenant', 'A', '--credential', 'secret'],
    ['runtime-status', '--tenant', 'A', '--file', 'private.json'],
    ['runtime-status', '--tenant', 'A', '--resume']
  ])('rejects invalid or mutating options %#', (...args) => {
    expect(() => parseAdminCommand(args)).toThrow()
  })
})
