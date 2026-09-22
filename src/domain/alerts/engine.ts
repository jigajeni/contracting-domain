import { addDays, daysBetween, todayIST, type ISODate } from '../dates'

/**
 * The alert engine.
 *
 * Twenty-four rules are already defined as data in `alert_rules` — offsets,
 * repeat intervals, who to give it to, how loudly, and when to escalate. This
 * turns a rule and a thing with a date on it into the tasks that should exist
 * today.
 *
 * Two properties matter more than anything else here:
 *
 *   It must be idempotent. The job runs nightly and a person may run it by
 *   hand; running it twice must not produce two of anything. The dedupe key is
 *   (rule, entity, trigger date) and there is a unique index on it, so the
 *   database is the guarantee rather than this code being careful.
 *
 *   It must not shout on the first run. A rule that repeats every fifteen days
 *   would otherwise generate two years of nudges for one unrefunded EMD the
 *   moment it is switched on, and a hundred tasks nobody reads is the same as
 *   no tasks at all.
 *
 * Pure — no database, no clock beyond what is passed in. CLAUDE.md §3.
 */

export type Priority = 'low' | 'normal' | 'high' | 'critical'
export type Role = 'owner' | 'admin' | 'accounts' | 'pm' | 'site_engineer' | 'auditor'

export type Responsibility = 'liaison' | 'office' | 'execution' | 'supply'

export const RESPONSIBILITY_LABEL: Record<Responsibility, string> = {
  liaison: 'Bringing work in and getting paid',
  office: 'Tenders, statutory, banking, documents',
  execution: 'Site, labour and rates',
  supply: 'Materials and follow-up',
}

export interface Rule {
  code: string
  entityType: string
  /**
   * Days relative to the anchor date. **Positive is before** the anchor —
   * `[60, 45, 30, 15]` on a bank guarantee means four warnings running up to
   * expiry. **Negative is after** it: BILL_STUCK is `[-15]`, fifteen days
   * after the bill entered its current stage.
   */
  offsetsDays: number[]
  /** Keep nudging every N days once the offsets are spent. */
  repeatDays: number | null
  defaultRole: Role | null
  /**
   * Whose job this is, as distinct from who may see it. Preferred over the
   * role when the firm has said who holds it — three partners who all need to
   * see everything are all Owners, and resolving by role sends every task to
   * whichever of them was created first.
   */
  defaultResponsibility: Responsibility | null
  defaultPriority: Priority
  escalateAfterDays: number
}

export interface Candidate {
  /** The thing that might need chasing. */
  entityType: string
  entityId: string
  firmId: string
  projectId?: string | null
  /** The date the offsets are measured from. */
  anchorDate: ISODate
  title: string
  description?: string | null
  /**
   * Already dealt with — the EMD came back, the bill moved on, the licence was
   * renewed. Kept as a flag rather than filtered by the caller so the reason a
   * candidate produced nothing is visible in one place.
   */
  resolved?: boolean
  /** Overrides the rule, where a work order states its own deadline. */
  priority?: Priority
  /**
   * Distinguishes several dates on one row.
   *
   * A tipper carries four expiry dates — insurance, fitness, PUC, permit — and
   * they are one machine, not four. Without this the two that happen to warn
   * on the same day would collide on the dedupe key and only one would ever be
   * written, silently.
   */
  variant?: string | null
}

export interface TaskSpec {
  dedupeKey: string
  ruleCode: string
  firmId: string
  projectId: string | null
  entityType: string
  entityId: string
  title: string
  description: string | null
  /** When it should be done by — the anchor, not the day it fired. */
  dueDate: ISODate
  /** The day this alert was meant to appear. Part of the dedupe key. */
  triggerDate: ISODate
  priority: Priority
  role: Role | null
  responsibility: Responsibility | null
}

/**
 * How far back the engine will generate.
 *
 * Only relevant to repeating rules. Without it, switching the engine on
 * against two years of history would create a nudge for every fortnight since
 * a tender was lost. Sixty days is roughly "this quarter" — far enough back to
 * catch what is genuinely outstanding, near enough not to bury anyone.
 */
export const DEFAULT_WINDOW_DAYS = 60

/**
 * The dates on which this rule should fire for this anchor.
 *
 * A single formula covers both directions, which is why the offsets are
 * signed: `anchor − offset` is before the anchor for a positive offset and
 * after it for a negative one.
 */
export function triggerDates(
  rule: Rule,
  anchor: ISODate,
  today: ISODate = todayIST(),
  windowDays = DEFAULT_WINDOW_DAYS,
): ISODate[] {
  const earliest = addDays(today, -windowDays)
  const out: ISODate[] = []

  for (const offset of rule.offsetsDays) {
    const trigger = addDays(anchor, -offset)
    // Not yet due, or so long ago it is history rather than a task.
    if (trigger > today || trigger < earliest) continue
    out.push(trigger)
  }

  /* Repeats carry on from the last offset. An unrefunded EMD is chased every
     fifteen days until it lands, and a new task each time is the point — a
     single stale one gets ignored. */
  if (rule.repeatDays && rule.repeatDays > 0) {
    const last = rule.offsetsDays.length
      ? Math.min(...rule.offsetsDays)          // the latest point in time
      : 0
    let trigger = addDays(anchor, -last)
    let guard = 0
    while (trigger <= today && guard++ < 400) {
      if (trigger >= earliest && !out.includes(trigger)) out.push(trigger)
      trigger = addDays(trigger, rule.repeatDays)
    }
  }

  return [...new Set(out)].sort()
}

/**
 * (rule, entity, [variant,] trigger date) — CLAUDE.md §3.
 *
 * The entity is in it because one rule watches many things; the trigger date
 * is in it because T−30 and T−15 on the same guarantee are two different
 * reminders, not one repeated.
 *
 * **The trigger date is always the last segment**, and everything before it
 * identifies the series. `supersedeOlder` relies on that: it closes older
 * warnings by comparing rows that share the prefix, so a lorry's PUC reminder
 * never closes its fitness reminder.
 */
export const dedupeKey = (
  ruleCode: string, entityType: string, entityId: string, triggerDate: ISODate,
  variant?: string | null,
): string =>
  `${ruleCode}:${entityType}:${entityId}${variant ? `:${variant}` : ''}:${triggerDate}`

/** Every task that should exist today for this rule and this candidate. */
export function tasksFor(
  rule: Rule,
  candidate: Candidate,
  today: ISODate = todayIST(),
  windowDays = DEFAULT_WINDOW_DAYS,
): TaskSpec[] {
  if (candidate.resolved) return []

  return triggerDates(rule, candidate.anchorDate, today, windowDays).map((triggerDate) => ({
    dedupeKey: dedupeKey(
      rule.code, candidate.entityType, candidate.entityId, triggerDate, candidate.variant),
    ruleCode: rule.code,
    firmId: candidate.firmId,
    projectId: candidate.projectId ?? null,
    entityType: candidate.entityType,
    entityId: candidate.entityId,
    title: candidate.title,
    description: candidate.description ?? null,
    dueDate: candidate.anchorDate,
    triggerDate,
    priority: candidate.priority ?? rule.defaultPriority,
    role: rule.defaultRole,
    responsibility: rule.defaultResponsibility,
  }))
}

/** Everything a whole rule produces across its candidates. */
export function runRule(
  rule: Rule,
  candidates: Candidate[],
  today: ISODate = todayIST(),
  windowDays = DEFAULT_WINDOW_DAYS,
): TaskSpec[] {
  return candidates.flatMap((c) => tasksFor(rule, c, today, windowDays))
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

export interface OpenTask {
  id: string
  ruleCode: string | null
  dueDate: ISODate | null
  escalatedAt: string | null
  snoozedUntil: ISODate | null
  /** When the task appeared. Escalation needs it — see below. */
  createdOn: ISODate | null
}

/**
 * Which open tasks have gone past the point of being someone else's problem.
 *
 * Escalation is per rule: a lapsed bank guarantee escalates the day after it is
 * due, a security deposit claim after a week. A snoozed task is not overdue —
 * somebody has looked at it and said not yet, and overriding that would teach
 * people that snoozing does nothing.
 *
 * The task must ALSO have existed for that long. "Overdue plus three days"
 * means nobody acted for three days after being told, and you cannot ignore
 * something you were only just shown. Without this, switching the engine on
 * escalated twenty-one of the first twenty-eight tasks straight to the Owner —
 * every one of them for a deadline that had passed before the system knew
 * about it.
 */
export function toEscalate(
  tasks: OpenTask[],
  rules: Map<string, Rule>,
  today: ISODate = todayIST(),
): OpenTask[] {
  return tasks.filter((t) => {
    if (t.escalatedAt) return false
    if (!t.dueDate) return false
    if (t.snoozedUntil && t.snoozedUntil >= today) return false

    /* Written out rather than chained: `ruleCode && rules.get(...)` yields the
       empty string for a task with no rule, and `number > ''` is quietly false
       forever — the task would simply never escalate. */
    const rule = t.ruleCode ? rules.get(t.ruleCode) : undefined
    const after = rule?.escalateAfterDays ?? 3

    if (daysBetween(t.dueDate, today) <= after) return false
    // A task with no creation date is old enough by definition.
    if (t.createdOn && daysBetween(t.createdOn, today) <= after) return false
    return true
  })
}
