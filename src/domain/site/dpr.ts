import { daysBetween, type ISODate } from '../dates'
import { paise, ZERO, type Paise } from '../money'
import type { Attribution } from '../works/delay'

/**
 * The daily progress report, and the two things it is actually for.
 *
 * It looks like a diary and it is not one. Every DPR is evidence for something
 * that gets argued about months later:
 *
 *  - **Man-days.** A mukadam is engaged by the firm, not by a project, and is
 *    paid in one periodic settlement covering several sites. The only honest
 *    way to split that payment across works is the headcounts recorded each
 *    day — CLAUDE.md §8.7. A day nobody filled in is a day whose labour cost
 *    gets allocated by guesswork, and guesswork always favours whichever site
 *    somebody happens to be looking at.
 *
 *  - **Days lost.** A washed-out day is a day of liquidated damages unless it
 *    is in the delay register with a date and a cause. The rain that stopped
 *    work in July is not provable in November. So a report of a stopped day
 *    offers the delay entry at the moment the fact is fresh, rather than
 *    leaving it to be reconstructed when the extension is being drafted.
 *
 * Pure. CLAUDE.md §5.
 */

export type Weather =
  | 'clear' | 'cloudy' | 'light_rain' | 'heavy_rain' | 'extreme_heat' | 'other'

/**
 * How far back a report may be entered.
 *
 * Not a bureaucratic limit — a limit on memory. Headcounts a fortnight old are
 * recalled, not observed, and a recalled headcount is what a labour allocation
 * ends up resting on. Beyond this the report is still accepted, because a late
 * record beats none, but it is marked so nobody later mistakes it for a
 * contemporaneous one.
 */
export const BACKDATE_LIMIT_DAYS = 7

export type DateVerdict =
  | 'today'
  /** Yesterday to the limit. Ordinary — site reports at the end of the day. */
  | 'backdated'
  /** Past the limit. Accepted, but recorded as entered late. */
  | 'late'
  /** Refused. */
  | 'future'
  | 'before_start'

export interface DateCheck {
  verdict: DateVerdict
  daysLate: number
  accepted: boolean
  message: string | null
}

export function checkDate(
  reportDate: ISODate,
  today: ISODate,
  workStart: ISODate | null = null,
): DateCheck {
  if (reportDate > today) {
    return { verdict: 'future', daysLate: 0, accepted: false,
      message: 'A report cannot be filed for a day that has not happened.' }
  }
  if (workStart && reportDate < workStart) {
    return { verdict: 'before_start', daysLate: 0, accepted: false,
      message: `Work on this site started on ${workStart}. `
        + 'There is nothing to report before then.' }
  }
  const daysLate = daysBetween(reportDate, today)
  if (daysLate === 0) {
    return { verdict: 'today', daysLate, accepted: true, message: null }
  }
  if (daysLate <= BACKDATE_LIMIT_DAYS) {
    return { verdict: 'backdated', daysLate, accepted: true, message: null }
  }
  return { verdict: 'late', daysLate, accepted: true,
    message: `This is ${daysLate} days old. It will be saved and marked as `
      + 'entered late — headcounts this far back are remembered, not counted.' }
}

/* ------------------------------------------------------------------ */
/* Labour                                                              */
/* ------------------------------------------------------------------ */

export interface LabourLine {
  /** The mukadam or society supplying the gang. Null where nobody is named. */
  partyId: string | null
  trade: string
  headcount: number
  /** Agreed per-head daily wage. Zero where the rate is settled later. */
  wageRatePaise: Paise
}

/** Headcount × rate, per line. The stored `amount_paise`. */
export const lineAmount = (l: LabourLine): Paise =>
  paise(BigInt(Math.max(0, Math.trunc(l.headcount))) * l.wageRatePaise)

export const totalHeadcount = (lines: LabourLine[]): number =>
  lines.reduce((n, l) => n + Math.max(0, Math.trunc(l.headcount)), 0)

export const totalLabourCost = (lines: LabourLine[]): Paise =>
  lines.reduce((a, l) => (a + lineAmount(l)) as Paise, ZERO)

/**
 * Man-days by supplier for one day.
 *
 * The unit the periodic settlement is split by. Lines with no party named are
 * excluded rather than pooled under a blank key: an unattributed man-day
 * cannot be allocated to anyone's bill, and carrying it as if it could is how
 * a split silently stops summing to what was paid.
 */
export function manDaysByParty(lines: LabourLine[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const l of lines) {
    if (!l.partyId) continue
    const n = Math.max(0, Math.trunc(l.headcount))
    if (n === 0) continue
    out.set(l.partyId, (out.get(l.partyId) ?? 0) + n)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Machinery                                                           */
/* ------------------------------------------------------------------ */

/** Litres × rate. Litres are numeric(10,2), so they arrive as a string. */
export function dieselAmount(litres: string | number, ratePaise: Paise): Paise {
  const hundredths = BigInt(Math.round(Number(litres) * 100))
  const v = (hundredths * ratePaise + 50n) / 100n
  return paise(v)
}

/* ------------------------------------------------------------------ */
/* The stopped day                                                     */
/* ------------------------------------------------------------------ */

export interface DprInput {
  reportDate: ISODate
  weather: Weather | null
  workDoneSummary: string
  labour: LabourLine[]
  /** An issue raised on the same report, if any. */
  issueTitle?: string | null
}

/** Nobody on site and nothing written down. */
export const isStopped = (d: DprInput): boolean =>
  totalHeadcount(d.labour) === 0 && d.workDoneSummary.trim().length === 0

/**
 * Weather that stops work, and how a department reads it.
 *
 * `neutral` — neither side caused it, and the contract forgives it. This is
 * the attribution that makes a rain day claimable, which is the entire reason
 * the weather field is worth filling in.
 */
/**
 * Weather that stops work, and how a department reads it.
 *
 * `neutral` — neither side caused it, and the contract forgives it. This is
 * the attribution that makes a rain day claimable, which is the entire reason
 * the weather field is worth filling in.
 */
const STOPPING_WEATHER: Partial<Record<Weather, { cause: DelayCause; title: string }>> = {
  heavy_rain: { cause: 'rain_monsoon', title: 'Continuous rainfall — work suspended' },
  extreme_heat: { cause: 'other', title: 'Extreme heat — work suspended' },
}

/** The `delay_cause` enum. Free text is the title; this is what it files under. */
export type DelayCause =
  | 'land_not_handed_over' | 'drawings_not_received' | 'dept_approval_pending'
  | 'funds_not_released' | 'utility_shifting_pending' | 'forest_revenue_clearance'
  | 'rain_monsoon' | 'labour_shortage' | 'material_shortage' | 'machinery_breakdown'
  | 'law_and_order' | 'local_obstruction' | 'our_own_fault' | 'other'

export interface DelaySuggestion {
  suggest: boolean
  attribution: Attribution
  cause: DelayCause
  /** What goes in the register, in words. Empty where only the site knows. */
  title: string
  /** Why the offer is being made, in the words shown on the screen. */
  reason: string
}

/**
 * Whether this report should open a delay entry.
 *
 * Only offered, never automatic. A stopped day has a cause and only the person
 * who was there knows it — a site that shut because the department had not
 * handed over the land and a site that shut because our own mixer was down are
 * the same empty report and opposite outcomes at the counter. Guessing
 * `neutral` for every quiet day would fill the register with claims that
 * collapse under one question, and a register that collapses under one
 * question is worse than an empty one.
 */
export function delaySuggestion(d: DprInput): DelaySuggestion {
  const weather = d.weather ? STOPPING_WEATHER[d.weather] : undefined

  if (weather && isStopped(d)) {
    return { suggest: true, attribution: 'neutral', cause: weather.cause,
      title: weather.title,
      reason: 'Nobody on site and the weather stopped it. Recorded now, this '
        + 'is a forgiven day; reconstructed later, it is a penalty.' }
  }
  if (isStopped(d)) {
    return { suggest: true, attribution: 'department', cause: 'other', title: '',
      reason: 'No labour and no work recorded. If something outside our '
        + 'control stopped the day, say what — an unexplained empty day '
        + 'counts against us.' }
  }
  return { suggest: false, attribution: 'neutral', cause: 'other', title: '', reason: '' }
}

/* ------------------------------------------------------------------ */
/* What is wrong with this report                                      */
/* ------------------------------------------------------------------ */

export type Severity = 'blocking' | 'warning'
export interface Problem { severity: Severity; message: string }

/**
 * Problems are `blocking` or `warning`, and almost nothing here blocks.
 *
 * The person filling this in is standing at a site on a phone. A form that
 * refuses to save until every field is right does not produce better data — it
 * produces no data, and then the man-days for that day are invented in the
 * office a month later. So the only blocking problems are ones that would
 * write a figure nobody can correct later.
 */
export function validate(d: DprInput): Problem[] {
  const out: Problem[] = []

  for (const l of d.labour) {
    if (!Number.isInteger(l.headcount) || l.headcount < 0) {
      out.push({ severity: 'blocking', message: `${l.trade}: headcount must be a whole number.` })
    }
    if (l.headcount > 0 && !l.partyId) {
      out.push({ severity: 'warning',
        message: `${l.headcount} ${l.trade} with no mukadam named — those `
          + 'man-days cannot be allocated when the gang is paid.' })
    }
    if (l.headcount === 0 && l.wageRatePaise > ZERO) {
      out.push({ severity: 'warning', message: `${l.trade}: a rate with nobody on it.` })
    }
  }

  const heads = totalHeadcount(d.labour)
  if (heads > 0 && d.workDoneSummary.trim().length === 0) {
    out.push({ severity: 'warning',
      message: `${heads} on site and no work written down. The day is paid `
        + 'for either way; what it bought is the part that gets forgotten.' })
  }
  if (heads === 0 && d.workDoneSummary.trim().length > 0) {
    out.push({ severity: 'warning',
      message: 'Work recorded with nobody on site. If a subcontractor or a '
        + 'machine did it, say so — otherwise this looks like a missed headcount.' })
  }
  if (isStopped(d) && !d.weather && !d.issueTitle) {
    out.push({ severity: 'warning',
      message: 'An empty day with no reason given is a day of liquidated '
        + 'damages nobody can argue about later.' })
  }
  return out
}

export const blocking = (ps: Problem[]): Problem[] =>
  ps.filter((p) => p.severity === 'blocking')

export const WEATHER_LABEL: Record<string, string> = {
  clear: 'Clear', cloudy: 'Cloudy', light_rain: 'Light rain',
  heavy_rain: 'Heavy rain', extreme_heat: 'Extreme heat', other: 'Other',
}
