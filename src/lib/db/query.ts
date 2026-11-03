import { parseOr } from './compile'
import type { DbResult, FilterOp, QueryState } from './types'

export type QueryRunner = (state: QueryState) => Promise<DbResult>

export interface QueryBuilder extends PromiseLike<DbResult> {
  select: (columns?: string, options?: { count?: 'exact' | null; head?: boolean }) => QueryBuilder
  insert: (payload: any) => QueryBuilder
  update: (payload: any) => QueryBuilder
  upsert: (
    payload: any,
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ) => QueryBuilder
  filter: (column: string, operator: string, value: unknown) => QueryBuilder
  ilikeAnyOf: (column: string, patterns: readonly string[]) => QueryBuilder
  delete: (options?: { count?: 'exact' | null }) => QueryBuilder
  contains: (column: string, value: unknown) => QueryBuilder
  eq: (column: string, value: unknown) => QueryBuilder
  neq: (column: string, value: unknown) => QueryBuilder
  gt: (column: string, value: unknown) => QueryBuilder
  gte: (column: string, value: unknown) => QueryBuilder
  lt: (column: string, value: unknown) => QueryBuilder
  lte: (column: string, value: unknown) => QueryBuilder
  like: (column: string, value: unknown) => QueryBuilder
  ilike: (column: string, value: unknown) => QueryBuilder
  is: (column: string, value: unknown) => QueryBuilder
  in: (column: string, value: readonly unknown[]) => QueryBuilder
  or: (filters: string) => QueryBuilder
  order: (column: string, options?: { ascending?: boolean }) => QueryBuilder
  limit: (count: number) => QueryBuilder
  range: (from: number, to: number) => QueryBuilder
  single: () => QueryBuilder
  maybeSingle: () => QueryBuilder
}

function fresh(table: string): QueryState {
  return {
    table,
    action: 'select',
    columns: null,
    count: null,
    head: false,
    filters: [],
    orders: [],
    range: null,
    limit: null,
    payload: null,
    onConflict: null,
    ignoreDuplicates: false,
    single: false,
    maybeSingle: false,
  }
}

export function createQuery(table: string, run: QueryRunner): QueryBuilder {
  const state = fresh(table)
  const builder = {
    select(columns = '*', options?: { count?: 'exact' | null; head?: boolean }) {
      state.columns = columns
      if (options?.count) state.count = 'exact'
      if (options?.head) state.head = true
      return builder
    },
    insert(payload: any) {
      state.action = 'insert'
      state.payload = payload
      return builder
    },
    update(payload: any) {
      state.action = 'update'
      state.payload = payload
      return builder
    },
    upsert(
      payload: any,
      options?: { onConflict?: string; ignoreDuplicates?: boolean },
    ) {
      state.action = 'upsert'
      state.payload = payload
      state.onConflict = options?.onConflict ?? null
      state.ignoreDuplicates = options?.ignoreDuplicates ?? false
      return builder
    },
    delete(options?: { count?: 'exact' | null }) {
      state.action = 'delete'
      if (options?.count) state.count = 'exact'
      return builder
    },
    eq: (column: string, value: unknown) => filter('eq', column, value),
    neq: (column: string, value: unknown) => filter('neq', column, value),
    gt: (column: string, value: unknown) => filter('gt', column, value),
    gte: (column: string, value: unknown) => filter('gte', column, value),
    lt: (column: string, value: unknown) => filter('lt', column, value),
    lte: (column: string, value: unknown) => filter('lte', column, value),
    like: (column: string, value: unknown) => filter('like', column, value),
    ilike: (column: string, value: unknown) => filter('ilike', column, value),
    is: (column: string, value: unknown) => filter('is', column, value),
    in: (column: string, value: readonly unknown[]) => filter('in', column, [...value]),
    filter(column: string, operator: string, value: unknown) {
      const ops: FilterOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'cs']
      if (!ops.includes(operator as FilterOp)) throw new Error(`Unsupported filter: ${operator}`)
      return filter(operator as FilterOp, column, value)
    },
    ilikeAnyOf(column: string, patterns: readonly string[]) {
      state.filters.push({ op: 'ilikeAny', column, value: [...patterns] })
      return builder
    },
    or(filters: string) {
      state.filters.push(parseOr(filters))
      return builder
    },
    contains(column: string, value: unknown) {
      state.filters.push({ op: 'cs', column, value })
      return builder
    },
    order(column: string, options?: { ascending?: boolean }) {
      state.orders.push({ column, ascending: options?.ascending !== false })
      return builder
    },
    limit(count: number) {
      state.limit = count
      return builder
    },
    range(from: number, to: number) {
      state.range = { from, to }
      return builder
    },
    single<T = any>() {
      void (undefined as unknown as T)
      state.single = true
      return builder
    },
    maybeSingle<T = any>() {
      void (undefined as unknown as T)
      state.maybeSingle = true
      return builder
    },
    then<TResult1 = DbResult, TResult2 = never>(
      onfulfilled?: ((value: DbResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return run({ ...state, filters: [...state.filters], orders: [...state.orders] }).then(
        onfulfilled ?? ((value) => value as TResult1),
        onrejected ?? undefined,
      )
    },
  }

  function filter(op: FilterOp, column: string, value: unknown) {
    state.filters.push({ op, column, value })
    return builder
  }

  return builder
}
