import { addDays, daysBetween, isoDate, type ISODate } from '../dates'
import { type Paise } from '../money'

/**
 * What we owe suppliers, and when it falls due.
 *
 * The mirror of `ageReceivables`, and the half the forecast was missing. It
 * projected every rupee coming in and almost nothing going out, which does not
 * make it half a forecast — it makes it an optimistic one.
 *
 * A supplier account is a running balance settled periodically, not a stack of
 * invoices paid one at a time. The Pooja Ceramic statement is the shape:
 * previous due, this bill, cash received, closing balance — and "SATURDAY
 * CLOSE" printed across it. So the settlement rule belongs to the supplier and
 * every unpaid bill's due date follows from it, rather than being typed one by
 * one and then being wrong.
 *
 * Pure. CLAUDE.md §5.
 */

export type TermsKind = 'on_demand' | 'days' | 'weekly' | 'monthly'

export interface PaymentTerms {
  kind: TermsKind
  /** Net N days, for `days`. */
  creditDays?: number | null
  /** 0 = Sunday … 6 = Saturday, for `weekly`. */
  settlementDow?: number | null
  /** 1–28, for `monthly`. */
  settlementDay?: number | null
}

export const DEFAULT_TERMS: PaymentTerms = { kind: 'on_demand' }

export const DOW_NAME = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const

/**
 * When a bill dated `billDate` falls due.
 *
 * `on_demand` is not a fallback, it is what nearly every account here really
 * is: the money is owed from the day it is billed and the timing is settled by
 * cash availability in conversation. Returning the bill date says the debt is
 * live now — which is right, and is why the whole balance counts in the
 * forecast at full value. What it does NOT say is that anybody broke an
 * agreement; that reading belongs to `AgedSupplier.agreed`.
 */
export function dueDateFor(billDate: ISODate, terms: PaymentTerms): ISODate {
  switch (terms.kind) {
    case 'days':
      return addDays(billDate, terms.creditDays ?? 0)

    case 'weekly': {
      const target = terms.settlementDow
      if (target === null || target === undefined) return billDate
      const dow = dayOfWeek(billDate)
      /* The NEXT settlement day, and a bill dated on one settles that day
         rather than waiting a week. */
      const ahead = (target - dow + 7) % 7
      return addDays(billDate, ahead)
    }

    case 'monthly': {
      const day = terms.settlementDay
      if (day === null || day === undefined) return billDate
      const [y, m, d] = billDate.split('-').map(Number) as [number, number, number]
      /* This month if the day has not passed, otherwise next. Capped at 28 by
         the CHECK constraint, so no month is short of it. */
      const thisMonth = isoDate(
        `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
      if (day >= d) return thisMonth
      const ny = m === 12 ? y + 1 : y
      const nm = m === 12 ? 1 : m + 1
      return isoDate(
        `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
    }

    case 'on_demand':
    default:
      return billDate
  }
}

/** 0 = Sunday … 6 = Saturday. UTC, because an ISODate carries no time. */
export function dayOfWeek(d: ISODate): number {
  return new Date(`${d}T00:00:00Z`).getUTCDay()
}

export function describeTerms(terms: PaymentTerms): string {
  switch (terms.kind) {
    case 'days':
      return terms.creditDays ? `${terms.creditDays} days` : 'on demand'
    case 'weekly':
      return terms.settlementDow === null || terms.settlementDow === undefined
        ? 'weekly'
        : `weekly, ${DOW_NAME[terms.settlementDow]}`
    case 'monthly':
      return terms.settlementDay ? `monthly, ${ordinalDay(terms.settlementDay)}` : 'monthly'
    default:
      return 'on demand'
  }
}

function ordinalDay(n: number): string {
  const teen = n % 100
  if (teen >= 11 && teen <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

// ---------------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------------

export interface Payable {
  supplierId: string
  supplierName: string
  terms: PaymentTerms
  billDate: ISODate
  amountPaise: Paise
}

export interface AgedSupplier {
  supplierId: string
  supplierName: string
  terms: PaymentTerms
  /**
   * Whether a due date was ever agreed with this supplier.
   *
   * Nearly always false, and that is the truth rather than missing data:
   * settlement here is by cash availability, discussed with the supplier. The
   * distinction decides a word — a balance past an agreed date is **overdue**,
   * a balance with no agreed date is **outstanding**. Printing "overdue"
   * against somebody who promised nothing asserts a broken promise that was
   * never made, and the first time it is checked against the shop the whole
   * column stops being believed.
   */
  agreed: boolean
  totalPaise: Paise
  /** Past its due date. Where nothing was agreed, this ages from the bill. */
  overduePaise: Paise
  /** The earliest due date still unpaid — when they will next ask. */
  nextDue: ISODate | null
  /** Days past due on the oldest overdue bill. Zero when nothing is overdue. */
  oldestOverdueDays: number
  count: number
}

const sum = (xs: Paise[]): Paise => xs.reduce((a, b) => (a + b) as Paise, 0n as Paise)

/**
 * Grouped by supplier, worst first.
 *
 * Sorted by what is past its date rather than by the total, because that is
 * the call to make: a ₹14 lakh running balance nobody is pressing for is an
 * ordinary account, while ₹40,000 owed since June is somebody who stops
 * supplying. Read `agreed` before choosing the word for it.
 */
export function agePayables(
  rows: Payable[], today: ISODate,
): AgedSupplier[] {
  const bySupplier = new Map<string, Payable[]>()
  for (const r of rows) {
    const list = bySupplier.get(r.supplierId)
    if (list) list.push(r)
    else bySupplier.set(r.supplierId, [r])
  }

  const out: AgedSupplier[] = []
  for (const [supplierId, list] of bySupplier) {
    const dated = list.map((r) => ({ ...r, due: dueDateFor(r.billDate, r.terms) }))
    const overdue = dated.filter((r) => r.due < today)
    const pending = dated.filter((r) => r.due >= today)

    out.push({
      supplierId,
      supplierName: list[0]!.supplierName,
      terms: list[0]!.terms,
      agreed: list[0]!.terms.kind !== 'on_demand',
      totalPaise: sum(dated.map((r) => r.amountPaise)),
      overduePaise: sum(overdue.map((r) => r.amountPaise)),
      nextDue: pending.length > 0
        ? pending.reduce((m, r) => (r.due < m ? r.due : m), pending[0]!.due)
        : null,
      oldestOverdueDays: overdue.length > 0
        ? Math.max(...overdue.map((r) => daysBetween(r.due, today)))
        : 0,
      count: dated.length,
    })
  }

  return out.sort((a, b) =>
    (b.overduePaise > a.overduePaise ? 1 : b.overduePaise < a.overduePaise ? -1 : 0) ||
    (b.totalPaise > a.totalPaise ? 1 : b.totalPaise < a.totalPaise ? -1 : 0))
}

/**
 * The difference between our books and the supplier's statement.
 *
 * Positive means they say we owe more than we have booked — usually a bill
 * nobody entered, occasionally one of theirs against the wrong account. It is
 * the single most useful number on a supplier screen and nothing else computes
 * it.
 */
export function statementGap(
  oursPaise: Paise, theirsPaise: Paise | null,
): Paise | null {
  if (theirsPaise === null) return null
  return (theirsPaise - oursPaise) as Paise
}
