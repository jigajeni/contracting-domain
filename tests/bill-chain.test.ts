import { describe, expect, it } from 'vitest'
import { paise, pctOf, roundToRupee, qtyTimesRate, formatINR, type Paise } from '@/domain/money'
import {
  computeBill, computeDeductions, computeLine, totalDeductions,
  type ComputedLine,
} from '@/domain/billing/compute'

/**
 * The last three real bills the office raised, reproduced through the same
 * functions the application runs — `computeLine`, `computeBill` and
 * `computeDeductions`, not a copy of their arithmetic. PLAN.md makes this the
 * exit criterion for Phase 1, and "reproduces in the system" has to mean the
 * system: a fixture that recomputes the chain beside the code pins a belief,
 * and passes just as happily when the code is wrong.
 *
 * The earlier version of this file did exactly that, and hid two things.
 *
 *   It disagreed with the application about the SIGN of the tender premium.
 *   It subtracted a positive percentage; the database stores below-estimate as
 *   NEGATIVE (CLAUDE.md §1, अंदाजपत्रकीय दरापेक्षा % कमी) and `computeBill`
 *   reads it that way, so the same 0.25% that reduced the bill here would have
 *   added ₹20,346 there. Both were self-consistent. Only one was real.
 *
 *   It never noticed that the department's "Work Portion" cannot always be
 *   derived. See the Suslad bill below.
 *
 * Figures in comments are what the department printed. Where ours differs by a
 * paisa it is said so rather than rounded away.
 */

/**
 * A bill's cumulative total as a single line.
 *
 * The item-by-item schedule is exercised in billing-compute.test.ts; what these
 * fixtures pin is the chain above the lines. One unit at one paisa keeps the
 * arithmetic exact and the intent obvious.
 */
const totalling = (cumulativePaise: number): ComputedLine[] => [
  computeLine({
    boqItemId: 'total', itemNo: '—', description: 'bill total', unit: 'nos',
    tenderedQty: String(cumulativePaise), previousQty: '0',
    cumulativeQty: String(cumulativePaise), ratePaise: paise(1),
  }),
]

describe('Ankale 1st RA bill', () => {
  /**
   * Veterinary dispensary, Jath — ZP Sangli, agreement B-1/76/2025-26.
   * Quoted 0.25% BELOW the estimate, so the premium is stored negative and
   * comes off the bill total, not off the item rates: percentage-rate contract.
   */
  const bill = computeBill({
    lines: totalling(406_933_868),           // ₹40,69,338.68
    premiumPct: '-0.25',
    passThroughPaise: paise(5_090_341),      // royalty 15,958.41 + lab 34,945.00
    passThroughInGstBase: false,             // ZP Sangli keeps them out
    gstRatePct: '18',
    cumulativeAdditionsPaise: paise(3_773_000),   // insurance ₹37,730
    previousBillsTotalPaise: 0n as Paise,
  })

  it('takes the premium off the bill total', () => {
    expect(formatINR(bill.premiumPaise)).toBe('₹10,173.35')   // bill says 10,173.34
    expect(formatINR(bill.workValuePaise)).toBe('₹40,59,165.33')
  })

  it('keeps royalty and testing out of the GST base', () => {
    expect(formatINR(bill.gstBasePaise)).toBe('₹40,08,261.92')  // bill: 40,08,261.93
    // Exactly the department's figure. It used to come out a paisa high,
    // because 18% was rounded once instead of two 9% halves being added.
    expect(formatINR(bill.gstPaise)).toBe('₹7,21,487.14')
  })

  it('adds two halves rather than rounding the whole rate once', () => {
    /* The bill prints CGST and SGST as separate lines and the department adds
       them. Rounding 18% in one go lands a paisa away on both of these bills,
       in opposite directions — which is exactly how a bill comes back. */
    expect(bill.cgstPaise).toBe(bill.sgstPaise)
    expect(bill.cgstPaise + bill.sgstPaise).toBe(bill.gstPaise)
    expect(bill.igstPaise).toBe(0n)
    expect(pctOf(bill.gstBasePaise, '18')).toBe(72_148_715n)   // one paisa higher
  })

  it('lands within a paisa of the department across the whole chain', () => {
    expect(Number(bill.cumulativeTotalPaise - paise(481_838_248))).toBeLessThanOrEqual(2)
  })

  it('confirms the pass-through figure is royalty plus laboratory testing', () => {
    const royalty = qtyTimesRate('73.82', paise(21_618))   // 73.82 cum @ ₹216.18
    const lab = qtyTimesRate('2.00', paise(1_747_250))     // 2 job @ ₹17,472.50
    expect(formatINR(royalty)).toBe('₹15,958.41')
    expect(formatINR(lab)).toBe('₹34,945')
    expect(formatINR((royalty + lab) as Paise)).toBe('₹50,903.41')
  })

  it('would add the premium instead of subtracting it if the sign were dropped', () => {
    /* The bug the old fixture could not see. A positive percentage means ABOVE
       the estimate, and one work in the register genuinely is (+4.9548%), so
       this cannot be papered over by taking the absolute value. */
    const wrongSign = computeBill({
      lines: totalling(406_933_868), premiumPct: '0.25',
      passThroughPaise: paise(5_090_341), passThroughInGstBase: false,
      gstRatePct: '18', cumulativeAdditionsPaise: 0n as Paise,
      previousBillsTotalPaise: 0n as Paise,
    })
    expect(formatINR(wrongSign.workValuePaise)).toBe('₹40,79,512.03')
    expect(wrongSign.workValuePaise - bill.workValuePaise).toBe(2_034_670n)  // ₹20,346.70
  })
})

describe('Ankale 3rd RA bill', () => {
  const bill = computeBill({
    lines: totalling(643_888_330),                    // ₹64,38,883.30
    limitCumulativeToPaise: paise(642_429_300),       // "limited rs" ₹64,24,293
    premiumPct: '-0.25',
    passThroughPaise: paise(5_142_656),
    passThroughInGstBase: false,
    gstRatePct: '18',
    cumulativeAdditionsPaise: 0n as Paise,
    previousBillsTotalPaise: paise(609_915_800),      // ₹60,99,158.00
  })

  it('caps the cumulative before applying the premium', () => {
    expect(formatINR(bill.premiumPaise)).toBe('₹16,060.73')     // matches the bill
    expect(formatINR(bill.workValuePaise)).toBe('₹64,08,232.27')
    expect(formatINR(bill.gstBasePaise)).toBe('₹63,56,805.71')
    expect(formatINR(bill.gstPaise)).toBe('₹11,44,225.02')
  })

  it('applies the cap, not the measured total', () => {
    expect(bill.limitedTotalPaise).toBe(642_429_300n)
    expect(bill.linesTotalPaise).toBe(643_888_330n)
  })

  it('pays cumulative minus previous, not the since-previous column', () => {
    // CLAUDE.md §2. The department's own figures.
    expect(formatINR(bill.cumulativeTotalPaise)).toBe('₹75,52,457.29')
    expect(formatINR(bill.previousPaise)).toBe('₹60,99,158')
    expect(bill.payablePaise).toBe(bill.cumulativeTotalPaise - bill.previousPaise)
  })
})

describe('Ankale 2nd RA bill — the deduction block', () => {
  /**
   * Transcribed from page 2. The department prints a "Work Portion" and every
   * percentage deduction is taken on THAT, never on the bill total. Income tax
   * comes off at 1% rather than the 2% a company normally attracts under 194C,
   * so the rate stays per-project and the department's figure always wins.
   */
  const workPortion = paise(86_763_000)      // ₹8,67,630

  const deductions = computeDeductions(workPortion, [
    { code: 'SD', name: 'Security deposit', basis: 'manual',
      previousCumulativePaise: 0n as Paise, overridePaise: paise(2_574_500) },
    { code: 'LABOUR_CESS', name: 'Labour cess', basis: 'manual',
      previousCumulativePaise: 0n as Paise, overridePaise: paise(859_000) },
    { code: 'LABOUR_CESS_ZP', name: 'ZP cess', basis: 'pct_of_gross',
      ratePct: '0.01', previousCumulativePaise: 0n as Paise },
    { code: 'IT_TDS_194C', name: 'Income tax', basis: 'pct_of_gross',
      ratePct: '1', previousCumulativePaise: 0n as Paise },
    { code: 'CGST_TDS', name: 'CGST TDS', basis: 'pct_of_gross',
      ratePct: '1', previousCumulativePaise: 0n as Paise },
    { code: 'SGST_TDS', name: 'SGST TDS', basis: 'pct_of_gross',
      ratePct: '1', previousCumulativePaise: 0n as Paise },
  ])

  const by = (code: string) => deductions.find((d) => d.code === code)!

  it('takes income tax, CGST and SGST at 1% of the work portion', () => {
    for (const code of ['IT_TDS_194C', 'CGST_TDS', 'SGST_TDS']) {
      expect(formatINR(by(code).thisBillPaise)).toBe('₹8,676')
    }
  })

  it('takes ZP cess at 0.01% of the work portion', () => {
    expect(formatINR(by('LABOUR_CESS_ZP').thisBillPaise)).toBe('₹87')
  })

  it('balances deductions against the cheque', () => {
    const total = totalDeductions(deductions)
    const cheque = paise(96_335_400)          // ₹9,63,354
    expect(formatINR(total)).toBe('₹60,450')
    expect(formatINR((total + cheque) as Paise)).toBe('₹10,23,804')
  })

  it('would be 4% higher if taken on the bill total instead', () => {
    /* Why deduction_base_paise exists at all. Taking the same heads on the
       cumulative rather than the printed Work Portion overstates every one. */
    const onTotal = computeDeductions(paise(90_000_000), [
      { code: 'IT_TDS_194C', name: 'Income tax', basis: 'pct_of_gross',
        ratePct: '1', previousCumulativePaise: 0n as Paise },
    ])
    expect(onTotal[0]!.thisBillPaise).toBeGreaterThan(by('IT_TDS_194C').thisBillPaise)
  })
})

describe('Suslad 1st and final bill — the standing regression fixture', () => {
  /**
   * ZP School Suslad, Shivneri Majur Sahakari Sanstha. Seeded from the actual
   * payment authorisation DDOHQ00/SN/0000X000000 and named in PLAN.md as the
   * fixture Phase 1 exits on: ₹5,39,143.63 of line items and ₹44,963 of
   * deductions across eight heads.
   *
   * This bill is why `deductionBaseOverridePaise` exists. The work value is
   * ₹5,39,143.63 and the authorisation computes every deduction on ₹5,16,800 —
   * CGST TDS is exactly 1% of it. Until the base could be entered, reproducing
   * this bill meant overriding all eight heads by hand to reach figures that
   * one number gives.
   */
  const bill = computeBill({
    lines: totalling(53_914_363),            // ₹5,39,143.63
    premiumPct: '0',
    passThroughPaise: 0n as Paise,
    passThroughInGstBase: true,
    gstRatePct: '18',
    cumulativeAdditionsPaise: 0n as Paise,
    previousBillsTotalPaise: 0n as Paise,
    deductionBaseOverridePaise: paise(51_680_000),   // ₹5,16,800, as printed
  })

  it('reproduces the line total to the paisa', () => {
    expect(formatINR(bill.linesTotalPaise)).toBe('₹5,39,143.63')
    expect(formatINR(bill.workValuePaise)).toBe('₹5,39,143.63')
  })

  it('charges 18% GST, split into halves', () => {
    expect(formatINR(bill.cgstPaise)).toBe('₹48,522.93')
    expect(formatINR(bill.sgstPaise)).toBe('₹48,522.93')
    expect(formatINR(bill.cumulativeTotalPaise)).toBe('₹6,36,189.49')
  })

  it('deducts on the printed Work Portion, not on the work value', () => {
    expect(bill.deductionBasePaise).toBe(51_680_000n)
    expect(bill.deductionBasePaise).not.toBe(bill.workValuePaise)
    // The tell: CGST TDS on the authorisation is exactly 1% of this base.
    expect(formatINR(roundToRupee(pctOf(bill.deductionBasePaise, '1')))).toBe('₹5,168')
  })

  it('derives the base from work value when the department gave no other', () => {
    const ordinary = computeBill({
      lines: totalling(53_914_363), premiumPct: '0',
      passThroughPaise: 0n as Paise, passThroughInGstBase: true,
      gstRatePct: '18', cumulativeAdditionsPaise: 0n as Paise,
      previousBillsTotalPaise: 0n as Paise,
    })
    expect(ordinary.deductionBasePaise).toBe(ordinary.workValuePaise)
  })

  it('reproduces the eight deduction heads and the total', () => {
    /* Entered as the authorisation states them. Several are not a clean
       percentage of the base — labour cess lands on ₹5,116 where 1% would be
       ₹5,168 — which is the department's own arithmetic and must not be
       "corrected". Each therefore carries an override and a reason. */
    const reason = 'As per ZP Sangli payment authorisation DDOHQ00/SN/0000X000000.'
    const deductions = computeDeductions(bill.deductionBasePaise, ([
      ['SD', 1_592_800], ['WORKER_INSURANCE', 258_400],
      ['LABOUR_CESS', 511_600], ['LABOUR_CESS_ZP', 5_200],
      ['IT_TDS_194C', 1_033_500], ['CGST_TDS', 516_800],
      ['SGST_TDS', 516_800], ['ROYALTY', 61_200],
    ] as [string, number][]).map(([code, amt]) => ({
      code, name: code, basis: 'manual',
      previousCumulativePaise: 0n as Paise,
      overridePaise: paise(amt), overrideReason: reason,
    })))

    expect(deductions).toHaveLength(8)
    expect(formatINR(totalDeductions(deductions))).toBe('₹44,963')
  })

  it('keeps the department’s figures when the bill is reopened', () => {
    /* The entry screen used to initialise its override map empty, so opening a
       saved bill recomputed every head from our own percentages. On this bill
       that turns ₹44,963 into ₹51,680 and moves the net by ₹6,717 — on a bill
       the department has already paid, recorded in the revision log as though
       somebody meant it. The draft query now returns what each head recorded
       and the form seeds from it; this pins the arithmetic either way. */
    const ours = computeDeductions(bill.deductionBasePaise, [
      { code: 'SD', name: 'SD', basis: 'pct_of_gross', ratePct: '5',
        previousCumulativePaise: 0n as Paise },
      { code: 'IT_TDS_194C', name: 'IT', basis: 'pct_of_gross', ratePct: '2',
        previousCumulativePaise: 0n as Paise },
      { code: 'CGST_TDS', name: 'CGST', basis: 'pct_of_gross', ratePct: '1',
        previousCumulativePaise: 0n as Paise },
      { code: 'SGST_TDS', name: 'SGST', basis: 'pct_of_gross', ratePct: '1',
        previousCumulativePaise: 0n as Paise },
      { code: 'LABOUR_CESS', name: 'Cess', basis: 'pct_of_gross', ratePct: '1',
        previousCumulativePaise: 0n as Paise },
    ])
    expect(formatINR(totalDeductions(ours))).toBe('₹51,680')
    // ₹6,717 apart, which is what gets lost if the recorded figures are dropped.
    expect(totalDeductions(ours) - paise(4_496_300)).toBe(671_700n)
  })

  it('nets to what the department actually paid', () => {
    const net = (bill.cumulativeTotalPaise - paise(4_496_300)) as Paise
    expect(formatINR(net)).toBe('₹5,91,226.49')
  })
})

describe('PWD Miraj — a different department, a different rule', () => {
  /**
   * Rest house extension, agreement B-1/HO/36/2025-26, Form 47 running account
   * bill. PWD charges GST on work PLUS testing where ZP excludes testing from
   * the base. The rule is departmental, so it stays per project and is never
   * assumed — this fixture exists to stop anyone "simplifying" the flag away.
   */
  it('keeps pass-through inside the GST base', () => {
    const bill = computeBill({
      lines: totalling(160_312_594),          // work + testing ₹16,03,125.94
      premiumPct: '0',
      passThroughPaise: paise(5_000_000),     // testing, and it stays in
      passThroughInGstBase: true,
      gstRatePct: '18',
      cumulativeAdditionsPaise: 0n as Paise,
      previousBillsTotalPaise: 0n as Paise,
    })
    expect(bill.gstBasePaise).toBe(bill.workValuePaise)
    expect(formatINR(roundToRupee(bill.gstPaise))).toBe('₹2,88,563')
  })

  it('would tax ₹9,000 less under the ZP rule', () => {
    // Same bill, ZP's rule. The flag is worth real money, which is why it is
    // per project and not a constant.
    const zp = computeBill({
      lines: totalling(160_312_594), premiumPct: '0',
      passThroughPaise: paise(5_000_000), passThroughInGstBase: false,
      gstRatePct: '18', cumulativeAdditionsPaise: 0n as Paise,
      previousBillsTotalPaise: 0n as Paise,
    })
    expect(formatINR(roundToRupee(zp.gstPaise))).toBe('₹2,79,563')
  })

  it('takes deductions on the work portion and balances to the cheque', () => {
    const workPortion = paise(160_366_400)         // ₹16,03,664
    const deductions = computeDeductions(workPortion, [
      { code: 'IT_TDS_194C', name: 'Income tax', basis: 'pct_of_gross',
        ratePct: '2', previousCumulativePaise: 0n as Paise },
      { code: 'SD', name: 'Security deposit', basis: 'manual',
        previousCumulativePaise: 0n as Paise, overridePaise: paise(3_900_000) },
      { code: 'LABOUR_CESS', name: 'Labour cess', basis: 'pct_of_gross',
        ratePct: '1', previousCumulativePaise: 0n as Paise },
      { code: 'CGST_TDS', name: 'CGST TDS', basis: 'pct_of_gross',
        ratePct: '1', previousCumulativePaise: 0n as Paise },
      { code: 'SGST_TDS', name: 'SGST TDS', basis: 'pct_of_gross',
        ratePct: '1', previousCumulativePaise: 0n as Paise },
      { code: 'WATER', name: 'Water charges', basis: 'pct_of_gross',
        ratePct: '1', previousCumulativePaise: 0n as Paise },
    ])

    expect(formatINR(deductions[0]!.thisBillPaise)).toBe('₹32,073')   // income tax 2%
    expect(formatINR(deductions[2]!.thisBillPaise)).toBe('₹16,037')   // 1% heads
    expect(formatINR(totalDeductions(deductions))).toBe('₹1,35,221')
  })
})

describe('the BOQ reconciles to the work order', () => {
  it('applies the quoted percentage to the whole schedule', () => {
    // 77 items summed: ₹63,28,491.89 advertised, quoted 0.25% below.
    const bill = computeBill({
      lines: totalling(632_849_189), premiumPct: '-0.25',
      passThroughPaise: 0n as Paise, passThroughInGstBase: true,
      gstRatePct: '0', cumulativeAdditionsPaise: 0n as Paise,
      previousBillsTotalPaise: 0n as Paise,
    })
    expect(formatINR(bill.workValuePaise)).toBe('₹63,12,670.66')
    // The work order states ₹63,12,671 — the same figure rounded to the rupee.
    expect(formatINR(roundToRupee(bill.workValuePaise))).toBe('₹63,12,671')
  })
})

describe('the departmental estimate formula', () => {
  /**
   * Dafalapur anganwadi estimate, ZP Sangli / PS Jath. This is where the
   * (A)/(B) distinction the bills quietly use is actually defined, so these
   * figures are the source of the rule rather than another instance of it.
   * Estimate arithmetic, not bill arithmetic — no computeBill here on purpose.
   */
  const B = paise(138_149_900)              // total of all items, ₹13,81,499
  const labTesting = paise(1_234_000)       // ₹12,340
  const royalty = paise(266_100)            // ₹2,661
  const A = (B - labTesting - royalty) as Paise

  it('derives the net work portion (A) from the work portion (B)', () => {
    expect(formatINR(A)).toBe('₹13,66,498')
  })

  it('charges GST on (A) and everything else on (B)', () => {
    expect(formatINR(roundToRupee(pctOf(A, '18')))).toBe('₹2,45,970')
    expect(formatINR(roundToRupee(pctOf(B, '2')))).toBe('₹27,630')     // electrification
    expect(formatINR(roundToRupee(pctOf(B, '0.25')))).toBe('₹3,454')   // SQM
  })

  it('rounds once at the end, not per component', () => {
    // 0.5% of B lands on 6,907.495 and the estimate prints 6,907, where
    // half-up gives 6,908. (B) is itself a "Say Rs." figure, so the department
    // took its percentages on the unrounded item total. Rounding each
    // component separately drifts the estimate by two rupees.
    const perComponent = [
      roundToRupee(pctOf(B, '0.5')), roundToRupee(pctOf(A, '18')),
      roundToRupee(pctOf(B, '2')), roundToRupee(pctOf(B, '0.5')),
      roundToRupee(pctOf(B, '2')), roundToRupee(pctOf(B, '0.25')),
    ].reduce((a, b) => (a + b) as Paise, 0n as Paise)

    const roundedOnce = roundToRupee([
      pctOf(B, '0.5'), pctOf(A, '18'), pctOf(B, '2'),
      pctOf(B, '0.5'), pctOf(B, '2'), pctOf(B, '0.25'),
    ].reduce((a, b) => (a + b) as Paise, 0n as Paise))

    expect(formatINR((B + roundedOnce) as Paise)).toBe('₹16,99,997')   // the estimate
    expect(formatINR((B + perComponent) as Paise)).toBe('₹16,99,999')  // two rupees adrift
  })

  it('sits under the administrative approval it must not exceed', () => {
    const estimate = paise(169_999_700)                // ₹16,99,997
    const administrativeApproval = paise(170_000_000)  // ₹17,00,000
    expect(estimate < administrativeApproval).toBe(true)
  })
})
