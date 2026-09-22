import { describe, expect, it } from 'vitest'
import {
  disagreements, measure, reconcileWithBill, rollUp, workingOf,
} from '@/domain/works/measurement'

/**
 * The MB is checked against the department's own arithmetic to three places,
 * so ours has to be exact. Floating point is not: 2.5 × 1.2 comes out
 * 3.0000000000000004, and a cubic metre of concrete is about ₹7,000.
 */

describe('measure', () => {
  it('multiplies nos × length × breadth × depth', () => {
    // A footing: 4 nos, 1.5 × 1.5 × 0.6.
    expect(measure({ nos: 4, length: '1.5', breadth: '1.5', depth: '0.6' })).toBe('5.4')
  })

  it('is exact where floating point is not', () => {
    // 2.5 * 1.2 * 0.15 in floats drifts at the last place.
    expect(measure({ nos: 1, length: '2.5', breadth: '1.2', depth: '0.15' })).toBe('0.45')
    expect(measure({ nos: '1', length: '0.1', breadth: '0.2', depth: '0.3' })).toBe('0.006')
    // 1.005 rounded at three places must not fall to 1.004.
    expect(measure({ nos: '1.005' })).toBe('1.005')
  })

  it('takes only the dimensions an item actually has', () => {
    expect(measure({ nos: 12 })).toBe('12')                              // a count
    expect(measure({ nos: 3, length: '4.5' })).toBe('13.5')              // running metre
    expect(measure({ nos: 2, length: '3.2', breadth: '2.5' })).toBe('16') // square metre
  })

  it('shows which dimensions were taken', () => {
    expect(workingOf({ nos: 4, length: '1.5', breadth: '1.5', depth: '0.6' }))
      .toBe('4 × 1.5 × 1.5 × 0.6')
    expect(workingOf({ nos: 3, length: '4.5' })).toBe('3 × 4.5')
    expect(workingOf({})).toBe('—')
  })

  it('deducts an opening measured out of a wall', () => {
    // Negative nos is how a door or window is taken out of brickwork.
    expect(measure({ nos: -1, length: '1.2', breadth: '2.1', depth: '0.23' }))
      .toBe('-0.58')
  })

  it('rounds the product half away from zero at the third place', () => {
    // Inputs are capped at three places; it is the product that needs
    // rounding. 1.005 × 1.5 is exactly 1.5075.
    expect(measure({ nos: '1.005', length: '1.5' })).toBe('1.508')
    expect(measure({ nos: '-1.005', length: '1.5' })).toBe('-1.508')
    // And a product that lands exactly on a third place is left alone.
    expect(measure({ nos: '1.005', length: '2' })).toBe('2.01')
  })

  it('is zero when nothing was measured', () => {
    expect(measure({})).toBe('0')
    expect(measure({ nos: '', length: null })).toBe('0')
  })

  it('refuses a measurement written to more than three places', () => {
    // An MB is written to three. More is a typo, not extra precision.
    expect(() => measure({ length: '1.23456' })).toThrow(/three decimals/)
  })

  it('refuses something that is not a number', () => {
    expect(() => measure({ nos: '4 nos' })).toThrow(/not a measurement/)
    expect(() => measure({ length: '-' })).toThrow(/not a measurement/)
  })
})

describe('rolling up', () => {
  it('totals every entry against its item', () => {
    const totals = rollUp([
      { boqItemId: 'a', quantity: '5.4' },
      { boqItemId: 'a', quantity: '2.75' },
      { boqItemId: 'b', quantity: '12' },
    ])
    expect(totals).toEqual({ a: '8.15', b: '12' })
  })

  it('adds exactly across many entries', () => {
    // 0.1 added ten times is 0.9999999999999999 in floating point.
    const entries = Array.from({ length: 10 }, () => ({ boqItemId: 'a', quantity: '0.1' }))
    expect(rollUp(entries)).toEqual({ a: '1' })
  })

  it('nets a deduction entry against the measurements it reduces', () => {
    expect(rollUp([
      { boqItemId: 'a', quantity: '18.4' },
      { boqItemId: 'a', quantity: '-0.58' },
    ])).toEqual({ a: '17.82' })
  })
})

describe('the MB against the bill', () => {
  const billed = [
    { boqItemId: 'a', itemNo: '1', cumulativeQty: '8.15' },
    { boqItemId: 'b', itemNo: '2', cumulativeQty: '12.5' },
    { boqItemId: 'c', itemNo: '3', cumulativeQty: '4' },
  ]

  it('says nothing about an item that was never measured', () => {
    // The MB is optional — a small work often has none at all, and silence is
    // the right answer rather than a false disagreement.
    const r = reconcileWithBill({ a: '8.15' }, billed)
    expect(r.map((x) => x.itemNo)).toEqual(['1'])
    expect(disagreements(r)).toHaveLength(0)
  })

  it('flags an item measured at one figure and billed at another', () => {
    const r = reconcileWithBill({ a: '8.15', b: '12' }, billed)
    const bad = disagreements(r)
    expect(bad).toHaveLength(1)
    expect(bad[0]!.itemNo).toBe('2')
    expect(bad[0]!.measuredQty).toBe('12')
    expect(bad[0]!.billedQty).toBe('12.5')
    expect(bad[0]!.differenceQty).toBe('-0.5')   // billed more than measured
  })

  it('reports a positive difference when the MB is ahead of the bill', () => {
    const r = reconcileWithBill({ c: '6' }, billed)
    expect(r[0]!.differenceQty).toBe('2')
    expect(r[0]!.agrees).toBe(false)
  })

  it('treats a differently written but equal quantity as agreement', () => {
    const r = reconcileWithBill({ c: '4.000' }, billed)
    expect(r[0]!.agrees).toBe(true)
    expect(r[0]!.differenceQty).toBe('0')
  })
})
