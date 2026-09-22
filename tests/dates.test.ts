import { describe, expect, it } from 'vitest'
import {
  isoDate, formatDate, formatDateTime, addDays, addMonths,
  daysBetween, daysUntil, daysSince, isOverdue, todayIST, toISODate,
} from '@/domain/dates'
import { fyOf, fyLabel, sameFY, fyQuarter } from '@/domain/fy'

describe('business dates', () => {
  it('renders DD-MM-YYYY and never an ISO string', () => {
    expect(formatDate(isoDate('2026-05-12'))).toBe('12-05-2026')
    expect(formatDate('2025-01-06')).toBe('06-01-2025')
    expect(formatDate(null)).toBe('—')
  })

  it('renders timestamps in IST regardless of server zone', () => {
    // 2026-05-12T09:30:00Z is 15:00 IST
    expect(formatDateTime('2026-05-12T09:30:00Z')).toBe('12-05-2026 15:00')
  })

  it('computes today in IST, not UTC', () => {
    // 18:45 UTC on 11 May is already 12 May in Jath.
    expect(todayIST(new Date('2026-05-11T18:45:00Z'))).toBe('2026-05-12')
  })

  it('adds days and months, clamping short months', () => {
    expect(addDays(isoDate('2026-05-12'), 180)).toBe('2026-11-08')
    expect(addMonths(isoDate('2026-01-31'), 1)).toBe('2026-02-28')
    expect(addMonths(isoDate('2026-11-08'), 24)).toBe('2028-11-08')
  })

  it('measures aging and overdue-ness', () => {
    expect(daysBetween(isoDate('2026-08-01'), isoDate('2026-08-29'))).toBe(28)
    expect(daysSince(isoDate('2026-08-01'), isoDate('2026-08-29'))).toBe(28)
    expect(daysUntil(isoDate('2026-09-20'), isoDate('2026-08-29'))).toBe(22)
    expect(isOverdue(isoDate('2026-08-20'), isoDate('2026-08-29'))).toBe(true)
    expect(isOverdue(isoDate('2026-09-20'), isoDate('2026-08-29'))).toBe(false)
  })
})

describe('financial year is April to March', () => {
  it('puts March and April in different years', () => {
    expect(fyLabel('2026-03-31')).toBe('FY 2025-26')
    expect(fyLabel('2026-04-01')).toBe('FY 2026-27')
    expect(fyLabel('2026-12-31')).toBe('FY 2026-27')
  })

  it('bounds the year correctly', () => {
    const fy = fyOf('2026-08-29')
    expect(fy.start).toBe('2026-04-01')
    expect(fy.end).toBe('2027-03-31')
    expect(fy.startYear).toBe(2026)
  })

  it('groups two dates in the same FY across the calendar boundary', () => {
    expect(sameFY('2026-12-31', '2027-01-01')).toBe(true)
    expect(sameFY('2026-03-31', '2026-04-01')).toBe(false)
  })

  it('numbers quarters from April', () => {
    expect(fyQuarter('2026-04-15')).toBe(1)
    expect(fyQuarter('2026-08-29')).toBe(2)
    expect(fyQuarter('2026-12-01')).toBe(3)
    expect(fyQuarter('2027-02-01')).toBe(4)
  })
})

describe('database date columns', () => {
  it('survives a Date object arriving from the driver', () => {
    // node-postgres is configured to hand back date columns as strings, but a
    // Date can still reach these helpers from JSON or from a caller. A page
    // must not white-screen because of it. This is the bug that took down the
    // dashboard the first time it ran.
    const d = new Date('2026-05-12T00:00:00Z')
    expect(formatDate(d)).toBe('12-05-2026')
    expect(daysBetween(d, '2026-05-20')).toBe(8)
    expect(daysSince(d, isoDate('2026-08-29'))).toBe(109)
  })

  it('treats a full timestamp string as its calendar date', () => {
    expect(formatDate('2026-05-12T18:30:00.000Z')).toBe('12-05-2026')
  })
})

describe('toISODate', () => {
  it('takes the calendar day a DATE column actually holds', () => {
    /* node-postgres builds a DATE as LOCAL midnight. Read with UTC getters,
       every timezone east of UTC hands back the previous day — for a bank
       guarantee that is the difference between a warning and a lapse. */
    expect(toISODate(new Date(2026, 8, 22))).toBe('2026-09-22')
    expect(toISODate(new Date(2026, 0, 1))).toBe('2026-01-01')
  })

  it('passes a string straight through', () => {
    expect(toISODate('2026-09-22')).toBe('2026-09-22')
    expect(toISODate('2026-09-22T18:30:00.000Z')).toBe('2026-09-22')
  })

  it('says nothing rather than guessing', () => {
    expect(toISODate(null)).toBeNull()
    expect(toISODate(undefined)).toBeNull()
    expect(toISODate('not a date')).toBeNull()
    expect(toISODate(new Date('nonsense'))).toBeNull()
  })
})
