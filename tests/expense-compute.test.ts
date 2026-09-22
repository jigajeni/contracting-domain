import { describe, expect, it } from 'vitest'
import { paise, type Paise } from '@/domain/money'
import { TDS_HINT, computeExpense } from '@/domain/expense/compute'

/**
 * A supplier bill of ₹1,00,000 plus 18% GST with 1% TDS under 194C. Three
 * different numbers come out of it and all three are used somewhere.
 */
const BASIC = paise(1_00_000_00n)

describe('the three figures', () => {
  const e = computeExpense({
    basicPaise: BASIC, gstRatePct: '18.0000', tdsRatePct: '1.0000',
  })

  it('books the cost including GST and including the TDS', () => {
    expect(e.totalPaise).toBe(1_18_000_00n as Paise)
  })

  /* TDS is not a discount. It is our cost either way — part of it simply goes
     to the government instead of the supplier. Netting it out of the cost
     understates every project's spend by the TDS rate, quietly. */
  it('does not net the TDS out of the cost', () => {
    expect(e.totalPaise).not.toBe(1_17_000_00n as Paise)
  })

  it('pays the supplier the cost less the TDS', () => {
    expect(e.payablePaise).toBe(1_17_000_00n as Paise)
    expect(e.payablePaise + e.tdsPaise).toBe(e.totalPaise)
  })
})

describe('TDS is charged on the basic, never on the GST', () => {
  /* Section 194C is on the sum payable for the work, and where GST is shown
     separately it is excluded. On these figures the wrong base gives ₹1,180
     instead of ₹1,000 — and the supplier notices immediately. */
  it('deducts 1% of the work value', () => {
    const e = computeExpense({
      basicPaise: BASIC, gstRatePct: '18.0000', tdsRatePct: '1.0000',
    })
    expect(e.tdsPaise).toBe(1_000_00n as Paise)
    expect(e.tdsPaise).not.toBe(1_180_00n as Paise)
  })

  it('is unaffected by the GST rate', () => {
    const at18 = computeExpense({
      basicPaise: BASIC, gstRatePct: '18.0000', tdsRatePct: '2.0000' })
    const at5 = computeExpense({
      basicPaise: BASIC, gstRatePct: '5.0000', tdsRatePct: '2.0000' })
    expect(at18.tdsPaise).toBe(at5.tdsPaise)
    expect(at18.totalPaise).not.toBe(at5.totalPaise)
  })
})

describe('an entered figure beats the rate', () => {
  /* The invoice is the document that has to be reconciled against. Same
     principle as a department's deduction arithmetic beating the statutory
     rate — CLAUDE.md §2. */
  it('uses the GST on the invoice, however the supplier rounded it', () => {
    const e = computeExpense({
      basicPaise: BASIC, gstRatePct: '18.0000', gstPaise: paise(17_999_50n),
    })
    expect(e.gstPaise).toBe(17_999_50n as Paise)
    expect(e.totalPaise).toBe(1_17_999_50n as Paise)
  })

  it('uses an entered TDS, including a deliberate zero', () => {
    const e = computeExpense({
      basicPaise: BASIC, tdsRatePct: '1.0000', tdsPaise: paise(0n),
    })
    expect(e.tdsPaise).toBe(0n as Paise)
    expect(e.payablePaise).toBe(BASIC)
    /* A transporter with ten or fewer carriages and a PAN declaration attracts
       nil. Falling back to the rate because the figure "looked empty" would
       deduct from somebody it must not be deducted from. */
  })

  it('stops calling it an estimate once both are entered', () => {
    const e = computeExpense({
      basicPaise: BASIC, gstPaise: paise(18_000_00n), tdsPaise: paise(1_000_00n),
      gstRatePct: '18.0000', tdsRatePct: '1.0000',
    })
    expect(e.estimated).toBe(false)
  })

  it('flags an estimate when either came off a rate', () => {
    expect(computeExpense({ basicPaise: BASIC, gstRatePct: '18.0000' }).estimated).toBe(true)
    expect(computeExpense({ basicPaise: BASIC, tdsRatePct: '1.0000' }).estimated).toBe(true)
  })
})

describe('an unregistered supplier', () => {
  it('has no GST and no estimate', () => {
    const e = computeExpense({ basicPaise: BASIC })
    expect(e.gstPaise).toBe(0n as Paise)
    expect(e.totalPaise).toBe(BASIC)
    expect(e.payablePaise).toBe(BASIC)
    expect(e.estimated).toBe(false)
  })
})

describe('bad data', () => {
  it('never makes the supplier owe us', () => {
    const e = computeExpense({
      basicPaise: BASIC, tdsPaise: paise(2_00_000_00n),
    })
    expect(e.payablePaise).toBe(0n as Paise)
    /* The cost is untouched — the error is in the deduction, not the bill. */
    expect(e.totalPaise).toBe(BASIC)
  })
})

describe('TDS hints', () => {
  /* A suggestion for the form, never a decision. The rate deducted is whatever
     was actually deducted: 1% to an individual, 2% to a company under the same
     section, which is a fact about the payee and not about the category. */
  it('suggests 194C for labour and 194J for professional fees', () => {
    expect(TDS_HINT.labour!.section).toBe('194C')
    expect(TDS_HINT.office_overhead!.section).toBe('194J')
    expect(TDS_HINT.office_overhead!.pct).toBe('10.0000')
  })

  it('says nothing about buckets where it does not apply', () => {
    expect(TDS_HINT.material).toBeUndefined()
    expect(TDS_HINT.fuel).toBeUndefined()
    expect(TDS_HINT.statutory).toBeUndefined()
  })

  it('warns that a transporter may attract nil', () => {
    expect(TDS_HINT.transport!.note).toMatch(/declaration/)
  })
})
