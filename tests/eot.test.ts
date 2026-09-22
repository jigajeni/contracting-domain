import { describe, expect, it } from 'vitest'
import { isoDate } from '@/domain/dates'
import { buildPack, draftGrounds, type EotEvent } from '@/domain/works/eot'

const d = isoDate
const ev = (
  id: string, from: string, to: string | null,
  over: Partial<EotEvent> = {},
): EotEvent => ({
  id, startDate: d(from), endDate: to ? d(to) : null,
  attribution: 'department', cause: 'drawings_not_received', title: `Event ${id}`,
  blockingParty: 'PWD Sub Division, Jath', documents: 1, alreadyClaimed: false,
  ...over,
})

const asOf = d('2026-09-15')
const base = {
  stipulatedCompletion: d('2026-12-31'), daysGranted: 0, asOf,
}

describe('what may be claimed at all', () => {
  it('drops our own fault, whatever is selected', () => {
    const events = [
      ev('a', '2026-04-01', '2026-04-30'),
      ev('b', '2026-05-01', '2026-05-10', { attribution: 'us' }),
    ]
    const p = buildPack({ ...base, events, selectedIds: ['a', 'b'] })
    expect(p.eligible.map((e) => e.id)).toEqual(['a'])
    expect(p.included.map((e) => e.id)).toEqual(['a'])
    expect(p.daysClaimed).toBe(30)
  })

  /* Claiming the same days in two applications is how a department stops
     believing a file. */
  it('drops an event already carried in a granted extension', () => {
    const p = buildPack({
      ...base,
      events: [ev('a', '2026-04-01', '2026-04-30', { alreadyClaimed: true })],
      selectedIds: ['a'],
    })
    expect(p.eligible).toHaveLength(0)
    expect(p.canSubmit).toBe(false)
    expect(p.problems[0]!.message).toMatch(/already carried/i)
  })
})

describe('the day count', () => {
  /* The commonest reason a pack comes back. Two events overlapping are one
     standstill. */
  it('is the merged count, not the sum', () => {
    const p = buildPack({
      ...base,
      events: [ev('a', '2026-04-01', '2026-04-29'), ev('b', '2026-04-10', '2026-04-20')],
      selectedIds: ['a', 'b'],
    })
    expect(p.daysClaimed).toBe(29)
    expect(p.daysClaimed).not.toBe(40)
  })

  /* The envelope and the count differ wherever the delays were not continuous,
     and that gap is the first thing a department asks about — so it is
     reported rather than quietly smoothed. */
  it('reports the period envelope separately from the days claimed', () => {
    const p = buildPack({
      ...base,
      events: [ev('a', '2026-04-01', '2026-04-10'), ev('b', '2026-06-01', '2026-06-10')],
      selectedIds: ['a', 'b'],
    })
    expect(p.daysClaimed).toBe(20)
    expect(p.periodFrom).toBe(d('2026-04-01'))
    expect(p.periodTo).toBe(d('2026-06-10'))
    expect(p.periodDays).toBe(71)
  })

  it('claims an open event up to today and never beyond', () => {
    const p = buildPack({
      ...base, events: [ev('a', '2026-09-01', null)], selectedIds: ['a'],
    })
    expect(p.daysClaimed).toBe(15)
    expect(p.periodTo).toBe(asOf)
  })
})

describe('the filing deadline', () => {
  /* Fifteen days before the completion date, and late filing carries its own
     penalty — CLAUDE.md §3. */
  it('is fifteen days before the date being extended', () => {
    const p = buildPack({
      ...base, events: [ev('a', '2026-04-01', '2026-04-30')], selectedIds: ['a'],
    })
    expect(p.filingDeadline).toBe(d('2026-12-16'))
    expect(p.daysToFile).toBe(92)
  })

  it('counts from the date already extended to, not the original', () => {
    const p = buildPack({
      ...base, daysGranted: 30,
      events: [ev('a', '2026-04-01', '2026-04-30')], selectedIds: ['a'],
    })
    expect(p.filingDeadline).toBe(d('2027-01-15'))
  })

  it('says how late it is, and that it is still worth filing', () => {
    const p = buildPack({
      ...base, stipulatedCompletion: d('2026-08-01'),
      events: [ev('a', '2026-04-01', '2026-04-30')], selectedIds: ['a'],
    })
    expect(p.daysToFile).toBeLessThan(0)
    const late = p.problems.find((x) => x.message.includes('days ago'))!
    expect(late.severity).toBe('weak')
    expect(late.message).toMatch(/still worth filing/i)
    /* Late is not a reason to block — an unfiled claim is worth nothing at all. */
    expect(p.canSubmit).toBe(true)
  })
})

describe('what makes a pack weak rather than impossible', () => {
  it('flags events with no evidence without blocking', () => {
    const p = buildPack({
      ...base,
      events: [ev('a', '2026-04-01', '2026-04-30', { documents: 0 })],
      selectedIds: ['a'],
    })
    expect(p.canSubmit).toBe(true)
    expect(p.problems.some((x) => x.severity === 'weak'
      && /correspondence/i.test(x.message))).toBe(true)
  })

  it('blocks a work with no stipulated completion date', () => {
    const p = buildPack({
      ...base, stipulatedCompletion: null,
      events: [ev('a', '2026-04-01', '2026-04-30')], selectedIds: ['a'],
    })
    expect(p.canSubmit).toBe(false)
    expect(p.filingDeadline).toBeNull()
  })
})

describe('the revised completion date', () => {
  it('adds what is already granted and what is being claimed', () => {
    const p = buildPack({
      ...base, daysGranted: 30,
      events: [ev('a', '2026-04-01', '2026-04-30')], selectedIds: ['a'],
    })
    /* 31-12-2026 plus thirty granted plus thirty claimed is sixty days, not
       thirty. My first expectation here was the original date plus one of the
       two — the exact mistake of treating an extension already granted as
       though it were the thing being applied for. */
    expect(p.revisedCompletion).toBe(d('2027-03-01'))
  })
})

describe('the draft grounds', () => {
  const p = buildPack({
    ...base,
    events: [
      ev('a', '2026-04-01', '2026-04-29', { title: 'Land not handed over' }),
      ev('b', '2026-04-10', '2026-04-20', {
        title: 'Drawings not received', correspondenceRef: 'Letter 442/2026' }),
    ],
    selectedIds: ['a', 'b'],
  })
  const text = draftGrounds(p, 'Approach road, Ankale')

  it('names each event with its dates and its reference', () => {
    expect(text).toContain('Land not handed over')
    expect(text).toContain('01-04-2026')
    expect(text).toContain('Letter 442/2026')
  })

  /* Dates in the office's own format, never an ISO string — CLAUDE.md §0.4. */
  it('writes dates as DD-MM-YYYY', () => {
    expect(text).toContain('29-04-2026')
    expect(text).not.toContain('2026-04-29')
  })

  /* Saying it before the department asks is the difference between a
     clarification and a correction. */
  it('explains the overlap rather than leaving it to be queried', () => {
    expect(text).toMatch(/overlap/i)
    expect(text).toContain('29 calendar days')
  })

  it('is empty when nothing is included, rather than a sentence about nothing', () => {
    expect(draftGrounds(buildPack({ ...base, events: [], selectedIds: [] }), 'X'))
      .toBe('')
  })
})
