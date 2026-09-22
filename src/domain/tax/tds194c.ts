import { paise, pctOf, ZERO, type Paise } from '../money'

/**
 * Section 194C — deduction at source on a works contract.
 *
 * One section, one implementation. It applies identically to a mukadam's
 * fortnightly settlement and to a piece-rate subcontractor's fourth running
 * bill, and the moment there are two copies of it the rate gets corrected in
 * one of them.
 *
 * Pure. CLAUDE.md §5.
 */

export type PayeeKind = 'individual' | 'company' | 'society'

/**
 * The rate depends on **who is paid**, not on what for: one per cent to an
 * individual or HUF, two per cent to anyone else, under the same section.
 */
export const TDS_PCT: Record<PayeeKind, string> = {
  individual: '1.0000',
  company: '2.0000',
  society: '2.0000',
}

/** Single payment, and financial-year aggregate, below which 194C does not bite. */
export const SINGLE_THRESHOLD = paise(30_000_00)
export const ANNUAL_THRESHOLD = paise(1_00_000_00)

/** No PAN, no ordinary rate — section 206AA. */
export const NO_PAN_PCT = '20.0000'

export interface TdsInput {
  /** The amount before GST. TDS is never charged on the tax. */
  grossPaise: Paise
  payeeKind: PayeeKind
  hasPan: boolean
  /** Already paid to this party this financial year, excluding this payment. */
  paidThisFyPaise: Paise
  /** An entered figure. Beats every rule below. */
  enteredPaise?: Paise | null
}

export interface TdsResult {
  tdsPaise: Paise
  ratePct: string | null
  /** Why it is what it is, in the words shown on the screen. */
  reason: string
  entered: boolean
}

/**
 * What to deduct.
 *
 * Two rules here are worth more than the arithmetic. **The thresholds are
 * crossed by the year, not by the payment** — somebody paid nine thousand a
 * fortnight never trips the single-payment limit and trips the annual one in
 * August, after which every payment is deductible. Reading the payment alone
 * under-deducts all year and the shortfall surfaces at the return. The
 * aggregate is measured over the FINANCIAL year, April to March — CLAUDE.md
 * §0.3 — never a rolling twelve months and never a calendar year.
 *
 * And **no PAN means twenty per cent**, not the ordinary rate. That is section
 * 206AA and it is the most expensive line on any of these screens: worth
 * getting the PAN before the first payment, not after the fourth.
 */
export function computeTds(input: TdsInput): TdsResult {
  if (input.enteredPaise !== null && input.enteredPaise !== undefined) {
    return { tdsPaise: input.enteredPaise, ratePct: null, entered: true,
      reason: 'Entered, so the figure stands whatever the rule says.' }
  }

  const aggregate = (input.paidThisFyPaise + input.grossPaise) as Paise
  const overSingle = input.grossPaise > SINGLE_THRESHOLD
  const overAnnual = aggregate > ANNUAL_THRESHOLD

  if (!overSingle && !overAnnual) {
    return { tdsPaise: ZERO, ratePct: null, entered: false,
      reason: 'Under both 194C thresholds — ₹30,000 on one payment and '
        + '₹1,00,000 across the year — so nothing is deducted yet.' }
  }

  if (!input.hasPan) {
    return { tdsPaise: pctOf(input.grossPaise, NO_PAN_PCT), ratePct: NO_PAN_PCT,
      entered: false,
      reason: 'No PAN on file, so section 206AA applies at 20% instead of the '
        + 'ordinary rate. Get the PAN — this is the most expensive line here.' }
  }

  const pct = TDS_PCT[input.payeeKind]
  return { tdsPaise: pctOf(input.grossPaise, pct), ratePct: pct, entered: false,
    reason: overSingle
      ? `Over ₹30,000 on this payment, so 194C applies at ${pct}%.`
      : `The year's payments have crossed ₹1,00,000, so 194C applies at ${pct}%.` }
}
