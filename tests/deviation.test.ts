import { describe, expect, it } from 'vitest'
import { formatINR, paise, type Paise } from '@/domain/money'
import {
  checkStatement, computeDeviation, errorsOf, summarise, totalsOf, warningsOf,
  type DeviationInput,
} from '@/domain/works/deviation'

/**
 * A quantity executed beyond its tendered figure is not payable because it was
 * done — the department caps the bill at the tendered quantity until a
 * deviation is approved. An extra item is not in the BOQ at all and has no
 * rate until one is sanctioned.
 */

const line = (o: Partial<DeviationInput> & Pick<DeviationInput, 'tenderedQty' | 'executedQty'>)
  : DeviationInput => ({
  boqItemId: 'x', itemNo: '1', description: 'item', unit: 'cum',
  ratePaise: paise(100_000) as Paise,          // ₹1,000
  ...o,
})

describe('one item', () => {
  it('reports an excess against the tendered quantity', () => {
    const d = computeDeviation(line({ tenderedQty: '100', executedQty: '112.5' }))
    expect(d.kind).toBe('excess')
    expect(d.deviationQty).toBe('12.5')
    expect(d.deviationPct).toBe('12.50')
    expect(formatINR(d.amountPaise)).toBe('₹12,500')
  })

  it('reports a saving as a negative', () => {
    const d = computeDeviation(line({ tenderedQty: '100', executedQty: '84' }))
    expect(d.kind).toBe('saving')
    expect(d.deviationQty).toBe('-16')
    expect(d.deviationPct).toBe('-16.00')
    expect(formatINR(d.amountPaise)).toBe('-₹16,000')
  })

  it('says nothing when the item was executed exactly as tendered', () => {
    const d = computeDeviation(line({ tenderedQty: '100', executedQty: '100' }))
    expect(d.kind).toBe('nil')
    expect(d.deviationQty).toBe('0')
    expect(d.deviationPct).toBe('0.00')
  })

  it('treats an item with no tendered quantity as an extra, not a deviation', () => {
    // A percentage of nothing is undefined, not infinite. An extra item is a
    // different thing from an over-run.
    const d = computeDeviation(line({ tenderedQty: '0', executedQty: '8' }))
    expect(d.kind).toBe('extra')
    expect(d.deviationPct).toBeNull()
    expect(formatINR(d.amountPaise)).toBe('₹8,000')
  })

  it('honours an explicit extra flag even where a tendered quantity exists', () => {
    const d = computeDeviation(line({ tenderedQty: '10', executedQty: '3', isExtra: true }))
    expect(d.kind).toBe('extra')
  })

  it('keeps quantities exact at three decimals', () => {
    const d = computeDeviation(line({ tenderedQty: '66.640', executedQty: '73.820' }))
    expect(d.deviationQty).toBe('7.18')
  })

  it('rounds the percentage to two places', () => {
    const d = computeDeviation(line({ tenderedQty: '3', executedQty: '4' }))
    expect(d.deviationPct).toBe('33.33')
  })
})

describe('the statement as a whole', () => {
  const lines = [
    computeDeviation(line({ itemNo: '1', tenderedQty: '100', executedQty: '112.5' })),
    computeDeviation(line({ itemNo: '2', tenderedQty: '200', executedQty: '180' })),
    computeDeviation(line({ itemNo: '3', tenderedQty: '0', executedQty: '5' })),
  ]

  it('separates excess, savings and extra items', () => {
    const t = totalsOf(lines)
    expect(formatINR(t.excessPaise)).toBe('₹12,500')
    expect(formatINR(t.savingsPaise)).toBe('-₹20,000')
    expect(formatINR(t.extraPaise)).toBe('₹5,000')
    expect(formatINR(t.netPaise)).toBe('-₹2,500')
  })

  it('measures the net against the contract value', () => {
    const t = totalsOf(lines, paise(10_000_000) as Paise)   // ₹1,00,000
    expect(t.netPctOfContract).toBe('-2.50')
  })

  it('says nothing about a percentage with no contract value to compare', () => {
    expect(totalsOf(lines).netPctOfContract).toBeNull()
  })

  it('summarises in one line', () => {
    expect(summarise(totalsOf(lines, paise(10_000_000) as Paise)))
      .toBe('₹12,500 excess, ₹20,000 savings, ₹5,000 extra items — ' +
            'net down ₹2,500 (-2.50% of contract)')
    expect(summarise(totalsOf([]))).toBe('No deviation.')
  })
})

describe('what needs approving', () => {
  const excess = computeDeviation(
    line({ itemNo: '1', tenderedQty: '100', executedQty: '130', reason: 'Rock met at 1.2 m' }))

  it('accepts a modest statement with reasons recorded', () => {
    const f = checkStatement([excess], {
      status: 'proposed', contractValuePaise: paise(100_000_000) as Paise,
    })
    expect(errorsOf(f)).toHaveLength(0)
    expect(warningsOf(f)).toHaveLength(0)
  })

  it('refuses an extra item with no rate', () => {
    // Nothing to bill it at until a rate analysis is sanctioned.
    const noRate = computeDeviation(line({
      itemNo: '9', tenderedQty: '0', executedQty: '4',
      ratePaise: paise(0) as Paise, reason: 'Departmental instruction',
    }))
    const e = errorsOf(checkStatement([noRate], { status: 'proposed' }))
    expect(e).toHaveLength(1)
    expect(e[0]!.message).toContain('rate analysis')
  })

  it('refuses an extra item with no justification', () => {
    const noReason = computeDeviation(line({ itemNo: '9', tenderedQty: '0', executedQty: '4' }))
    const e = errorsOf(checkStatement([noReason], { status: 'proposed' }))
    expect(e.some((x) => x.message.includes('justification'))).toBe(true)
  })

  it('warns about an over-run with no reason recorded', () => {
    const bare = computeDeviation(line({ itemNo: '2', tenderedQty: '100', executedQty: '130' }))
    const w = warningsOf(checkStatement([bare], { status: 'proposed' }))
    expect(w.some((x) => x.itemNo === '2')).toBe(true)
  })

  it('warns once the net passes the permitted limit', () => {
    const big = computeDeviation(line({
      tenderedQty: '100', executedQty: '250', reason: 'Scope extended',
    }))
    const w = warningsOf(checkStatement([big], {
      status: 'proposed', contractValuePaise: paise(1_000_000) as Paise,
    }))
    expect(w.some((x) => x.message.includes('needs sanction'))).toBe(true)
  })

  it('stops warning once the statement has been sanctioned', () => {
    const big = computeDeviation(line({
      tenderedQty: '100', executedQty: '250', reason: 'Scope extended',
    }))
    const w = warningsOf(checkStatement([big], {
      status: 'approved', contractValuePaise: paise(1_000_000) as Paise,
    }))
    expect(w.some((x) => x.message.includes('needs sanction'))).toBe(false)
  })

  it('honours a permitted limit the work order states itself', () => {
    const mid = computeDeviation(line({
      tenderedQty: '100', executedQty: '115', reason: 'Extra length',
    }))
    // ₹15,000 of excess against a ₹1,00,000 contract is 15%.
    const opts = { status: 'proposed', contractValuePaise: paise(10_000_000) as Paise }
    expect(warningsOf(checkStatement([mid], { ...opts, permittedPct: 20 }))).toHaveLength(0)
    expect(warningsOf(checkStatement([mid], { ...opts, permittedPct: 5 })).length)
      .toBeGreaterThan(0)
  })

  it('refuses an empty statement', () => {
    expect(errorsOf(checkStatement([], { status: 'proposed' }))[0]!.message)
      .toContain('at least one item')
  })
})
