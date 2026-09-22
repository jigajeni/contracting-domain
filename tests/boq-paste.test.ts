import { describe, expect, it } from 'vitest'
import { parseTabularBoq } from '@/domain/boq/tabular'
import { formatINR } from '@/domain/money'

/**
 * Most works have no Mahatenders BOQ: PWD prices from an estimate and nothing
 * under ten lakh gets a BOQ at all. The schedule is still item-wise — the
 * Suslad final bill carries twenty-two items — so it has to be pasteable.
 *
 * The rows below are the first items of the Suslad school repair bill, which
 * is a real sub-ten-lakh work.
 */
const SUSLAD_TSV = [
  'Item\tDescription\tUnit\tQuantity\tRate',
  '1\tExcavation soft murum etc complete\tcum\t0.675\t207.00',
  '2\tProviding and laying cement concrete in M-10 PCC\tcum\t6.480\t6429.40',
  '3\tProviding and laying cement concrete DPC 50mm in M-20\tcum\t77.690\t481.05',
  '4\tProviding second class BBM etc complete\tcum\t2.460\t8602.95',
  '21\tLaboratory testing charges etc complete\tJOB\t1.000\t5263.00',
  '22\tProviding and fixing name board etc complete\tNO\t1.000\t9963.00',
].join('\n')

describe('pasting a priced schedule', () => {
  it('reads a spreadsheet paste with a header row', () => {
    const boq = parseTabularBoq(SUSLAD_TSV)
    expect(boq.items).toHaveLength(6)
    expect(boq.warnings).toEqual([])

    const first = boq.items[0]!
    expect(first.slNo).toBe('1')
    expect(first.description).toBe('Excavation soft murum etc complete')
    expect(first.unit).toBe('cum')
    expect(first.quantity).toBe('0.675')
    expect(formatINR(first.ratePaise)).toBe('₹207')
    expect(formatINR(first.amountPaise)).toBe('₹139.73')   // matches the bill
  })

  it('reproduces the item amounts from the real bill', () => {
    const boq = parseTabularBoq(SUSLAD_TSV)
    const byNo = Object.fromEntries(boq.items.map((i) => [i.slNo, i]))
    expect(formatINR(byNo['2']!.amountPaise)).toBe('₹41,662.51')
    expect(formatINR(byNo['3']!.amountPaise)).toBe('₹37,372.77')
    expect(formatINR(byNo['4']!.amountPaise)).toBe('₹21,163.26')
    expect(formatINR(byNo['21']!.amountPaise)).toBe('₹5,263')
  })

  it('detects the column order from the header, in any arrangement', () => {
    const reordered = [
      'Description\tRate\tQty\tUnit\tItem no',
      'Excavation soft murum\t207.00\t0.675\tcum\t1',
    ].join('\n')
    const boq = parseTabularBoq(reordered)
    expect(boq.items[0]!.quantity).toBe('0.675')
    expect(formatINR(boq.items[0]!.ratePaise)).toBe('₹207')
    expect(boq.items[0]!.slNo).toBe('1')
  })

  it('accepts Marathi headings, which is how the estimates come', () => {
    const marathi = [
      'अ.क्र.\tतपशील\tएकमान\tपरिमाण\tदर',
      '1\tखोदाई\tcum\t12.500\t207.00',
    ].join('\n')
    const boq = parseTabularBoq(marathi)
    expect(boq.items).toHaveLength(1)
    expect(boq.items[0]!.description).toBe('खोदाई')
    expect(formatINR(boq.items[0]!.amountPaise)).toBe('₹2,587.50')
  })

  it('falls back to a positional order when there is no header', () => {
    const noHeader = '1\tExcavation\tcum\t0.675\t207.00'
    const boq = parseTabularBoq(noHeader)
    expect(boq.items).toHaveLength(1)
    expect(boq.items[0]!.description).toBe('Excavation')
  })

  it('handles rupee symbols and thousands separators', () => {
    const messy = [
      'Item\tDescription\tUnit\tQuantity\tRate',
      '1\tSteel Fe500D\tMT\t12.482\t₹89,911.45',
    ].join('\n')
    const boq = parseTabularBoq(messy)
    expect(formatINR(boq.items[0]!.ratePaise)).toBe('₹89,911.45')
    expect(formatINR(boq.items[0]!.amountPaise)).toBe('₹11,22,274.72')
  })

  it('warns about a row it cannot price, but not about a heading', () => {
    const withJunk = [
      'Item\tDescription\tUnit\tQuantity\tRate',
      '1\tExcavation\tcum\t0.675\t207.00',
      '\tSub-total carried forward\t\t\t',        // heading: quiet
      '2\tConcrete\tcum\tas per site\t6429.40',   // meant to be priced: loud
    ].join('\n')
    const boq = parseTabularBoq(withJunk)
    expect(boq.items).toHaveLength(1)
    // The unreadable row is named; the heading is only counted.
    expect(boq.warnings.filter((w) => /Concrete/.test(w))).toHaveLength(1)
    expect(boq.warnings.some((w) => /headings or sub-totals/.test(w))).toBe(true)
  })

  it('refuses a paste with nothing priced in it', () => {
    expect(() => parseTabularBoq('Name\tAddress\nSahyadri Infra\tJath'))
      .toThrow(/description, a quantity and a rate/i)
  })
})
