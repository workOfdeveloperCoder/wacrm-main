import type { Embed, Filter, ForeignKey, QueryState } from './types'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export function assertIdent(name: string, what = 'identifier'): string {
  if (!IDENT.test(name)) {
    throw new Error(`Invalid ${what}: ${name}`)
  }
  return name
}

export function quoteIdent(name: string): string {
  return `"${assertIdent(name)}"`
}

export function splitTopLevel(input: string): string[] {
  const parts: string[] = []
  let buf = ''
  let depth = 0
  for (const ch of input) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      if (buf.trim()) parts.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) parts.push(buf.trim())
  return parts
}

function parseEmbedHead(head: string): Pick<Embed, 'alias' | 'table' | 'constraint' | 'inner'> {
  const colon = head.indexOf(':')
  const alias = colon === -1 ? null : head.slice(0, colon)
  let rest = colon === -1 ? head : head.slice(colon + 1)
  const bangs = rest.split('!')
  const table = bangs[0] ?? ''
  let constraint: string | null = null
  let inner = false
  for (const flag of bangs.slice(1)) {
    if (flag === 'inner' || flag === 'left') {
      inner = flag === 'inner'
    } else if (flag) {
      constraint = flag
    }
  }
  assertIdent(table, 'table')
  if (alias) assertIdent(alias, 'alias')
  if (constraint) assertIdent(constraint, 'constraint')
  return { alias: alias ?? table, table, constraint, inner }
}

function parseField(token: string): { column?: string; embed?: Embed } {
  const open = token.indexOf('(')
  if (open === -1) {
    if (token === '*') return { column: '*' }
    assertIdent(token, 'column')
    return { column: token }
  }
  if (!token.endsWith(')')) throw new Error(`Invalid select field: ${token}`)
  const head = token.slice(0, open)
  const inner = token.slice(open + 1, -1)
  const parsed = parseSelectList(inner)
  return {
    embed: {
      ...parseEmbedHead(head),
      columns: parsed.columns,
      embeds: parsed.embeds,
    },
  }
}

export function parseSelectList(input: string): { columns: '*' | string[]; embeds: Embed[] } {
  const trimmed = input.trim()
  if (!trimmed || trimmed === '*') return { columns: '*', embeds: [] }
  const columns: string[] = []
  const embeds: Embed[] = []
  let star = false
  for (const token of splitTopLevel(trimmed)) {
    const field = parseField(token)
    if (field.embed) embeds.push(field.embed)
    else if (field.column === '*') star = true
    else if (field.column) columns.push(field.column)
  }
  return { columns: star ? '*' : columns, embeds }
}

const FILTER_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in'])

function predicate(part: string): Filter {
  const first = part.indexOf('.')
  const second = part.indexOf('.', first + 1)
  if (first < 1 || second < 0) throw new Error(`Invalid or() filter: ${part}`)
  const column = part.slice(0, first)
  const op = part.slice(first + 1, second)
  const value = part.slice(second + 1)
  if (!FILTER_OPS.has(op)) throw new Error(`Unsupported or() operator: ${op}`)
  if (op === 'is') return { op, column, value: value === 'null' ? null : value === 'true' }
  if (op === 'ilike' || op === 'like') return { op, column, value: value.replaceAll('*', '%') }
  return { op: op as Filter['op'], column, value }
}

function parseLogic(raw: string, joiner: 'and' | 'or'): Filter {
  const children = splitTopLevel(raw).map(parseNode)
  if (children.length === 1) return children[0]
  return { op: 'eq', column: '_', value: null, bool: joiner, children }
}

function parseNode(part: string): Filter {
  const and = part.match(/^and\(([\s\S]*)\)$/)
  if (and?.[1] != null) return parseLogic(and[1], 'and')
  const or = part.match(/^or\(([\s\S]*)\)$/)
  if (or?.[1] != null) return parseLogic(or[1], 'or')
  return predicate(part)
}

/** PostgREST `or` string, including nested `and()` / `or()` groups. */
export function parseOr(raw: string): Filter {
  return parseLogic(raw, 'or')
}

export function relation(
  parent: string,
  embed: Embed,
  fks: ForeignKey[],
): { kind: 'manyToOne' | 'oneToMany'; fk: ForeignKey } {
  const pool = embed.constraint
    ? fks.filter((fk) => fk.constraint === embed.constraint)
    : fks.filter(
        (fk) =>
          (fk.fromTable === parent && fk.toTable === embed.table) ||
          (fk.fromTable === embed.table && fk.toTable === parent),
      )
  const manyToOne = pool.filter((fk) => fk.fromTable === parent && fk.toTable === embed.table)
  const oneToMany = pool.filter((fk) => fk.fromTable === embed.table && fk.toTable === parent)
  if (manyToOne.length === 1) return { kind: 'manyToOne', fk: manyToOne[0] }
  if (manyToOne.length === 0 && oneToMany.length === 1) return { kind: 'oneToMany', fk: oneToMany[0] }
  throw new Error(
    `Cannot resolve relationship ${parent} -> ${embed.table}${embed.constraint ? ` (${embed.constraint})` : ''}`,
  )
}

export interface SqlParts {
  text: string
  values: unknown[]
}

function pushValue(values: unknown[], value: unknown): string {
  values.push(value)
  return `$${values.length}`
}

function columnRef(column: string, alias: string): string {
  const json = column.match(/^([A-Za-z_][A-Za-z0-9_]*)->>(([A-Za-z_][A-Za-z0-9_]*))$/)
  if (json) return `${alias}.${quoteIdent(json[1]!)}->>'${json[2]}'`
  if (column.includes('.')) {
    const [embed, col] = column.split('.')
    return `${quoteIdent(embed)}.${quoteIdent(col ?? '')}`
  }
  return `${alias}.${quoteIdent(column)}`
}

function renderFilters(
  filters: Filter[],
  alias: string,
  values: unknown[],
  joiner: 'AND' | 'OR',
): string {
  const clauses: string[] = []
  for (const filter of filters) {
    if (filter.bool && filter.children) {
      const inner = renderFilters(filter.children, alias, values, filter.bool === 'or' ? 'OR' : 'AND')
      if (inner) clauses.push(`(${inner})`)
      continue
    }
    const ref = columnRef(filter.column, alias)
    if (filter.op === 'is') {
      if (filter.value === null) clauses.push(`${ref} IS NULL`)
      else clauses.push(`${ref} IS ${filter.value ? 'TRUE' : 'FALSE'}`)
      continue
    }
    if (filter.op === 'in') {
      const list = Array.isArray(filter.value) ? filter.value : []
      if (list.length === 0) {
        clauses.push('FALSE')
        continue
      }
      const params = list.map((item) => pushValue(values, item))
      clauses.push(`${ref} IN (${params.join(', ')})`)
      continue
    }
    if (filter.op === 'cs') {
      const list = Array.isArray(filter.value) ? filter.value : [filter.value]
      clauses.push(`${ref} @> ${pushValue(values, list)}::text[]`)
      continue
    }
    if (filter.op === 'ilikeAny') {
      const list = Array.isArray(filter.value) ? filter.value : []
      if (list.length === 0) {
        clauses.push('FALSE')
        continue
      }
      const params = list.map((item) => pushValue(values, item))
      clauses.push(`${ref} ILIKE ANY (ARRAY[${params.join(', ')}])`)
      continue
    }
    const op =
      filter.op === 'eq'
        ? '='
        : filter.op === 'neq'
          ? '<>'
          : filter.op === 'gt'
            ? '>'
            : filter.op === 'gte'
              ? '>='
              : filter.op === 'lt'
                ? '<'
                : filter.op === 'lte'
                  ? '<='
                  : filter.op === 'like'
                    ? 'LIKE'
                    : 'ILIKE'
    clauses.push(`${ref} ${op} ${pushValue(values, filter.value)}`)
  }
  return clauses.join(` ${joiner} `)
}

export function whereSql(
  filters: Filter[],
  alias: string,
  values: unknown[],
): string {
  return renderFilters(filters, alias, values, 'AND')
}

export function parentFilters(filters: Filter[]): Filter[] {
  return filters.filter((filter) => !filter.column.includes('.'))
}

export function embedFilters(filters: Filter[], embed: Embed): Filter[] {
  const prefix = [`${embed.alias}.`, `${embed.table}.`]
  return filters
    .filter((filter) => prefix.some((p) => filter.column.startsWith(p)))
    .map((filter) => ({
      ...filter,
      column: filter.column.slice(filter.column.indexOf('.') + 1),
    }))
}

export function orderSql(state: Pick<QueryState, 'orders'>, alias: string): string {
  if (state.orders.length === 0) return ''
  const parts = state.orders.map((order) => {
    const dir = order.ascending ? 'ASC' : 'DESC'
    return `${alias}.${quoteIdent(order.column)} ${dir} NULLS LAST`
  })
  return ` ORDER BY ${parts.join(', ')}`
}

export function limitSql(state: Pick<QueryState, 'range' | 'limit'>, values: unknown[]): string {
  if (state.range) {
    const count = state.range.to - state.range.from + 1
    return ` LIMIT ${pushValue(values, count)} OFFSET ${pushValue(values, state.range.from)}`
  }
  if (state.limit != null) return ` LIMIT ${pushValue(values, state.limit)}`
  return ''
}

export function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    return value.map((item) => jsonValue(item))
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(value)
  }
  return value
}

export function cleanRow<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row }
  for (const [key, value] of Object.entries(out)) {
    if (value instanceof Date) out[key as keyof T] = value.toISOString() as T[keyof T]
  }
  return out
}
