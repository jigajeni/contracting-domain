import { describe, it, expect } from 'vitest'
import { isoDate } from '@/domain/dates'
import {
  HELD_UNTIL_HOUR, IMMEDIATE, MAX_FAILURES, coalesce, decide, inQuietHours,
  verdictFor, type Candidate,
} from '@/domain/notifications/push'

const c = (over: Partial<Candidate> = {}): Candidate => ({
  dedupeKey: 'BG_EXPIRY|bank_instrument|abc|2026-09-16',
  ruleCode: 'BG_EXPIRY',
  title: 'Performance BG expires in 30 days',
  dueDate: isoDate('2026-10-16'),
  overdue: false, escalated: false,
  firmName: 'Sahyadri Infra', url: '/tasks',
  ...over,
})

describe('what interrupts somebody', () => {
  it('lets the short list of costly deadlines through', () => {
    expect(decide(c(), 10).send).toBe(true)
    expect(IMMEDIATE.has('WORK_ORDER_FORMALITIES')).toBe(true)
    expect(IMMEDIATE.has('GEOTAG_UPLOAD')).toBe(true)
  })

  it('holds everything else for the digest', () => {
    // A bill stuck sixteen days is not more urgent at 11pm than at seven.
    const d = decide(c({ ruleCode: 'BILL_STUCK' }), 10)
    expect(d.send).toBe(false)
    expect(d.reason).toContain('digest')
  })

  it('always sends an escalation, whatever the rule', () => {
    // By the time it has escalated, the quiet channel has already failed once.
    const d = decide(c({ ruleCode: 'BILL_STUCK', escalated: true }), 10)
    expect(d.send).toBe(true)
    expect(d.urgency).toBe('critical')
  })

  it('ranks an overdue deadline above a coming one', () => {
    expect(decide(c({ overdue: true }), 10).urgency).toBe('critical')
    expect(decide(c(), 10).urgency).toBe('high')
  })
})

describe('quiet hours', () => {
  it('covers the night, both sides of midnight', () => {
    expect(inQuietHours(22)).toBe(true)
    expect(inQuietHours(2)).toBe(true)
    expect(inQuietHours(6)).toBe(true)
    expect(inQuietHours(7)).toBe(false)
    expect(inQuietHours(20)).toBe(false)
  })

  it('holds rather than drops — the item is not lost, only delayed', () => {
    const d = decide(c({ overdue: true }), 2)
    expect(d.send).toBe(true)
    expect(d.holdUntilHour).toBe(HELD_UNTIL_HOUR)
  })

  it('sends immediately in the day', () => {
    expect(decide(c(), 14).holdUntilHour).toBeNull()
  })
})

describe('one buzz, not eleven', () => {
  it('folds a batch into a single push named after the worst of it', () => {
    const p = coalesce([
      c({ dedupeKey: 'a', ruleCode: 'BG_EXPIRY' }),
      c({ dedupeKey: 'b', ruleCode: 'GEOTAG_UPLOAD', overdue: true,
          title: 'Geo-tagged photographs not uploaded' }),
      c({ dedupeKey: 'cc', ruleCode: 'LICENCE_RENEWAL' }),
    ], 10)!
    expect(p.title).toBe('Geo-tagged photographs not uploaded')
    expect(p.body).toContain('and 2 others')
    expect(p.covers).toHaveLength(3)
  })

  it('sends a batch of one in its own words', () => {
    // "1 other thing needs you" is a worse notification than the thing itself.
    const p = coalesce([c()], 10)!
    expect(p.body).not.toContain('other')
    expect(p.url).toBe('/tasks')
  })

  it('points a single item at itself and a batch at the list', () => {
    const one = coalesce([c({ url: '/works/1/eot' })], 10)!
    expect(one.url).toBe('/works/1/eot')
    const many = coalesce([
      c({ dedupeKey: 'a', url: '/works/1/eot' }),
      c({ dedupeKey: 'b' })], 10)!
    expect(many.url).toBe('/tasks')
  })

  it('carries one tag so a later batch replaces it rather than stacking', () => {
    expect(coalesce([c()], 10)!.tag).toBe('ops-alerts')
  })

  it('drops the whole push when nothing in it warrants one', () => {
    expect(coalesce([c({ ruleCode: 'BILL_STUCK' }),
                     c({ dedupeKey: 'b', ruleCode: 'EMD_REFUND' })], 10)).toBeNull()
  })

  it('counts only what is actually being sent', () => {
    const p = coalesce([
      c({ dedupeKey: 'a', ruleCode: 'BG_EXPIRY' }),
      c({ dedupeKey: 'b', ruleCode: 'BILL_STUCK' }),
    ], 10)!
    expect(p.covers).toEqual(['a'])
    expect(p.body).not.toContain('other')
  })
})

describe('a push service\'s reply', () => {
  it('deletes a subscription on 404 and 410, never retries it', () => {
    // Retried nightly, a dead endpoint is a queue that never drains and hides
    // the fact that somebody is no longer being reached at all.
    expect(verdictFor(404)).toBe('gone')
    expect(verdictFor(410)).toBe('gone')
  })

  it('retries what is the service\'s problem', () => {
    expect(verdictFor(429)).toBe('retry')
    expect(verdictFor(500)).toBe('retry')
    expect(verdictFor(503)).toBe('retry')
  })

  it('does not retry our own mistake', () => {
    expect(verdictFor(400)).toBe('gone')
    expect(verdictFor(403)).toBe('gone')
  })

  it('accepts the 201 a push service actually returns', () => {
    expect(verdictFor(201)).toBe('delivered')
    expect(verdictFor(200)).toBe('delivered')
  })

  it('gives up after a handful of failures either way', () => {
    expect(MAX_FAILURES).toBeGreaterThan(1)
    expect(MAX_FAILURES).toBeLessThan(20)
  })
})
