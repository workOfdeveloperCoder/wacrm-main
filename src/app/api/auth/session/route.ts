import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

import { sessionUser } from '@/lib/db/auth'
import { getPool } from '@/lib/db/pool'
import { SESSION_COOKIE } from '@/lib/db/session'

export async function POST() {
  const store = await cookies()
  const session = await sessionUser(store.get(SESSION_COOKIE)?.value)
  if (!session) return NextResponse.json({ user: null })
  const { rows } = await getPool().query<{ email: string | null; created_at: Date | string | null }>(
    `SELECT email, created_at FROM auth.users WHERE id = $1`,
    [session.sub],
  )
  const row = rows[0]
  const createdAt = row?.created_at instanceof Date ? row.created_at.toISOString() : row?.created_at ?? undefined
  return NextResponse.json({
    user: { id: session.sub, email: row?.email ?? undefined, created_at: createdAt },
  })
}
