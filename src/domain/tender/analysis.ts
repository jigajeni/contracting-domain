import { ZERO, type Paise } from '../money'

/**
 * Whether the bidding is working.
 *
 * Everything else in this system records what happened. This is the one place
 * that asks a question the office cannot answer from its own files: **are we
 * quoting at the right level?** Too high and the work goes elsewhere; too low
 * and it is won at a margin that eats itself, and the second failure is
 * invisible for a year because it looks like success.
 *
 * Two figures answer it together and neither answers it alone. A win rate of
 * eighty per cent means nothing without knowing what was given away to get it,
 * and an average premium means nothing without knowing how much of it won.
 *
 * Pure. CLAUDE.md §5.
 */

export type Result =
  | 'draft' | 'submitted' | 'technical_qualified' | 'technical_rejected'
  | 'l1' | 'l2' | 'l3' | 'other_rank' | 'lost' | 'awarded' | 'cancelled'
  | 'retendered'

/** Results that mean the bid was actually judged against other bidders. */
export const DECIDED: ReadonlySet<Result> = new Set<Result>(
  ['l1', 'l2', 'l3', 'other_rank', 'lost', 'awarded'])

/** Results that mean we got it. L1 normally becomes the award. */
export const WON: ReadonlySet<Result> = new Set<Result>(['l1', 'awarded'])

/**
 * Results that say nothing about our pricing and must not be counted.
 *
 * A cancelled or retendered notice was never decided; a technical rejection
 * was decided on papers, not on price. Leaving them in the denominator makes
 * the win rate a measure of how often departments cancel things.
 */
export const NOT_A_CONTEST: ReadonlySet<Result> = new Set<Result>(
  ['draft', 'submitted', 'cancelled', 'retendered',
   'technical_qualified', 'technical_rejected'])

export interface Bid {
  id: string
  result: Result
  /** Signed. Negative is BELOW the estimate, which is the normal quote. */
  premiumPct: number | null
  estimatedCostPaise: Paise
  /** What we would be paid if we won it. */
  quotedValuePaise: Paise
  clientId: string | null
  clientName: string | null
  firmId: string
  fyLabel: string
}

export interface WinRate {
  /** Bids that were actually judged on price. */
  contested: number
  won: number
  /** null rather than 0% where nothing has been decided yet. */
  ratePct: number | null
  /** Left out of the contest, and why it would be wrong to count them. */
  excluded: number
  valueWonPaise: Paise
  valueContestedPaise: Paise
}

export function winRate(bids: Bid[]): WinRate {
  const contested = bids.filter((b) => !NOT_A_CONTEST.has(b.result))
  const won = contested.filter((b) => WON.has(b.result))

  return {
    contested: contested.length,
    won: won.length,
    /* Null, not zero. "0%" against no decided bids reads as a firm that
       never wins; the truth is that nothing has been decided. */
    ratePct: contested.length === 0
      ? null : (won.length / contested.length) * 100,
    excluded: bids.length - contested.length,
    valueWonPaise: won.reduce((a, b) => (a + b.quotedValuePaise) as Paise, ZERO),
    valueContestedPaise: contested.reduce(
      (a, b) => (a + b.quotedValuePaise) as Paise, ZERO),
  }
}

/* ------------------------------------------------------------------ */
/* Where the line is                                                   */
/* ------------------------------------------------------------------ */

export interface PremiumBand {
  /** Inclusive lower bound, in percent below the estimate. 0 = at estimate. */
  fromPct: number
  toPct: number
  label: string
  bids: number
  won: number
  ratePct: number | null
}

/**
 * The bands the premium is read in.
 *
 * Chosen against the departmental rule rather than round numbers: **more than
 * 10% below triggers an additional security deposit of the whole
 * differential** for PWD and ZP Sangli. So 0–5, 5–10 and past 10 are the
 * three states that actually differ, and the last one costs money to be in
 * whether or not it wins.
 */
export const BANDS: readonly {
  fromPct: number; toPct: number; label: string
  /** `below` is the discount as a positive number. */
  holds: (below: number) => boolean
}[] = [
  { fromPct: 0, toPct: 5, label: 'Up to 5% below',
    holds: (b) => b >= 0 && b < 5 },
  { fromPct: 5, toPct: 10, label: '5 to 10% below',
    /* Inclusive at ten. The ASD rule is strictly MORE than 10% below, so a
       bid at exactly ten owes nothing and belongs on this side of the line —
       the bands exist to mirror that rule and a boundary off by one case
       makes them mirror something else. */
    holds: (b) => b >= 5 && b <= 10 },
  { fromPct: 10, toPct: Infinity, label: 'More than 10% below',
    holds: (b) => b > 10 },
] as const

/**
 * How each level of discount actually fared.
 *
 * Read down the win rates: where it stops improving is where the money is
 * being given away for nothing. A firm winning 60% at 8% below and 65% at 14%
 * below is buying five points of win rate with six points of margin, on every
 * work, and furnishing an additional security deposit for the privilege.
 *
 * Bids quoted ABOVE the estimate are excluded rather than given a band of
 * their own — they are rare enough here that one of them would read as a
 * hundred per cent win rate or nothing at all.
 */
export function premiumBands(bids: Bid[]): PremiumBand[] {
  const contested = bids.filter(
    (b) => !NOT_A_CONTEST.has(b.result)
      && b.premiumPct !== null && b.premiumPct <= 0)

  return BANDS.map((band) => {
    const inBand = contested.filter(
      (b) => band.holds(-(b.premiumPct as number)))
    const won = inBand.filter((b) => WON.has(b.result))
    return {
      fromPct: band.fromPct, toPct: band.toPct, label: band.label,
      bids: inBand.length,
      won: won.length,
      ratePct: inBand.length === 0 ? null : (won.length / inBand.length) * 100,
    }
  })
}

export interface PremiumSummary {
  /** Mean discount across decided bids. Negative, as stored. */
  averagePct: number | null
  /** Mean discount across the ones that WON. */
  winningAveragePct: number | null
  /**
   * The gap between those two.
   *
   * Positive means winning bids were cheaper than our average — the ordinary
   * case, and its size is what a win costs. Near zero means price is not what
   * decides these tenders, which is worth knowing before another point is
   * shaved off.
   */
  costOfWinningPct: number | null
  /** Decided bids quoted more than 10% below, which owe an ASD. */
  asdTriggering: number
}

export function premiumSummary(bids: Bid[]): PremiumSummary {
  const contested = bids.filter(
    (b) => !NOT_A_CONTEST.has(b.result) && b.premiumPct !== null)
  const won = contested.filter((b) => WON.has(b.result))

  const mean = (xs: Bid[]): number | null =>
    xs.length === 0 ? null
      : xs.reduce((a, b) => a + (b.premiumPct as number), 0) / xs.length

  const all = mean(contested)
  const winning = mean(won)

  return {
    averagePct: all,
    winningAveragePct: winning,
    costOfWinningPct: all !== null && winning !== null ? all - winning : null,
    /* Strictly more than ten — the rule is `>`, and a bid at exactly 10%
       below owes nothing. CLAUDE.md §1. */
    asdTriggering: contested.filter(
      (b) => b.premiumPct !== null && -b.premiumPct > 10).length,
  }
}

/* ------------------------------------------------------------------ */
/* Who we actually win with                                            */
/* ------------------------------------------------------------------ */

export interface ByClient {
  clientId: string
  clientName: string
  bids: number
  won: number
  ratePct: number
  averagePremiumPct: number | null
}

/**
 * Win rate per department, biggest first.
 *
 * Departments do not behave alike, and a rate averaged across all of them
 * hides the one where we never win. Departments with a single decided bid are
 * kept — this is a small firm and one bid is a real fact — but the count is
 * shown beside the rate so nobody reads 100% off a sample of one.
 */
export function byClient(bids: Bid[]): ByClient[] {
  const map = new Map<string, Bid[]>()
  for (const b of bids) {
    if (NOT_A_CONTEST.has(b.result) || !b.clientId) continue
    map.set(b.clientId, [...(map.get(b.clientId) ?? []), b])
  }

  return [...map.entries()]
    .map(([clientId, list]) => {
      const won = list.filter((b) => WON.has(b.result))
      const withPremium = list.filter((b) => b.premiumPct !== null)
      return {
        clientId,
        clientName: list[0]!.clientName ?? 'Unnamed department',
        bids: list.length,
        won: won.length,
        ratePct: (won.length / list.length) * 100,
        averagePremiumPct: withPremium.length === 0 ? null
          : withPremium.reduce((a, b) => a + (b.premiumPct as number), 0)
            / withPremium.length,
      }
    })
    .sort((a, b) => b.bids - a.bids)
}
