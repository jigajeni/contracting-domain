import { pctOf, type Paise } from '../money'

/**
 * What an execution arrangement does to the cash.
 *
 * `project_economics` already gets the *revenue* right — CLAUDE.md §2A and
 * migration 0007. The forecast did not, and the two errors run in opposite
 * directions:
 *
 *   **Inward** (`executed_for_other`) — their contract, our execution. The
 *   department pays *them*, and they pass it on less the agreed percentage. So
 *   the money is smaller than the bill and arrives from the counterparty, not
 *   from the department. Counting the bill at face value against the
 *   department overstates the week and points the chase at the wrong office.
 *
 *   **Outward** (`executed_by_other`) — our contract, their execution. The
 *   whole bill does arrive from the department, so the inflow was right; what
 *   was missing is that all of it bar our percentage goes straight back out.
 *   A forecast that books the inflow and not the payment out is the more
 *   dangerous of the two, because it looks like cash we can spend.
 *
 * Pure — no database, no clock. CLAUDE.md §5.
 *
 * Two assumptions, both stated rather than hidden:
 *
 *   The pass-through on an outward work is dated the **same day** the money
 *   arrives. In practice the executor is paid a little later. Same-day is the
 *   conservative choice — it never shows cash in hand that is already spoken
 *   for — and inventing a lag would be a guess dressed as a figure.
 *
 *   Commission is charged on the **work value**, not on GST. GST is collected
 *   for the government and passed on; nobody takes a percentage of it. That is
 *   what the seeded settlements do (4% of ₹41.2 L gross, not of the ₹48.6 L
 *   bill) and what `commission_basis = 'gross_bill'` means.
 */

export type ExecutionModel = 'own' | 'executed_for_other' | 'executed_by_other'
export type CommissionBasis = 'work_value' | 'gross_bill' | 'net_received' | 'fixed'

export interface ArrangementTerms {
  model: ExecutionModel
  counterpartyName: string | null
  /** numeric(7,4) as a string, e.g. "4.0000". */
  commissionPct: string | null
  commissionFixedPaise: Paise | null
  basis: CommissionBasis | null
}

export interface ArrangementInput {
  /** The department's figure for this bill: net payable, GST included. */
  netPayablePaise: Paise
  /** This bill's work value before GST — what a percentage is charged on. */
  grossPaise: Paise
  /**
   * The figure settled in `project_commissions` against THIS bill, where one
   * exists. It wins over the percentage, for the same reason a department's
   * deduction wins over the statutory rate: a 4% understanding gets
   * renegotiated, and our books must match what was actually agreed.
   */
  agreedCommissionPaise: Paise | null
  terms: ArrangementTerms
}

export interface Netted {
  /** What actually reaches the bank against this bill. */
  inflowPaise: Paise
  payer: 'department' | 'counterparty'
  /** Paid straight back out on the same day. Zero on anything but outward. */
  outflowPaise: Paise
  commissionPaise: Paise
  /** True when the commission was computed from the rate rather than agreed. */
  estimated: boolean
  /**
   * Why nothing could be netted, when that is the case. The bill then stands
   * at face value and the screen says so — a wrong number nobody is warned
   * about is worse than a right one nobody netted.
   */
  unresolved: string | null
}

const ZERO = 0n as Paise

const passthrough = (net: Paise): Netted => ({
  inflowPaise: net,
  payer: 'department',
  outflowPaise: ZERO,
  commissionPaise: ZERO,
  estimated: false,
  unresolved: null,
})

/**
 * The commission on one bill, or a reason there isn't one.
 *
 * Three of the four bases collapse to "a percentage of this bill" once you are
 * forecasting per bill rather than reporting per project:
 *
 *   `gross_bill`   a percentage of this bill's work value — literally that.
 *   `work_value`   a percentage of the contract value. Allocated across bills
 *                  in proportion to each bill's work value, which is the same
 *                  number, and totals correctly over the life of the work.
 *   `net_received` a percentage of what is actually received, so of the net
 *                  payable rather than the work value. The one that differs.
 *
 * `fixed` does not. A flat sum agreed for the whole work has no honest per-bill
 * share — charging it against every bill triples it on a three-bill project,
 * and picking one bill to carry it is a guess. It is left unresolved until
 * somebody records the settlement against the bill it belongs to.
 */
function commissionFor(input: ArrangementInput): { paise: Paise; estimated: boolean }
  | { unresolved: string } {
  const { terms } = input

  if (input.agreedCommissionPaise !== null) {
    return { paise: input.agreedCommissionPaise, estimated: false }
  }

  if (terms.basis === 'fixed' || (!terms.commissionPct && terms.commissionFixedPaise)) {
    return {
      unresolved: 'A fixed commission is agreed for the whole work, so it has no '
        + 'per-bill share. Record the settlement against the bill it is paid on.',
    }
  }

  if (!terms.commissionPct || Number(terms.commissionPct) === 0) {
    return { unresolved: 'No commission rate is recorded against this work.' }
  }

  const base = terms.basis === 'net_received' ? input.netPayablePaise : input.grossPaise
  return { paise: pctOf(base, terms.commissionPct), estimated: true }
}

export function netArrangement(input: ArrangementInput): Netted {
  const { terms, netPayablePaise: net } = input
  if (terms.model === 'own') return passthrough(net)

  const c = commissionFor(input)
  if ('unresolved' in c) {
    return {
      ...passthrough(net),
      /* The payer is still wrong on an inward work even when the amount cannot
         be netted, and saying so costs nothing. */
      payer: terms.model === 'executed_for_other' ? 'counterparty' : 'department',
      unresolved: c.unresolved,
    }
  }

  /* A commission larger than the bill is a data error — a rate entered as 40
     rather than 4, or an agreed figure typed against the wrong bill. Clamped
     so the forecast never shows a negative receipt, and flagged rather than
     silently absorbed. */
  const overrun = c.paise > net
  const commission = (overrun ? net : c.paise) as Paise

  if (terms.model === 'executed_for_other') {
    return {
      inflowPaise: (net - commission) as Paise,
      payer: 'counterparty',
      outflowPaise: ZERO,
      commissionPaise: commission,
      estimated: c.estimated,
      unresolved: overrun
        ? 'The commission recorded is larger than the bill. Check the rate or the settlement.'
        : null,
    }
  }

  return {
    inflowPaise: net,
    payer: 'department',
    outflowPaise: (net - commission) as Paise,
    commissionPaise: commission,
    estimated: c.estimated,
    unresolved: overrun
      ? 'The commission recorded is larger than the bill. Check the rate or the settlement.'
      : null,
  }
}

/** Who the money is actually chased from. */
export function payerName(n: Netted, terms: ArrangementTerms, department: string | null): string {
  return n.payer === 'counterparty'
    ? terms.counterpartyName ?? 'the contract holder'
    : department ?? 'the department'
}
