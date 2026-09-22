import { describe, expect, it } from 'vitest'
import type { ISODate } from '@/domain/dates'
import {
  DEFAULT_WINDOW_DAYS, dedupeKey, runRule, tasksFor, toEscalate, triggerDates,
  type Candidate, type OpenTask, type Rule,
} from '@/domain/alerts/engine'

const d = (s: string) => s as ISODate
const TODAY = d('2026-09-04')

/**
 * The rules as they are actually configured in alert_rules, so a change to the
 * seeded offsets shows up here rather than silently altering what the office
 * gets chased about.
 */
const BG_EXPIRY: Rule = {
  code: 'BG_EXPIRY', entityType: 'bank_instrument',
  offsetsDays: [60, 45, 30, 15], repeatDays: null,
  defaultRole: 'admin', defaultResponsibility: null, defaultPriority: 'critical', escalateAfterDays: 1,
}
const EMD_REFUND: Rule = {
  code: 'EMD_REFUND', entityType: 'tender',
  offsetsDays: [-15], repeatDays: 15,
  defaultRole: 'accounts', defaultResponsibility: null, defaultPriority: 'normal', escalateAfterDays: 7,
}
const LICENCE_RENEWAL: Rule = {
  code: 'LICENCE_RENEWAL', entityType: 'licence',
  offsetsDays: [150, 120, 100, 90], repeatDays: null,
  defaultRole: 'admin', defaultResponsibility: null, defaultPriority: 'high', escalateAfterDays: 3,
}

const candidate = (o: Partial<Candidate> = {}): Candidate => ({
  entityType: 'bank_instrument', entityId: 'e1', firmId: 'f1',
  anchorDate: d('2026-10-04'), title: 'Performance BG expires', ...o,
})

describe('when a rule fires', () => {
  it('warns before the date, at each offset reached', () => {
    // A guarantee expiring on 04-11-2026, seen on 04-09-2026: sixty days out,
    // so only the T−60 warning has arrived.
    expect(triggerDates(BG_EXPIRY, d('2026-11-03'), TODAY)).toEqual(['2026-09-04'])
  })

  it('accumulates warnings as the date approaches', () => {
    // Expiring 20-09-2026 — T−60, T−45 and T−30 have all passed, T−15 is today.
    const t = triggerDates(BG_EXPIRY, d('2026-09-19'), TODAY)
    expect(t).toContain('2026-09-04')      // T−15, today
    expect(t.length).toBeGreaterThan(1)
  })

  it('says nothing before the first offset is reached', () => {
    // Expiring in a year. Nothing to do about it yet.
    expect(triggerDates(BG_EXPIRY, d('2027-09-04'), TODAY)).toEqual([])
  })

  it('counts forward when the offset is negative', () => {
    // BILL_STUCK is [-15]: fifteen days AFTER the bill entered its stage.
    const stuck: Rule = { ...BG_EXPIRY, code: 'BILL_STUCK', offsetsDays: [-15], repeatDays: null }
    expect(triggerDates(stuck, d('2026-08-20'), TODAY)).toEqual(['2026-09-04'])
    // Only fourteen days in — not yet.
    expect(triggerDates(stuck, d('2026-08-21'), TODAY)).toEqual([])
  })

  it('gives the renewal lead the licence actually needs', () => {
    // The papers must REACH the department three months before expiry, so the
    // first nudge is at T−150, not at T−30. CLAUDE.md §3.
    const t = triggerDates(LICENCE_RENEWAL, d('2027-01-01'), TODAY)
    expect(t[0]).toBe('2026-08-04')      // 150 days before 01-01-2027
    expect(t).toContain('2026-09-03')    // and T−120, also already passed
  })

  it('produces every offset already reached, not just the newest', () => {
    /* On a nightly run each of these appears on its own day and is deduped
       thereafter. They pile up only on a first run against existing data —
       which is right: they are warnings that were genuinely missed, and the
       window is what stops that becoming a flood. */
    const t = triggerDates(BG_EXPIRY, d('2026-10-04'), TODAY)
    expect(t).toEqual(['2026-08-05', '2026-08-20', '2026-09-04'])
  })
})

describe('rules that keep asking', () => {
  it('nudges every fifteen days until the refund lands', () => {
    // Result on 01-08-2026: first chase at +15, then every fortnight.
    const t = triggerDates(EMD_REFUND, d('2026-08-01'), TODAY)
    expect(t).toEqual(['2026-08-16', '2026-08-31'])
  })

  it('does not generate two years of nudges on the first run', () => {
    /* The reason the window exists. An EMD unrefunded since 2024 would
       otherwise produce fifty tasks the moment the engine is switched on, and
       fifty tasks nobody reads is the same as none. */
    const t = triggerDates(EMD_REFUND, d('2024-06-01'), TODAY)
    expect(t.length).toBeLessThanOrEqual(Math.ceil(DEFAULT_WINDOW_DAYS / 15) + 1)
    expect(t.every((x) => x >= '2026-07-06')).toBe(true)
  })

  it('respects a window the caller narrows', () => {
    expect(triggerDates(EMD_REFUND, d('2026-01-01'), TODAY, 20).length).toBeLessThanOrEqual(2)
  })

  it('never repeats a date it already produced', () => {
    const t = triggerDates(EMD_REFUND, d('2026-08-20'), TODAY)
    expect(new Set(t).size).toBe(t.length)
  })
})

describe('the dedupe key', () => {
  it('is the rule, the thing and the day it fired', () => {
    expect(dedupeKey('BG_EXPIRY', 'bank_instrument', 'abc', d('2026-09-04')))
      .toBe('BG_EXPIRY:bank_instrument:abc:2026-09-04')
  })

  it('separates two warnings on the same guarantee', () => {
    // T−30 and T−15 are two different reminders, not one repeated.
    const specs = tasksFor(BG_EXPIRY, candidate({ anchorDate: d('2026-09-19') }), TODAY)
    expect(new Set(specs.map((s) => s.dedupeKey)).size).toBe(specs.length)
  })

  it('separates several dates on one row', () => {
    /* A lorry carries four expiry dates — insurance, fitness, PUC, permit. They
       are one machine and four reminders. Keyed on the machine alone, two
       falling on the same day would collide and only one would ever be
       written, with nothing to show it had happened. */
    const machine = { entityType: 'machinery', entityId: 'm1', firmId: 'f1',
                      anchorDate: d('2026-10-04'), title: 'expires' }
    const fitness = tasksFor(BG_EXPIRY, { ...machine, variant: 'fitness' }, TODAY)
    const puc = tasksFor(BG_EXPIRY, { ...machine, variant: 'puc' }, TODAY)
    expect(fitness[0]!.dedupeKey).not.toBe(puc[0]!.dedupeKey)
    expect(fitness[0]!.dedupeKey).toContain(':fitness:')
  })

  it('leaves the key alone when there is only one date', () => {
    // Existing keys must not shift, or every task in the database is orphaned
    // and the next run writes a duplicate of all of them.
    expect(dedupeKey('BG_EXPIRY', 'bank_instrument', 'abc', d('2026-09-04')))
      .toBe('BG_EXPIRY:bank_instrument:abc:2026-09-04')
  })

  it('always ends with the trigger date', () => {
    /* supersedeOlder closes older warnings by comparing everything before the
       last segment. If a variant were appended after the date instead, a
       lorry's PUC reminder would close its fitness reminder. */
    for (const variant of [undefined, 'puc']) {
      const key = dedupeKey('R', 'machinery', 'm1', d('2026-09-04'), variant)
      expect(key.slice(key.lastIndexOf(':') + 1)).toBe('2026-09-04')
    }
  })

  it('is stable, so running the job twice produces the same keys', () => {
    const once = tasksFor(BG_EXPIRY, candidate(), TODAY).map((s) => s.dedupeKey)
    const twice = tasksFor(BG_EXPIRY, candidate(), TODAY).map((s) => s.dedupeKey)
    expect(once).toEqual(twice)
  })
})

describe('the task produced', () => {
  it('is due on the date that matters, not the day it fired', () => {
    const specs = tasksFor(BG_EXPIRY, candidate({ anchorDate: d('2026-10-04') }), TODAY)
    // Every one is due when the guarantee expires...
    expect(specs.every((s) => s.dueDate === '2026-10-04')).toBe(true)
    // ...and each carries the day its own warning was meant to appear.
    expect(specs.map((s) => s.triggerDate)).toEqual(['2026-08-05', '2026-08-20', '2026-09-04'])
  })

  it('carries the rule’s own urgency and owner', () => {
    const [task] = tasksFor(BG_EXPIRY, candidate(), TODAY)
    expect(task!.priority).toBe('critical')
    expect(task!.role).toBe('admin')
  })

  it('lets a candidate override the priority', () => {
    const [task] = tasksFor(BG_EXPIRY, candidate({ priority: 'low' }), TODAY)
    expect(task!.priority).toBe('low')
  })

  it('says nothing about something already dealt with', () => {
    // The refund arrived, the bill moved on, the licence was renewed.
    expect(tasksFor(EMD_REFUND, candidate({
      anchorDate: d('2026-08-01'), resolved: true,
    }), TODAY)).toEqual([])
  })

  it('runs across many candidates at once', () => {
    const specs = runRule(BG_EXPIRY, [
      candidate({ entityId: 'a', anchorDate: d('2026-10-04') }),
      candidate({ entityId: 'b', anchorDate: d('2026-09-19') }),
      candidate({ entityId: 'c', anchorDate: d('2028-01-01') }),   // far off
    ], TODAY)
    expect(new Set(specs.map((s) => s.entityId))).toEqual(new Set(['a', 'b']))
  })
})

describe('escalation', () => {
  const rules = new Map<string, Rule>([
    ['BG_EXPIRY', BG_EXPIRY],       // escalates after 1 day
    ['EMD_REFUND', EMD_REFUND],     // after 7
  ])
  const task = (o: Partial<OpenTask> = {}): OpenTask => ({
    id: 't1', ruleCode: 'BG_EXPIRY', dueDate: d('2026-09-01'),
    escalatedAt: null, snoozedUntil: null, createdOn: d('2026-07-01'), ...o,
  })

  it('escalates once a task is past its rule’s patience', () => {
    // Due 01-09, escalates after one day, and it is the 4th.
    expect(toEscalate([task()], rules, TODAY).map((t) => t.id)).toEqual(['t1'])
  })

  it('gives a slower rule longer', () => {
    const emd = task({ ruleCode: 'EMD_REFUND', dueDate: d('2026-08-30') })
    expect(toEscalate([emd], rules, TODAY)).toEqual([])       // five days, needs seven
    const older = task({ ruleCode: 'EMD_REFUND', dueDate: d('2026-08-20') })
    expect(toEscalate([older], rules, TODAY)).toHaveLength(1)
  })

  it('does not escalate a task the moment it is created', () => {
    /* Switching the engine on generates tasks for deadlines that passed before
       the system knew about them. Escalating those immediately would put
       twenty-one critical items on the Owner on day one, for things nobody
       had been shown. */
    const fresh = task({ dueDate: d('2026-06-01'), createdOn: TODAY })
    expect(toEscalate([fresh], rules, TODAY)).toEqual([])
  })

  it('escalates it once it has been sitting there', () => {
    const seen = task({ dueDate: d('2026-06-01'), createdOn: d('2026-08-25') })
    expect(toEscalate([seen], rules, TODAY)).toHaveLength(1)
  })

  it('leaves a snoozed task alone', () => {
    /* Somebody looked at it and said not yet. Escalating anyway would teach
       people that snoozing does nothing, and then nobody snoozes honestly. */
    const snoozed = task({ snoozedUntil: d('2026-09-30') })
    expect(toEscalate([snoozed], rules, TODAY)).toEqual([])
  })

  it('escalates once a snooze has run out', () => {
    expect(toEscalate([task({ snoozedUntil: d('2026-09-01') })], rules, TODAY))
      .toHaveLength(1)
  })

  it('does not escalate the same task twice', () => {
    expect(toEscalate([task({ escalatedAt: '2026-09-02T10:00:00Z' })], rules, TODAY))
      .toEqual([])
  })

  it('still escalates a task with no rule code at all', () => {
    // An empty rule code must fall back to the default, not disable escalation.
    const orphan = task({ ruleCode: '', dueDate: d('2026-08-01') })
    expect(toEscalate([orphan], rules, TODAY)).toHaveLength(1)
  })

  it('ignores a task with no due date and an unknown rule', () => {
    expect(toEscalate([task({ dueDate: null })], rules, TODAY)).toEqual([])
    const unknown = task({ ruleCode: 'NOT_A_RULE', dueDate: d('2026-08-01') })
    expect(toEscalate([unknown], rules, TODAY)).toHaveLength(1)   // falls back to 3 days
  })
})
