import { addDays, daysBetween, type ISODate } from '../dates'
import { type Paise } from '../money'

/**
 * The thirteen-week rolling forecast.
 *
 * The screen Phase 3 exists for: opening balance, what is expected in, what is
 * committed out, and the projected closing balance each week — with the week
 * it goes negative marked, because that is the week somebody has to do
 * something about.
 *
 * Two numbers per week, side by side and never merged.
 *
 *   **Raw** takes every expected inflow at face value.
 *   **Weighted** discounts each by how likely it is to arrive.
 *
 * Keeping both visible is the whole discipline. A single blended figure reads
 * as a fact, and the expected dates on government bills are guesses — an
 * optimistic one produces a forecast that is confidently wrong, which is worse
 * than an obviously uncertain one. PLAN.md is explicit: the forecast is only as
 * honest as the screen where those dates get reviewed.
 *
 * Pure — no database, no clock beyond what is passed in. CLAUDE.md §5.
 */

export type Confidence = 'high' | 'medium' | 'low'

/**
 * What a confidence level is worth.
 *
 * Not a probability anybody measured — a deliberate haircut. `high` is not 1.0
 * because a bill that has passed and is at treasury still slips; `low` is not 0
 * because "unlikely this quarter" is not "never". Whether these hold is exactly
 * what the four-week exit criterion tests.
 */
export const WEIGHT: Record<Confidence, number> = {
  high: 0.9,
  medium: 0.6,
  low: 0.25,
}

export interface Flow {
  /** When it is expected to land or be paid. */
  date: ISODate
  amountPaise: Paise
  /**
   * How likely it is. Set on every inflow.
   *
   * On an OUTFLOW it is normally absent, and that is the rule: a payment you
   * owe is not a guess, so it is never discounted. The one exception is a
   * pass-through on a work executed by another contractor — we pay the
   * executor out of what the department pays us, so if the receipt slips the
   * payment slips with it. Such a flow carries the confidence of the receipt
   * it mirrors, and the two then move together. Discounting the inflow while
   * holding the outflow at full value was showing a week ₹12 lakh worse than
   * either outcome can actually be.
   */
  confidence?: Confidence
  label?: string
}

export interface ForecastInput {
  /** Money in the bank on `from`, across every account in scope. */
  openingPaise: Paise
  from: ISODate
  inflows: Flow[]
  /** Committed: EMIs, salaries, statutory dues, known payments. */
  outflows: Flow[]
  weeks?: number
}

export interface Week {
  index: number
  start: ISODate
  end: ISODate
  inPaise: Paise
  outPaise: Paise
  /** Inflows discounted by confidence. */
  weightedInPaise: Paise
  /**
   * Outflows, discounted only where one carries a confidence of its own — a
   * pass-through that cannot happen unless its receipt does. Equal to
   * `outPaise` everywhere else.
   */
  weightedOutPaise: Paise
  openingPaise: Paise
  closingPaise: Paise
  weightedClosingPaise: Paise
  /** True when the raw projection goes below zero. */
  short: boolean
  /** True when only the weighted projection does — a warning, not a fact. */
  shortIfOptimistic: boolean
}

export interface Forecast {
  from: ISODate
  weeks: Week[]
  /** The first week the raw projection goes negative, or null. */
  firstShortWeek: number | null
  /** The same for the weighted projection. Usually earlier. */
  firstWeightedShortWeek: number | null
  totalInPaise: Paise
  totalOutPaise: Paise
}

export const DEFAULT_WEEKS = 13

const sum = (xs: Paise[]): Paise => xs.reduce((a, b) => (a + b) as Paise, 0n as Paise)

/**
 * Apply a confidence weight without floating-point money.
 *
 * The weight is scaled to an integer and the division is done on bigints, so
 * ₹1,23,456.78 at 0.6 is exact rather than 0.6000000000000001 of it.
 */
function weigh(amount: Paise, confidence: Confidence | undefined): Paise {
  const w = WEIGHT[confidence ?? 'medium']
  const scaled = BigInt(Math.round(w * 1000))
  return ((amount * scaled) / 1000n) as Paise
}

export function buildForecast(input: ForecastInput): Forecast {
  const weeks = input.weeks ?? DEFAULT_WEEKS
  const out: Week[] = []

  let opening = input.openingPaise
  let weightedOpening = input.openingPaise

  for (let i = 0; i < weeks; i++) {
    const start = addDays(input.from, i * 7)
    const end = addDays(start, 6)

    /* A flow before the window starts belongs to the first week rather than
       nowhere: an inflow that was expected last Tuesday and has not arrived is
       still owed, and dropping it silently flatters the forecast. */
    const inWeek = (f: Flow) => {
      if (i === 0) return f.date <= end
      return f.date >= start && f.date <= end
    }

    const ins = input.inflows.filter(inWeek)
    const outs = input.outflows.filter(inWeek)

    const inPaise = sum(ins.map((f) => f.amountPaise))
    const outPaise = sum(outs.map((f) => f.amountPaise))
    const weightedIn = sum(ins.map((f) => weigh(f.amountPaise, f.confidence)))
    /* Only a flow that explicitly says how likely it is gets discounted. An
       ordinary committed payment has no confidence and passes through at full
       value, which is the invariant. */
    const weightedOut = sum(outs.map((f) =>
      f.confidence ? weigh(f.amountPaise, f.confidence) : f.amountPaise))

    const closing = (opening + inPaise - outPaise) as Paise
    const weightedClosing = (weightedOpening + weightedIn - weightedOut) as Paise

    out.push({
      index: i,
      start, end,
      inPaise, outPaise,
      weightedInPaise: weightedIn,
      weightedOutPaise: weightedOut,
      openingPaise: opening,
      closingPaise: closing,
      weightedClosingPaise: weightedClosing,
      short: closing < 0n,
      shortIfOptimistic: closing >= 0n && weightedClosing < 0n,
    })

    opening = closing
    weightedOpening = weightedClosing
  }

  const firstShort = out.find((w) => w.short)
  const firstWeighted = out.find((w) => w.weightedClosingPaise < 0n)

  return {
    from: input.from,
    weeks: out,
    firstShortWeek: firstShort ? firstShort.index : null,
    firstWeightedShortWeek: firstWeighted ? firstWeighted.index : null,
    totalInPaise: sum(out.map((w) => w.inPaise)),
    totalOutPaise: sum(out.map((w) => w.outPaise)),
  }
}

// ---------------------------------------------------------------------------
// Receivables aging
// ---------------------------------------------------------------------------

/**
 * Buckets chosen for how a government bill actually ages, not the textbook
 * 30/60/90. Under a fortnight is a bill in motion; past ninety days somebody
 * has to go and sit in the office.
 */
export const AGE_BUCKETS = [
  { key: '0-15', label: 'Under a fortnight', upto: 15 },
  { key: '16-30', label: '16 to 30 days', upto: 30 },
  { key: '31-60', label: '31 to 60 days', upto: 60 },
  { key: '61-90', label: '61 to 90 days', upto: 90 },
  { key: '90+', label: 'Over 90 days', upto: Infinity },
] as const

export type BucketKey = (typeof AGE_BUCKETS)[number]['key']

export interface Receivable {
  clientName: string
  /** The day the clock started — when the bill was submitted. */
  since: ISODate
  amountPaise: Paise
}

export interface AgedClient {
  clientName: string
  totalPaise: Paise
  /** Oldest first — the number anybody actually quotes. */
  oldestDays: number
  buckets: Record<BucketKey, Paise>
  count: number
}

export function bucketFor(days: number): BucketKey {
  for (const b of AGE_BUCKETS) if (days <= b.upto) return b.key
  return '90+'
}

/** Who owes what, oldest first — the question the Owner asks on a Monday. */
export function ageReceivables(
  rows: Receivable[], today: ISODate,
): AgedClient[] {
  const byClient = new Map<string, AgedClient>()

  for (const r of rows) {
    const days = Math.max(0, daysBetween(r.since, today))
    const existing = byClient.get(r.clientName) ?? {
      clientName: r.clientName,
      totalPaise: 0n as Paise,
      oldestDays: 0,
      count: 0,
      buckets: Object.fromEntries(
        AGE_BUCKETS.map((b) => [b.key, 0n as Paise]),
      ) as Record<BucketKey, Paise>,
    }

    const key = bucketFor(days)
    existing.buckets[key] = (existing.buckets[key] + r.amountPaise) as Paise
    existing.totalPaise = (existing.totalPaise + r.amountPaise) as Paise
    existing.oldestDays = Math.max(existing.oldestDays, days)
    existing.count += 1
    byClient.set(r.clientName, existing)
  }

  /* Sorted by what is owed, not by age. A ₹1.4 crore bill sixty days old is
     the call to make before a ₹40,000 one at ninety. */
  return [...byClient.values()].sort((a, b) =>
    Number(b.totalPaise - a.totalPaise))
}
