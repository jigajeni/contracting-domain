import { describe, expect, it } from 'vitest'
import type { ISODate } from '@/domain/dates'
import { formatINR, paise, type Paise } from '@/domain/money'
import {
  AGE_BUCKETS, DEFAULT_WEEKS, WEIGHT, ageReceivables, bucketFor, buildForecast,
} from '@/domain/cashflow/forecast'

const d = (s: string) => s as ISODate
const MONDAY = d('2026-09-14')
const rs = (n: number) => paise(n * 100)

const base = {
  openingPaise: rs(500_000), from: MONDAY, inflows: [], outflows: [],
}

describe('the shape of the forecast', () => {
  it('runs thirteen weeks from the start date', () => {
    const f = buildForecast(base)
    expect(f.weeks).toHaveLength(DEFAULT_WEEKS)
    expect(f.weeks[0]!.start).toBe('2026-09-14')
    expect(f.weeks[0]!.end).toBe('2026-09-20')
    expect(f.weeks[12]!.end).toBe('2026-12-13')
  })

  it('carries the closing balance into the next week', () => {
    const f = buildForecast({
      ...base,
      inflows: [{ date: d('2026-09-16'), amountPaise: rs(100_000), confidence: 'high' }],
    })
    expect(f.weeks[0]!.closingPaise).toBe(rs(600_000))
    expect(f.weeks[1]!.openingPaise).toBe(rs(600_000))
  })

  it('does not lose money that was expected before the window opened', () => {
    /* A bill expected last Tuesday and still unpaid is still owed. Dropping it
       because the date has passed flatters the forecast, which is the one
       direction a cash forecast must never be wrong in. */
    const f = buildForecast({
      ...base,
      inflows: [{ date: d('2026-08-01'), amountPaise: rs(200_000), confidence: 'high' }],
    })
    expect(f.weeks[0]!.inPaise).toBe(rs(200_000))
    expect(f.totalInPaise).toBe(rs(200_000))
  })

  it('puts a flow in exactly one week', () => {
    const f = buildForecast({
      ...base,
      inflows: [{ date: d('2026-09-21'), amountPaise: rs(100_000) }],
    })
    expect(f.weeks[0]!.inPaise).toBe(0n)
    expect(f.weeks[1]!.inPaise).toBe(rs(100_000))
    expect(f.totalInPaise).toBe(rs(100_000))
  })
})

describe('the red line', () => {
  it('names the week the money runs out', () => {
    // ₹5,00,000 opening, ₹2,00,000 committed out every week, nothing in.
    const f = buildForecast({
      ...base,
      outflows: Array.from({ length: 13 }, (_, i) => ({
        date: d(['2026-09-14','2026-09-21','2026-09-28','2026-10-05','2026-10-12',
                 '2026-10-19','2026-10-26','2026-11-02','2026-11-09','2026-11-16',
                 '2026-11-23','2026-11-30','2026-12-07'][i]!),
        amountPaise: rs(200_000),
      })),
    })
    // 5L → 3L → 1L → −1L
    expect(f.weeks[2]!.closingPaise).toBe(rs(-100_000))
    expect(f.firstShortWeek).toBe(2)
    expect(f.weeks[2]!.short).toBe(true)
  })

  it('is null when the money holds', () => {
    expect(buildForecast(base).firstShortWeek).toBeNull()
  })
})

describe('raw and weighted, side by side', () => {
  it('discounts an inflow by how likely it is, and never an outflow', () => {
    const f = buildForecast({
      ...base, openingPaise: 0n as Paise,
      inflows: [{ date: MONDAY, amountPaise: rs(100_000), confidence: 'low' }],
      outflows: [{ date: MONDAY, amountPaise: rs(10_000) }],
    })
    expect(f.weeks[0]!.inPaise).toBe(rs(100_000))
    expect(f.weeks[0]!.weightedInPaise).toBe(rs(25_000))     // low = 0.25
    expect(f.weeks[0]!.outPaise).toBe(rs(10_000))            // not discounted
    expect(f.weeks[0]!.closingPaise).toBe(rs(90_000))
    expect(f.weeks[0]!.weightedClosingPaise).toBe(rs(15_000))
  })

  it('treats a missing confidence as medium rather than certain', () => {
    const f = buildForecast({
      ...base, openingPaise: 0n as Paise,
      inflows: [{ date: MONDAY, amountPaise: rs(100_000) }],
    })
    expect(f.weeks[0]!.weightedInPaise).toBe(rs(60_000))
  })

  it('warns about a week that only fails if the optimism is wrong', () => {
    /* The interesting case, and the reason both numbers are kept. Raw says
       fine; weighted says short. That is a week to watch, not a crisis — and
       merging the two into one figure would hide which it was. */
    const f = buildForecast({
      ...base, openingPaise: 0n as Paise,
      inflows: [{ date: MONDAY, amountPaise: rs(100_000), confidence: 'low' }],
      outflows: [{ date: MONDAY, amountPaise: rs(50_000) }],
    })
    expect(f.weeks[0]!.short).toBe(false)                    // 0 + 100 − 50
    expect(f.weeks[0]!.shortIfOptimistic).toBe(true)         // 0 + 25 − 50
    expect(f.firstShortWeek).toBeNull()
    expect(f.firstWeightedShortWeek).toBe(0)
  })

  it('weights without going near a float', () => {
    // 0.6 of ₹1,23,456.78 is exact, not 0.6000000000000001 of it.
    const f = buildForecast({
      ...base, openingPaise: 0n as Paise,
      inflows: [{ date: MONDAY, amountPaise: paise(12_345_678), confidence: 'medium' }],
    })
    expect(formatINR(f.weeks[0]!.weightedInPaise)).toBe('₹74,074.06')
  })

  it('keeps high below certainty, because a passed bill still slips', () => {
    expect(WEIGHT.high).toBeLessThan(1)
    expect(WEIGHT.low).toBeGreaterThan(0)
  })
})

describe('receivables aging', () => {
  const rows = [
    { clientName: 'PWD Sangli', since: d('2026-06-10'), amountPaise: rs(14_200_000) },
    { clientName: 'PWD Sangli', since: d('2026-09-01'), amountPaise: rs(300_000) },
    { clientName: 'ZP Sangli', since: d('2026-08-20'), amountPaise: rs(500_000) },
  ]
  const aged = ageReceivables(rows, d('2026-09-14'))

  it('groups by department and totals what is owed', () => {
    expect(aged).toHaveLength(2)
    expect(aged[0]!.clientName).toBe('PWD Sangli')
    expect(aged[0]!.totalPaise).toBe(rs(14_500_000))
    expect(aged[0]!.count).toBe(2)
  })

  it('reports the oldest bill, which is the number people quote', () => {
    expect(aged[0]!.oldestDays).toBe(96)
  })

  it('sorts by what is owed, not by age', () => {
    /* A ₹1.42 crore bill at 96 days is the call to make before a ₹5,000 one
       at 200. Sorting by age puts the trivial one on top. */
    expect(aged[0]!.clientName).toBe('PWD Sangli')
    expect(Number(aged[0]!.totalPaise)).toBeGreaterThan(Number(aged[1]!.totalPaise))
  })

  it('puts each bill in one bucket', () => {
    expect(aged[0]!.buckets['90+']).toBe(rs(14_200_000))
    expect(aged[0]!.buckets['0-15']).toBe(rs(300_000))
    expect(aged[1]!.buckets['16-30']).toBe(rs(500_000))
  })

  it('buckets on the boundaries the way the labels read', () => {
    expect(bucketFor(0)).toBe('0-15')
    expect(bucketFor(15)).toBe('0-15')
    expect(bucketFor(16)).toBe('16-30')
    expect(bucketFor(30)).toBe('16-30')
    expect(bucketFor(91)).toBe('90+')
    expect(AGE_BUCKETS.map((b) => b.key)).toHaveLength(5)
  })

  it('never ages a bill negatively', () => {
    // A bill submitted with tomorrow's date is zero days old, not minus one.
    const future = ageReceivables(
      [{ clientName: 'X', since: d('2026-09-20'), amountPaise: rs(100) }], d('2026-09-14'))
    expect(future[0]!.oldestDays).toBe(0)
  })
})

describe('a contingent outflow moves with its receipt', () => {
  /* The pass-through to a contractor executing our work. Discounting the
     inflow while holding the payment out at full value showed a week ₹12 lakh
     worse than either outcome can be: either the money arrives and we pay, or
     it does not and we do not. */
  it('discounts an outflow that carries a confidence', () => {
    const f = buildForecast({
      openingPaise: paise(0n),
      from: d('2026-09-11'),
      inflows: [{ date: d('2026-09-12'), amountPaise: paise(10_00_000_00n),
                  confidence: 'medium' }],
      outflows: [{ date: d('2026-09-12'), amountPaise: paise(9_00_000_00n),
                   confidence: 'medium', label: 'Pass-through' }],
      weeks: 1,
    })
    const w = f.weeks[0]!
    expect(w.weightedInPaise).toBe(6_00_000_00n as Paise)
    expect(w.weightedOutPaise).toBe(5_40_000_00n as Paise)
    expect(w.weightedClosingPaise).toBe(60_000_00n as Paise)
  })

  it('still never discounts an ordinary committed payment', () => {
    const f = buildForecast({
      openingPaise: paise(10_00_000_00n),
      from: d('2026-09-11'),
      inflows: [],
      outflows: [{ date: d('2026-09-12'), amountPaise: paise(1_00_000_00n),
                   label: 'EMI — HDFC' }],
      weeks: 1,
    })
    const w = f.weeks[0]!
    expect(w.weightedOutPaise).toBe(w.outPaise)
    expect(w.weightedClosingPaise).toBe(9_00_000_00n as Paise)
  })
})
