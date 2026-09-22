import { addDays, daysBetween, type ISODate } from '../dates'
import {
  CLAIMABLE, daysCovered, mergeIntervals, type Attribution, type DelayEvent,
} from './delay'

/**
 * Assembling an extension of time from the delay register.
 *
 * The application has to reach the department **fifteen days before the
 * completion date** — CLAUDE.md §3, `EOT_APPLICATION_DEADLINE` — and filing
 * late carries a per-day penalty of its own. So the pack is built from what is
 * already recorded rather than written from memory on the day, which is how it
 * gets filed late and short.
 *
 * Three things decide whether an application survives the counter, and all
 * three are checked here rather than discovered there:
 *
 *   **The day count must be the merged one.** Two events overlapping are one
 *   standstill. A claim for forty days against a thirty-day stoppage is the
 *   commonest reason a pack comes back.
 *
 *   **The same days must not be claimed twice.** An event already carried in a
 *   granted extension cannot appear in the next one, and a department that
 *   spots it reads the whole file differently afterwards.
 *
 *   **Our own fault must not be in it.** One such line and the rest stops
 *   being believed.
 *
 * Pure. CLAUDE.md §5.
 */

/** Days before the stipulated completion by which the application must arrive. */
export const FILING_LEAD_DAYS = 15

export interface EotEvent extends DelayEvent {
  /** Evidence attached to this event. */
  documents: number
  /** The letter or order this rests on, where there is one. */
  correspondenceRef?: string | null
  /** Already carried in another extension. */
  alreadyClaimed: boolean
}

export interface EotPackInput {
  events: EotEvent[]
  /** The ids somebody has chosen to include. */
  selectedIds: string[]
  stipulatedCompletion: ISODate | null
  /** Days already granted, which move the date this is measured against. */
  daysGranted: number
  asOf: ISODate
}

export type Problem = {
  severity: 'blocking' | 'weak'
  message: string
}

export interface EotPack {
  /** Events that may be claimed at all. */
  eligible: EotEvent[]
  /** Of those, the ones selected. */
  included: EotEvent[]
  /** Merged distinct days across the included events. */
  daysClaimed: number
  /** Earliest start and latest end of the included events. */
  periodFrom: ISODate | null
  periodTo: ISODate | null
  /**
   * Calendar days between those two dates. Larger than `daysClaimed` wherever
   * the delays did not run continuously, and the difference is the first thing
   * a department asks about — so it is reported rather than hidden.
   */
  periodDays: number
  /** The date the application has to reach the department by. */
  filingDeadline: ISODate | null
  /** Days until that deadline. Negative once it has passed. */
  daysToFile: number | null
  /** What the completion date becomes if the whole claim is granted. */
  revisedCompletion: ISODate | null
  problems: Problem[]
  /** Nothing blocking. Weak points may remain. */
  canSubmit: boolean
}

export function buildPack(input: EotPackInput): EotPack {
  const eligible = input.events.filter(
    (e) => CLAIMABLE[e.attribution as Attribution] && !e.alreadyClaimed)
  const included = eligible.filter((e) => input.selectedIds.includes(e.id))

  const intervals = included.map((e) => ({
    from: e.startDate,
    /* An open event is claimed up to today. Claiming into the future is a
       claim for days that have not been lost yet, and the department has the
       same calendar we do. */
    to: e.endDate ?? input.asOf,
  }))

  const merged = mergeIntervals(intervals)
  const daysClaimed = daysCovered(intervals)
  const periodFrom = merged.length > 0 ? merged[0]!.from : null
  const periodTo = merged.length > 0 ? merged[merged.length - 1]!.to : null
  const periodDays = periodFrom && periodTo
    ? daysBetween(periodFrom, periodTo) + 1 : 0

  const revised = input.stipulatedCompletion
    ? addDays(input.stipulatedCompletion, input.daysGranted + daysClaimed)
    : null

  const filingDeadline = input.stipulatedCompletion
    ? addDays(addDays(input.stipulatedCompletion, input.daysGranted),
              -FILING_LEAD_DAYS)
    : null
  const daysToFile = filingDeadline
    ? daysBetween(input.asOf, filingDeadline) : null

  const problems: Problem[] = []

  if (included.length === 0) {
    problems.push({
      severity: 'blocking',
      message: eligible.length === 0
        ? 'Nothing in the register can be claimed. Delays caused by our own '
          + 'fault are never claimable, and an event already carried in a '
          + 'granted extension cannot be claimed again.'
        : 'Nothing is selected yet.',
    })
  }

  /* The one that gets a pack returned. */
  const withoutEvidence = included.filter((e) => e.documents === 0)
  if (withoutEvidence.length > 0) {
    problems.push({
      severity: 'weak',
      message: (withoutEvidence.length === included.length
          ? (included.length === 1
              ? 'This event has no document attached.'
              : `None of the ${included.length} events has a document attached.`)
          : `${withoutEvidence.length} of the ${included.length} events `
            + `${withoutEvidence.length === 1 ? 'has' : 'have'} no document `
            + `attached.`)
        + ` An application rests on the correspondence — the letter asking for `
        + `the drawings, the reply that never came — not on our own register.`,
    })
  }

  const stillOpen = included.filter((e) => e.endDate === null)
  if (stillOpen.length > 0) {
    problems.push({
      severity: 'weak',
      message: `${stillOpen.length === 1 ? 'One of these is' : `${stillOpen.length} of these are`} `
        + `still running, so the claim is for days lost up to today and will `
        + `understate the final figure. A second application can follow once `
        + `${stillOpen.length === 1 ? 'it closes' : 'they close'}.`,
    })
  }

  if (daysToFile !== null && daysToFile < 0) {
    problems.push({
      severity: 'weak',
      message: `The application was due ${-daysToFile} days ago — it had to reach `
        + `the department fifteen days before the completion date. Late filing `
        + `carries its own penalty, and it is still worth filing.`,
    })
  }

  if (!input.stipulatedCompletion) {
    problems.push({
      severity: 'blocking',
      message: 'This work has no stipulated completion date, so there is nothing '
        + 'to extend and no deadline to file by. Enter the work order date and '
        + 'the time of completion first.',
    })
  }

  /* Reported rather than flagged: a broken run is perfectly legitimate and
     also the first thing a department queries, so the pack should state it
     before somebody is asked across a counter. */
  return {
    eligible, included, daysClaimed, periodFrom, periodTo, periodDays,
    filingDeadline, daysToFile, revisedCompletion: revised, problems,
    canSubmit: !problems.some((p) => p.severity === 'blocking'),
  }
}

/**
 * The grounds paragraph, from the events themselves.
 *
 * A first draft to be edited, never a submission. It exists because the
 * alternative is a blank box at the end of a long day, and a blank box is how
 * an application ends up saying "delay due to departmental reasons" and
 * getting exactly the consideration that sentence deserves.
 */
export function draftGrounds(pack: EotPack, workName: string): string {
  if (pack.included.length === 0) return ''

  const lines = pack.included
    .slice()
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .map((e, i) => {
      const to = e.endDate ?? pack.periodTo!
      const days = daysBetween(e.startDate, to) + 1
      const who = e.blockingParty ? ` by ${e.blockingParty}` : ''
      return `${i + 1}. ${e.title}${who} — from ${fmt(e.startDate)} to `
           + `${e.endDate ? fmt(e.endDate) : 'the present'}, ${days} days.`
           + (e.correspondenceRef ? ` Reference: ${e.correspondenceRef}.` : '')
    })

  const overlapNote = pack.daysClaimed < sumOfDays(pack)
    ? `\n\nThe events above overlap. The extension sought is for `
      + `${pack.daysClaimed} calendar days on which work was actually stopped, `
      + `not the sum of the individual periods.`
    : ''

  return `Work: ${workName}\n\n`
    + `The following caused work to stand still and were beyond our control:\n\n`
    + `${lines.join('\n')}\n\n`
    + `An extension of ${pack.daysClaimed} days is sought, from `
    + `${fmt(pack.periodFrom!)} to ${fmt(pack.periodTo!)}.`
    + overlapNote
}

const sumOfDays = (pack: EotPack): number =>
  pack.included.reduce(
    (n, e) => n + daysBetween(e.startDate, e.endDate ?? pack.periodTo!) + 1, 0)

/** DD-MM-YYYY. CLAUDE.md §0.4 — never an ISO string in front of a user. */
function fmt(d: ISODate): string {
  const [y, m, day] = d.split('-')
  return `${day}-${m}-${y}`
}
