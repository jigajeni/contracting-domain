import { type Paise } from '../money'

/**
 * The management P&L. Indicative, and the word is not a disclaimer.
 *
 * Tally is the statutory book of record — CLAUDE.md §8.12 — and this is built
 * from operational data that was entered to run works, not to close books. It
 * differs from the statutory accounts in ways worth naming rather than
 * discovering:
 *
 *   **Revenue is recognised on billing**, not on work done. A bill raised in
 *   March for February's work lands in the year it was billed. There is no
 *   work-in-progress and no percentage-of-completion, because the department's
 *   measurement is what makes revenue real here and nothing earlier does.
 *
 *   **Cost is what has been booked.** A work with no expenses entered
 *   contributes its whole revenue to the result and none of its cost, and the
 *   result is overstated by exactly that. So the unmeasured share is reported
 *   beside every figure — the same discipline as the profitability screen, for
 *   the same reason.
 *
 *   **No depreciation, no tax, no provisions.** Machinery is bought and
 *   booked; it is not written down over its life. This is a trading view.
 *
 *   **Arrangement works are netted.** Revenue on a work executed by another
 *   contractor is the commission alone.
 *
 * Pure. CLAUDE.md §5.
 */

export interface PnlInput {
  /** Revenue to us — already net of arrangement commissions. */
  revenuePaise: Paise
  /** Expenses booked against a work, by bucket. */
  directByBucket: { bucket: string; totalPaise: Paise }[]
  /** Expenses booked against no work: rent, audit, bank charges. */
  overheadByBucket: { bucket: string; totalPaise: Paise }[]
  /** Revenue on works with no cost booked at all. */
  unmeasuredRevenuePaise: Paise
  unmeasuredWorks: number
}

export interface Pnl {
  revenuePaise: Paise
  directCostPaise: Paise
  /** Revenue less direct cost. What the works themselves returned. */
  grossPaise: Paise
  grossPct: number | null
  overheadPaise: Paise
  /** Gross less overhead. The trading result before finance, tax and wear. */
  operatingPaise: Paise
  operatingPct: number | null
  directByBucket: { bucket: string; totalPaise: Paise }[]
  overheadByBucket: { bucket: string; totalPaise: Paise }[]
  unmeasuredRevenuePaise: Paise
  unmeasuredWorks: number
  /** Share of revenue with no cost behind it, 0–100. */
  unmeasuredPct: number | null
}

const sum = (xs: { totalPaise: Paise }[]): Paise =>
  xs.reduce((s, x) => (s + x.totalPaise) as Paise, 0n as Paise)

const pct = (part: Paise, whole: Paise): number | null =>
  whole === 0n ? null : Number((part * 100n) / whole)

export function computePnl(input: PnlInput): Pnl {
  const direct = sum(input.directByBucket)
  const overhead = sum(input.overheadByBucket)
  const gross = (input.revenuePaise - direct) as Paise
  const operating = (gross - overhead) as Paise

  return {
    revenuePaise: input.revenuePaise,
    directCostPaise: direct,
    grossPaise: gross,
    grossPct: pct(gross, input.revenuePaise),
    overheadPaise: overhead,
    operatingPaise: operating,
    operatingPct: pct(operating, input.revenuePaise),
    directByBucket: [...input.directByBucket].sort(
      (a, b) => (b.totalPaise > a.totalPaise ? 1 : -1)),
    overheadByBucket: [...input.overheadByBucket].sort(
      (a, b) => (b.totalPaise > a.totalPaise ? 1 : -1)),
    unmeasuredRevenuePaise: input.unmeasuredRevenuePaise,
    unmeasuredWorks: input.unmeasuredWorks,
    unmeasuredPct: pct(input.unmeasuredRevenuePaise, input.revenuePaise),
  }
}

/**
 * How far the result can be trusted, in one word.
 *
 * A quarter of revenue with no cost behind it is not a small caveat on a
 * margin — it is the difference between a firm that made money and one that
 * has not finished counting.
 */
export function confidenceOf(p: Pnl): 'good' | 'partial' | 'unusable' {
  if (p.unmeasuredPct === null) return 'unusable'
  if (p.unmeasuredPct >= 50) return 'unusable'
  if (p.unmeasuredPct >= 10) return 'partial'
  return 'good'
}
