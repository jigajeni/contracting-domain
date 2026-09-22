import { type Paise } from '../money'
import { QTY_UNIT, formatQty, parseQty } from '../works/deviation'

/**
 * Where a work made or lost its money, item by item.
 *
 * The profitability screen can say a work is running at 25%. It cannot say
 * which item did that, and on a percentage-rate contract that is the whole
 * question: the premium is quoted once against the entire schedule, and then
 * quantities move and rates get adjusted item by item until the margin is
 * whatever it turns out to be.
 *
 * **This is the revenue side and only the revenue side.** Cost cannot be
 * attributed here and the module will not pretend otherwise: expenses are
 * booked against a work and a cost bucket, never against a BOQ item, and
 * splitting a cement bill across thirty items by any formula would invent a
 * number that looks authoritative and is made up. What this compares is what
 * an item was PRICED at in the schedule against what it is actually EARNING.
 *
 * The variance splits exactly two ways, and the split is the useful part:
 *
 *   quantity variance  (executed − tendered) × BOQ rate
 *   rate variance      executed × (allowed − BOQ rate)
 *   ─────────────────────────────────────────────────────
 *   total              executed × allowed − tendered × BOQ rate
 *
 * That is an identity, not an approximation — QaRa − QeRe expands to
 * (Qa−Qe)Re + Qa(Ra−Re) with nothing left over. A test pins it, because a
 * decomposition whose parts do not sum to the whole is worse than no
 * decomposition: somebody reconciles it for an afternoon and finds nothing.
 *
 * The rate side is real money here, not a rounding. ZP allows concrete at
 * ₹126 per cum below the schedule where SCADA is not used on the batching
 * plant — on the Ankale bills that applies to every concrete item, and it is
 * invisible in any total that only looks at quantities.
 *
 * Pure. CLAUDE.md §5.
 */

export interface VarianceInput {
  boqItemId: string
  itemNo: string
  description: string
  unit: string | null
  tenderedQty: string
  /** Cumulative executed, from the latest bill. */
  executedQty: string
  /** What the schedule priced it at. */
  boqRatePaise: Paise
  /**
   * What the department is actually allowing. Differs where a rate adjustment
   * applies — the SCADA deduction is the standing example.
   */
  allowedRatePaise: Paise
  /**
   * What counts as a big move on ONE item, for drawing attention. NOT the
   * contract's permitted deviation: that applies to the statement as a whole,
   * never to a single item — see `DEFAULT_PERMITTED_PCT` in the deviation
   * module. An item at +40% inside a statement that nets to +3% breaches
   * nothing, and calling it a breach would send somebody to the department
   * for an approval they do not need.
   */
  noticeThresholdPct?: string | null
  isExtra?: boolean
}

export interface VarianceLine extends VarianceInput {
  /** tendered × BOQ rate — what the schedule said this item was worth. */
  estimatePaise: Paise
  /** executed × allowed rate — what it is actually earning. */
  earnedPaise: Paise
  /** earned − estimate. Negative is money lost against the schedule. */
  variancePaise: Paise
  /** The part of it caused by doing more or less work. */
  quantityVariancePaise: Paise
  /** The part caused by being paid a different rate. */
  rateVariancePaise: Paise
  /** Executed less tendered, signed. */
  deviationQty: string
  /** Of the tendered quantity, or null for an extra item. */
  deviationPct: string | null
  /** Moved more than the notice threshold. Worth a look, not a breach. */
  largeDeviation: boolean
  /**
   * Tendered but nothing executed yet.
   *
   * On a work in progress this is the ordinary state of everything not reached
   * — the bituminous layers on a road that is still at sub-base. Arithmetically
   * it is a −100% deviation and calling it one is nonsense: an item nobody has
   * started is pending, not saved. Kept out of the deviation counts and out of
   * the net, and shown as "not started" rather than as a minus sign.
   */
  notStarted: boolean
  /** Which half dominates — what to say about this line in one word. */
  driver: 'quantity' | 'rate' | 'both' | 'none'
}

/** Signed quantity × rate, in paise. Quantities carry three decimals. */
function qtyRate(qtyThousandths: bigint, ratePaise: Paise): Paise {
  return ((qtyThousandths * ratePaise) / QTY_UNIT) as Paise
}

export function computeVariance(input: VarianceInput): VarianceLine {
  const tendered = parseQty(input.tenderedQty)
  const executed = parseQty(input.executedQty)
  const diff = executed - tendered

  const estimate = qtyRate(tendered, input.boqRatePaise)
  const earned = qtyRate(executed, input.allowedRatePaise)

  const quantityVariance = qtyRate(diff, input.boqRatePaise)
  const rateVariance = qtyRate(
    executed, (input.allowedRatePaise - input.boqRatePaise) as Paise)

  /* Any rounding from the two divisions lands on the quantity half rather than
     vanishing, so the parts always sum to the total exactly. Putting it on the
     larger half would be arbitrary; putting it nowhere would break the
     identity the whole module rests on. */
  const total = (earned - estimate) as Paise
  const balanced = (total - rateVariance) as Paise

  const deviationPct = tendered === 0n
    ? null
    /* A percentage of nothing is undefined, not zero — an extra item is a
       different thing, not an infinite deviation. Same rule as the deviation
       module, deliberately. */
    : formatQty((diff * 100n * QTY_UNIT) / tendered)

  const notStarted = tendered > 0n && executed === 0n

  const notice = input.noticeThresholdPct ? Number(input.noticeThresholdPct) : null
  const largeDeviation = !notStarted && notice !== null && deviationPct !== null
    && Math.abs(Number(deviationPct)) > notice

  const q = balanced < 0n ? -balanced : balanced
  const r = rateVariance < 0n ? -rateVariance : rateVariance
  const driver: VarianceLine['driver'] =
    q === 0n && r === 0n ? 'none'
    : r === 0n ? 'quantity'
    : q === 0n ? 'rate'
    /* Neither dominates unless it is at least twice the other — "both" is the
       honest answer more often than a forced winner. */
    : q > r * 2n ? 'quantity'
    : r > q * 2n ? 'rate'
    : 'both'

  return {
    ...input,
    estimatePaise: estimate,
    earnedPaise: earned,
    variancePaise: total,
    quantityVariancePaise: balanced,
    rateVariancePaise: rateVariance,
    deviationQty: formatQty(diff),
    deviationPct,
    largeDeviation,
    notStarted,
    driver,
  }
}

export interface VarianceTotals {
  estimatePaise: Paise
  earnedPaise: Paise
  variancePaise: Paise
  quantityVariancePaise: Paise
  rateVariancePaise: Paise
  /** Items running below what the schedule priced them at. */
  losingItems: number
  /** Items that moved a lot. Worth a look; not, by itself, a breach. */
  largeDeviations: number
  /**
   * Net deviation across the items that have actually been STARTED, as a
   * percentage of what those items were priced at. THIS is what the contract's
   * permitted limit applies to.
   *
   * Items not started are excluded, and that is the difference between a
   * figure worth reading and a nonsense. A road at sub-base stage has not
   * "deviated −56%" because the bituminous layers are unbilled; it is 43%
   * done. Including them makes every work in progress look like a catastrophe
   * and the number gets ignored, which is how a real deviation slips past.
   */
  netDeviationPct: number | null
  /** Items tendered and not yet begun. */
  notStarted: number
  /** What those untouched items were priced at. */
  notStartedPaise: Paise
  items: number
}

const sum = (xs: Paise[]): Paise => xs.reduce((a, b) => (a + b) as Paise, 0n as Paise)

export function totalVariance(lines: VarianceLine[]): VarianceTotals {
  const estimate = sum(lines.map((l) => l.estimatePaise))
  const earned = sum(lines.map((l) => l.earnedPaise))

  /* The net is over started items only — see the field comment. */
  const started = lines.filter((l) => !l.notStarted)
  const startedEstimate = sum(started.map((l) => l.estimatePaise))
  const startedEarned = sum(started.map((l) => l.earnedPaise))
  const idle = lines.filter((l) => l.notStarted)
  return {
    estimatePaise: estimate,
    earnedPaise: earned,
    variancePaise: sum(lines.map((l) => l.variancePaise)),
    quantityVariancePaise: sum(lines.map((l) => l.quantityVariancePaise)),
    rateVariancePaise: sum(lines.map((l) => l.rateVariancePaise)),
    losingItems: lines.filter((l) => l.variancePaise < 0n).length,
    largeDeviations: lines.filter((l) => l.largeDeviation).length,
    netDeviationPct: startedEstimate === 0n
      ? null
      : Number(((startedEarned - startedEstimate) * 1000n) / startedEstimate) / 10,
    notStarted: idle.length,
    notStartedPaise: sum(idle.map((l) => l.estimatePaise)),
    items: lines.length,
  }
}
