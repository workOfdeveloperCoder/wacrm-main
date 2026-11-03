import { describe, expect, it } from 'vitest'

import { parseOr, parseSelectList, whereSql } from './compile'

describe('postgres select list', () => {
  it('parses a nested embed and an inner hint', () => {
    const parsed = parseSelectList('id, status, broadcasts!inner(account_id), contact:contacts(name, phone)')
    expect(parsed.columns).toEqual(['id', 'status'])
    expect(parsed.embeds.map((embed) => embed.alias)).toEqual(['broadcasts', 'contact'])
    expect(parsed.embeds[0]?.inner).toBe(true)
    expect(parsed.embeds[1]?.table).toBe('contacts')
  })
})

describe('postgres filters', () => {
  it('turns a contact search or() into ILIKE parameters', () => {
    const values: unknown[] = []
    const sql = whereSql([parseOr('name.ilike.*ann*,phone.ilike.*555*')], 't', values)
    expect(sql).toContain('OR')
    expect(sql).toContain('ILIKE')
    expect(values).toEqual(['%ann%', '%555%'])
  })

  it('keeps a broadcast lock claim as nested and/or', () => {
    const values: unknown[] = []
    const sql = whereSql(
      [parseOr('and(or(delivery_locked_at.is.null,delivery_locked_at.lt.2026-01-01T00:00:00.000Z),or(delivery_lease_until.is.null,delivery_lease_until.lt.2026-01-02T00:00:00.000Z))')],
      't',
      values,
    )
    expect(sql).toContain('IS NULL')
    expect(sql).toContain('OR')
    expect(values).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'])
  })
})
