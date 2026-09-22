import { addDays, daysUntil, type ISODate } from '../dates'
import { ZERO, type Paise } from '../money'

/**
 * Contractor registration rules.
 *
 * The two categories are not variations on a theme, they are different
 * instruments, and confusing them is how a registration gets suspended:
 *
 *   सामान्य कंत्राटदार — General Contractor. Wins work competitively. Bounded
 *   only by the monetary capacity of its class.
 *
 *   सुशिक्षित बेरोजगार अभियंता — Educated Unemployed Engineer, वर्ग-५अ. Receives
 *   work by nomination without tender, inside the district of registration —
 *   but capped per work AND per year, for a five-year window only, and
 *   sub-letting is absolutely barred. Two years' suspension for a breach.
 *
 * Pure. CLAUDE.md §1 and §8.9.
 */

export type RegistrationCategory =
  | 'general_contractor'
  | 'educated_unemployed_engineer'
  | 'labour_society'
  | 'specialist'
  | 'other'

export type RegistrationAuthority = 'zp' | 'pwd' | 'mjp' | 'mahatransco' | 'other'

export const AUTHORITY_LABEL: Record<RegistrationAuthority, string> = {
  zp: 'Zilla Parishad',
  pwd: 'Public Works Department',
  mjp: 'Maharashtra Jeevan Pradhikaran',
  mahatransco: 'MahaTransco',
  other: 'Other',
}

export interface RegistrationShape {
  category: RegistrationCategory | null
  /**
   * Who issued it. A registration only works for its own authority's
   * departments — the same person's ZP class allows ₹30 lakh where their PWD
   * class allows ₹150 lakh, and answering from the wrong one is wrong by a
   * factor of five in whichever direction the sort happened to land.
   */
  authority?: RegistrationAuthority | null
  monetaryLimitPaise: Paise | null
  perWorkCapPaise: Paise | null
  annualAggregateCapPaise: Paise | null
  eligibilityYears: number | null
  eligibilityEndDate: ISODate | null
  validFrom: ISODate | null
  validTo: ISODate | null
  nominationEligible: boolean
  /**
   * Where the registration must be earned upwards. A work ABOVE this value may
   * only be taken once a work AT OR BELOW it has been completed on the same
   * registration — GR 05-04-2023 clause 4.2, ₹15 lakh on Prashant's वर्ग-५, and
   * ₹10 lakh on the MahaTransco one. Null on every registration without the
   * condition, which is most of them.
   */
  progressionThresholdPaise?: Paise | null
  /**
   * Nomination work allowed across the LIFE of the registration, never reset.
   *
   * Not the same thing as the annual aggregate and not interchangeable with
   * it. MahaTransco allows ₹50 lakh in total, once; the 2022 ZP certificates
   * allow ₹60 lakh a year, every year. Holding a lifetime figure in the annual
   * field shows exhausted headroom refilling each April, which clears a work
   * that costs the registration itself.
   */
  lifetimeQuotaPaise?: Paise | null
  /** Taken against that quota so far, over all years. */
  lifetimeUsedPaise?: Paise | null
  /** No earnest money on a bid made under this registration. */
  emdExempt?: boolean
  /** Security deposit as a percentage OF the ordinary rate. 50 means half. */
  sdConcessionPct?: string | null
  subletProhibited: boolean
  districtRestriction: string | null
  renewalLeadDays: number
}

export interface Finding {
  field?: string
  message: string
  /** An error blocks the save; a warning is stated and allowed. */
  severity: 'error' | 'warning'
}

/**
 * What this category requires to be usable.
 *
 * A nomination registration with no caps recorded is worse than no
 * registration at all: `eligible_firms_for_value()` would report unlimited
 * headroom and the work would be accepted over the cap.
 */
export function checkRegistration(r: RegistrationShape): Finding[] {
  const out: Finding[] = []

  if (r.validFrom && r.validTo && r.validTo < r.validFrom) {
    out.push({ field: 'validTo', severity: 'error', message: 'Valid-to is before valid-from.' })
  }

  if (r.category === 'educated_unemployed_engineer') {
    if (!r.perWorkCapPaise || r.perWorkCapPaise <= 0n) {
      out.push({
        field: 'perWorkCapPaise', severity: 'error',
        message: 'A nomination registration is capped per work. Without the cap ' +
                 'the system would report unlimited headroom and a work could be ' +
                 'accepted over it.',
      })
    }
    if (!r.annualAggregateCapPaise || r.annualAggregateCapPaise <= 0n) {
      out.push({
        field: 'annualAggregateCapPaise', severity: 'error',
        message: 'A nomination registration is also capped per year. Record the ' +
                 'annual aggregate.',
      })
    }
    if (!r.subletProhibited) {
      out.push({
        field: 'subletProhibited', severity: 'error',
        message: 'Sub-letting is absolutely barred on this registration — two ' +
                 'years’ suspension. It cannot be recorded as allowed.',
      })
    }
    if (!r.eligibilityEndDate && !r.eligibilityYears) {
      out.push({
        field: 'eligibilityEndDate', severity: 'warning',
        message: 'The eligibility window is five years. Without its end date ' +
                 'nothing will warn you when it closes.',
      })
    }
    if (!r.districtRestriction) {
      out.push({
        field: 'districtRestriction', severity: 'warning',
        message: 'Nomination work is confined to the district of registration. ' +
                 'Record which district.',
      })
    }
    if (!r.nominationEligible) {
      out.push({
        field: 'nominationEligible', severity: 'warning',
        message: 'This category exists to receive nomination work. Leaving that ' +
                 'off hides it from the eligibility check.',
      })
    }
  }

  if (r.category === 'general_contractor') {
    if (!r.monetaryLimitPaise || r.monetaryLimitPaise <= 0n) {
      out.push({
        field: 'monetaryLimitPaise', severity: 'error',
        message: 'A class carries a monetary capacity. A work above it cannot be ' +
                 'taken on this registration at all.',
      })
    }
    if (r.nominationEligible) {
      out.push({
        field: 'nominationEligible', severity: 'warning',
        message: 'A general contractor wins work competitively. Nomination work ' +
                 'belongs to a वर्ग-५अ registration.',
      })
    }
  }

  if (!r.validTo) {
    out.push({
      field: 'validTo', severity: 'warning',
      message: 'No expiry recorded, so no renewal reminder will ever fire.',
    })
  }

  return out
}

export const errorsOf = (f: Finding[]) => f.filter((x) => x.severity === 'error')
export const warningsOf = (f: Finding[]) => f.filter((x) => x.severity === 'warning')

/**
 * When the renewal papers must reach the department.
 *
 * Not when the registration expires — three months before it, because that is
 * the deadline on both ZP certificates. Sixty days is already too late.
 * CLAUDE.md §3, LICENCE_RENEWAL.
 */
export const renewalDueDate = (validTo: ISODate, leadDays = 90): ISODate =>
  addDays(validTo, -leadDays)

export interface RenewalState {
  /** Days until the papers must be in, which can be negative. */
  daysToFile: number
  daysToExpiry: number
  expired: boolean
  /** The filing window has opened or passed. */
  actNow: boolean
}

export function renewalState(
  validTo: ISODate | null, leadDays = 90, asOf?: ISODate,
): RenewalState | null {
  if (!validTo) return null
  const daysToExpiry = daysUntil(validTo, asOf)
  return {
    daysToExpiry,
    daysToFile: daysUntil(renewalDueDate(validTo, leadDays), asOf),
    expired: daysToExpiry < 0,
    actNow: daysToExpiry <= leadDays,
  }
}

/**
 * Whether a work of this value can be taken on this registration.
 *
 * The SQL function eligible_firms_for_value() ranks every firm for a tender;
 * this is the same judgement for one registration, in the browser, so the
 * answer appears as the value is typed rather than after a round trip.
 */
export interface EligibilityInput {
  registration: RegistrationShape
  valuePaise: Paise
  /** Already committed this financial year against the annual cap. */
  committedThisYearPaise: Paise
  isNomination: boolean
  /**
   * Which authority's registration the awarding department needs. Null means
   * the question does not arise — a private client needs no registration — and
   * the authority check is then skipped rather than failing everything.
   */
  requiredAuthority?: RegistrationAuthority | null
  /**
   * Works already completed at or below the progression threshold on this
   * registration. Only consulted where a threshold exists.
   */
  qualifyingWorksCompleted?: number
  asOf?: ISODate
}

export type Verdict =
  | 'eligible'
  | 'wrong_authority'
  | 'progression_not_met'
  | 'expired'
  | 'above_class_capacity'
  | 'above_per_work_cap'
  | 'insufficient_annual_headroom'
  | 'lifetime_quota_exhausted'
  | 'window_closed'
  | 'not_nomination_eligible'

export interface Eligibility {
  verdict: Verdict
  /** What is left under the annual cap, where there is one. */
  headroomPaise: Paise | null
  /**
   * What is left of the lifetime quota, where there is one. Shown beside the
   * annual headroom rather than folded into it: they run out differently and
   * one number cannot say which is binding.
   */
  lifetimeRemainingPaise: Paise | null
  reason: string
}

export function checkEligibility(input: EligibilityInput): Eligibility {
  const { registration: r, valuePaise, committedThisYearPaise, isNomination } = input

  const headroom = r.annualAggregateCapPaise
    ? ((r.annualAggregateCapPaise - committedThisYearPaise) as Paise)
    : null

  const lifetimeRemaining = r.lifetimeQuotaPaise
    ? ((r.lifetimeQuotaPaise - (r.lifetimeUsedPaise ?? ZERO)) as Paise)
    : null

  /* Before anything about money. A ZP registration is not a smaller PWD
     registration — it is not a PWD registration at all, so comparing its
     capacity against a PWD work answers a question nobody asked. Checked first
     so the reason given is the real one. */
  if (input.requiredAuthority && r.authority
      && r.authority !== input.requiredAuthority) {
    return {
      verdict: 'wrong_authority', headroomPaise: headroom, lifetimeRemainingPaise: lifetimeRemaining,
      reason: `This is a ${AUTHORITY_LABEL[r.authority]} registration and the `
            + `work is being awarded by ${AUTHORITY_LABEL[input.requiredAuthority]}. `
            + `A registration only covers its own department's work.`,
    }
  }

  const state = renewalState(r.validTo, r.renewalLeadDays, input.asOf)
  if (state?.expired) {
    return { verdict: 'expired', headroomPaise: headroom, lifetimeRemainingPaise: lifetimeRemaining,
             reason: `The registration expired ${-state.daysToExpiry} days ago.` }
  }

  if (r.monetaryLimitPaise && valuePaise > r.monetaryLimitPaise) {
    return {
      verdict: 'above_class_capacity', headroomPaise: headroom, lifetimeRemainingPaise: lifetimeRemaining,
      reason: 'Above the monetary capacity of this class. The work cannot be ' +
              'taken on this registration at all.',
    }
  }

  /* AFTER the capacity, and the ordering is the point. A work above the class
     capacity cannot be taken whatever is completed first, so answering
     "complete a smaller work" would send somebody to do one for nothing. The
     clause applies to the estimated cost however the work was won, so it sits
     with the capacity rather than among the nomination rules. */
  if (r.progressionThresholdPaise
      && valuePaise > r.progressionThresholdPaise
      && (input.qualifyingWorksCompleted ?? 0) === 0) {
    return {
      verdict: 'progression_not_met', headroomPaise: headroom, lifetimeRemainingPaise: lifetimeRemaining,
      reason: 'This registration has to be earned upwards: a work at or below '
            + 'its starting limit must be COMPLETED before a larger one can be '
            + 'taken. None has been completed on it yet.',
    }
  }

  if (isNomination) {
    if (!r.nominationEligible) {
      return { verdict: 'not_nomination_eligible', headroomPaise: headroom, lifetimeRemainingPaise: lifetimeRemaining,
               reason: 'This registration does not receive work by nomination.' }
    }
    if (r.eligibilityEndDate && daysUntil(r.eligibilityEndDate, input.asOf) < 0) {
      return {
        verdict: 'window_closed', headroomPaise: headroom, lifetimeRemainingPaise: lifetimeRemaining,
        reason: 'The five-year eligibility window has closed. Nomination work ' +
                'can no longer be taken on this registration.',
      }
    }
    if (r.perWorkCapPaise && valuePaise > r.perWorkCapPaise) {
      return { verdict: 'above_per_work_cap', headroomPaise: headroom, lifetimeRemainingPaise: lifetimeRemaining,
               reason: 'Above the per-work cap for nomination work.' }
    }
    if (headroom !== null && valuePaise > headroom) {
      return { verdict: 'insufficient_annual_headroom', headroomPaise: headroom,
               lifetimeRemainingPaise: lifetimeRemaining,
               reason: 'Not enough left under the annual aggregate cap. This '
                     + 'one refills in April.' }
    }
    /* Last, and deliberately after the annual cap, because the two exhaust
       differently and the reason has to say which. An annual cap refills in
       April and a lifetime quota never does — telling somebody to wait for the
       new year when the registration is finished for good is the worst
       possible answer here. */
    if (lifetimeRemaining !== null && valuePaise > lifetimeRemaining) {
      return { verdict: 'lifetime_quota_exhausted', headroomPaise: headroom,
               lifetimeRemainingPaise: lifetimeRemaining,
               reason: 'Above what is left of the lifetime quota on this '
                     + 'registration. This does NOT refill in April — it is '
                     + 'the total nomination work the registration will ever '
                     + 'carry.' }
    }
  }

  return { verdict: 'eligible', headroomPaise: headroom,
           lifetimeRemainingPaise: lifetimeRemaining, reason: 'Eligible.' }
}
