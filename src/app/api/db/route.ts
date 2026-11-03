import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

import { sessionUser } from '@/lib/db/auth'
import { runQuery, runRpc } from '@/lib/db/execute'
import { foreignKeys, withRole } from '@/lib/db/pool'
import { SESSION_COOKIE } from '@/lib/db/session'
import type { QueryState } from '@/lib/db/types'

export async function POST(request: Request) {
  const store = await cookies()
  const session = await sessionUser(store.get(SESSION_COOKIE)?.value)
  if (!session) {
    return NextResponse.json(
      { data: null, error: { message: 'Not authenticated', code: '401' } },
      { status: 401 },
    )
  }

  const body = (await request.json()) as QueryState & { rpc?: string; args?: Record<string, unknown> }
  if (body.table === 'user_sessions') {
    return NextResponse.json(
      { data: null, error: { message: 'Not allowed', code: '42501' } },
      { status: 403 },
    )
  }

  const fks = await foreignKeys()
  const result = body.rpc
    ? await withRole(session.sub, false, (client) => runRpc(client, body.rpc!, body.args ?? {}))
    : await withRole(session.sub, false, (client) => runQuery(client, body, fks))
  return NextResponse.json(result)
}
