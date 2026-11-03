import { createHmac, timingSafeEqual } from 'crypto'

export const SESSION_COOKIE = 'wacrm_session'
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface SessionPayload {
  sid: string
  sub: string
  exp: number
}

function secret(): string {
  return process.env.AUTH_SECRET || process.env.ENCRYPTION_KEY || 'dev-only-change-me'
}

export function signSession(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret()).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function readSessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token) return null
  const dot = token.indexOf('.')
  if (dot < 1) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = createHmac('sha256', secret()).update(body).digest('base64url')
  const got = Buffer.from(sig)
  const want = Buffer.from(expected)
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload
    if (!payload.sid || !payload.sub || payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: WEEK_MS / 1000,
  }
}

export function sessionExpiry(): number {
  return Date.now() + WEEK_MS
}
