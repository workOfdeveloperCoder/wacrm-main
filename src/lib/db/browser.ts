'use client'

import { createQuery } from './query'
import type { AuthUser, DbResult, QueryState } from './types'

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function postQuery(state: QueryState): Promise<DbResult> {
  const response = await fetch('/api/db', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(state),
  })
  const body = await readJson(response)
  if (body && typeof body === 'object') return body as DbResult
  return {
    data: null,
    error: { message: response.ok ? 'Empty response' : `Request failed (${response.status})` },
  }
}

async function postAuth<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body ?? {}),
  })
  const parsed = await readJson(response)
  if (parsed && typeof parsed === 'object') return parsed as T
  return { error: { message: response.ok ? 'Empty response' : `Request failed (${response.status})` } } as T
}

type ChangeHandler = (event: string, session: { user: AuthUser } | null) => void
const listeners = new Set<ChangeHandler>()

function emit(event: string, user: AuthUser | null) {
  const session = user ? { user } : null
  for (const listener of listeners) listener(event, session)
}

let browserClient: ReturnType<typeof createBrowserClient> | null = null

function createBrowserClient() {
  return {
    from(table: string) {
      return createQuery(table, postQuery)
    },
    rpc(fn: string, args: Record<string, unknown> = {}) {
      return fetch('/api/db', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ rpc: fn, args }),
      }).then((response) => response.json())
    },
    auth: {
      async getUser() {
        const body = await postAuth<{ user: AuthUser | null }>('/api/auth/session')
        return { data: { user: body.user }, error: null as { message: string } | null }
      },
      async getSession() {
        const body = await postAuth<{ user: AuthUser | null }>('/api/auth/session')
        return { data: { session: body.user ? { user: body.user } : null }, error: null as { message: string } | null }
      },
      async signInWithPassword(input: { email: string; password: string }) {
        const body = await postAuth<{ user?: AuthUser; error?: { message: string } }>('/api/auth/login', input)
        if (body.error) return { data: { user: null, session: null }, error: body.error }
        emit('SIGNED_IN', body.user ?? null)
        return { data: { user: body.user ?? null, session: body.user ? { user: body.user } : null }, error: null }
      },
      async signUp(input: {
        email: string
        password: string
        options?: { data?: { full_name?: string }; emailRedirectTo?: string }
      }) {
        const body = await postAuth<{ user?: AuthUser; error?: { message: string } }>('/api/auth/signup', {
          email: input.email,
          password: input.password,
          fullName: input.options?.data?.full_name,
        })
        if (body.error) return { data: { user: null }, error: body.error }
        return { data: { user: body.user ?? null }, error: null }
      },
      async signOut(input?: { scope?: 'local' | 'global' }) {
        await postAuth('/api/auth/logout', { scope: input?.scope ?? 'local' })
        emit('SIGNED_OUT', null)
        return { error: null as { message: string } | null }
      },
      async updateUser(input: { password?: string; email?: string }) {
        const body = await postAuth<{ user?: AuthUser; error?: { message: string } }>('/api/auth/password', input)
        if (body.error) return { data: { user: null }, error: body.error }
        return { data: { user: body.user ?? null }, error: null }
      },
      async resetPasswordForEmail(_email?: string, _options?: { redirectTo?: string }) {
        return { data: null, error: { message: 'Password reset email is not set up on this Postgres install' } }
      },
      onAuthStateChange(cb: ChangeHandler) {
        listeners.add(cb)
        void postAuth<{ user: AuthUser | null }>('/api/auth/session').then((body) => {
          cb('INITIAL_SESSION', body.user ? { user: body.user } : null)
        })
        return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } }
      },
      async exchangeCodeForSession() {
        return { error: { message: 'Email links are not used with Postgres login' } }
      },
      async verifyOtp() {
        return { error: { message: 'Email links are not used with Postgres login' } }
      },
    },
    storage: {
      from(bucket: string) {
        return {
          async upload(filePath: string, file: Blob, options?: { contentType?: string; upsert?: boolean; cacheControl?: string }) {
            const body = new FormData()
            body.set('file', file, 'upload')
            body.set('upsert', options?.upsert ? '1' : '0')
            const response = await fetch(`/api/storage/${bucket}/${filePath}`, {
              method: 'POST',
              body,
              credentials: 'same-origin',
            })
            return response.json()
          },
          getPublicUrl(filePath: string) {
            return { data: { publicUrl: `/api/storage/${bucket}/${filePath}` } }
          },
          async remove(paths: string[]) {
            const response = await fetch(`/api/storage/${bucket}`, {
              method: 'DELETE',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ paths }),
            })
            return response.json()
          },
        }
      },
    },
    channel(name: string) {
      return createChannel(name)
    },
    removeChannel(channel?: { stop?: () => void }) {
      channel?.stop?.()
    },
  }
}

/** One client per tab. A new object each render retriggers effects that list it as a dependency. */
export function createClient() {
  if (!browserClient) browserClient = createBrowserClient()
  return browserClient
}

interface Listener {
  table: string
  filter?: string
  callback: (payload: { eventType: string; new: any; old: any }) => void
}

function createChannel(_name: string) {
  const listeners: Listener[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  const seen = new Map<string, string>()
  let primed = false
  const api = {
    on(
      _event: string,
      filter: { table?: string; filter?: string; event?: string; schema?: string },
      callback: (payload: any) => void,
    ) {
      if (filter?.table) listeners.push({ table: filter.table, filter: filter.filter, callback })
      return api
    },
    subscribe(cb?: (status: string) => void) {
      cb?.('SUBSCRIBED')
      timer = setInterval(() => void poll(), 4000)
      return api
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }

  async function poll() {
    for (const listener of listeners) {
      const query = createQuery(listener.table, postQuery)
      let pending = query.select('*').limit(200)
      const match = listener.filter?.match(/^([A-Za-z_][A-Za-z0-9_]*)=eq\.(.+)$/)
      if (match) pending = pending.eq(match[1], match[2])
      const { data } = await pending
      if (!Array.isArray(data)) continue
      for (const row of data as Record<string, unknown>[]) {
        const id = String(row.id ?? row.user_id ?? '')
        if (!id) continue
        const key = `${listener.table}:${id}`
        const stamp = JSON.stringify(row)
        const previous = seen.get(key)
        seen.set(key, stamp)
        if (!primed || previous === stamp) continue
        listener.callback({
          eventType: previous ? 'UPDATE' : 'INSERT',
          new: row,
          old: {},
        })
      }
    }
    primed = true
  }

  return api
}
