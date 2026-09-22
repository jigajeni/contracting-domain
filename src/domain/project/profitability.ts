import { type Paise } from '../money'

/**
 * What a work is actually making.
 *
 * `project_economics` has computed revenue, cost and margin correctly since
 * 0007 — including the two execution arrangements, where counting the contract
 * value as revenue overstates an outward work enormously. Nothing has ever put
 * it on a screen. Costs only became real last week, with expenses and site
 * cash, so until now it would have shown every work at a hundred per cent
 * margin.
 *
 * Which is the trap this module exists to keep visible. **A work with no cost
 * booked is not profitable; it is unmeasured.** The two look identical in a
 * margin column and completely different in life, so `costCoverage` is
 * reported beside every figure and a work with nothing booked says so rather
 * than showing a margin.
 *
 * Indicative, always. Tally is the statutory book of record — CLAUDE.md §8.12.
 *
 * Pure. CLAUDE.md §5.
 */

export type ExecutionModel = 'own' | 'executed_for_other' | 'executed_by_other'

export interface ProjectEconomics {
  contractValuePaise: Paise
  billedPaise: Paise
  receivedPaise: Paise
  revenuePaise: Paise
  costPaise: Paise
  executionModel: ExecutionModel
  /** Cash with a supervisor against this work, not yet settled by vouchers. */
  imprestOutstandingPaise: Paise
  /** Number of expense entries booked. Zero is the thing to notice. */
  costEntries: number
}

export interface Profitability {
  revenuePaise: Paise
  costPaise: Paise
  marginPaise: Paise
  /** Margin over revenue, 0–100, rounded. Null where there is no revenue. */
  marginPct: number | null
  /** Billed over contract value — how far through the work is, by money. */
  billedPct: number | null
  /** Received over billed — the collection gap. */
  collectedPct: number | null
  /** Still to collect on what has been billed. */
  outstandingPaise: Paise
  /**
   * Whether the cost figure can be believed at all. `none` means no expense
   * has been booked and the margin is meaningless; `partial` means site cash
   * is out that nobody has accounted for yet.
   */
  costCoverage: 'none' | 'partial' | 'booked'
  /** What is wrong with this row, in words, or null. */
  caveat: string | null
}

const ZERO = 0n as Paise

const pct = (part: Paise, whole: Paise): number | null =>
  whole === 0n ? null : Number((part * 100n) / whole)

export function profitabilityOf(e: ProjectEconomics): Profitability {
  const margin = (e.revenuePaise - e.costPaise) as Paise
  const outstanding = (e.billedPaise > e.receivedPaise
    ? e.billedPaise - e.receivedPaise : 0n) as Paise

  /* An outward arrangement legitimately has no cost of ours — somebody else
     executes it and we earn the commission — so "no cost booked" is the right
     answer there rather than a gap. */
  const costExpected = e.executionModel !== 'executed_by_other'

  const coverage: Profitability['costCoverage'] =
    !costExpected ? 'booked'
      : e.costEntries === 0 ? 'none'
      : e.imprestOutstandingPaise > 0n ? 'partial'
      : 'booked'

  return {
    revenuePaise: e.revenuePaise,
    costPaise: e.costPaise,
    marginPaise: margin,
    /* Suppressed where no cost is booked. A margin of 100% is not a finding,
       it is the absence of one, and printing it invites somebody to act on it. */
    marginPct: coverage === 'none' ? null : pct(margin, e.revenuePaise),
    billedPct: pct(e.billedPaise, e.contractValuePaise),
    collectedPct: pct(e.receivedPaise, e.billedPaise),
    outstandingPaise: outstanding,
    costCoverage: coverage,
    caveat: caveatFor(e, coverage),
  }
}

function caveatFor(
  e: ProjectEconomics, coverage: Profitability['costCoverage'],
): string | null {
  if (coverage === 'none') {
    return 'No cost has been booked against this work, so there is no margin to '
         + 'report — only what has been billed. This is not a profitable work; '
         + 'it is an unmeasured one.'
  }
  if (coverage === 'partial') {
    return 'Site cash is out against this work that has not been accounted for '
         + 'by vouchers yet, so the cost is understated and the margin is '
         + 'flattered by that much.'
  }
  if (e.executionModel === 'executed_by_other') {
    return 'Executed by another contractor. Our revenue is the commission and '
         + 'nothing else, and none of the execution cost is ours — the contract '
         + 'value is not our money passing through.'
  }
  if (e.executionModel === 'executed_for_other') {
    return 'Executed under another contractor\'s name. Revenue is the billed '
         + 'value less the commission we pass to them.'
  }
  return null
}

// ---------------------------------------------------------------------------
// Overhead
// ---------------------------------------------------------------------------

/**
 * Spread firm overhead across works in proportion to revenue.
 *
 * PLAN.md asks for it "optional", and optional is the whole design: overhead
 * allocation is a reporting choice, not a fact. Office rent did not belong to
 * the Ankale bridge in any sense a department would recognise, and a margin
 * that silently includes an allocation cannot be reconciled against anything.
 *
 * So it is applied on top, reversibly, and the unallocated margin stays on the
 * screen beside it. By revenue rather than by cost, because a work that has
 * booked no cost would otherwise attract no overhead at all and look better
 * than one that has been measured honestly.
 */
export function allocateOverhead(
  rows: { revenuePaise: Paise }[], overheadPaise: Paise,
): Paise[] {
  const total = rows.reduce((s, r) => (s + r.revenuePaise) as Paise, ZERO)
  if (total <= 0n) return rows.map(() => ZERO)

  /* Distributed by largest remainder so the parts sum to the whole. Rounding
     each share independently leaves rupees unallocated, and an overhead total
     that does not match the overhead is the kind of discrepancy somebody
     spends an afternoon on. */
  const exact = rows.map((r) => (r.revenuePaise * overheadPaise) / total)
  const allocated = exact.reduce((s, v) => s + v, 0n)
  let remainder = overheadPaise - allocated

  const order = rows
    .map((r, i) => ({ i, rem: (r.revenuePaise * overheadPaise) % total }))
    .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : 0))

  const out = exact.slice()
  for (const { i } of order) {
    if (remainder <= 0n) break
    out[i] = out[i]! + 1n
    remainder -= 1n
  }
  return out.map((v) => v as Paise)
}
