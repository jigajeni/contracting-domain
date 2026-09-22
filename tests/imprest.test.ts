import { describe, expect, it } from 'vitest'
import { paise, type Paise } from '@/domain/money'
import { canReturn, canSettle, positionOf } from '@/domain/expense/imprest'

/** ₹50,000 handed to a site supervisor. */
const ADVANCE = paise(50_000_00n)
const fresh = {
  amountPaise: ADVANCE, settledPaise: paise(0n), returnedPaise: paise(0n),
}

describe('a fresh advance', () => {
  const p = positionOf(fresh)

  it('is entirely outstanding and costs nothing yet', () => {
    expect(p.outstandingPaise).toBe(ADVANCE)
    expect(p.settledPaise).toBe(0n as Paise)
    expect(p.fit).toBe('open')
  })

  /* The error this module exists to prevent. An advance is cash moved to
     somebody who still owes it back — booking it as a cost and then booking
     the vouchers it paid for counts the same money twice. */
  it('is not a cost', () => {
    expect(p.settledPaise).not.toBe(ADVANCE)
  })

  it('cannot be closed with money still in the holder\'s pocket', () => {
    expect(p.canClose).toBe(false)
  })
})

describe('vouchers coming in', () => {
  it('reduces what is outstanding by the voucher', () => {
    const r = canSettle(fresh, paise(18_400_00n), false)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.position.settledPaise).toBe(18_400_00n as Paise)
    expect(r.position.outstandingPaise).toBe(31_600_00n as Paise)
    expect(r.position.fit).toBe('open')
  })

  it('closes the advance when the vouchers exactly account for it', () => {
    const r = canSettle(
      { ...fresh, settledPaise: paise(40_000_00n) }, paise(10_000_00n), false)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.position.outstandingPaise).toBe(0n as Paise)
    expect(r.position.fit).toBe('settled')
    expect(r.position.canClose).toBe(true)
  })

  it('refuses a voucher of nothing', () => {
    const r = canSettle(fresh, paise(0n), false)
    expect(r.ok).toBe(false)
  })

  /* Adding to a closed advance changes a balance somebody has signed off.
     A fresh advance is the honest answer, not a quiet reopening. */
  it('refuses a voucher against a closed advance', () => {
    const r = canSettle(fresh, paise(1_000_00n), true)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/closed/i)
  })
})

describe('overspending', () => {
  /* Allowed on purpose. A supervisor who put ₹2,000 of their own money into a
     tipper repair has to be able to record it; refusing the voucher only moves
     the record off the system. */
  const r = canSettle(
    { ...fresh, settledPaise: paise(49_000_00n) }, paise(3_000_00n), false)

  it('accepts the voucher and says what is owed back', () => {
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.position.fit).toBe('overspent')
    expect(r.position.overspentPaise).toBe(2_000_00n as Paise)
    expect(r.position.outstandingPaise).toBe(-2_000_00n as Paise)
  })

  /* Closing an overspent advance would quietly drop a debt to an employee. */
  it('cannot be closed while the firm owes the holder', () => {
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.position.canClose).toBe(false)
  })

  it('has nothing left to return', () => {
    const back = canReturn(
      { ...fresh, settledPaise: paise(52_000_00n) }, paise(1_000_00n))
    expect(back.ok).toBe(false)
    if (back.ok) return
    expect(back.reason).toMatch(/out of pocket/i)
    expect(back.reason).toContain('2,000')
  })
})

describe('unspent cash handed back', () => {
  const partly = { ...fresh, settledPaise: paise(30_000_00n) }

  it('accounts for the advance when the rest comes back', () => {
    const r = canReturn(partly, paise(20_000_00n))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.position.returnedPaise).toBe(20_000_00n as Paise)
    expect(r.position.outstandingPaise).toBe(0n as Paise)
    expect(r.position.canClose).toBe(true)
    /* And the cost stays at the vouchers, not at the advance. */
    expect(r.position.settledPaise).toBe(30_000_00n as Paise)
  })

  /* A phantom receipt is worse than a rejected entry, because it balances. */
  it('refuses more than is outstanding, and says to look for a double entry', () => {
    const r = canReturn(partly, paise(25_000_00n))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('20,000')
    expect(r.reason).toMatch(/twice/i)
  })

  it('refuses a return on a fully accounted advance', () => {
    const r = canReturn({ ...fresh, settledPaise: ADVANCE }, paise(100_00n))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/fully accounted/i)
  })

  it('refuses a return of nothing', () => {
    expect(canReturn(partly, paise(0n)).ok).toBe(false)
  })
})

describe('the whole cycle', () => {
  /* ₹50,000 out, ₹31,600 of vouchers, ₹18,400 back. The cost booked is the
     vouchers and nothing else; the bank is down by zero at the end. */
  it('costs the vouchers and nothing else', () => {
    const settled = canSettle(fresh, paise(31_600_00n), false)
    expect(settled.ok).toBe(true)
    if (!settled.ok) return

    const back = canReturn({
      amountPaise: ADVANCE,
      settledPaise: settled.position.settledPaise,
      returnedPaise: paise(0n),
    }, paise(18_400_00n))
    expect(back.ok).toBe(true)
    if (!back.ok) return

    expect(back.position.settledPaise).toBe(31_600_00n as Paise)
    expect(back.position.returnedPaise).toBe(18_400_00n as Paise)
    expect(back.position.outstandingPaise).toBe(0n as Paise)
    expect(back.position.canClose).toBe(true)

    /* The invariant: out of the bank, minus back into the bank, equals cost. */
    expect(ADVANCE - back.position.returnedPaise).toBe(back.position.settledPaise)
  })
})
