import { cookies } from 'next/headers'
import { mkdir, writeFile, rm } from 'fs/promises'
import path from 'path'

import { destroySession, sessionUser, updateEmail, updatePassword } from './auth'
import { runQuery, runRpc } from './execute'
import { foreignKeys, withRole } from './pool'
import { createQuery, type QueryRunner } from './query'
import { SESSION_COOKIE } from './session'
import type { AuthUser, DbResult, QueryState } from './types'

const STORAGE_ROOT = path.join(process.cwd(), 'data', 'storage')

async function currentUserId(): Promise<string | null> {
  const store = await cookies()
  const session = await sessionUser(store.get(SESSION_COOKIE)?.value)
  return session?.sub ?? null
}

function runner(userId: string | null, bypass: boolean): QueryRunner {
  return async (state: QueryState): Promise<DbResult> => {
    if (state.table === 'user_sessions') {
      return { data: null, error: { message: 'Not allowed', code: '42501' } }
    }
    if (!bypass && !userId) {
      return { data: null, error: { message: 'Not authenticated', code: '401' } }
    }
    const fks = await foreignKeys()
    return withRole(userId, bypass, (client) => runQuery(client, state, fks))
  }
}

function storageApi() {
  return {
    from(bucket: string) {
      const root = path.resolve(STORAGE_ROOT, bucket)
      return {
        async upload(
          filePath: string,
          file: Blob | Buffer | Uint8Array,
          options?: { upsert?: boolean; contentType?: string; cacheControl?: string },
        ) {
          const target = path.resolve(root, filePath)
          if (!target.startsWith(root)) {
            return { data: null, error: { message: 'Invalid path' } }
          }
          await mkdir(path.dirname(target), { recursive: true })
          const bytes = Buffer.isBuffer(file)
            ? file
            : file instanceof Uint8Array
              ? Buffer.from(file)
              : Buffer.from(await file.arrayBuffer())
          try {
            await writeFile(target, bytes, { flag: options?.upsert ? 'w' : 'wx' })
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Upload failed'
            return { data: null, error: { message } }
          }
          return { data: { path: filePath }, error: null }
        },
        getPublicUrl(filePath: string) {
          return { data: { publicUrl: `/api/storage/${bucket}/${filePath}` } }
        },
        async remove(paths: string[]) {
          await Promise.all(
            paths.map(async (filePath) => {
              const target = path.resolve(root, filePath)
              if (target.startsWith(root)) await rm(target, { force: true })
            }),
          )
          return { data: null, error: null }
        },
      }
    },
  }
}

function authApi(userId: string | null): {
  getUser: () => Promise<{ data: { user: AuthUser | null }; error: { message: string } | null }>
  getSession: () => Promise<{ data: { session: { user: AuthUser } | null }; error: { message: string } | null }>
  signInWithPassword: (input: { email: string; password: string }) => Promise<{ data: null; error: { message: string } | null }>
  signUp: (input: { email: string; password: string; options?: { data?: { full_name?: string }; emailRedirectTo?: string } }) => Promise<{ data: null; error: { message: string } | null }>
  signOut: (input?: { scope?: 'local' | 'global' }) => Promise<{ error: { message: string } | null }>
  updateUser: (input: { password?: string; email?: string }) => Promise<{ data: { user: AuthUser | null }; error: { message: string } | null }>
  resetPasswordForEmail: (email: string) => Promise<{ data: null; error: { message: string } | null }>
  onAuthStateChange: (cb: (event: string, session: { user: AuthUser } | null) => void) => { data: { subscription: { unsubscribe: () => void } } }
  exchangeCodeForSession: (code: string) => Promise<{ error: { message: string } | null }>
  verifyOtp: (input: unknown) => Promise<{ error: { message: string } | null }>
} {
  const user = userId ? { id: userId } : null
  return {
    async getUser() {
      return { data: { user }, error: null as { message: string } | null }
    },
    async getSession() {
      return { data: { session: user ? { user } : null }, error: null as { message: string } | null }
    },
    async signInWithPassword() {
      return { data: null, error: { message: 'Sign in from the browser' } }
    },
    async signUp() {
      return { data: null, error: { message: 'Sign up from the browser' } }
    },
    async signOut(input) {
      const store = await cookies()
      await destroySession(store.get(SESSION_COOKIE)?.value, input?.scope === 'global' ? 'global' : 'local')
      store.delete(SESSION_COOKIE)
      return { error: null as { message: string } | null }
    },
    async updateUser(input) {
      if (!userId) return { data: { user: null }, error: { message: 'Not authenticated' } }
      if (input.password) await updatePassword(userId, input.password)
      if (input.email) await updateEmail(userId, input.email)
      return { data: { user: { id: userId, email: input.email } }, error: null }
    },
    async resetPasswordForEmail() {
      return { data: null, error: { message: 'Password reset email is not set up on this Postgres install' } }
    },
    onAuthStateChange(cb) {
      cb('INITIAL_SESSION', user ? { user } : null)
      return { data: { subscription: { unsubscribe() {} } } }
    },
    async exchangeCodeForSession() {
      return { error: { message: 'Email links are not used with Postgres login' } }
    },
    async verifyOtp() {
      return { error: { message: 'Email links are not used with Postgres login' } }
    },
  }
}

function channelApi() {
  const api = {
    on() {
      return api
    },
    subscribe(cb?: (status: string) => void) {
      cb?.('SUBSCRIBED')
      return api
    },
  }
  return api
}

export function buildClient(userId: string | null, bypass: boolean) {
  const run = runner(userId, bypass)
  return {
    from(table: string) {
      return createQuery(table, run)
    },
    rpc(fn: string, args: Record<string, unknown> = {}) {
      if (!bypass && !userId) {
        return Promise.resolve({ data: null, error: { message: 'Not authenticated', code: '401' } })
      }
      return withRole(userId, bypass, (client) => runRpc(client, fn, args))
    },
    auth: authApi(userId),
    storage: storageApi(),
    channel() {
      return channelApi()
    },
    removeChannel(_channel?: unknown) {},
  }
}

export async function createClient() {
  return buildClient(await currentUserId(), false)
}

export function createAdminClient() {
  return buildClient(null, true)
}

export type PostgresClient = ReturnType<typeof buildClient>
