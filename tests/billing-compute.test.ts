import { describe, expect, it } from 'vitest'
import { formatINR, paise, roundToRupee, type Paise } from '@/domain/money'
import {
  computeBill,
  computeDeductions,
  computeLine,
  netPayable,
  totalDeductions,
  type BillLineInput,
  type ComputedLine,
} from '@/domain/billing/compute'

/**
 * The module under test against the departmental bills it has to reproduce.
 * tests/bill-chain.test.ts established what the arithmetic is; this asserts
 * the shipped implementation does it, so a refactor cannot quietly drift away
 * from the Ankale and Miraj bills.
 */

const line = (
  o: Partial<BillLineInput> & Pick<BillLineInput, 'cumulativeQty' | 'ratePaise'>,
): BillLineInput => ({
  boqItemId: 'x',
  itemNo: '1',
  description: 'item',
  unit: 'cum',
  tenderedQty: '1000',
  previousQty: '0',
  ...o,
})

/** One synthetic line carrying a known cumulative, for the bill-level chain. */
const firstOf = <T,>(xs: T[]): T => {
  const [x] = xs
  if (!x) throw new Error('expected at least one row')
  return x
}

const lump = (cumulativePaise: number): ComputedLine =>
  computeLine(line({ cumulativeQty: '1', ratePaise: paise(cumulativePaise) }))

describe('computeLine', () => {
  it('bills the cumulative less the previous cumulative', () => {
    // The Ankale royalty item: 73.82 cum @ ₹216.18, 40 cum already billed.
    const r = computeLine(
      line({ cumulativeQty: '73.82', previousQty: '40', ratePaise: paise(21_618) }),
    )
    expect(r.thisBillQty).toBe('33.82')
    expect(formatINR(r.cumulativeAmountPaise)).toBe('₹15,958.41')
    expect(formatINR(r.previousAmountPaise)).toBe('₹8,647.20')
    expect(formatINR(r.thisBillAmountPaise)).toBe('₹7,311.21')
  })

  it('subtracts three-decimal quantities exactly', () => {
    // 0.3 − 0.1 is 0.19999999999999998 in floating point.
    expect(
      computeLine(line({ cumulativeQty: '0.3', previousQty: '0.1', ratePaise: paise(100) }))
        .thisBillQty,
    ).toBe('0.2')
    expect(
      computeLine(line({ cumulativeQty: '12.345', previousQty: '12.345', ratePaise: paise(100) }))
        .thisBillQty,
    ).toBe('0')
    // A downward revision is legal — the department reduces a certified quantity.
    expect(
      computeLine(line({ cumulativeQty: '5', previousQty: '7.5', ratePaise: paise(100) }))
        .thisBillQty,
    ).toBe('-2.5')
  })

  it('flags execution beyond the tendered quantity', () => {
    const over = computeLine(
      line({ tenderedQty: '100', cumulativeQty: '104.5', ratePaise: paise(100) }),
    )
    expect(over.exceedsTendered).toBe(true) // needs a deviation statement
    const under = computeLine(
      line({ tenderedQty: '100', cumulativeQty: '100', ratePaise: paise(100) }),
    )
    expect(under.exceedsTendered).toBe(false)
  })

  it('records a rate the department reduced below the BOQ', () => {
    // SCADA: ₹126/cum off concrete where the batching plant had no
    // Supervisory Control and Data Acquisition.
    const r = computeLine(
      line({ cumulativeQty: '10', ratePaise: paise(680_000), boqRatePaise: paise(692_600) }),
    )
    expect(formatINR(r.rateReducedPaise)).toBe('₹126')
    expect(formatINR(r.thisBillAmountPaise)).toBe('₹68,000')
  })
})

describe('computeBill — Ankale 1st RA, ZP Sangli', () => {
  const bill = computeBill({
    lines: [lump(406_933_868)], // ₹40,69,338.68
    premiumPct: '-0.25', // quoted 0.25% below
    passThroughPaise: paise(5_090_341), // royalty ₹15,958.41 + testing ₹34,945
    passThroughInGstBase: false, // ZP excludes both from the base
    gstRatePct: '18',
    cumulativeAdditionsPaise: paise(3_773_000), // worker insurance ₹37,730
    previousBillsTotalPaise: paise(0),
  })

  it('takes the premium off the bill total, not off item rates', () => {
    expect(formatINR(bill.premiumPaise)).toBe('₹10,173.35') // bill: 10,173.34
    expect(formatINR(bill.workValuePaise)).toBe('₹40,59,165.33')
  })

  it('lifts pass-through items out of the GST base', () => {
    expect(formatINR(bill.gstBasePaise)).toBe('₹40,08,261.92') // bill: 40,08,261.93
    // The department's exact figure. This used to read ...15, a paisa high,
    // because 18% was rounded in one go instead of two 9% lines being added.
    expect(formatINR(bill.gstPaise)).toBe('₹7,21,487.14')
  })

  it('splits GST into equal CGST and SGST halves that sum to the total', () => {
    expect(bill.cgstPaise).toBe(bill.sgstPaise)
    expect(bill.igstPaise).toBe(0n)
    // Exactly, not within a paisa: the bill prints two lines and the
    // department adds them, so the total IS the sum.
    expect(bill.cgstPaise + bill.sgstPaise).toBe(bill.gstPaise)
  })

  it('lands within a paisa of the department across the whole chain', () => {
    expect(Number(bill.cumulativeTotalPaise - paise(481_838_248))).toBeLessThanOrEqual(2)
  })

  it('exposes the work portion as the deduction base', () => {
    expect(bill.deductionBasePaise).toBe(bill.workValuePaise)
  })
})

describe('computeBill — Ankale 3rd RA', () => {
  const bill = computeBill({
    lines: [lump(643_888_330)], // ₹64,38,883.30
    limitCumulativeToPaise: paise(642_429_300), // "limited rs" ₹64,24,293
    premiumPct: '-0.25',
    passThroughPaise: paise(5_142_656),
    passThroughInGstBase: false,
    gstRatePct: '18',
    // Insurance ₹37,730 + the "Contingency" ₹2,56,972 line. Those two are
    // exactly the gap between the work value plus GST and the cumulative the
    // department states, so the contingency rides the bill as a one-off
    // addition rather than as a BOQ item.
    cumulativeAdditionsPaise: paise(3_773_000 + 25_697_200),
    previousBillsTotalPaise: paise(609_915_800), // ₹60,99,158 already paid
  })

  it('caps the cumulative before applying the premium', () => {
    expect(formatINR(bill.linesTotalPaise)).toBe('₹64,38,883.30')
    expect(formatINR(bill.premiumPaise)).toBe('₹16,060.73')
    expect(formatINR(bill.workValuePaise)).toBe('₹64,08,232.27')
    expect(formatINR(bill.gstBasePaise)).toBe('₹63,56,805.71')
    expect(formatINR(bill.gstPaise)).toBe('₹11,44,225.02')  // bill: 11,44,225.03
  })

  it('pays cumulative minus previous, a paisa under the department', () => {
    /* CLAUDE.md §2 — never the since-previous column. The bill states
       ₹78,47,159.30 and ₹17,48,001.30; we land a paisa under both.

       This is the department disagreeing with itself, not with us. On the 1st
       RA of this same agreement its GST equals two 9% lines added, which is
       what we do and what the Suslad authorisation also does. On this bill it
       equals 18% rounded once. No single rule reproduces both, and picking the
       rule that matches two bills out of three is the most that arithmetic can
       do here.

       The remaining paisa is settled the way CLAUDE.md settles every such
       difference: the department's figure wins, entered as an override with a
       reason, and the bill stores its resolved totals rather than recomputing
       them on read. */
    expect(formatINR(bill.cumulativeTotalPaise)).toBe('₹78,47,159.29')
    expect(formatINR(bill.payablePaise)).toBe('₹17,48,001.29')
    expect(paise(784_715_930) - bill.cumulativeTotalPaise).toBe(1n)
  })
})

describe('computeBill — a premium above the estimate', () => {
  it('adds rather than subtracts when the quote is above', () => {
    const above = computeBill({
      lines: [lump(10_000_000)], // ₹1,00,000
      premiumPct: '5',
      passThroughPaise: paise(0),
      passThroughInGstBase: true,
      gstRatePct: '18',
      cumulativeAdditionsPaise: paise(0),
      previousBillsTotalPaise: paise(0),
    })
    expect(formatINR(above.workValuePaise)).toBe('₹1,05,000')

    const at = computeBill({
      lines: [lump(10_000_000)],
      premiumPct: '0',
      passThroughPaise: paise(0),
      passThroughInGstBase: true,
      gstRatePct: '18',
      cumulativeAdditionsPaise: paise(0),
      previousBillsTotalPaise: paise(0),
    })
    expect(formatINR(at.workValuePaise)).toBe('₹1,00,000')
  })
})

describe('computeBill — PWD Miraj, the other GST rule', () => {
  it('keeps testing charges inside the GST base', () => {
    // Rest house extension, agreement B-1/HO/36/2025-26, Form 47.
    const bill = computeBill({
      lines: [lump(160_312_594)], // work + testing ₹16,03,125.94
      premiumPct: '0',
      passThroughPaise: paise(1_234_000),
      passThroughInGstBase: true, // PWD, unlike ZP
      gstRatePct: '18',
      cumulativeAdditionsPaise: paise(0),
      previousBillsTotalPaise: paise(0),
    })
    expect(bill.gstBasePaise).toBe(bill.workValuePaise)
    // The bill states a whole-rupee ₹2,88,563, which both roundings reach.
    expect(formatINR(bill.gstPaise)).toBe('₹2,88,562.66')
    expect(formatINR(roundToRupee(bill.gstPaise))).toBe('₹2,88,563')
  })
})

describe('computeDeductions', () => {
  /** Ankale 2nd RA. The department prints "Work Portion" ₹8,67,630. */
  const workPortion = paise(86_763_000)

  it('takes percentages on the work portion, in whole rupees', () => {
    const ds = computeDeductions(workPortion, [
      { code: 'IT_TDS', name: 'Income tax', basis: 'pct_of_taxable', ratePct: '1', previousCumulativePaise: paise(0) },
      { code: 'CGST_TDS', name: 'CGST TDS', basis: 'pct_of_taxable', ratePct: '1', previousCumulativePaise: paise(0) },
      { code: 'SGST_TDS', name: 'SGST TDS', basis: 'pct_of_taxable', ratePct: '1', previousCumulativePaise: paise(0) },
      { code: 'ZP_CESS', name: 'ZP cess', basis: 'pct_of_taxable', ratePct: '0.01', previousCumulativePaise: paise(0) },
    ])
    expect(ds.map((d) => formatINR(d.thisBillPaise))).toEqual([
      '₹8,676',
      '₹8,676',
      '₹8,676',
      '₹87',
    ])
    expect(ds.every((d) => !d.isOverridden)).toBe(true)
  })

  it('is cumulative — this bill is the cumulative less what was already cut', () => {
    const d = firstOf(computeDeductions(workPortion, [
      {
        code: 'SD',
        name: 'Security deposit',
        basis: 'pct_of_taxable',
        ratePct: '3',
        previousCumulativePaise: paise(1_500_000), // ₹15,000 already retained
      },
    ]))
    expect(formatINR(d.cumulativePaise)).toBe('₹26,029')
    expect(formatINR(d.thisBillPaise)).toBe('₹11,029')
  })

  it('lets the department’s own figure win, and says it did', () => {
    // Our working and theirs differ; the bill must match theirs. CLAUDE.md §2.
    const d = firstOf(computeDeductions(workPortion, [
      {
        code: 'IT_TDS',
        name: 'Income tax',
        basis: 'pct_of_taxable',
        ratePct: '1',
        previousCumulativePaise: paise(0),
        overridePaise: paise(867_500),
        overrideReason: 'Department rounded down on the authorisation',
      },
    ]))
    expect(formatINR(d.computedPaise)).toBe('₹8,676') // what we make it
    expect(formatINR(d.thisBillPaise)).toBe('₹8,675') // what they cut
    expect(d.isOverridden).toBe(true)
    expect(d.overrideReason).toBe('Department rounded down on the authorisation')
  })

  it('leaves a manual head alone when nothing is entered for it', () => {
    /* Royalty is entered by hand from the department's own figure. With
       nothing typed it must contribute zero this bill, not wipe out what
       earlier bills already deducted — which showed as a negative royalty on
       the Miraj bill. */
    const d = firstOf(computeDeductions(workPortion, [{
      code: 'ROYALTY', name: 'Royalty on minor minerals', basis: 'manual',
      ratePct: null, previousCumulativePaise: paise(8_450_000),
    }]))
    expect(formatINR(d.thisBillPaise)).toBe('₹0')
    expect(formatINR(d.cumulativePaise)).toBe('₹84,500')
    expect(d.isOverridden).toBe(false)
  })

  it('carries manual deductions through untouched', () => {
    const d = firstOf(computeDeductions(workPortion, [
      {
        code: 'LABOUR_CESS',
        name: 'Labour welfare cess',
        basis: 'manual',
        ratePct: null,
        previousCumulativePaise: paise(0),
        overridePaise: paise(859_000),
      },
    ]))
    expect(formatINR(d.thisBillPaise)).toBe('₹8,590')
    expect(d.ratePct).toBeNull()
  })

  it('balances the Ankale 2nd RA deduction block against the cheque', () => {
    const ds = computeDeductions(workPortion, [
      { code: 'SD', name: 'Security deposit', basis: 'manual', previousCumulativePaise: paise(0), overridePaise: paise(2_574_500) },
      { code: 'LABOUR_CESS', name: 'Labour cess', basis: 'manual', previousCumulativePaise: paise(0), overridePaise: paise(859_000) },
      { code: 'ZP_CESS', name: 'ZP cess', basis: 'pct_of_taxable', ratePct: '0.01', previousCumulativePaise: paise(0) },
      { code: 'IT_TDS', name: 'Income tax', basis: 'pct_of_taxable', ratePct: '1', previousCumulativePaise: paise(0) },
      { code: 'CGST_TDS', name: 'CGST TDS', basis: 'pct_of_taxable', ratePct: '1', previousCumulativePaise: paise(0) },
      { code: 'SGST_TDS', name: 'SGST TDS', basis: 'pct_of_taxable', ratePct: '1', previousCumulativePaise: paise(0) },
    ])
    const total = totalDeductions(ds)
    expect(formatINR(total)).toBe('₹60,450')
    expect(formatINR((total + paise(96_335_400)) as Paise)).toBe('₹10,23,804')
  })
})

describe('netPayable', () => {
  it('is the payable less the cuts — the cheque', () => {
    const bill = computeBill({
      lines: [lump(101_400_000)],
      premiumPct: '0',
      passThroughPaise: paise(0),
      passThroughInGstBase: true,
      gstRatePct: '18',
      cumulativeAdditionsPaise: paise(0),
      previousBillsTotalPaise: paise(0),
    })
    const ds = computeDeductions(bill.deductionBasePaise, [
      { code: 'IT_TDS', name: 'Income tax', basis: 'pct_of_taxable', ratePct: '1', previousCumulativePaise: paise(0) },
    ])
    expect(formatINR(bill.payablePaise)).toBe('₹11,96,520')
    expect(formatINR(netPayable(bill, ds))).toBe('₹11,86,380')
  })
})
