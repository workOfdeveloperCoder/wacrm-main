/** Shared result shapes. Call sites still read `{ data, error }` and `error.code`. */

export interface DbError {
  message: string
  code?: string
  details?: string | null
  hint?: string | null
}

/** `data` stays loose on purpose: call sites were written against an untyped client. */
export interface DbResult<T = any> {
  data: T | null
  error: DbError | null
  count?: number | null
}

export interface AuthUser {
  id: string
  email?: string
  created_at?: string
  user_metadata?: Record<string, unknown>
  app_metadata?: Record<string, unknown>
}

/** Kept so existing `import type { User }` call sites compile. */
export type User = AuthUser

/** Kept so existing `import type { PostgrestError }` call sites compile. */
export type PostgrestError = DbError

/** Chain returned by `from()`. Deliberately loose so existing call sites keep compiling. */
export interface LooseQuery extends PromiseLike<DbResult> {
  select: (columns?: string, options?: any) => LooseQuery
  insert: (payload: any) => LooseQuery
  update: (payload: any) => LooseQuery
  upsert: (payload: any, options?: any) => LooseQuery
  delete: (options?: any) => LooseQuery
  eq: (column: string, value: any) => LooseQuery
  neq: (column: string, value: any) => LooseQuery
  gt: (column: string, value: any) => LooseQuery
  gte: (column: string, value: any) => LooseQuery
  lt: (column: string, value: any) => LooseQuery
  lte: (column: string, value: any) => LooseQuery
  like: (column: string, value: any) => LooseQuery
  ilike: (column: string, value: any) => LooseQuery
  is: (column: string, value: any) => LooseQuery
  in: (column: string, value: readonly any[]) => LooseQuery
  or: (filters: string) => LooseQuery
  contains: (column: string, value: any) => LooseQuery
  filter: (column: string, operator: string, value: any) => LooseQuery
  ilikeAnyOf: (column: string, patterns: readonly string[]) => LooseQuery
  order: (column: string, options?: any) => LooseQuery
  limit: (count: number) => LooseQuery
  range: (from: number, to: number) => LooseQuery
  single: <T = any>() => LooseQuery
  maybeSingle: <T = any>() => LooseQuery
}

/** Drop-in name for the old client type. Fakes in tests cast to this. */
export type SupabaseClient = {
  from: (table: string) => LooseQuery
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<DbResult>
  auth: any
  storage: any
  channel: (name: string) => any
  removeChannel: (channel?: any) => void
}

export type RealtimeChannel = { stop?: () => void }

export type EmailOtpType =
  | 'signup'
  | 'invite'
  | 'magiclink'
  | 'recovery'
  | 'email_change'
  | 'email'

export interface ForeignKey {
  constraint: string
  fromTable: string
  fromCol: string
  toTable: string
  toCol: string
}

export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is' | 'in' | 'cs' | 'ilikeAny'

export interface Filter {
  op: FilterOp
  /** `column` or `embed.column`. Unused when `bool` is set. */
  column: string
  value: unknown
  /** Nested PostgREST `and()` / `or()` group. */
  bool?: 'and' | 'or'
  children?: Filter[]
}

export interface Embed {
  alias: string
  table: string
  constraint: string | null
  inner: boolean
  columns: '*' | string[]
  embeds: Embed[]
}

export interface QueryState {
  table: string
  action: 'select' | 'insert' | 'update' | 'delete' | 'upsert'
  /** Select list. Null means no RETURNING / no row data. */
  columns: string | null
  count: 'exact' | null
  head: boolean
  filters: Filter[]
  orders: { column: string; ascending: boolean }[]
  range: { from: number; to: number } | null
  limit: number | null
  payload: Record<string, unknown> | Record<string, unknown>[] | null
  onConflict: string | null
  ignoreDuplicates: boolean
  single: boolean
  maybeSingle: boolean
}
