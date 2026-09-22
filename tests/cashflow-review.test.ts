import { describe, expect, it } from 'vitest'
import { isoDate, type ISODate } from '@/domain/dates'
import { paise, type Paise } from '@/domain/money'
import {
  STALE_AFTER_DAYS, classify, reviewQueue, summarise,
  type ReviewLine,
} from '@/domain/cashflow/review'

/**
 * The forecast is a function of this screen. These tests pin the four states
 * and, more importantly, the two judgements that decide whether the screen
 * tells the truth: that overdue outranks freshly-reviewed, and that coverage
 * is measured in rupees rather than in rows.
 */

const TODAY = isoDate('2026-09-11')

const line = (over: Partial<ReviewLine> = {}): ReviewLine => ({
  key: 'k', billId: 'b', inflowId: 'i', source: 'ra_bill',
  clientName: 'PWD Sub Division, Jath', projectCode: 'SIPL/2026/PWD/004',
  projectName: 'Approach road, Ankale', label: '3rd RA bill',
  outstandingPaise: paise(100_00_000_00n), cashPaise: paise(100_00_000_00n),
  since: isoDate('2026-07-01'), stage: 'checked_ee',
  expectedDate: isoDate('2026-10-01'), confidence: 'medium', notes: null,
  reviewedOn: isoDate('2026-09-09'), arrangement: null,
  ...over,
})

describe('classify', () => {
  it('is missing when no date has ever been given', () => {
    expect(classify(line({ expectedDate: null }), TODAY)).toBe('missing')
  })

  it('is missing even when the row was reviewed — a review that left it blank is not a date', () => {
    expect(classify(line({ expectedDate: null, reviewedOn: TODAY }), TODAY)).toBe('missing')
  })

  it('is current inside the window', () => {
    expect(classify(line(), TODAY)).toBe('current')
  })

  it('is stale one day past the window', () => {
    const reviewed = isoDate('2026-09-03') // 8 days
    expect(STALE_AFTER_DAYS).toBe(7)
    expect(classify(line({ reviewedOn: reviewed }), TODAY)).toBe('stale')
  })

  it('is stale exactly at the boundary only after it, not on it', () => {
    expect(classify(line({ reviewedOn: isoDate('2026-09-04') }), TODAY)).toBe('current')
  })

  it('is stale when it has never been reviewed', () => {
    expect(classify(line({ reviewedOn: null }), TODAY)).toBe('stale')
  })

  /* The one that matters. buildForecast sweeps a past-dated inflow into week
     one, so a passed date is the forecast actively claiming cash lands this
     week — and somebody having looked at it yesterday does not make that true. */
  it('is overdue even when reviewed today', () => {
    expect(classify(
      line({ expectedDate: isoDate('2026-09-01'), reviewedOn: TODAY }), TODAY,
    )).toBe('overdue')
  })

  it('treats today itself as still to come', () => {
    expect(classify(line({ expectedDate: TODAY }), TODAY)).toBe('current')
  })
})

describe('reviewQueue', () => {
  it('puts the worst state first, and the biggest money first inside it', () => {
    const q = reviewQueue([
      line({ key: 'current-big', outstandingPaise: paise(900_00_000_00n), cashPaise: paise(900_00_000_00n) }),
      line({ key: 'missing-small', expectedDate: null, outstandingPaise: paise(1_00_000_00n), cashPaise: paise(1_00_000_00n) }),
      line({ key: 'missing-big', expectedDate: null, outstandingPaise: paise(50_00_000_00n), cashPaise: paise(50_00_000_00n) }),
      line({ key: 'overdue', expectedDate: isoDate('2026-08-01'),
             outstandingPaise: paise(2_00_000_00n), cashPaise: paise(2_00_000_00n) }),
    ], TODAY)
    expect(q.map((l) => l.key))
      .toEqual(['overdue', 'missing-big', 'missing-small', 'current-big'])
  })

  it('counts the slip in days from the expected date', () => {
    const [l] = reviewQueue([line({ expectedDate: isoDate('2026-08-12') })], TODAY)
    expect(l!.slipDays).toBe(30)
    expect(l!.state).toBe('overdue')
  })

  it('leaves slipDays at zero for anything not overdue', () => {
    const [l] = reviewQueue([line()], TODAY)
    expect(l!.slipDays).toBe(0)
  })

  it('ages from submission, and copes with a line that has no start date', () => {
    const q = reviewQueue([line(), line({ key: 'x', since: null })], TODAY)
    expect(q.find((l) => l.key === 'k')!.ageDays).toBe(72)
    expect(q.find((l) => l.key === 'x')!.ageDays).toBeNull()
  })
})

describe('summarise', () => {
  /* Coverage by money, not by count — the whole reason the figure is worth
     printing. Twenty dated bills of ₹1 lakh beside one undated crore is 17%
     covered, and by count it would read 95%. */
  it('measures coverage in rupees', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      line({ key: `small-${i}`, outstandingPaise: paise(1_00_000_00n), cashPaise: paise(1_00_000_00n) }))
    const s = summarise(reviewQueue([
      ...many,
      line({ key: 'big', expectedDate: null, outstandingPaise: paise(100_00_000_00n), cashPaise: paise(100_00_000_00n) }),
    ], TODAY))

    expect(s.counts.missing).toBe(1)
    expect(s.counts.current).toBe(20)
    expect(s.totalPaise).toBe(120_00_000_00n as Paise)
    expect(s.missingPaise).toBe(100_00_000_00n as Paise)
    expect(s.forecastPaise).toBe(20_00_000_00n as Paise)
    expect(s.coveragePct).toBe(16)
  })

  it('counts an overdue line as visible to the forecast, because it is', () => {
    const s = summarise(reviewQueue([
      line({ expectedDate: isoDate('2026-08-01') }),
    ], TODAY))
    expect(s.missingPaise).toBe(0n as Paise)
    expect(s.coveragePct).toBe(100)
    expect(s.overduePaise).toBe(100_00_000_00n as Paise)
    /* Wrong is not the same as absent, and they are fixed differently: one
       needs a new date, the other needs any date. */
    expect(s.outstandingCount).toBe(1)
  })

  it('reports full coverage on an empty list rather than dividing by zero', () => {
    const s = summarise([])
    expect(s.coveragePct).toBe(100)
    expect(s.outstandingCount).toBe(0)
    expect(s.totalPaise).toBe(0n as Paise)
  })

  it('excludes only current lines from the work to do', () => {
    const s = summarise(reviewQueue([
      line({ key: 'a' }),
      line({ key: 'b', reviewedOn: null }),
      line({ key: 'c', expectedDate: null }),
      line({ key: 'd', expectedDate: isoDate('2026-01-01') }),
    ], TODAY))
    expect(s.counts).toEqual({ current: 1, stale: 1, missing: 1, overdue: 1 })
    expect(s.outstandingCount).toBe(3)
  })
})

describe('an arrangement line carries two figures', () => {
  /* The row shows the department's bill so it matches the paperwork; every
     total is built from the cash. Before this, the review said ₹2.91 crore was
     owed and the forecast said ₹2.88 crore, and neither screen explained the
     difference. */
  it('totals the cash, not the department figure', () => {
    const s = summarise(reviewQueue([
      line({ key: 'arr', outstandingPaise: paise(48_61_600_00n),
             cashPaise: paise(46_96_800_00n) }),
    ], TODAY))
    expect(s.totalPaise).toBe(46_96_800_00n as Paise)
  })

  it('orders by cash too, so a heavily-netted line does not jump the queue', () => {
    const q = reviewQueue([
      line({ key: 'big-bill-small-cash', outstandingPaise: paise(90_00_000_00n),
             cashPaise: paise(5_00_000_00n) }),
      line({ key: 'plain', outstandingPaise: paise(10_00_000_00n),
             cashPaise: paise(10_00_000_00n) }),
    ], TODAY)
    expect(q.map((l) => l.key)).toEqual(['plain', 'big-bill-small-cash'])
  })
})

/** Guards a real trap: ISO dates compare correctly as strings, DD-MM ones do not. */
describe('date comparison', () => {
  it('orders across a month boundary', () => {
    const dates: ISODate[] = [isoDate('2026-10-01'), isoDate('2026-09-30')]
    expect(dates[0]! > dates[1]!).toBe(true)
  })
})
