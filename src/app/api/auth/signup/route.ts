import { NextResponse } from 'next/server'

import { signUp } from '@/lib/db/auth'

export async function POST(request: Request) {
  const { email, password, fullName } = (await request.json()) as {
    email?: string
    password?: string
    fullName?: string
  }
  if (!email || !password) {
    return NextResponse.json({ error: { message: 'Email and password are required' } }, { status: 400 })
  }
  try {
    const user = await signUp(email, password, fullName)
    return NextResponse.json({ user })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create the account'
    const status = message.includes('duplicate') || message.includes('unique') ? 409 : 400
    return NextResponse.json({ error: { message } }, { status })
  }
}
