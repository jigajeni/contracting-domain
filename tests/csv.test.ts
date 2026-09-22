import { describe, it, expect } from 'vitest'
import { csvName, field, toCsv } from '@/domain/export/csv'

describe('one field', () => {
  it('quotes what would otherwise break the row', () => {
    expect(field('Shah, Sons & Co')).toBe('"Shah, Sons & Co"')
    expect(field('He said "no"')).toBe('"He said ""no"""')
    expect(field('line\nbreak')).toBe('"line\nbreak"')
  })

  it('stops Excel running a premium as arithmetic', () => {
    // "-8%" opened bare is a formula, and Excel evaluates it silently.
    expect(field('-8%')).toBe('"\t-8%"')
    expect(field('=1+1')).toBe('"\t=1+1"')
    expect(field('+91 98230 45905')).toBe('"\t+91 98230 45905"')
    expect(field('@handle')).toBe('"\t@handle"')
  })

  it('protects a long number from becoming scientific notation', () => {
    expect(field('604473243201812')).toContain('\t')
    // A normal figure is left alone.
    expect(field(4746000)).toBe('4746000')
    expect(field('SIPL/2026/PWD/001')).toBe('SIPL/2026/PWD/001')
  })

  it('writes nothing for nothing, rather than the word null', () => {
    expect(field(null)).toBe('')
    expect(field(undefined)).toBe('')
    expect(field('')).toBe('')
    expect(field(0)).toBe('0')
  })
})

describe('the file', () => {
  const rows = [
    { code: 'SIPL/2026/PWD/001', name: 'उमदी रस्ता', premium: '-8%' },
    { code: 'SIPL/2026/ZP/002', name: 'Dafalapur', premium: null },
  ]
  const cols = [
    { header: 'Code', value: (r: typeof rows[number]) => r.code },
    { header: 'Work', value: (r: typeof rows[number]) => r.name },
    { header: 'Premium', value: (r: typeof rows[number]) => r.premium },
  ]

  it('starts with a BOM so Windows Excel reads Marathi', () => {
    const csv = toCsv(cols, rows)
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toContain('उमदी रस्ता')
  })

  it('uses CRLF, which is what a spreadsheet expects', () => {
    expect(toCsv(cols, rows).split('\r\n')[0]).toBe('﻿Code,Work,Premium')
  })

  it('writes a header even with no rows', () => {
    expect(toCsv(cols, [])).toBe('﻿Code,Work,Premium\r\n')
  })
})

describe('the filename', () => {
  it('sorts by date and says what it is', () => {
    expect(csvName('bills', 'Sahyadri Infra', '2026-09-16'))
      .toBe('Sahyadri-Infra-bills-2026-09-16.csv')
  })

  it('survives a scope with punctuation in it', () => {
    expect(csvName('tenders', 'ZP Sangli — Bandhkam', '2026-09-16'))
      .toBe('ZP-Sangli-Bandhkam-tenders-2026-09-16.csv')
  })
})
