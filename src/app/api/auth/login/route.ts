import { NextResponse } from 'next/server'

import { openSession, signIn } from '@/lib/db/auth'
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/db/session'

export async function POST(request: Request) {
  const { email, password } = (await request.json()) as { email?: string; password?: string }
  if (!email || !password) {
    return NextResponse.json({ error: { message: 'Email and password are required' } }, { status: 400 })
  }
  try {
    const user = await signIn(email, password)
    const token = await openSession(user.id)
    const response = NextResponse.json({ user })
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions())
    return response
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid email or password'
    return NextResponse.json({ error: { message } }, { status: 401 })
  }
}
