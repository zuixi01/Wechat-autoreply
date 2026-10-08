import { Pool, type PoolClient } from 'pg'

export class Postgres {
  readonly pool: Pool
  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 5000,
      lock_timeout: 2500,
      idle_in_transaction_session_timeout: 5000,
      application_name: 'autoreply-service',
      options: '-c search_path=autoreply,public'
    })
    // Idle connection failures must not become an uncaught EventEmitter error;
    // database URLs and server diagnostics can contain credentials.
    this.pool.on('error', () => {
      process.stderr.write('Database connection unavailable.\n')
    })
  }

  async transaction<T>(
    tenantId: string,
    operation: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect()
    let discard = false
    try {
      // Capacity/quota admission must see commits made while its lock was waiting.
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId])
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        discard = true
      }
      throw error
    } finally {
      client.release(discard)
    }
  }
  async close(): Promise<void> {
    await this.pool.end()
  }
}
