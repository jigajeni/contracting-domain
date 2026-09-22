import { addDays, daysBetween, type ISODate } from '../dates'

/**
 * Days lost, and how many of them can actually be claimed.
 *
 * CLAUDE.md §1: delays attributable to the department are the evidence for an
 * extension of time, and a granted EOT waives liquidated damages for that
 * period. So this register is not a diary — every day in it is either a day of
 * penalty at the LD rate or a day forgiven, and which one depends on being
 * able to show the cause and the dates.
 *
 * **Overlapping delays lose the same calendar day once.** Land not handed over
 * from the 1st to the 30th and drawings not received from the 10th to the 20th
 * are two events and twenty-nine days, not forty. Adding the two together is
 * the obvious implementation and it is the one that gets a claim thrown out at
 * the counter — the department counts the calendar, not the register, and an
 * application for forty days against a thirty-day standstill reads as either
 * carelessness or something worse.
 *
 * So days are counted by merging intervals, never by summing events. Every
 * figure here — claimable, unclaimable, the total standstill — is a count of
 * distinct calendar days.
 *
 * Pure. CLAUDE.md §5.
 */

export type Attribution = 'department' | 'us' | 'neutral' | 'third_party'

export interface DelayEvent {
  id: string
  startDate: ISODate
  /** Null while it is still running. */
  endDate: ISODate | null
  attribution: Attribution
  cause: string
  title: string
  /** Who is stopping us. Null where nobody has been named. */
  blockingParty?: string | null
}

export interface Interval { from: ISODate; to: ISODate }

/**
 * Merge overlapping and touching intervals.
 *
 * Touching as well as overlapping: an event ending on the 10th and another
 * starting on the 11th is a continuous standstill, and leaving a seam between
 * them counts the same shutdown as two, which is only a presentational
 * difference until somebody sums the two day counts.
 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((a, b) => a.from.localeCompare(b.from))
  const out: Interval[] = [{ ...sorted[0]! }]

  for (const next of sorted.slice(1)) {
    const last = out[out.length - 1]!
    /* <= addDays(last.to, 1) rather than <= last.to, so abutting runs join. */
    if (next.from <= addDays(last.to, 1)) {
      if (next.to > last.to) last.to = next.to
    } else {
      out.push({ ...next })
    }
  }
  return out
}

/** Distinct calendar days covered, both ends inclusive. */
export function daysCovered(intervals: Interval[]): number {
  return mergeIntervals(intervals)
    .reduce((n, i) => n + daysBetween(i.from, i.to) + 1, 0)
}

/**
 * Which attributions a department will forgive.
 *
 * `department` always. `neutral` — rain, law and order — normally, because
 * neither side caused it and the contract treats it as force majeure. `us`
 * never, and putting it in a claim is how the whole application loses
 * credibility. `third_party` is the argued one: a utility that will not shift
 * its pole is not the department and is not us, and whether it is forgiven
 * depends on whose duty it was to get it moved.
 */
export const CLAIMABLE: Record<Attribution, boolean> = {
  department: true,
  neutral: true,
  third_party: true,
  us: false,
}

export interface DelaySummary {
  /** Distinct days on which something was stopping the work. */
  totalDaysLost: number
  /** Of those, days claimable in an extension of time. */
  claimableDays: number
  /** Days lost only to our own fault. Never claimable, always countable. */
  ownFaultDays: number
  /** Still running — no end date. */
  openEvents: number
  events: number
  byAttribution: Record<Attribution, number>
  /** Who is stopping us, biggest first. */
  byParty: { party: string; days: number; events: number }[]
}

const intervalsOf = (events: DelayEvent[], asOf: ISODate): Interval[] =>
  events.map((e) => ({ from: e.startDate, to: e.endDate ?? asOf }))

export function summarise(events: DelayEvent[], asOf: ISODate): DelaySummary {
  const claimable = events.filter((e) => CLAIMABLE[e.attribution])
  const ours = events.filter((e) => e.attribution === 'us')

  const byAttribution = {} as Record<Attribution, number>
  for (const a of ['department', 'us', 'neutral', 'third_party'] as Attribution[]) {
    /* Merged WITHIN each attribution. Two departmental delays overlapping are
       still one lost day of departmental delay. */
    byAttribution[a] = daysCovered(
      intervalsOf(events.filter((e) => e.attribution === a), asOf))
  }

  const parties = new Map<string, DelayEvent[]>()
  for (const e of events) {
    /* Our own fault is not a party, and letting it fall through to "Unnamed"
       would put our own delays in a list headed "who is blocking us". */
    const key = e.attribution === 'us' ? 'Us' : e.blockingParty || 'Not named'
    const list = parties.get(key)
    if (list) list.push(e); else parties.set(key, [e])
  }

  return {
    totalDaysLost: daysCovered(intervalsOf(events, asOf)),
    claimableDays: daysCovered(intervalsOf(claimable, asOf)),
    ownFaultDays: daysCovered(intervalsOf(ours, asOf)),
    openEvents: events.filter((e) => e.endDate === null).length,
    events: events.length,
    byAttribution,
    byParty: [...parties]
      .map(([party, list]) => ({
        party, days: daysCovered(intervalsOf(list, asOf)), events: list.length,
      }))
      .sort((a, b) => b.days - a.days),
  }
}

// ---------------------------------------------------------------------------
// What it costs, or saves
// ---------------------------------------------------------------------------

export interface LdExposureInput {
  /** Work order date plus time of completion, before any extension. */
  stipulatedCompletion: ISODate | null
  /** Days already granted in a sanctioned EOT. */
  daysGranted: number
  /** Days claimable but not yet applied for or not yet granted. */
  claimableDays: number
  actualCompletion: ISODate | null
  asOf: ISODate
}

export interface LdExposure {
  /** The date LD is measured against once granted extensions are applied. */
  revisedCompletion: ISODate | null
  /** Days beyond that date, today or at completion. Zero if not yet past it. */
  daysOverrun: number
  /**
   * What the overrun would fall to if every claimable day were granted. The
   * gap between this and `daysOverrun` is what an EOT application is worth.
   */
  daysOverrunIfClaimed: number
  /** Days of exposure an application could still remove. */
  daysRecoverable: number
  status: 'not_due' | 'on_time' | 'overrun' | 'unknown'
}

export function ldExposure(input: LdExposureInput): LdExposure {
  if (!input.stipulatedCompletion) {
    return {
      revisedCompletion: null, daysOverrun: 0, daysOverrunIfClaimed: 0,
      daysRecoverable: 0, status: 'unknown',
    }
  }

  const revised = addDays(input.stipulatedCompletion, input.daysGranted)
  const measureAt = input.actualCompletion ?? input.asOf
  const overrun = Math.max(0, daysBetween(revised, measureAt))

  /* Claimable days can only remove overrun that exists — a work finished
     early does not bank them, and showing a negative would invite somebody to
     treat them as credit against the next one. */
  const ifClaimed = Math.max(0, overrun - input.claimableDays)

  return {
    revisedCompletion: revised,
    daysOverrun: overrun,
    daysOverrunIfClaimed: ifClaimed,
    daysRecoverable: overrun - ifClaimed,
    status: overrun > 0 ? 'overrun'
      : input.actualCompletion ? 'on_time' : 'not_due',
  }
}

export const CAUSE_LABEL: Record<string, string> = {
  land_not_handed_over: 'Land not handed over',
  drawings_not_received: 'Drawings not received',
  dept_approval_pending: 'Departmental approval pending',
  funds_not_released: 'Funds not released',
  utility_shifting_pending: 'Utility shifting pending',
  forest_revenue_clearance: 'Forest or revenue clearance',
  rain_monsoon: 'Rain and monsoon',
  labour_shortage: 'Labour shortage',
  material_shortage: 'Material shortage',
  machinery_breakdown: 'Machinery breakdown',
  law_and_order: 'Law and order',
  local_obstruction: 'Local obstruction',
  our_own_fault: 'Our own fault',
  other: 'Other',
}

/**
 * Roll several works up without merging across them.
 *
 * The same trap as overlapping events, one level up and easier to miss. Days
 * are merged WITHIN a work because the work stopped once; they are SUMMED
 * across works because two sites held up on the same Tuesday each lost that
 * Tuesday. Merging across works quietly reported a group total smaller than
 * one of its own rows — 73 days lost against parties adding to 132 — which is
 * the kind of figure somebody notices and then distrusts the whole screen for.
 *
 * Per party is merged within the party for the same reason a single work is:
 * one department holding up one work twice over the same fortnight held it up
 * for a fortnight.
 */
export function rollUp(
  byProject: Map<string, DelayEvent[]>, asOf: ISODate,
): DelaySummary {
  const per = [...byProject.values()].map((events) => summarise(events, asOf))
  const all = [...byProject.values()].flat()

  const attribution = {} as Record<Attribution, number>
  for (const a of ['department', 'us', 'neutral', 'third_party'] as Attribution[]) {
    attribution[a] = per.reduce((n, s) => n + s.byAttribution[a], 0)
  }

  /* A party is not confined to one work, so its days are merged across every
     work it is holding up — but only its own. */
  const parties = new Map<string, DelayEvent[]>()
  for (const e of all) {
    const key = e.attribution === 'us' ? 'Us' : e.blockingParty || 'Not named'
    const list = parties.get(key)
    if (list) list.push(e); else parties.set(key, [e])
  }

  return {
    totalDaysLost: per.reduce((n, s) => n + s.totalDaysLost, 0),
    claimableDays: per.reduce((n, s) => n + s.claimableDays, 0),
    ownFaultDays: per.reduce((n, s) => n + s.ownFaultDays, 0),
    openEvents: per.reduce((n, s) => n + s.openEvents, 0),
    events: all.length,
    byAttribution: attribution,
    byParty: [...parties]
      .map(([party, list]) => {
        /* Within a party, still merge per work then sum — the same rule again. */
        const byWork = new Map<string, DelayEvent[]>()
        for (const e of list) {
          const k = (e as DelayEvent & { projectId?: string }).projectId ?? 'one'
          const l = byWork.get(k); if (l) l.push(e); else byWork.set(k, [e])
        }
        return {
          party,
          days: [...byWork.values()].reduce(
            (n, evs) => n + daysCovered(intervalsOf(evs, asOf)), 0),
          events: list.length,
        }
      })
      .sort((a, b) => b.days - a.days),
  }
}

export const ATTRIBUTION_LABEL: Record<Attribution, string> = {
  department: 'The department',
  us: 'Us',
  neutral: 'Neither side',
  third_party: 'A third party',
}
