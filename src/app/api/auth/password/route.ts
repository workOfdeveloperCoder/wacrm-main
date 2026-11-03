import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

import { sessionUser, updateEmail, updatePassword } from '@/lib/db/auth'
import { SESSION_COOKIE } from '@/lib/db/session'

export async function POST(request: Request) {
  const store = await cookies()
  const session = await sessionUser(store.get(SESSION_COOKIE)?.value)
  if (!session) {
    return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 })
  }
  const body = (await request.json()) as { password?: string; email?: string }
  if (body.password) await updatePassword(session.sub, body.password)
  if (body.email) await updateEmail(session.sub, body.email)
  return NextResponse.json({ user: { id: session.sub, email: body.email } })
}
