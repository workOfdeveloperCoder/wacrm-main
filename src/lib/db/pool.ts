import { Pool, type PoolClient } from 'pg'

import type { ForeignKey } from './types'

const globalForPg = globalThis as { wacrmPool?: Pool; wacrmFks?: ForeignKey[] }

export function getPool(): Pool {
  if (!globalForPg.wacrmPool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set')
    }
    const local = /localhost|127\.0\.0\.1/.test(connectionString)
    globalForPg.wacrmPool = new Pool({
      connectionString,
      max: 10,
      ssl: local ? false : { rejectUnauthorized: false },
    })
  }
  return globalForPg.wacrmPool
}

export async function foreignKeys(): Promise<ForeignKey[]> {
  if (globalForPg.wacrmFks) return globalForPg.wacrmFks
  const { rows } = await getPool().query<{
    constraint_name: string
    from_table: string
    from_col: string
    to_table: string
    to_col: string
  }>(`
    SELECT tc.constraint_name,
           kcu.table_name AS from_table,
           kcu.column_name AS from_col,
           ccu.table_name AS to_table,
           ccu.column_name AS to_col
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
  `)
  globalForPg.wacrmFks = rows.map((row) => ({
    constraint: row.constraint_name,
    fromTable: row.from_table,
    fromCol: row.from_col,
    toTable: row.to_table,
    toCol: row.to_col,
  }))
  return globalForPg.wacrmFks
}

export async function withRole<T>(
  userId: string | null,
  bypass: boolean,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    if (!bypass) {
      if (!userId) {
        await client.query('ROLLBACK')
        throw Object.assign(new Error('Not authenticated'), { code: '401' })
      }
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`)
      await client.query('SET LOCAL ROLE authenticated')
    }
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* connection already closed */
    }
    throw error
  } finally {
    client.release()
  }
}
