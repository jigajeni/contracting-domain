import { describe, expect, it } from 'vitest'
import { paise, type Paise } from '@/domain/money'
import { applyReceipt, signedAmount } from '@/domain/cashflow/receipt'

/**
 * Money landing against a bill. The arithmetic is small and the ways it goes
 * wrong are expensive: a bill wrongly marked settled leaves the balance
 * uncollected and invisible, and one wrongly left open keeps forecasting money
 * that is already in the bank.
 */

/** ARR/011 2nd RA, the real figure. */
const BILL = paise(48_61_600_00n)

describe('a receipt that settles the bill', () => {
  const r = applyReceipt({
    netPayablePaise: BILL, alreadyReceivedPaise: paise(0n), amountPaise: BILL,
  })

  it('is exact, not short and not over', () => {
    expect(r.fit).toBe('exact')
    expect(r.excessPaise).toBe(0n as Paise)
  })

  it('leaves nothing owed and settles', () => {
    expect(r.outstandingPaise).toBe(0n as Paise)
    expect(r.receivedPaise).toBe(BILL)
    expect(r.settles).toBe(true)
  })
})

describe('a part payment', () => {
  const r = applyReceipt({
    netPayablePaise: BILL, alreadyReceivedPaise: paise(0n),
    amountPaise: paise(20_00_000_00n),
  })

  /* The bill has not been paid; it has been paid something. It stays on the
     review and in the forecast for the balance, which is right — that money is
     still owed. */
  it('does not settle the bill', () => {
    expect(r.fit).toBe('short')
    expect(r.settles).toBe(false)
    expect(r.outstandingPaise).toBe(28_61_600_00n as Paise)
  })

  it('accumulates across receipts', () => {
    const second = applyReceipt({
      netPayablePaise: BILL, alreadyReceivedPaise: r.receivedPaise,
      amountPaise: paise(28_61_600_00n),
    })
    expect(second.receivedPaise).toBe(BILL)
    expect(second.settles).toBe(true)
    expect(second.fit).toBe('exact')
  })
})

describe('a receipt larger than the bill', () => {
  const r = applyReceipt({
    netPayablePaise: BILL, alreadyReceivedPaise: paise(0n),
    amountPaise: paise(50_00_000_00n),
  })

  /* Allowed — the money genuinely arrived and refusing it leaves somebody
     unable to record it — but the excess is stated rather than absorbed,
     because it is almost always posted against the wrong bill. */
  it('states the excess instead of swallowing it', () => {
    expect(r.fit).toBe('over')
    expect(r.excessPaise).toBe(1_38_400_00n as Paise)
    expect(r.outstandingPaise).toBe(0n as Paise)
    expect(r.settles).toBe(true)
  })

  it('still records everything that arrived', () => {
    expect(r.receivedPaise).toBe(50_00_000_00n as Paise)
  })
})

describe('edge cases that would otherwise reopen a settled bill', () => {
  it('keeps an over-received bill settled on a further zero', () => {
    const r = applyReceipt({
      netPayablePaise: BILL,
      alreadyReceivedPaise: paise(50_00_000_00n),
      amountPaise: paise(0n),
    })
    expect(r.settles).toBe(true)
    expect(r.fit).toBe('over')
  })

  it('treats a bill of nothing as settled', () => {
    const r = applyReceipt({
      netPayablePaise: paise(0n), alreadyReceivedPaise: paise(0n),
      amountPaise: paise(0n),
    })
    expect(r.settles).toBe(true)
    expect(r.outstandingPaise).toBe(0n as Paise)
  })
})

describe('direction', () => {
  /* Deliberately not special-cased by account type. A receipt into a cash
     credit account reduces what is drawn, which is the same arithmetic — what
     must never happen is cash and credit being summed, and that is kept apart
     in openingBalance, not here. */
  it('signs by direction alone', () => {
    expect(signedAmount('in', paise(100n))).toBe(100n as Paise)
    expect(signedAmount('out', paise(100n))).toBe(-100n as Paise)
  })
})
