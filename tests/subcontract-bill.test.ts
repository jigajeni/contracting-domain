import { describe, it, expect } from 'vitest'
import { ZERO, paise } from '@/domain/money'
import {
  blocking, checkSublet, computeBill, type BillInput, type OrderTerms,
} from '@/domain/subcontract/bill'

const TERMS: OrderTerms = {
  orderValuePaise: paise(20_00_000_00),      // ₹20 lakh
  retentionPct: '5.0000',
  advancePaise: paise(2_00_000_00),          // ₹2 lakh mobilisation
  advanceRecoveredPaise: ZERO,
  advanceRecoveryPct: null,
}

const bill = (over: Partial<BillInput> = {}): BillInput => ({
  terms: TERMS,
  cumulativeValuePaise: paise(5_00_000_00),
  previousValuePaise: ZERO,
  previousRetentionPaise: ZERO,
  materialIssuedPaise: ZERO,
  otherDeductionsPaise: ZERO,
  tds: { payeeKind: 'individual', hasPan: true, paidThisFyPaise: ZERO },
  isFinal: false,
  ...over,
})

describe('the cumulative identity', () => {
  it('bills the difference, never the total', () => {
    const b = computeBill(bill({
      cumulativeValuePaise: paise(8_00_000_00),
      previousValuePaise: paise(5_00_000_00),
    }))
    expect(b.grossPaise).toBe(paise(3_00_000_00))
  })

  it('refuses a cumulative figure below what has already been billed', () => {
    const b = computeBill(bill({
      cumulativeValuePaise: paise(3_00_000_00),
      previousValuePaise: paise(5_00_000_00),
    }))
    expect(blocking(b.problems)[0]!.message).toContain('negative bill')
  })
})

describe('retention', () => {
  it('is worked out on the value to date, less what is already held', () => {
    // Not 5% of this bill: a rate changed mid-order, or one corrected bill,
    // leaves a per-bill total unable to reconcile against the order.
    const b = computeBill(bill({
      cumulativeValuePaise: paise(8_00_000_00),
      previousValuePaise: paise(5_00_000_00),
      previousRetentionPaise: paise(25_000_00),   // 5% of 5 lakh
    }))
    const r = b.deductions.find((d) => d.code === 'retention')!
    expect(r.amountPaise).toBe(paise(15_000_00))  // 5% of 8L − 25,000
    expect(b.retentionHeldPaise).toBe(paise(40_000_00))
  })

  it('is still held after the final bill, and says who has to watch for it', () => {
    const b = computeBill(bill({ isFinal: true }))
    expect(b.retentionHeldPaise).toBeGreaterThan(0n)
    expect(b.problems.some((p) => p.message.includes('defect liability'))).toBe(true)
  })
})

describe('recovering the advance', () => {
  it('recovers it at the pace the work is done', () => {
    // ₹2 lakh against a ₹20 lakh order is 10%, so a ₹5 lakh bill gives ₹50,000.
    const b = computeBill(bill())
    expect(b.deductions.find((d) => d.code === 'advance_recovery')!.amountPaise)
      .toBe(paise(50_000_00))
    expect(b.advanceOutstandingPaise).toBe(paise(1_50_000_00))
  })

  it('honours an agreed recovery percentage where there is one', () => {
    const b = computeBill(bill({
      terms: { ...TERMS, advanceRecoveryPct: '20.0000' } }))
    expect(b.deductions.find((d) => d.code === 'advance_recovery')!.amountPaise)
      .toBe(paise(1_00_000_00))
  })

  it('never recovers more than is outstanding', () => {
    // The rule that matters. Taking back more than was advanced is money that
    // was never owed, off somebody who cannot easily argue about it.
    const b = computeBill(bill({
      terms: { ...TERMS, advanceRecoveredPaise: paise(1_80_000_00),
               advanceRecoveryPct: '50.0000' },
    }))
    expect(b.deductions.find((d) => d.code === 'advance_recovery')!.amountPaise)
      .toBe(paise(20_000_00))
    expect(b.advanceOutstandingPaise).toBe(ZERO)
  })

  it('takes the whole balance on a final bill', () => {
    const b = computeBill(bill({ isFinal: true }))
    expect(b.deductions.find((d) => d.code === 'advance_recovery')!.amountPaise)
      .toBe(paise(2_00_000_00))
    expect(b.advanceOutstandingPaise).toBe(ZERO)
  })

  it('deducts nothing once it is fully recovered', () => {
    const b = computeBill(bill({
      terms: { ...TERMS, advanceRecoveredPaise: paise(2_00_000_00) } }))
    expect(b.deductions.some((d) => d.code === 'advance_recovery')).toBe(false)
  })
})

describe('what the bill comes to', () => {
  it('nets the deductions off the gross and lists every one', () => {
    const b = computeBill(bill({ materialIssuedPaise: paise(80_000_00) }))
    expect(b.grossPaise).toBe(paise(5_00_000_00))
    // 25,000 retention + 50,000 advance + 80,000 material + 5,000 TDS
    expect(b.totalDeductionsPaise).toBe(paise(1_60_000_00))
    expect(b.netPayablePaise).toBe(paise(3_40_000_00))
    expect(b.deductions.map((d) => d.code)).toEqual(
      ['retention', 'advance_recovery', 'material_issued', 'tds_194c'])
  })

  it('charges 194C at one per cent to an individual with a PAN', () => {
    expect(computeBill(bill()).tds.tdsPaise).toBe(paise(5_000_00))
  })

  it('charges twenty per cent with no PAN — section 206AA', () => {
    const b = computeBill(bill({
      tds: { payeeKind: 'individual', hasPan: false, paidThisFyPaise: ZERO } }))
    expect(b.tds.tdsPaise).toBe(paise(1_00_000_00))
    expect(b.tds.reason).toContain('206AA')
  })

  it('refuses a bill the deductions have swallowed', () => {
    // A subcontractor handed a negative bill stops working.
    const b = computeBill(bill({
      cumulativeValuePaise: paise(50_000_00),
      materialIssuedPaise: paise(60_000_00),
    }))
    expect(blocking(b.problems)[0]!.message).toContain('stops working')
  })

  it('warns when the work has run past the order value', () => {
    const b = computeBill(bill({ cumulativeValuePaise: paise(23_00_000_00) }))
    expect(b.problems.some((p) => p.message.includes('above the order value'))).toBe(true)
    expect(b.progressPct).toBeCloseTo(115, 0)
  })
})

describe('whether we may sub-contract at all', () => {
  it('allows it where the work order permits it', () => {
    expect(checkSublet({ subcontractingAllowed: true,
                         registrationSubletProhibited: false }).allowed).toBe(true)
  })

  it('BLOCKS where the work order forbids it, never merely warns', () => {
    // CLAUDE.md §13. A warning that can be clicked past is not a control.
    const c = checkSublet({ subcontractingAllowed: false,
                            registrationSubletProhibited: false })
    expect(c.allowed).toBe(false)
    expect(c.verdict).toBe('prohibited')
  })

  it('blocks on the registration first, and names the two-year penalty', () => {
    const c = checkSublet({
      subcontractingAllowed: true, registrationSubletProhibited: true,
      registrationCategory: 'educated_unemployed_engineer' })
    expect(c.verdict).toBe('registration_barred')
    expect(c.reason).toContain('TWO YEARS')
  })

  it('names the shorter penalty for a general contractor', () => {
    const c = checkSublet({
      subcontractingAllowed: true, registrationSubletProhibited: true,
      registrationCategory: 'general_contractor' })
    expect(c.reason).toContain('three to six months')
  })
})
