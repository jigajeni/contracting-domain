/**
 * Financial year. April to March. Never January to December.
 * CLAUDE.md §0.3 — a "year" filter that means calendar year is a bug.
 */
import { type ISODate, isoDate, todayIST } from './dates'

export interface FinancialYear {
  /** 2026 for FY 2026-27. */
  startYear: number
  start: ISODate // 01-04-2026
  end: ISODate   // 31-03-2027
  label: string  // 'FY 2026-27'
  short: string  // '2026-27'
}

export function fyOf(d: ISODate | string = todayIST()): FinancialYear {
  const s = isoDate(String(d).slice(0, 10))
  const [y, m] = s.split('-').map(Number) as [number, number]
  const startYear = m >= 4 ? y : y - 1
  return {
    startYear,
    start: `${startYear}-04-01` as ISODate,
    end: `${startYear + 1}-03-31` as ISODate,
    label: `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`,
    short: `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`,
  }
}

export const fyLabel = (d?: ISODate | string): string => fyOf(d).label

export function sameFY(a: ISODate | string, b: ISODate | string): boolean {
  return fyOf(a).startYear === fyOf(b).startYear
}

/** Recent financial years, newest first — for the FY picker in the header. */
export function recentFYs(count = 5, from: ISODate | string = todayIST()): FinancialYear[] {
  const cur = fyOf(from).startYear
  return Array.from({ length: count }, (_, i) => fyOf(`${cur - i}-04-01`))
}

/** The quarter within the financial year — Q1 is Apr–Jun. */
export function fyQuarter(d: ISODate | string = todayIST()): 1 | 2 | 3 | 4 {
  const m = Number(String(d).slice(5, 7))
  const idx = Math.floor(((m - 4 + 12) % 12) / 3) + 1
  return idx as 1 | 2 | 3 | 4
}
