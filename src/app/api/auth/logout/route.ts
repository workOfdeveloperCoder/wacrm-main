import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

import { destroySession } from '@/lib/db/auth'
import { SESSION_COOKIE } from '@/lib/db/session'

export async function POST(request: Request) {
  const { scope } = (await request.json().catch(() => ({}))) as { scope?: 'local' | 'global' }
  const store = await cookies()
  await destroySession(store.get(SESSION_COOKIE)?.value, scope === 'global' ? 'global' : 'local')
  const response = NextResponse.json({ ok: true })
  response.cookies.delete(SESSION_COOKIE)
  return response
}
