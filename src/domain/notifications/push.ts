import { type ISODate } from '../dates'

/**
 * What is worth interrupting somebody for.
 *
 * A push notification is the only thing this system can do that reaches a
 * person who is not looking at it. That makes it the most valuable channel
 * here and the easiest to destroy: **the cost of a push is not the one push,
 * it is every push afterwards.** A phone that buzzes eleven times on a Monday
 * gets the app's notifications turned off, and then the licence expiring in
 * October arrives nowhere.
 *
 * So the rules below are all about sending FEWER.
 *
 * Pure. CLAUDE.md §5.
 */

export type Urgency = 'critical' | 'high' | 'normal' | 'low'

/**
 * Rules that get through on their own, the moment they fire.
 *
 * Deliberately short, and every entry earns its place by being something where
 * a day's delay costs real money and the deadline cannot be recovered:
 *
 *  - `WORK_ORDER_FORMALITIES` — miss it and the work goes to somebody else and
 *    the registration is suspended, two years on an Educated Unemployed
 *    Engineer registration.
 *  - `GEOTAG_UPLOAD` — photographs before the first day, or the bill for that
 *    work becomes our own liability.
 *  - `BG_EXPIRY` — a lapsed guarantee is not a reminder, it is an event.
 *  - `EOT_APPLICATION_DEADLINE` — the application must reach the department
 *    fifteen days before completion, and late filing carries a per-day penalty.
 *  - `LICENCE_RENEWAL` — papers must REACH the department three months early,
 *    so the last warning is already the late one.
 *
 * Everything else waits for the digest. A bill that has been stuck for sixteen
 * days is not more urgent at 11pm than at seven tomorrow.
 */
export const IMMEDIATE: ReadonlySet<string> = new Set([
  'WORK_ORDER_FORMALITIES',
  'GEOTAG_UPLOAD',
  'BG_EXPIRY',
  'EOT_APPLICATION_DEADLINE',
  'LICENCE_RENEWAL',
])

/**
 * Quiet hours, Asia/Kolkata.
 *
 * Nothing between these leaves the building. Not a preference — a phone that
 * buzzes at two in the morning gets the whole app silenced by breakfast, and
 * nothing in this system is worth waking somebody for. Anything that fires
 * inside the window is held to the start of the day.
 */
export const QUIET_FROM_HOUR = 21
export const QUIET_TO_HOUR = 7

export const inQuietHours = (hour: number): boolean =>
  hour >= QUIET_FROM_HOUR || hour < QUIET_TO_HOUR

/** The hour a held notification goes out instead. */
export const HELD_UNTIL_HOUR = QUIET_TO_HOUR

export interface Candidate {
  /** `tasks.dedupe_key` — the same key must never buzz twice. */
  dedupeKey: string
  ruleCode: string
  title: string
  dueDate: ISODate | null
  /** Already past its date. */
  overdue: boolean
  escalated: boolean
  firmName: string | null
  url: string
}

export interface Decision {
  send: boolean
  /** Hold until this hour when quiet hours bite. Null means send now. */
  holdUntilHour: number | null
  urgency: Urgency
  reason: string
}

/**
 * Whether one item interrupts, right now.
 *
 * An escalation always does — by the time a task has been overdue three days
 * and passed to an Owner, the quiet channel has already failed once.
 */
export function decide(c: Candidate, hour: number): Decision {
  const immediate = IMMEDIATE.has(c.ruleCode)
  const urgency: Urgency = c.escalated ? 'critical'
    : immediate && c.overdue ? 'critical'
    : immediate ? 'high'
    : 'normal'

  if (!immediate && !c.escalated) {
    return { send: false, holdUntilHour: null, urgency,
      reason: 'Waits for the digest. It is not more urgent tonight than it is '
        + 'at seven tomorrow.' }
  }
  if (inQuietHours(hour)) {
    return { send: true, holdUntilHour: HELD_UNTIL_HOUR, urgency,
      reason: 'Held to the morning. Nothing here is worth a phone going off '
        + 'at night, and one that does gets the app silenced by breakfast.' }
  }
  return { send: true, holdUntilHour: null, urgency, reason: 'Sent now.' }
}

/* ------------------------------------------------------------------ */
/* One buzz, not eleven                                                */
/* ------------------------------------------------------------------ */

export interface Push {
  title: string
  body: string
  /** Collapses on the device: a newer push with this tag REPLACES the old. */
  tag: string
  url: string
  urgency: Urgency
  /** Every dedupe key folded into this push, so none is chased twice. */
  covers: string[]
}

/**
 * Fold a batch into one notification.
 *
 * The nightly run generates a dozen tasks at once and a dozen separate buzzes
 * is the failure mode this whole module exists to avoid. One push, named after
 * the most urgent thing in it, counting the rest — and carrying a `tag`, so a
 * second batch replaces the first on the phone instead of stacking beneath it.
 *
 * A single item keeps its own words. "1 other thing needs you" is a worse
 * notification than the thing itself.
 */
export function coalesce(items: Candidate[], hour: number): Push | null {
  const sending = items
    .map((c) => ({ c, d: decide(c, hour) }))
    .filter((x) => x.d.send)
  if (sending.length === 0) return null

  const rank: Record<Urgency, number> = { critical: 0, high: 1, normal: 2, low: 3 }
  sending.sort((a, b) => rank[a.d.urgency] - rank[b.d.urgency])

  const lead = sending[0]!
  const rest = sending.length - 1

  const where = lead.c.firmName ? ` · ${lead.c.firmName}` : ''
  return {
    title: lead.c.escalated ? `Overdue: ${lead.c.title}` : lead.c.title,
    body: rest === 0
      ? `${lead.c.overdue ? 'Past its date' : 'Needs you'}${where}`
      : `${lead.c.overdue ? 'Past its date' : 'Needs you'}${where}`
        + ` — and ${rest} other${rest === 1 ? '' : 's'}`,
    /* One tag for the lot. A later batch replaces this on the phone rather
       than stacking under it. */
    tag: 'ops-alerts',
    url: rest === 0 ? lead.c.url : '/tasks',
    urgency: lead.d.urgency,
    covers: sending.map((x) => x.c.dedupeKey),
  }
}

/* ------------------------------------------------------------------ */
/* Dead devices                                                        */
/* ------------------------------------------------------------------ */

export type SubscriptionVerdict = 'delivered' | 'retry' | 'gone'

/**
 * What a push service's reply means for the subscription.
 *
 * **404 and 410 mean the subscription is dead** — the browser was cleared, the
 * app uninstalled, the permission revoked — and it must be deleted, not
 * retried. A dead endpoint retried nightly is a queue that never drains and,
 * worse, hides the fact that a person is no longer being reached at all.
 *
 * 429 and 5xx are the service's problem, not ours, and are worth another go.
 * 400 and 403 mean we sent something wrong — usually a VAPID key that no
 * longer matches the one the device subscribed with — and retrying will not
 * fix it, so it is surfaced rather than swallowed.
 */
export function verdictFor(status: number): SubscriptionVerdict {
  if (status >= 200 && status < 300) return 'delivered'
  if (status === 404 || status === 410) return 'gone'
  if (status === 429 || status >= 500) return 'retry'
  return 'gone'
}

/** After this many consecutive failures a subscription is dropped anyway. */
export const MAX_FAILURES = 5
