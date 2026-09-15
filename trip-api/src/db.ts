import pg from 'pg'

const { Pool } = pg

export type Db = pg.Pool

export function createPool(): Db {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL is required')
  }
  return new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
  })
}

export async function withClient<T>(
  pool: Db,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

export async function withTransaction<T>(
  pool: Db,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withClient(pool, async (client) => {
    await client.query('BEGIN')
    try {
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    }
  })
}
