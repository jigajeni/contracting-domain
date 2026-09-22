import { type Paise } from '../money'

/**
 * Site cash given to a supervisor, and what happens to it.
 *
 * The one error this module exists to prevent: **an advance is not an
 * expense.** It is cash that has moved from the bank to a person who still
 * owes it back. Booking it as a cost and then booking the vouchers it paid for
 * counts the same money twice — once when it left the bank and again when it
 * was spent — and every project the supervisor touched is overstated by the
 * whole advance. Nothing about the figures looks wrong afterwards, which is
 * what makes it dangerous.
 *
 * So an advance moves money and books no cost. Cost appears only as the
 * vouchers are entered against it, and those vouchers move no money, because
 * the cash left the bank when the advance was issued. Each rupee moves once
 * and is costed once.
 *
 *   amount           what was handed over
 *   settled          vouchers entered against it — this is the cost
 *   returned         unspent cash handed back into an account
 *   outstanding      amount − settled − returned: still in the holder's pocket
 *
 * Pure. CLAUDE.md §5.
 */

export type ImprestFit = 'open' | 'settled' | 'overspent'

export interface ImprestPosition {
  amountPaise: Paise
  settledPaise: Paise
  returnedPaise: Paise
  /** Still with the holder. Negative means they are out of pocket. */
  outstandingPaise: Paise
  /**
   * What the holder spent beyond the advance and is owed back. Zero unless
   * they overspent — which happens, and is a reimbursement the firm owes,
   * not an error to refuse.
   */
  overspentPaise: Paise
  fit: ImprestFit
  /** Nothing left with the holder and nothing owed to them. */
  canClose: boolean
}

export interface ImprestInput {
  amountPaise: Paise
  settledPaise: Paise
  returnedPaise: Paise
}

const ZERO = 0n as Paise

export function positionOf(a: ImprestInput): ImprestPosition {
  const remaining = (a.amountPaise - a.settledPaise - a.returnedPaise) as Paise
  const overspent = (remaining < 0n ? -remaining : 0n) as Paise

  return {
    amountPaise: a.amountPaise,
    settledPaise: a.settledPaise,
    returnedPaise: a.returnedPaise,
    outstandingPaise: remaining,
    overspentPaise: overspent,
    fit: remaining > 0n ? 'open' : remaining === 0n ? 'settled' : 'overspent',
    /* An overspent advance cannot be closed by itself: the firm owes the
       holder, and closing it would quietly drop that debt. It closes when the
       reimbursement is paid, which increases the advance. */
    canClose: remaining === 0n,
  }
}

export type SettleProblem =
  | { ok: true; position: ImprestPosition }
  | { ok: false; reason: string }

/**
 * A voucher entered against the advance.
 *
 * Overspending is allowed. A supervisor who put ₹2,000 of their own money into
 * a tipper repair has to be able to record it, and refusing the voucher just
 * moves the record off the system. What is refused is a *negative* voucher and
 * a settlement on a closed advance — the first is not a thing and the second
 * silently reopens a balance somebody has already signed off.
 */
export function canSettle(
  a: ImprestInput, amountPaise: Paise, isClosed: boolean,
): SettleProblem {
  if (amountPaise <= 0n) {
    return { ok: false, reason: 'A voucher of nothing is not a voucher.' }
  }
  if (isClosed) {
    return {
      ok: false,
      reason: 'This advance is closed. Reopen it, or issue a fresh advance — '
        + 'adding to a closed one changes a balance that has been signed off.',
    }
  }
  return {
    ok: true,
    position: positionOf({ ...a, settledPaise: (a.settledPaise + amountPaise) as Paise }),
  }
}

/**
 * Unspent cash handed back.
 *
 * Capped at what is actually outstanding. Handing back more than is left is
 * either a miscount or a settlement entered twice, and accepting it would put
 * money into the bank that the holder never had — a phantom receipt, which is
 * worse than a rejected entry because it balances.
 */
export function canReturn(a: ImprestInput, amountPaise: Paise): SettleProblem {
  if (amountPaise <= 0n) {
    return { ok: false, reason: 'A return of nothing is not a return.' }
  }
  const p = positionOf(a)
  if (p.outstandingPaise <= 0n) {
    return {
      ok: false,
      reason: p.fit === 'overspent'
        ? `Nothing is left to return — the holder is out of pocket by `
          + `${rupees(p.overspentPaise)} and is owed a reimbursement.`
        : 'Nothing is left to return. This advance is fully accounted for.',
    }
  }
  if (amountPaise > p.outstandingPaise) {
    return {
      ok: false,
      reason: `Only ${rupees(p.outstandingPaise)} is outstanding. Returning more `
        + `would put money in the bank the holder never had — check whether a `
        + `voucher has been entered twice.`,
    }
  }
  return {
    ok: true,
    position: positionOf({ ...a, returnedPaise: (a.returnedPaise + amountPaise) as Paise }),
  }
}

/** Plain rupees for an error message. Presentation proper uses formatINR. */
function rupees(p: Paise): string {
  return `₹${(Number(p) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}

/**
 * How long an advance has been open.
 *
 * Not a rule, a number. An advance outstanding for months is either forgotten
 * cash or a supervisor keeping a float, and both are worth seeing; which of
 * the two it is depends on the site and not on a threshold.
 */
export const STALE_ADVANCE_DAYS = 30
