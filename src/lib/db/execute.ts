import type { PoolClient } from 'pg'

import {
  cleanRow,
  embedFilters,
  jsonValue,
  limitSql,
  orderSql,
  parentFilters,
  parseSelectList,
  quoteIdent,
  relation,
  whereSql,
} from './compile'
import type { DbError, DbResult, Embed, ForeignKey, QueryState } from './types'

function dbError(error: unknown): DbError {
  if (error && typeof error === 'object') {
    const err = error as { message?: string; code?: string; detail?: string }
    return {
      message: err.message ?? 'Database error',
      code: err.code,
      details: err.detail ?? null,
    }
  }
  return { message: 'Database error' }
}

function selectList(columns: '*' | string[], alias: string, extra: string[]): string {
  if (columns === '*') return `${alias}.*`
  const names = [...new Set([...columns, ...extra])]
  return names.map((name) => `${alias}.${quoteIdent(name)}`).join(', ')
}

async function attachEmbeds(
  client: PoolClient,
  parentTable: string,
  parents: Record<string, unknown>[],
  embeds: Embed[],
  filters: QueryState['filters'],
  fks: ForeignKey[],
): Promise<Record<string, unknown>[]> {
  let rows = parents
  for (const embed of embeds) {
    const rel = relation(parentTable, embed, fks)
    const childFilters = embedFilters(filters, embed)
    const keyOnParent = rel.kind === 'manyToOne' ? rel.fk.fromCol : rel.fk.toCol
    const keyOnChild = rel.kind === 'manyToOne' ? rel.fk.toCol : rel.fk.fromCol
    const ids = [...new Set(rows.map((row) => row[keyOnParent]).filter((id) => id != null))]
    let children: Record<string, unknown>[] = []
    if (ids.length > 0) {
      const values: unknown[] = []
      const params = ids.map((id) => {
        values.push(id)
        return `$${values.length}`
      })
      const extraWhere = whereSql(childFilters, 'c', values)
      const cols = selectList(embed.columns, 'c', [keyOnChild])
      const sql = `SELECT ${cols} FROM public.${quoteIdent(embed.table)} c WHERE c.${quoteIdent(keyOnChild)} IN (${params.join(', ')})${extraWhere ? ` AND ${extraWhere}` : ''}`
      const loaded = await client.query(sql, values)
      children = loaded.rows.map((row) => cleanRow(row))
      if (embed.embeds.length > 0) {
        children = await attachEmbeds(client, embed.table, children, embed.embeds, [], fks)
      }
    }
    const grouped = new Map<unknown, Record<string, unknown>[]>()
    for (const child of children) {
      const key = child[keyOnChild]
      const list = grouped.get(key) ?? []
      list.push(child)
      grouped.set(key, list)
    }
    const next: Record<string, unknown>[] = []
    for (const parent of rows) {
      const matches = grouped.get(parent[keyOnParent]) ?? []
      if (rel.kind === 'manyToOne') {
        const one = matches[0] ?? null
        if (embed.inner && !one) continue
        parent[embed.alias] = one
      } else {
        if (embed.inner && matches.length === 0) continue
        parent[embed.alias] = matches
      }
      next.push(parent)
    }
    rows = next
  }
  return rows
}

function strip(row: Record<string, unknown>, columns: '*' | string[], embeds: Embed[]): Record<string, unknown> {
  if (columns === '*') return row
  const keep = new Set([...columns, ...embeds.map((embed) => embed.alias)])
  const out: Record<string, unknown> = {}
  for (const key of keep) out[key] = row[key]
  return out
}

async function runSelect(
  client: PoolClient,
  state: QueryState,
  fks: ForeignKey[],
): Promise<DbResult> {
  const parsed = parseSelectList(state.columns && state.columns.length > 0 ? state.columns : '*')
  const values: unknown[] = []
  const where = whereSql(parentFilters(state.filters), 't', values)
  const exists: string[] = []
  for (const embed of parsed.embeds) {
    const childFilters = embedFilters(state.filters, embed)
    if (!embed.inner && childFilters.length === 0) continue
    const rel = relation(state.table, embed, fks)
    const childValuesStart = values
    const extra = whereSql(childFilters, 'c', childValuesStart)
    if (rel.kind === 'manyToOne') {
      exists.push(
        `EXISTS (SELECT 1 FROM public.${quoteIdent(embed.table)} c WHERE c.${quoteIdent(rel.fk.toCol)} = t.${quoteIdent(rel.fk.fromCol)}${extra ? ` AND ${extra}` : ''})`,
      )
    } else {
      exists.push(
        `EXISTS (SELECT 1 FROM public.${quoteIdent(embed.table)} c WHERE c.${quoteIdent(rel.fk.fromCol)} = t.${quoteIdent(rel.fk.toCol)}${extra ? ` AND ${extra}` : ''})`,
      )
    }
  }
  const all = [where, ...exists].filter(Boolean).join(' AND ')
  const whereSqlText = all ? ` WHERE ${all}` : ''
  let count: number | null = null
  if (state.count === 'exact') {
    const countResult = await client.query(
      `SELECT count(*)::int AS count FROM public.${quoteIdent(state.table)} t${whereSqlText}`,
      values,
    )
    count = countResult.rows[0]?.count ?? 0
  }
  if (state.head) return { data: null, error: null, count }

  const extraCols =
    parsed.columns === '*'
      ? []
      : parsed.embeds.flatMap((embed) => {
          try {
            const rel = relation(state.table, embed, fks)
            return [rel.kind === 'manyToOne' ? rel.fk.fromCol : rel.fk.toCol]
          } catch {
            return []
          }
        })
  const sql = `SELECT ${selectList(parsed.columns, 't', extraCols)} FROM public.${quoteIdent(state.table)} t${whereSqlText}${orderSql(state, 't')}${limitSql(state, values)}`
  const loaded = await client.query(sql, values)
  let rows = loaded.rows.map((row) => cleanRow(row as Record<string, unknown>))
  rows = await attachEmbeds(client, state.table, rows, parsed.embeds, state.filters, fks)
  rows = rows.map((row) => strip(row, parsed.columns, parsed.embeds))
  return finish(rows, state, count)
}

function finish(rows: Record<string, unknown>[], state: QueryState, count: number | null): DbResult {
  if (state.single) {
    if (rows.length !== 1) {
      return {
        data: null,
        error: { message: rows.length === 0 ? 'No rows found' : 'Multiple rows found', code: 'PGRST116' },
        count,
      }
    }
    return { data: rows[0], error: null, count }
  }
  if (state.maybeSingle) {
    if (rows.length > 1) {
      return { data: null, error: { message: 'Multiple rows found', code: 'PGRST116' }, count }
    }
    return { data: rows[0] ?? null, error: null, count }
  }
  return { data: rows, error: null, count }
}

function sqlParam(values: unknown[], value: unknown): string {
  if (value instanceof Date) {
    values.push(value.toISOString())
    return `$${values.length}`
  }
  if (Array.isArray(value)) {
    const objects = value.some((item) => item !== null && typeof item === 'object' && !(item instanceof Date))
    if (objects) {
      values.push(JSON.stringify(value))
      return `$${values.length}::jsonb`
    }
    values.push(value.map((item) => (item instanceof Date ? item.toISOString() : item)))
    return `$${values.length}`
  }
  if (value !== null && typeof value === 'object') {
    values.push(JSON.stringify(value))
    return `$${values.length}::jsonb`
  }
  values.push(value ?? null)
  return `$${values.length}`
}

function payloadRows(payload: QueryState['payload']): Record<string, unknown>[] {
  if (!payload) return []
  const list = Array.isArray(payload) ? payload : [payload]
  return list.map((row) => {
    const clean: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      if (value !== undefined) clean[key] = value
    }
    return clean
  })
}

function returningClause(columns: string | null): string {
  if (!columns) return ''
  const parsed = parseSelectList(columns)
  if (parsed.columns === '*') return ' RETURNING *'
  return ` RETURNING ${parsed.columns.map(quoteIdent).join(', ')}`
}

async function runWrite(client: PoolClient, state: QueryState): Promise<DbResult> {
  const rows = payloadRows(state.payload)
  const values: unknown[] = []
  if (state.action === 'insert' || state.action === 'upsert') {
    if (rows.length === 0) return { data: state.single || state.maybeSingle ? null : [], error: null }
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
    for (const column of columns) quoteIdent(column)
    const tuples = rows.map((row) => {
      const params = columns.map((column) => sqlParam(values, row[column] ?? null))
      return `(${params.join(', ')})`
    })
    let conflict = ''
    if (state.action === 'upsert' && state.onConflict) {
      const keys = state.onConflict.split(',').map((key) => quoteIdent(key.trim()))
      const keyNames = state.onConflict.split(',').map((key) => key.trim())
      if (state.ignoreDuplicates) {
        conflict = ` ON CONFLICT (${keys.join(', ')}) DO NOTHING`
      } else {
        const updates = columns
          .filter((column) => !keyNames.includes(column))
          .map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`)
        conflict = ` ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ${updates.join(', ') || `${keys[0]} = EXCLUDED.${keys[0]}`}`
      }
    }
    const sql = `INSERT INTO public.${quoteIdent(state.table)} (${columns.map(quoteIdent).join(', ')}) VALUES ${tuples.join(', ')}${conflict}${returningClause(state.columns)}`
    const inserted = await client.query(sql, values)
    if (!state.columns) return { data: null, error: null }
    return finish(
      inserted.rows.map((row) => cleanRow(row as Record<string, unknown>)),
      state,
      null,
    )
  }

  const table = quoteIdent(state.table)
  if (state.action === 'update') {
    const patch = rows[0] ?? {}
    const sets = Object.keys(patch).map((column) => {
      quoteIdent(column)
      return `${quoteIdent(column)} = ${sqlParam(values, patch[column] ?? null)}`
    })
    if (sets.length === 0) return { data: [], error: null }
    const where = whereSql(parentFilters(state.filters), table, values)
    const sql = `UPDATE public.${table} SET ${sets.join(', ')}${where ? ` WHERE ${where}` : ''}${returningClause(state.columns)}`
    const updated = await client.query(sql, values)
    if (!state.columns) return { data: null, error: null }
    return finish(
      updated.rows.map((row) => cleanRow(row as Record<string, unknown>)),
      state,
      null,
    )
  }

  const where = whereSql(parentFilters(state.filters), table, values)
  const returning = state.columns
    ? returningClause(state.columns)
    : state.count === 'exact'
      ? ' RETURNING 1'
      : ''
  const sql = `DELETE FROM public.${table}${where ? ` WHERE ${where}` : ''}${returning}`
  const deleted = await client.query(sql, values)
  const count = state.count === 'exact' ? deleted.rowCount : null
  if (!state.columns) return { data: null, error: null, count }
  return finish(
    deleted.rows.map((row) => cleanRow(row as Record<string, unknown>)),
    state,
    count,
  )
}

export async function runQuery(
  client: PoolClient,
  state: QueryState,
  fks: ForeignKey[],
): Promise<DbResult> {
  try {
    if (state.action === 'select') return await runSelect(client, state, fks)
    return await runWrite(client, state)
  } catch (error) {
    return { data: null, error: dbError(error) }
  }
}

export async function runRpc(
  client: PoolClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<DbResult> {
  try {
    quoteIdent(fn)
    const names = Object.keys(args)
    const values: unknown[] = []
    const call = names
      .map((name) => {
        const value = args[name]
        const json =
          value !== null &&
          typeof value === 'object' &&
          !(value instanceof Date) &&
          (!Array.isArray(value) || value.some((item) => item !== null && typeof item === 'object'))
        values.push(json ? JSON.stringify(value) : jsonValue(value))
        return `${quoteIdent(name)} => $${values.length}${json ? '::jsonb' : ''}`
      })
      .join(', ')
    const result = await client.query(`SELECT * FROM public.${quoteIdent(fn)}(${call})`, values)
    const rows = result.rows.map((row) => cleanRow(row as Record<string, unknown>))
    if (rows.length === 1 && result.fields.length === 1) {
      const only = result.fields[0]?.name
      return { data: only ? rows[0]?.[only] ?? null : rows[0], error: null }
    }
    const meta = await client.query(
      `SELECT p.proretset FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1 LIMIT 1`,
      [fn],
    )
    if (meta.rows[0]?.proretset) return { data: rows, error: null }
    return { data: rows[0] ?? null, error: null }
  } catch (error) {
    return { data: null, error: dbError(error) }
  }
}
