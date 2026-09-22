/**
 * Dates. Business dates are calendar dates with no time and no zone —
 * a work order dated 12-05-2026 is that date in Jath, whatever the server
 * thinks. Event timestamps are timestamptz and are a different thing.
 * CLAUDE.md §0.4
 */

export const APP_TIMEZONE = 'Asia/Kolkata'

/** A business date as stored: 'YYYY-MM-DD'. */
export type ISODate = string & { readonly __brand: 'ISODate' }

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

export function isoDate(s: string): ISODate {
  if (!ISO_RE.test(s)) throw new RangeError(`not an ISO date: ${s}`)
  return s as ISODate
}

/** Today in Asia/Kolkata, regardless of where the process runs. */
export function todayIST(now: Date = new Date()): ISODate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
  return parts as ISODate
}

/** '2026-05-12' → '12-05-2026'. The only format a user ever sees. */
export function formatDate(d: ISODate | string | Date | null | undefined): string {
  if (!d) return '—'
  const s = normalise(d)
  if (!ISO_RE.test(s)) return '—'
  const [y, m, day] = s.split('-') as [string, string, string]
  return `${day}-${m}-${y}`
}

/** A timestamptz rendered in IST: '12-05-2026 15:30'. */
export function formatDateTime(ts: Date | string | null | undefined): string {
  if (!ts) return '—'
  const d = typeof ts === 'string' ? new Date(ts) : ts
  if (Number.isNaN(d.getTime())) return '—'
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? ''
  return `${g('day')}-${g('month')}-${g('year')} ${g('hour')}:${g('minute')}`
}

/**
 * Accept anything the database or a caller might hand us and reduce it to a
 * bare 'YYYY-MM-DD'. The pg driver is configured to return date columns as
 * strings, but a Date can still arrive from JSON or from a caller, and a page
 * should not white-screen because of it.
 */
function normalise(d: ISODate | string | Date): string {
  if (d instanceof Date) return d.toISOString().slice(0, 10)
  return String(d).slice(0, 10)
}

function toUTCDate(d: ISODate | string | Date): Date {
  const [y, m, day] = normalise(d).split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, day))
}

function fromUTCDate(d: Date): ISODate {
  return d.toISOString().slice(0, 10) as ISODate
}

export function addDays(d: ISODate | string | Date, n: number): ISODate {
  const t = toUTCDate(d)
  t.setUTCDate(t.getUTCDate() + n)
  return fromUTCDate(t)
}

export function addMonths(d: ISODate | string | Date, n: number): ISODate {
  const t = toUTCDate(d)
  const day = t.getUTCDate()
  t.setUTCDate(1)
  t.setUTCMonth(t.getUTCMonth() + n)
  // Clamp: 31 Jan + 1 month is 28/29 Feb, not 3 March.
  const lastDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()
  t.setUTCDate(Math.min(day, lastDay))
  return fromUTCDate(t)
}

/** b − a, in whole days. */
export function daysBetween(a: ISODate | string | Date, b: ISODate | string | Date): number {
  return Math.round((toUTCDate(b).getTime() - toUTCDate(a).getTime()) / 86_400_000)
}

/** Positive when d is in the past. The number every aging report shows. */
export function daysSince(d: ISODate | string | Date, today: ISODate = todayIST()): number {
  return daysBetween(d, today)
}

export function daysUntil(d: ISODate | string | Date, today: ISODate = todayIST()): number {
  return daysBetween(today, d)
}

export const isOverdue = (due: ISODate | string | Date | null | undefined, today: ISODate = todayIST()): boolean =>
  due != null && daysUntil(due, today) < 0

/**
 * Whatever the database handed back, as an ISO date — or null.
 *
 * A `date` column arrives as a 'YYYY-MM-DD' string through the application
 * pool, because a type parser is registered there. Through any other
 * connection — a script, a test, a one-off client — it arrives as a JS Date,
 * and `String(value).slice(0, 10)` then yields "Fri Sep 0". That has now been
 * the cause of three separate bugs: a tender deadline showing "NaNd", the
 * document list crashing, and the alert engine throwing on an invalid time
 * value.
 *
 * So the conversion lives here, works on either, and is what code touching a
 * date from the database should use instead of slicing a string.
 */
export function toISODate(v: unknown): ISODate | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    /* LOCAL parts, not UTC. node-postgres builds a DATE as local midnight, so
       in IST the 22nd arrives as 2026-09-21T18:30:00Z — and UTC getters then
       hand back the 21st. Every timezone east of UTC is off by a day, which
       for a bank guarantee expiry is the difference between a warning and a
       lapse. */
    const y = v.getFullYear()
    const m = String(v.getMonth() + 1).padStart(2, '0')
    const d = String(v.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}` as ISODate
  }
  const s = String(v).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? (s as ISODate) : null
}
