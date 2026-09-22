import { ZERO, pctOf, type Paise } from '../money'
import { computeTds, type TdsInput, type TdsResult } from '../tax/tds194c'

/**
 * A subcontractor's running bill.
 *
 * The same cumulative arithmetic as a departmental RA bill, one level down:
 * gross value of all work done to date, less what has already been billed,
 * equals this bill. Deductions computed **cumulatively** and then netted the
 * same way, because a retention or an advance recovery worked out per bill
 * drifts from its own running total and nobody notices until the final bill.
 *
 * Where it differs from an RA bill is the direction and the stakes. This is
 * money going out to somebody who is usually smaller than us and whose next
 * week depends on it, and three of the rules below exist because getting them
 * wrong takes money off a person who cannot easily argue about it.
 *
 * Pure. CLAUDE.md §5.
 */

export interface OrderTerms {
  orderValuePaise: Paise
  /** Retention withheld from each bill, as a percentage of the work value. */
  retentionPct: string
  /** Paid up front, recovered from the bills. */
  advancePaise: Paise
  /** Recovered so far, across all previous bills. */
  advanceRecoveredPaise: Paise
  /**
   * How much of each bill goes to recovering the advance. Null recovers it
   * proportionally to progress, which is how a mobilisation advance behaves.
   */
  advanceRecoveryPct?: string | null
}

export interface BillInput {
  terms: OrderTerms
  /** Value of all work done under this order to date. */
  cumulativeValuePaise: Paise
  /** Value certified on all previous bills. */
  previousValuePaise: Paise
  /** Retention already withheld across previous bills. */
  previousRetentionPaise: Paise
  /** Cement, steel and the rest issued to them at cost and deducted back. */
  materialIssuedPaise: Paise
  /** Anything else withheld this bill, with a reason, already netted. */
  otherDeductionsPaise: Paise
  tds: Omit<TdsInput, 'grossPaise'>
  isFinal: boolean
}

export interface Deduction {
  code: 'retention' | 'advance_recovery' | 'material_issued' | 'tds_194c' | 'other'
  label: string
  amountPaise: Paise
  note?: string
}

export type ProblemKind = 'blocking' | 'warning'
export interface Problem { kind: ProblemKind; message: string }

export interface Bill {
  /** cumulative − previous. What this bill certifies. */
  grossPaise: Paise
  deductions: Deduction[]
  totalDeductionsPaise: Paise
  netPayablePaise: Paise
  tds: TdsResult
  /** Retention held across all bills including this one. */
  retentionHeldPaise: Paise
  /** Advance still outstanding after this bill. */
  advanceOutstandingPaise: Paise
  /** How far through the order value the cumulative figure is. */
  progressPct: number
  problems: Problem[]
}

const sum = (xs: Paise[]): Paise => xs.reduce((a, b) => (a + b) as Paise, ZERO)

export function computeBill(input: BillInput): Bill {
  const t = input.terms
  const gross = (input.cumulativeValuePaise - input.previousValuePaise) as Paise
  const problems: Problem[] = []

  if (input.cumulativeValuePaise < input.previousValuePaise) {
    problems.push({ kind: 'blocking',
      message: 'The cumulative value is below what has already been billed. '
        + 'A running bill is cumulative — this would be a negative bill.' })
  }

  /* Retention, computed on the CUMULATIVE value and then netted against what
     has already been held. Taking the percentage of this bill alone is the
     obvious implementation and it drifts: a rate that changes mid-order, or a
     single corrected bill, leaves the running total unable to be reconciled
     against the order. */
  const retentionToDate = pctOf(input.cumulativeValuePaise, t.retentionPct)
  const retention = (retentionToDate - input.previousRetentionPaise) as Paise

  /* Recovery, capped at what is actually outstanding. Recovering more than was
     advanced takes money that was never owed, and on a final bill a
     proportional rule will do exactly that if it is not stopped. */
  const advanceOutstandingBefore =
    (t.advancePaise - t.advanceRecoveredPaise) as Paise
  let recovery: Paise = ZERO
  if (advanceOutstandingBefore > ZERO) {
    const wanted = input.isFinal
      ? advanceOutstandingBefore
      : t.advanceRecoveryPct
        ? pctOf(gross, t.advanceRecoveryPct)
        /* Proportional to progress: the advance is recovered at the same pace
           the work is done, which is what a mobilisation advance is for. */
        : t.orderValuePaise > ZERO
          ? pctOf(gross, String(Number(t.advancePaise * 10000n / t.orderValuePaise) / 100))
          : ZERO
    recovery = (wanted > advanceOutstandingBefore
      ? advanceOutstandingBefore : wanted) as Paise
  }

  /* TDS on the work value, never on anything already deducted. The cost to us
     is the whole bill; the part that goes to the government instead of to them
     is this. CLAUDE.md §2E. */
  const tds = computeTds({ ...input.tds, grossPaise: gross })

  const deductions: Deduction[] = []
  if (retention !== ZERO) {
    deductions.push({ code: 'retention', label: 'Retention',
      amountPaise: retention,
      /* Number() so "5.0000" reads as "5". A percentage is stored at four
         decimal places and nobody writes it that way on an order. */
      note: `${Number(t.retentionPct)}% of the value to date, `
          + 'less what is already held' })
  }
  if (recovery > ZERO) {
    deductions.push({ code: 'advance_recovery', label: 'Advance recovered',
      amountPaise: recovery,
      note: input.isFinal ? 'The whole balance, because this is the final bill'
                          : 'Capped at what is still outstanding' })
  }
  if (input.materialIssuedPaise > ZERO) {
    deductions.push({ code: 'material_issued', label: 'Material issued at cost',
      amountPaise: input.materialIssuedPaise })
  }
  if (tds.tdsPaise > ZERO) {
    deductions.push({ code: 'tds_194c', label: 'Income tax 194C',
      amountPaise: tds.tdsPaise, note: tds.reason })
  }
  if (input.otherDeductionsPaise !== ZERO) {
    deductions.push({ code: 'other', label: 'Other deductions',
      amountPaise: input.otherDeductionsPaise })
  }

  const total = sum(deductions.map((d) => d.amountPaise))
  const net = (gross - total) as Paise

  if (net < ZERO) {
    problems.push({ kind: 'blocking',
      message: 'The deductions come to more than the bill. Recover less of the '
        + 'advance now and carry the rest — a negative bill cannot be paid, and '
        + 'a subcontractor who is handed one stops working.' })
  }

  const advanceOutstanding = (advanceOutstandingBefore - recovery) as Paise
  if (input.isFinal && advanceOutstanding > ZERO) {
    problems.push({ kind: 'warning',
      message: `${advanceOutstanding} paise of the advance is still outstanding `
        + 'on a final bill. After this there is nothing left to recover it from.' })
  }

  if (t.orderValuePaise > ZERO
      && input.cumulativeValuePaise > t.orderValuePaise) {
    const over = Number((input.cumulativeValuePaise - t.orderValuePaise)
      * 10000n / t.orderValuePaise) / 100
    problems.push({ kind: 'warning',
      message: `The work done is ${over.toFixed(1)}% above the order value. `
        + 'Either the order needs revising or this bill is measuring work '
        + 'nobody ordered.' })
  }

  if (input.isFinal && retentionToDate > ZERO) {
    problems.push({ kind: 'warning',
      message: 'Retention is still held after the final bill, which is correct '
        + '— it is released after the defect liability period, not with this. '
        + 'Make sure somebody is watching for that date.' })
  }

  const progressPct = t.orderValuePaise > ZERO
    ? Number(input.cumulativeValuePaise * 10000n / t.orderValuePaise) / 100
    : 0

  return {
    grossPaise: gross, deductions, totalDeductionsPaise: total,
    netPayablePaise: net, tds,
    retentionHeldPaise: retentionToDate,
    advanceOutstandingPaise: advanceOutstanding,
    progressPct, problems,
  }
}

export const blocking = (ps: Problem[]): Problem[] =>
  ps.filter((p) => p.kind === 'blocking')

/* ------------------------------------------------------------------ */
/* Whether we may sub-contract this at all                             */
/* ------------------------------------------------------------------ */

export type SubletVerdict = 'allowed' | 'prohibited' | 'registration_barred'

export interface SubletCheck {
  verdict: SubletVerdict
  allowed: boolean
  reason: string
}

/**
 * Whether a subcontract order may exist against this work.
 *
 * **A block, never a warning** — CLAUDE.md §13. ZP work orders commonly forbid
 * sub-contracting outright, and an Educated Unemployed Engineer registration
 * bars sub-letting absolutely: the penalty is suspension of three to six
 * months for a general contractor and **two years** on an EUE registration.
 *
 * A warning that can be clicked past is not a control. Somebody entering an
 * order at five o'clock will click past it, and the consequence lands on the
 * registration rather than on them.
 */
export function checkSublet(input: {
  subcontractingAllowed: boolean
  registrationSubletProhibited: boolean
  registrationCategory?: string | null
}): SubletCheck {
  if (input.registrationSubletProhibited) {
    const eue = input.registrationCategory === 'educated_unemployed_engineer'
    return {
      verdict: 'registration_barred', allowed: false,
      reason: 'The registration this work was taken on bars sub-letting '
        + `absolutely. ${eue ? 'On an Educated Unemployed Engineer '
          + 'registration the penalty is TWO YEARS of suspension.'
          : 'The penalty is suspension of three to six months.'}`,
    }
  }
  if (!input.subcontractingAllowed) {
    return {
      verdict: 'prohibited', allowed: false,
      reason: 'This work order forbids sub-contracting. Recording one here '
        + 'would be a record of breaching a printed condition.',
    }
  }
  return { verdict: 'allowed', allowed: true,
           reason: 'Sub-contracting is permitted on this work.' }
}
