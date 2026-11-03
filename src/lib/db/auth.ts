import { randomUUID } from 'crypto'

import bcrypt from 'bcryptjs'

import { getPool } from './pool'
import { readSessionToken, sessionExpiry, signSession, type SessionPayload } from './session'
import type { AuthUser } from './types'

let sessionsReady: Promise<void> | null = null

function ensureSessions(): Promise<void> {
  if (!sessionsReady) {
    sessionsReady = getPool()
      .query(`
        CREATE TABLE IF NOT EXISTS public.user_sessions (
          id uuid PRIMARY KEY,
          user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;
      `)
      .then(() => undefined)
  }
  return sessionsReady
}

export async function signUp(email: string, password: string, fullName?: string): Promise<AuthUser> {
  const hash = await bcrypt.hash(password, 10)
  const { rows } = await getPool().query<{ id: string; email: string }>(
    `INSERT INTO auth.users (
       id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous
     ) VALUES (
       gen_random_uuid(), 'authenticated', 'authenticated', $1, $2, now(),
       $3::jsonb, now(), now(), false, false
     )
     RETURNING id, email`,
    [email.trim().toLowerCase(), hash, JSON.stringify({ full_name: fullName ?? '' })],
  )
  const user = rows[0]
  if (!user) throw new Error('Could not create the account')
  return { id: user.id, email: user.email, user_metadata: { full_name: fullName ?? '' } }
}

export async function signIn(email: string, password: string): Promise<AuthUser> {
  const { rows } = await getPool().query<{ id: string; email: string; encrypted_password: string | null }>(
    `SELECT id, email, encrypted_password
     FROM auth.users
     WHERE lower(email) = lower($1) AND deleted_at IS NULL
     LIMIT 1`,
    [email.trim()],
  )
  const user = rows[0]
  if (!user?.encrypted_password || !(await bcrypt.compare(password, user.encrypted_password))) {
    throw new Error('Invalid email or password')
  }
  await getPool().query(`UPDATE auth.users SET last_sign_in_at = now() WHERE id = $1`, [user.id])
  return { id: user.id, email: user.email }
}

export async function openSession(userId: string): Promise<string> {
  await ensureSessions()
  const sid = randomUUID()
  await getPool().query(`INSERT INTO public.user_sessions (id, user_id) VALUES ($1, $2)`, [sid, userId])
  return signSession({ sid, sub: userId, exp: sessionExpiry() })
}

export async function sessionUser(token: string | undefined | null): Promise<SessionPayload | null> {
  const payload = readSessionToken(token)
  if (!payload) return null
  await ensureSessions()
  const { rows } = await getPool().query(`SELECT 1 FROM public.user_sessions WHERE id = $1 AND user_id = $2`, [
    payload.sid,
    payload.sub,
  ])
  return rows.length ? payload : null
}

export async function destroySession(token: string | undefined | null, scope: 'local' | 'global' = 'local') {
  const payload = readSessionToken(token)
  if (!payload) return
  await ensureSessions()
  if (scope === 'global') {
    await getPool().query(`DELETE FROM public.user_sessions WHERE user_id = $1`, [payload.sub])
  } else {
    await getPool().query(`DELETE FROM public.user_sessions WHERE id = $1`, [payload.sid])
  }
}

export async function updatePassword(userId: string, password: string) {
  const hash = await bcrypt.hash(password, 10)
  await getPool().query(`UPDATE auth.users SET encrypted_password = $2, updated_at = now() WHERE id = $1`, [
    userId,
    hash,
  ])
}

export async function updateEmail(userId: string, email: string) {
  await getPool().query(`UPDATE auth.users SET email = $2, updated_at = now() WHERE id = $1`, [
    userId,
    email.trim().toLowerCase(),
  ])
  await getPool().query(`UPDATE public.profiles SET email = $2 WHERE user_id = $1`, [
    userId,
    email.trim().toLowerCase(),
  ])
}
