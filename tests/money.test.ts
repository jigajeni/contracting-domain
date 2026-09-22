import { describe, expect, it } from 'vitest'
import {
  paise, rupeesToPaise, pctOf, qtyTimesRate, roundToRupee,
  formatINR, formatINRCompact, formatLakh, add, sub,
} from '@/domain/money'

describe('money is integer paise', () => {
  it('rejects fractional paise', () => {
    expect(() => paise(1.5)).toThrow()
  })

  it('parses rupee input without floating point', () => {
    expect(rupeesToPaise('1234.56')).toBe(123456n)
    expect(rupeesToPaise('₹1,25,50,000')).toBe(1255000000n)
    expect(rupeesToPaise('0.05')).toBe(5n)
    expect(rupeesToPaise('-500')).toBe(-50000n)
    expect(rupeesToPaise('5.4')).toBe(540n)
    expect(() => rupeesToPaise('1.234')).toThrow()
  })
})

describe('Indian number formatting', () => {
  it('groups lakh and crore, not thousands', () => {
    expect(formatINR(1255000000n)).toBe('₹1,25,50,000')
    expect(formatINR(4520495000n)).toBe('₹4,52,04,950')
    expect(formatINR(100000n)).toBe('₹1,000')
    expect(formatINR(-4496300n)).toBe('-₹44,963')
  })

  it('shows paise only when there are any', () => {
    expect(formatINR(53914363n)).toBe('₹5,39,143.63')
    expect(formatINR(53914300n)).toBe('₹5,39,143')
    expect(formatINR(53914300n, { paise: true })).toBe('₹5,39,143.00')
  })

  it('compacts for dashboard tiles', () => {
    expect(formatINRCompact(4520495000n)).toBe('₹4.52 Cr')
    expect(formatINRCompact(1255000000n)).toBe('₹1.26 Cr')
    expect(formatINRCompact(53914363n)).toBe('₹5.39 L')
    expect(formatINRCompact(840000n)).toBe('₹8,400')
  })

  it('formats registration capacity in lakh', () => {
    expect(formatLakh(1500000000n)).toBe('150.00 L')   // Sahyadri Infra, Class 4
    expect(formatLakh(300000000n)).toBe('30.00 L')     // Class 5-A
    expect(formatLakh(50000000n)).toBe('5.00 L')       // per-work cap
  })
})

describe('percentages and quantities', () => {
  it('computes a deduction as a percentage of a base', () => {
    // Suslad bill: department base ₹5,16,800
    const base = paise(51680000)
    expect(pctOf(base, '2.0000')).toBe(1033600n)  // IT TDS 194C @ 2%
    expect(pctOf(base, '1.0000')).toBe(516800n)   // CGST TDS @ 1%
    expect(pctOf(base, 1)).toBe(516800n)
  })

  it('rounds half up, symmetrically about zero', () => {
    expect(pctOf(paise(1), '50.0000')).toBe(1n)     // 0.5 → 1
    expect(pctOf(paise(-1), '50.0000')).toBe(-1n)
  })

  it('multiplies a 3dp quantity by a paise rate', () => {
    // Suslad item 2: 6.480 cum @ ₹6,429.40 = ₹41,662.51
    expect(qtyTimesRate('6.480', paise(642940))).toBe(4166251n)
    // item 1: 0.675 @ ₹207.00 = ₹139.73 (0.675 × 20700 = 13972.5 → 13973)
    expect(qtyTimesRate('0.675', paise(20700))).toBe(13973n)
  })

  it('rounds to whole rupees the way a department does', () => {
    expect(roundToRupee(paise(13973))).toBe(14000n)
    expect(roundToRupee(paise(13949))).toBe(13900n)
    expect(roundToRupee(paise(-13973))).toBe(-14000n)
  })
})

describe('arithmetic stays in bigint', () => {
  it('adds and subtracts without precision loss at crore scale', () => {
    const a = paise(452049500000)   // ₹45.20 Cr in paise
    const b = paise(1)
    expect(add(a, b)).toBe(452049500001n)
    expect(sub(add(a, b), b)).toBe(a)
  })
})
