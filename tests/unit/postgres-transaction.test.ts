import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  on: vi.fn()
}))
vi.mock('pg', () => ({
  Pool: class {
    connect = mock.connect
    end = mock.end
    on = mock.on
  }
}))
import { Postgres } from '../../server/src/database/postgres'

beforeEach(() => {
  vi.resetAllMocks()
  mock.query.mockResolvedValue({ rows: [] })
  mock.connect.mockResolvedValue({ query: mock.query, release: mock.release })
})
describe('database transaction connection lifecycle with a mock pool', () => {
  it('sets the trusted tenant scope and commits on the same connection', async () => {
    const db = new Postgres('postgresql://synthetic.invalid/db')
    expect(
      await db.transaction('tenant-A', async (client) => {
        await client.query('SELECT 1')
        return 'result'
      })
    ).toBe('result')
    expect(mock.query.mock.calls).toEqual([
      ['BEGIN ISOLATION LEVEL READ COMMITTED'],
      ["SELECT set_config('app.tenant_id',$1,true)", ['tenant-A']],
      ['SELECT 1'],
      ['COMMIT']
    ])
    expect(mock.release).toHaveBeenCalledExactlyOnceWith(false)
  })
  it('rolls back failed operations and preserves the original error', async () => {
    const db = new Postgres('postgresql://synthetic.invalid/db'),
      original = new Error('operation_failed')
    await expect(
      db.transaction('tenant-A', async () => {
        throw original
      })
    ).rejects.toBe(original)
    expect(mock.query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(mock.release).toHaveBeenCalledExactlyOnceWith(false)
  })
  it('discards a broken rollback connection without replacing the original error', async () => {
    const db = new Postgres('postgresql://synthetic.invalid/db'),
      original = new Error('operation_failed')
    mock.query.mockImplementation(async (text: string) => {
      if (text === 'ROLLBACK') throw new Error('network_lost')
      return { rows: [] }
    })
    await expect(
      db.transaction('tenant-A', async () => {
        throw original
      })
    ).rejects.toBe(original)
    expect(mock.release).toHaveBeenCalledExactlyOnceWith(true)
  })
})
