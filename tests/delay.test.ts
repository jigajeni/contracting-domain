import { describe, expect, it } from 'vitest'
import { isoDate } from '@/domain/dates'
import {
  daysCovered, ldExposure, mergeIntervals, rollUp, summarise, type DelayEvent,
} from '@/domain/works/delay'

const d = isoDate
const ev = (
  id: string, from: string, to: string | null,
  attribution: DelayEvent['attribution'] = 'department',
  blockingParty: string | null = 'PWD Sub Division, Jath',
): DelayEvent => ({
  id, startDate: d(from), endDate: to ? d(to) : null,
  attribution, cause: 'other', title: id, blockingParty,
})

describe('counting calendar days, not events', () => {
  /* The whole point. Land not handed over 1st–30th and drawings not received
     10th–20th is twenty-nine days of standstill, not forty. An application for
     forty against a thirty-day standstill reads as carelessness at best, and
     it is thrown out at the counter. */
  it('counts an overlap once', () => {
    expect(daysCovered([
      { from: d('2026-04-01'), to: d('2026-04-29') },
      { from: d('2026-04-10'), to: d('2026-04-20') },
    ])).toBe(29)
  })

  it('does not simply add the two', () => {
    expect(daysCovered([
      { from: d('2026-04-01'), to: d('2026-04-29') },
      { from: d('2026-04-10'), to: d('2026-04-20') },
    ])).not.toBe(40)
  })

  it('includes both ends of a single day', () => {
    expect(daysCovered([{ from: d('2026-04-05'), to: d('2026-04-05') }])).toBe(1)
  })

  /* An event ending on the 10th and another starting on the 11th is one
     continuous shutdown. Leaving a seam is only presentational until somebody
     sums the day counts. */
  it('joins abutting intervals', () => {
    expect(mergeIntervals([
      { from: d('2026-04-01'), to: d('2026-04-10') },
      { from: d('2026-04-11'), to: d('2026-04-20') },
    ])).toHaveLength(1)
    expect(daysCovered([
      { from: d('2026-04-01'), to: d('2026-04-10') },
      { from: d('2026-04-11'), to: d('2026-04-20') },
    ])).toBe(20)
  })

  it('keeps a real gap as two intervals', () => {
    expect(mergeIntervals([
      { from: d('2026-04-01'), to: d('2026-04-10') },
      { from: d('2026-04-13'), to: d('2026-04-20') },
    ])).toHaveLength(2)
  })

  it('swallows an interval entirely inside another', () => {
    expect(daysCovered([
      { from: d('2026-04-01'), to: d('2026-04-30') },
      { from: d('2026-04-10'), to: d('2026-04-12') },
    ])).toBe(30)
  })

  it('counts nothing when there is nothing', () => {
    expect(daysCovered([])).toBe(0)
  })
})

describe('what can be claimed', () => {
  const asOf = d('2026-09-15')

  it('separates what the department owes from what we do', () => {
    const s = summarise([
      ev('a', '2026-04-01', '2026-04-30', 'department'),
      ev('b', '2026-05-01', '2026-05-10', 'us', null),
    ], asOf)
    expect(s.totalDaysLost).toBe(40)
    expect(s.claimableDays).toBe(30)
    expect(s.ownFaultDays).toBe(10)
  })

  /* Our own fault inside a departmental standstill costs nothing extra — the
     work was already stopped — but it must not be claimed either. */
  it('does not claim our own days hidden inside a departmental delay', () => {
    const s = summarise([
      ev('a', '2026-04-01', '2026-04-30', 'department'),
      ev('b', '2026-04-10', '2026-04-15', 'us', null),
    ], asOf)
    expect(s.totalDaysLost).toBe(30)
    expect(s.claimableDays).toBe(30)
    expect(s.ownFaultDays).toBe(6)
  })

  it('treats rain as claimable and our own shortage as not', () => {
    const s = summarise([
      ev('rain', '2026-06-01', '2026-06-20', 'neutral', null),
      ev('mine', '2026-07-01', '2026-07-05', 'us', null),
    ], asOf)
    expect(s.claimableDays).toBe(20)
    expect(s.byAttribution.neutral).toBe(20)
    expect(s.byAttribution.us).toBe(5)
  })

  /* An open event is still costing days today, so it counts to today. */
  it('counts an open event up to today', () => {
    const s = summarise([ev('a', '2026-09-01', null, 'department')], asOf)
    expect(s.totalDaysLost).toBe(15)
    expect(s.openEvents).toBe(1)
  })
})

describe('who is blocking us', () => {
  const asOf = d('2026-09-15')

  it('groups by party, biggest first, and merges within each', () => {
    const s = summarise([
      ev('a', '2026-04-01', '2026-04-30', 'department', 'PWD Jath'),
      ev('b', '2026-04-10', '2026-04-20', 'department', 'PWD Jath'),
      ev('c', '2026-05-01', '2026-05-05', 'third_party', 'MSEDCL'),
    ], asOf)
    expect(s.byParty[0]).toEqual({ party: 'PWD Jath', days: 30, events: 2 })
    expect(s.byParty[1]).toEqual({ party: 'MSEDCL', days: 5, events: 1 })
  })

  /* Our own delays must not appear in a list headed "who is blocking us"
     under a name that sounds like somebody else's. */
  it('names our own fault as us, never as unnamed', () => {
    const s = summarise([ev('a', '2026-04-01', '2026-04-05', 'us', null)], asOf)
    expect(s.byParty[0]!.party).toBe('Us')
  })
})

describe('what it costs, or saves', () => {
  const asOf = d('2026-09-15')

  it('measures overrun against the extended date, not the original', () => {
    const e = ldExposure({
      stipulatedCompletion: d('2026-06-30'), daysGranted: 30,
      claimableDays: 0, actualCompletion: null, asOf,
    })
    expect(e.revisedCompletion).toBe(d('2026-07-30'))
    expect(e.daysOverrun).toBe(47)
  })

  /* The gap between these two is exactly what an EOT application is worth,
     which is the number somebody needs before deciding whether to file one. */
  it('says how much of the overrun an application could remove', () => {
    const e = ldExposure({
      stipulatedCompletion: d('2026-06-30'), daysGranted: 0,
      claimableDays: 60, actualCompletion: null, asOf,
    })
    expect(e.daysOverrun).toBe(77)
    expect(e.daysOverrunIfClaimed).toBe(17)
    expect(e.daysRecoverable).toBe(60)
  })

  /* Claimable days are not credit. A work finished early does not bank them
     against the next one, and a negative would invite exactly that reading. */
  it('never turns unused claimable days into a negative overrun', () => {
    const e = ldExposure({
      stipulatedCompletion: d('2026-12-31'), daysGranted: 0,
      claimableDays: 40, actualCompletion: null, asOf,
    })
    expect(e.daysOverrun).toBe(0)
    expect(e.daysOverrunIfClaimed).toBe(0)
    expect(e.daysRecoverable).toBe(0)
    expect(e.status).toBe('not_due')
  })

  it('measures a finished work at its completion, not at today', () => {
    const e = ldExposure({
      stipulatedCompletion: d('2026-06-30'), daysGranted: 0,
      claimableDays: 0, actualCompletion: d('2026-07-10'), asOf,
    })
    expect(e.daysOverrun).toBe(10)
    expect(e.status).toBe('overrun')
  })

  it('says so rather than guessing when there is no stipulated date', () => {
    const e = ldExposure({
      stipulatedCompletion: null, daysGranted: 0, claimableDays: 0,
      actualCompletion: null, asOf,
    })
    expect(e.status).toBe('unknown')
    expect(e.revisedCompletion).toBeNull()
  })
})

describe('rolling several works up', () => {
  /* The same trap one level up, and the one my own screen fell into: merging
     across works reported 73 days lost while the party table added to 132.
     Two sites stopped on the same Tuesday each lost that Tuesday. */
  const asOf = d('2026-09-15')
  const withProject = (e: DelayEvent, projectId: string) =>
    ({ ...e, projectId }) as DelayEvent

  it('sums across works instead of merging them', () => {
    const g = new Map<string, DelayEvent[]>([
      ['p1', [withProject(ev('a', '2026-04-01', '2026-04-30'), 'p1')]],
      ['p2', [withProject(ev('b', '2026-04-01', '2026-04-30'), 'p2')]],
    ])
    const r = rollUp(g, asOf)
    expect(r.totalDaysLost).toBe(60)
    expect(r.totalDaysLost).not.toBe(30)
  })

  it('still merges overlaps inside one work', () => {
    const g = new Map<string, DelayEvent[]>([
      ['p1', [
        withProject(ev('a', '2026-04-01', '2026-04-30'), 'p1'),
        withProject(ev('b', '2026-04-10', '2026-04-20'), 'p1'),
      ]],
    ])
    expect(rollUp(g, asOf).totalDaysLost).toBe(30)
  })

  /* The reconciliation that failed on screen: the party table has to be able
     to add up to the headline when one party is holding everything up. */
  it('has parties that reconcile with the total', () => {
    const g = new Map<string, DelayEvent[]>([
      ['p1', [withProject(ev('a', '2026-04-01', '2026-04-30', 'department', 'PWD'), 'p1')]],
      ['p2', [withProject(ev('b', '2026-04-01', '2026-04-30', 'department', 'PWD'), 'p2')]],
    ])
    const r = rollUp(g, asOf)
    expect(r.byParty[0]!.days).toBe(60)
    expect(r.byParty.reduce((n, p) => n + p.days, 0)).toBe(r.totalDaysLost)
  })
})
