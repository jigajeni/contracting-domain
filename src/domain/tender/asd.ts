import { pctOf, type Paise } from '../money'

/**
 * अतिरिक्त सुरक्षा अनामत — additional security deposit.
 *
 * Bid far enough below the estimated cost and the department demands an extra
 * deposit before the agreement, over and above the ordinary security deposit
 * recovered from bills. It is furnished as a bank guarantee or an FDR, so it
 * blocks margin money at the bank, and failing to furnish it in time loses the
 * work.
 *
 * `tenders.premium_pct` has been stored since the first migration, signed,
 * negative for below-estimate — and nothing had ever done anything with it but
 * print it. The system could tell you that you had bid 14% below and not that
 * doing so had committed you to a ₹14 lakh guarantee.
 *
 * **The rule is departmental, not universal**, exactly like the GST base
 * (CLAUDE.md §2B). The threshold and the basis come from `clients`; this
 * function only does the arithmetic. Confirmed for PWD and ZP Sangli: more
 * than 10% below, and the deposit is the FULL difference between the estimate
 * and the accepted amount — not merely the part below the threshold.
 *
 * Pure. CLAUDE.md §5.
 */

export type AsdBasis = 'full_differential' | 'excess_below_threshold'

export interface AsdRule {
  /** Below this much, ASD applies. Null = no rule recorded for the department. */
  thresholdPct: string | null
  basis: AsdBasis
}

export interface AsdInput {
  estimatedCostPaise: Paise
  /**
   * Signed, as stored: NEGATIVE is below the estimate. This is the field that
   * catches people — CLAUDE.md §1, अंदाजपत्रकीय दरापेक्षा % कमी.
   */
  premiumPct: string | null
  rule: AsdRule
}

export interface Asd {
  /** What must be furnished. Zero when the threshold is not crossed. */
  requiredPaise: Paise
  /** True when the bid is below the estimate by more than the threshold. */
  applies: boolean
  /** How far below the estimate, as a positive number. Zero at or above. */
  belowPct: number
  /** The full estimate − accepted difference, whether or not ASD applies. */
  differentialPaise: Paise
  /**
   * Set when no answer is possible: the department's rule has not been
   * recorded. Distinct from "no ASD due", and the screen must say which —
   * an unrecorded rule reading as zero is how a guarantee gets missed.
   */
  unknown: string | null
}

const ZERO = 0n as Paise

export function computeAsd(input: AsdInput): Asd {
  const premium = input.premiumPct === null ? null : Number(input.premiumPct)

  if (premium === null) {
    return {
      requiredPaise: ZERO, applies: false, belowPct: 0, differentialPaise: ZERO,
      unknown: 'No premium is recorded against this tender, so whether an '
        + 'additional deposit is due cannot be worked out.',
    }
  }

  /* Above or at the estimate: nothing is owed under any rule, so an unrecorded
     threshold does not matter and saying "unknown" here would be noise. */
  const below = premium < 0 ? -premium : 0
  if (below === 0) {
    return {
      requiredPaise: ZERO, applies: false, belowPct: 0,
      differentialPaise: ZERO, unknown: null,
    }
  }

  const differential = pctOf(input.estimatedCostPaise, below.toString())

  if (input.rule.thresholdPct === null) {
    return {
      requiredPaise: ZERO, applies: false, belowPct: below,
      differentialPaise: differential,
      unknown: `Bid ${fmtPct(below)}% below the estimate, and this department's `
        + `additional-deposit rule has not been recorded. Check the tender `
        + `conditions before the agreement — this is not the same as nothing `
        + `being due.`,
    }
  }

  const threshold = Number(input.rule.thresholdPct)
  /* Strictly more than the threshold. A bid at exactly the threshold is not
     "more than" it, and departments write the condition that way. */
  if (below <= threshold) {
    return {
      requiredPaise: ZERO, applies: false, belowPct: below,
      differentialPaise: differential, unknown: null,
    }
  }

  const required = input.rule.basis === 'full_differential'
    ? differential
    /* Only the part falling below (estimate − threshold%). */
    : pctOf(input.estimatedCostPaise, (below - threshold).toString())

  return {
    requiredPaise: required,
    applies: true,
    belowPct: below,
    differentialPaise: differential,
    unknown: null,
  }
}

/** Trim a percentage for a sentence: 12, 12.5, 12.75. */
function fmtPct(n: number): string {
  return String(Number(n.toFixed(4)))
}

export function describeAsd(a: Asd, rule: AsdRule): string {
  if (a.unknown) return a.unknown
  if (!a.applies) {
    return a.belowPct > 0
      ? `Bid ${fmtPct(a.belowPct)}% below the estimate, inside the `
        + `${fmtPct(Number(rule.thresholdPct))}% threshold. No additional deposit.`
      : 'At or above the estimate. No additional deposit.'
  }
  return rule.basis === 'full_differential'
    ? `Bid ${fmtPct(a.belowPct)}% below the estimate, past the `
      + `${fmtPct(Number(rule.thresholdPct))}% threshold — the whole difference `
      + `must be furnished as a guarantee or FDR before the agreement.`
    : `Bid ${fmtPct(a.belowPct)}% below the estimate. The part below `
      + `${fmtPct(Number(rule.thresholdPct))}% must be furnished before the agreement.`
}
