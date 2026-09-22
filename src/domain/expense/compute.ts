import { pctOf, type Paise } from '../money'

/**
 * What an expense costs, and what leaves the bank.
 *
 * Not the same number, and that is the whole reason this is a module rather
 * than an addition in a form handler. A supplier bill of ₹1,00,000 plus 18%
 * GST with 1% TDS under 194C:
 *
 *   cost booked      ₹1,18,000   basic + GST
 *   paid to supplier ₹1,17,000   less the TDS withheld
 *   owed to govt     ₹1,000      the TDS, payable by the 7th
 *
 * TDS is not a discount. It is our cost either way — we simply pay part of it
 * to the government instead of to the supplier — so the cost booked against
 * the project includes it. Netting it out of the cost understates every
 * project's spend by the TDS rate, quietly and consistently.
 *
 * **TDS is computed on the basic amount, never on the GST.** Section 194C is
 * charged on the sum payable for the work, and where GST is shown separately
 * on the invoice it is excluded. Getting this wrong overstates the deduction
 * by the GST rate on the rate — on the figures above, ₹1,180 instead of
 * ₹1,000 — and the supplier notices immediately.
 *
 * Pure. CLAUDE.md §5.
 */

export interface ExpenseInput {
  basicPaise: Paise
  /** Rate as a string, e.g. "18.0000". Zero or absent for unregistered. */
  gstRatePct?: string | null
  /** An entered GST figure, which beats the rate — the invoice is the truth. */
  gstPaise?: Paise | null
  /** Rate as a string, e.g. "1.0000" or "2.0000" for 194C. */
  tdsRatePct?: string | null
  /** An entered TDS figure, which beats the rate. */
  tdsPaise?: Paise | null
}

export interface ComputedExpense {
  basicPaise: Paise
  gstPaise: Paise
  tdsPaise: Paise
  /** The cost booked against the project. Basic plus GST, TDS included. */
  totalPaise: Paise
  /** What the supplier is actually paid. */
  payablePaise: Paise
  /** True when either figure came off a rate rather than off the invoice. */
  estimated: boolean
}

const ZERO = 0n as Paise

export function computeExpense(input: ExpenseInput): ComputedExpense {
  const basic = input.basicPaise

  /* An entered figure wins. The invoice is the document that has to be
     reconciled against, and a supplier rounding GST their own way is their
     prerogative — the same principle as a department's deduction arithmetic
     beating the statutory rate. */
  const gstEntered = input.gstPaise !== null && input.gstPaise !== undefined
  const gst = gstEntered
    ? input.gstPaise!
    : input.gstRatePct ? pctOf(basic, input.gstRatePct) : ZERO

  const tdsEntered = input.tdsPaise !== null && input.tdsPaise !== undefined
  const tds = tdsEntered
    ? input.tdsPaise!
    /* On the basic, not on basic + GST. */
    : input.tdsRatePct ? pctOf(basic, input.tdsRatePct) : ZERO

  const total = (basic + gst) as Paise
  /* Clamped: a TDS larger than the invoice is a data error, and a negative
     payable reads as the supplier owing us. */
  const payable = (total > tds ? total - tds : 0n) as Paise

  return {
    basicPaise: basic,
    gstPaise: gst,
    tdsPaise: tds,
    totalPaise: total,
    payablePaise: payable,
    estimated: (!gstEntered && !!input.gstRatePct) || (!tdsEntered && !!input.tdsRatePct),
  }
}

/**
 * The TDS section that normally applies to a cost bucket.
 *
 * A suggestion for the form, never a decision: the rate that gets deducted is
 * whatever was actually deducted, and a company attracts 2% under 194C where
 * an individual attracts 1% — which is a fact about the payee, not about the
 * category. The Ankale bills have income tax deducted at 1% where the
 * statutory rate for a company is 2%, and CLAUDE.md §2 is explicit that the
 * department's figure wins. Same principle facing the other way.
 */
export const TDS_HINT: Record<string, { section: string; pct: string; note: string }> = {
  labour: { section: '194C', pct: '1.0000',
            note: 'Contract payment. 1% to an individual or HUF, 2% to a company.' },
  subcontract: { section: '194C', pct: '2.0000',
                 note: 'Contract payment. 2% where the subcontractor is a company.' },
  machinery: { section: '194I', pct: '2.0000',
               note: 'Rent of plant and machinery.' },
  transport: { section: '194C', pct: '1.0000',
               note: 'Nil where the transporter owns ten or fewer goods carriages '
                   + 'and gives a declaration with their PAN.' },
  office_overhead: { section: '194J', pct: '10.0000',
                     note: 'Professional or technical services.' },
  site_overhead: { section: '194C', pct: '1.0000',
                   note: 'Contract payment.' },
}
