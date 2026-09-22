import { daysBetween, todayIST, type ISODate } from '../dates'
import { type Paise } from '../money'
import type { Confidence } from './forecast'

/**
 * The weekly review of expected dates.
 *
 * The forecast reads `expected_inflows`. Nothing else writes to that table, so
 * the thirteen-week screen is a direct function of what somebody last typed
 * here. PLAN.md puts it plainly: *the forecast is only as honest as this
 * screen*.
 *
 * Which makes the job of this module not "list the bills" but **say how much
 * of the forecast is currently a lie**, in four states:
 *
 *   `missing`  — money owed with no expected date at all. Worse than a wrong
 *                date, because it is not in the forecast in any form. The
 *                aging table shows it; the thirteen weeks do not.
 *   `overdue`  — the expected date has passed and the money has not arrived.
 *                Actively wrong: `buildForecast` sweeps a past-dated inflow
 *                into week one, so every one of these is claiming cash lands
 *                this week.
 *   `stale`    — a future date nobody has looked at in over a week.
 *   `current`  — reviewed inside the window.
 *
 * Pure. No database, no clock beyond what is passed in — CLAUDE.md §5.
 */

export type ReviewState = 'missing' | 'overdue' | 'stale' | 'current'

/**
 * How long an expected date stays trustworthy.
 *
 * Seven days because the review is weekly. It is not a claim that a date goes
 * wrong after a week — it is that nobody has checked, and an unchecked date on
 * a government bill drifts in one direction only.
 */
export const STALE_AFTER_DAYS = 7

export interface ReviewLine {
  /** Stable key for the row: the bill where there is one, else the inflow. */
  key: string
  billId: string | null
  inflowId: string | null
  source: string
  clientName: string | null
  projectCode: string | null
  projectName: string | null
  /** "3rd RA", "Final bill", or what the inflow is for. */
  label: string
  /**
   * The department's figure: still owed on the bill, or the amount of a
   * non-bill inflow. What the paperwork says, and what the row shows.
   */
  outstandingPaise: Paise
  /**
   * What would actually reach the bank — the same figure on ordinary work,
   * and net of commission on an inward arrangement.
   *
   * Every total is built from this one, so the review and the forecast cannot
   * report two different amounts owed. The row still shows the department's
   * figure, because that is what somebody holding the bill will look for.
   */
  cashPaise: Paise
  /** When the clock started — submission, for a bill. */
  since: ISODate | null
  stage: string | null
  expectedDate: ISODate | null
  confidence: Confidence | null
  notes: string | null
  reviewedOn: ISODate | null
  /**
   * Set when the work is executed under somebody else's name or by somebody
   * else — CLAUDE.md §2A.
   *
   * The amount on the line stays the DEPARTMENT's figure, because that is what
   * the bill says and what somebody comparing against paperwork will look for.
   * What the arrangement does to the cash is carried beside it: who actually
   * pays, what reaches the bank, and what goes straight back out. The forecast
   * uses the netted figures; the review screen shows both, so a reviewer
   * setting a date can see which number is which.
   */
  arrangement: {
    model: 'executed_for_other' | 'executed_by_other'
    counterparty: string | null
    commissionPct: string | null
    /** What reaches our bank against this line. */
    netInflowPaise: Paise
    /** Passed straight back out the same day. Zero unless outward. */
    passThroughPaise: Paise
    commissionPaise: Paise
    payer: 'department' | 'counterparty'
    /** The commission was computed from the rate, not settled. */
    estimated: boolean
    /** Why nothing could be netted. The line then stands at face value. */
    unresolved: string | null
  } | null
}

export interface ReviewedLine extends ReviewLine {
  state: ReviewState
  /** Days outstanding. Null when there is no honest start date. */
  ageDays: number | null
  daysSinceReview: number | null
  /** Days past the expected date. Zero unless overdue. */
  slipDays: number
}

export interface ReviewSummary {
  totalPaise: Paise
  /** Carrying an expected date, so visible to the forecast at all. */
  forecastPaise: Paise
  missingPaise: Paise
  overduePaise: Paise
  stalePaise: Paise
  counts: Record<ReviewState, number>
  /** Share of outstanding money the forecast can see, 0–100, rounded. */
  coveragePct: number
  /** Lines needing an answer: everything but `current`. */
  outstandingCount: number
}

export function classify(line: ReviewLine, today: ISODate = todayIST()): ReviewState {
  if (!line.expectedDate) return 'missing'
  /* Overdue outranks stale. A date reviewed yesterday that has already passed
     is not fresh — it is a date the department missed, and the fact that
     somebody looked recently does not make the forecast right. */
  if (line.expectedDate < today) return 'overdue'
  if (!line.reviewedOn) return 'stale'
  return daysBetween(line.reviewedOn, today) > STALE_AFTER_DAYS ? 'stale' : 'current'
}

/** Order the screen is worked in: worst money first, biggest money first. */
const RANK: Record<ReviewState, number> = {
  overdue: 0, missing: 1, stale: 2, current: 3,
}

export function reviewQueue(
  lines: ReviewLine[], today: ISODate = todayIST(),
): ReviewedLine[] {
  return lines
    .map((l) => {
      const state = classify(l, today)
      return {
        ...l,
        state,
        ageDays: l.since ? daysBetween(l.since, today) : null,
        daysSinceReview: l.reviewedOn ? daysBetween(l.reviewedOn, today) : null,
        slipDays: state === 'overdue' && l.expectedDate
          ? daysBetween(l.expectedDate, today) : 0,
      }
    })
    .sort((a, b) =>
      RANK[a.state] - RANK[b.state] ||
      (b.cashPaise > a.cashPaise ? 1 : b.cashPaise < a.cashPaise ? -1 : 0))
}

const sum = (xs: ReviewedLine[]): Paise =>
  xs.reduce((s, l) => (s + l.cashPaise) as Paise, 0n as Paise)

export function summarise(lines: ReviewedLine[]): ReviewSummary {
  const of = (s: ReviewState) => lines.filter((l) => l.state === s)
  const total = sum(lines)
  const missing = sum(of('missing'))
  /* Coverage is by money, not by count. Twenty small bills with dates and one
     crore-rupee bill without is not ninety-five per cent covered. */
  const forecast = (total - missing) as Paise

  return {
    totalPaise: total,
    forecastPaise: forecast,
    missingPaise: missing,
    overduePaise: sum(of('overdue')),
    stalePaise: sum(of('stale')),
    counts: {
      missing: of('missing').length,
      overdue: of('overdue').length,
      stale: of('stale').length,
      current: of('current').length,
    },
    coveragePct: total === 0n
      ? 100
      : Number((forecast * 100n) / total),
    outstandingCount: lines.filter((l) => l.state !== 'current').length,
  }
}
