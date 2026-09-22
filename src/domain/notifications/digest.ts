import { daysBetween, formatDate, type ISODate } from '../dates'

/**
 * The seven o'clock digest.
 *
 * One email a day per person, covering what is late, what is due today, what
 * is coming this week, and anything that landed on them overnight.
 *
 * Two rules decide whether this is useful or landfill.
 *
 *   **Nothing to say means nothing is sent.** A daily email that sometimes
 *   reads "no items" teaches people to filter the sender, and then the one
 *   that mattered goes to the same folder. Silence has to be meaningful.
 *
 *   **A section is capped.** Forty overdue tasks listed in full is a wall
 *   nobody reads to the bottom of; eight and "and 32 more" is a prompt to open
 *   the system, which is where the work actually gets done. The digest is a
 *   nudge, not a report.
 *
 * Pure — no database, no clock beyond what is passed in. CLAUDE.md §5.
 */

export interface DigestItem {
  title: string
  dueDate: ISODate | null
  priority: string
  firmName: string | null
  projectCode: string | null
  /** Set where the item is an escalation, so the digest can say so. */
  escalated?: boolean
}

export interface DigestInput {
  userName: string
  today: ISODate
  /** Every open task assigned to this person, in any state of lateness. */
  tasks: DigestItem[]
  /** Instruments, policies and registrations lapsing inside sixty days. */
  expiring: { label: string; on: ISODate; firmName: string | null }[]
}

export interface Section {
  key: 'overdue' | 'today' | 'week' | 'expiring'
  heading: string
  items: string[]
  /** How many were left out of `items` by the cap. */
  more: number
}

export interface Digest {
  userName: string
  today: ISODate
  subject: string
  sections: Section[]
  /** Everything counted, including what the cap left out. */
  total: number
}

/** How many lines a section may show before it starts saying "and N more". */
export const SECTION_CAP = 8

const line = (i: DigestItem): string => {
  const bits = [i.firmName, i.projectCode].filter(Boolean).join(' · ')
  const when = i.dueDate ? formatDate(i.dueDate) : 'no date'
  return `${i.title}${bits ? ` (${bits})` : ''} — ${when}`
}

function section(
  key: Section['key'], heading: string, items: string[],
): Section | null {
  if (items.length === 0) return null
  return {
    key, heading,
    items: items.slice(0, SECTION_CAP),
    more: Math.max(0, items.length - SECTION_CAP),
  }
}

export function buildDigest(input: DigestInput): Digest {
  const { today } = input

  const overdue: DigestItem[] = []
  const dueToday: DigestItem[] = []
  const thisWeek: DigestItem[] = []

  for (const t of input.tasks) {
    if (!t.dueDate) continue          // undated work is not urgent by omission
    const left = daysBetween(today, t.dueDate)
    if (left < 0) overdue.push(t)
    else if (left === 0) dueToday.push(t)
    else if (left <= 7) thisWeek.push(t)
  }

  /* Escalations first inside the overdue block: they are the ones somebody has
     already failed to act on, which is a different message from merely late. */
  overdue.sort((a, b) =>
    Number(!!b.escalated) - Number(!!a.escalated) ||
    daysBetween(today, a.dueDate!) - daysBetween(today, b.dueDate!))

  const sections = [
    section('overdue', 'Overdue', overdue.map((t) =>
      `${line(t)} (${-daysBetween(today, t.dueDate!)} days late${
        t.escalated ? ', escalated to you' : ''})`)),
    section('today', 'Due today', dueToday.map(line)),
    section('week', 'Within seven days', thisWeek.map(line)),
    section('expiring', 'Expiring within sixty days', input.expiring.map((e) =>
      `${e.label}${e.firmName ? ` (${e.firmName})` : ''} — ${formatDate(e.on)}, ${
        daysBetween(today, e.on)} days`)),
  ].filter((s): s is Section => s !== null)

  const total = overdue.length + dueToday.length + thisWeek.length + input.expiring.length

  return {
    userName: input.userName,
    today,
    subject: subjectFor(overdue.length, dueToday.length, total),
    sections,
    total,
  }
}

/**
 * The subject line carries the news, because on a phone it is often all that
 * gets read. Lead with what is wrong; fall back to what is due.
 */
function subjectFor(overdue: number, today: number, total: number): string {
  if (overdue > 0) {
    return `${overdue} overdue${today > 0 ? `, ${today} due today` : ''}`
  }
  if (today > 0) return `${today} due today`
  return `${total} coming up`
}

/** Nothing to say means nothing is sent. */
export const worthSending = (d: Digest): boolean => d.total > 0

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderText(d: Digest, url: string): string {
  const out = [`Good morning, ${d.userName.split(' ')[0]}.`, '']
  for (const s of d.sections) {
    out.push(`${s.heading.toUpperCase()}`)
    for (const i of s.items) out.push(`  - ${i}`)
    if (s.more > 0) out.push(`  ...and ${s.more} more`)
    out.push('')
  }
  out.push(`Open the system: ${url}`)
  return out.join('\n')
}

/**
 * HTML kept deliberately plain: inline styles, no images, no external CSS.
 * Mail clients strip everything else, and a digest that arrives looking broken
 * is worse than one that arrives looking like a memo.
 */
export function renderHtml(d: Digest, url: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const body = d.sections.map((s) => `
    <h2 style="font:600 13px/1.4 system-ui,sans-serif;color:#6B7280;
               text-transform:uppercase;letter-spacing:.06em;margin:24px 0 8px">
      ${esc(s.heading)}
    </h2>
    <ul style="margin:0;padding-left:18px">
      ${s.items.map((i) =>
        `<li style="font:400 14px/1.6 system-ui,sans-serif;color:#111827;margin:0 0 4px">
           ${esc(i)}</li>`).join('')}
      ${s.more > 0
        ? `<li style="font:400 14px/1.6 system-ui,sans-serif;color:#6B7280">
             and ${s.more} more</li>`
        : ''}
    </ul>`).join('')

  return `<div style="max-width:640px;margin:0 auto;padding:24px">
  <p style="font:400 15px/1.6 system-ui,sans-serif;color:#111827;margin:0">
    Good morning, ${esc(d.userName.split(' ')[0] ?? '')}.
  </p>
  ${body}
  <p style="margin:28px 0 0">
    <a href="${esc(url)}"
       style="font:600 14px system-ui,sans-serif;color:#fff;background:#0B1B33;
              padding:10px 18px;border-radius:10px;text-decoration:none">
      Open the system
    </a>
  </p>
  <p style="font:400 12px/1.5 system-ui,sans-serif;color:#9CA3AF;margin:24px 0 0">
    Sahyadri Infra Projects Pvt Ltd · Jath, Dist. Sangli 416404 · internal use only
  </p>
</div>`
}
