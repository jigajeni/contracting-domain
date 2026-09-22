import { describe, expect, it } from 'vitest'
import { paise, type Paise } from '@/domain/money'
import type { ISODate } from '@/domain/dates'
import {
  checkEligibility, checkRegistration, errorsOf, renewalDueDate, renewalState,
  warningsOf, type RegistrationShape,
} from '@/domain/firms/registration'

const d = (s: string) => s as ISODate

/**
 * The two registrations the firm actually holds, from the certificates:
 *
 *   सामान्य कंत्राटदार वर्ग-४, capacity ₹150 lakh — wins work competitively.
 *   सुशिक्षित बेरोजगार अभियंता वर्ग-५अ, ₹30 lakh class capacity, ₹5 lakh per
 *   nomination work, ₹60 lakh a year, five-year window, sub-letting barred.
 *
 * Choosing the wrong vehicle is how a registration gets suspended, so these
 * are the rules worth pinning. CLAUDE.md §8.9.
 */

const GENERAL: RegistrationShape = {
  category: 'general_contractor',
  monetaryLimitPaise: paise(15_000_000_00),        // ₹150 lakh
  perWorkCapPaise: null,
  annualAggregateCapPaise: null,
  eligibilityYears: null,
  eligibilityEndDate: null,
  validFrom: d('2024-04-01'),
  validTo: d('2027-03-31'),
  nominationEligible: false,
  subletProhibited: false,
  districtRestriction: null,
  renewalLeadDays: 90,
}

const NOMINATION: RegistrationShape = {
  category: 'educated_unemployed_engineer',
  monetaryLimitPaise: paise(3_000_000_00),         // ₹30 lakh
  perWorkCapPaise: paise(500_000_00),              // ₹5 lakh per work
  annualAggregateCapPaise: paise(6_000_000_00),    // ₹60 lakh a year
  eligibilityYears: 5,
  eligibilityEndDate: d('2028-03-31'),
  validFrom: d('2023-04-01'),
  validTo: d('2028-03-31'),
  nominationEligible: true,
  subletProhibited: true,
  districtRestriction: 'Sangli',
  renewalLeadDays: 90,
}

describe('what a registration must record', () => {
  it('accepts both real registrations as they stand', () => {
    expect(errorsOf(checkRegistration(GENERAL))).toHaveLength(0)
    expect(errorsOf(checkRegistration(NOMINATION))).toHaveLength(0)
  })

  it('refuses a nomination registration with no caps', () => {
    // Worse than no registration: eligible_firms_for_value() would report
    // unlimited headroom and a work would be accepted over the cap.
    const e = errorsOf(checkRegistration({
      ...NOMINATION, perWorkCapPaise: null, annualAggregateCapPaise: null,
    }))
    expect(e.map((x) => x.field)).toEqual(['perWorkCapPaise', 'annualAggregateCapPaise'])
  })

  it('refuses to record sub-letting as allowed on a nomination registration', () => {
    const e = errorsOf(checkRegistration({ ...NOMINATION, subletProhibited: false }))
    expect(e).toHaveLength(1)
    expect(e[0]!.message).toContain('two')      // two years' suspension
  })

  it('insists a general contractor has a monetary capacity', () => {
    const e = errorsOf(checkRegistration({ ...GENERAL, monetaryLimitPaise: null }))
    expect(e[0]!.field).toBe('monetaryLimitPaise')
  })

  it('warns when a general contractor is marked nomination-eligible', () => {
    const w = warningsOf(checkRegistration({ ...GENERAL, nominationEligible: true }))
    expect(w.some((x) => x.field === 'nominationEligible')).toBe(true)
  })

  it('warns when nothing will ever fire a renewal reminder', () => {
    const w = warningsOf(checkRegistration({ ...GENERAL, validTo: null }))
    expect(w.some((x) => x.field === 'validTo')).toBe(true)
  })

  it('rejects a validity that runs backwards', () => {
    const e = errorsOf(checkRegistration({
      ...GENERAL, validFrom: d('2027-04-01'), validTo: d('2024-03-31'),
    }))
    expect(e[0]!.field).toBe('validTo')
  })
})

describe('renewal timing', () => {
  it('counts back three months from expiry, not from the expiry itself', () => {
    // The papers must REACH the department three months before. Sixty days is
    // already too late — CLAUDE.md §3.
    expect(renewalDueDate(d('2027-03-31'))).toBe('2026-12-31')
  })

  it('opens the filing window at the lead time', () => {
    const s = renewalState(d('2027-03-31'), 90, d('2026-12-15'))!
    expect(s.daysToExpiry).toBe(106)
    expect(s.daysToFile).toBe(16)
    expect(s.actNow).toBe(false)          // 106 days out, window not yet open

    const later = renewalState(d('2027-03-31'), 90, d('2027-01-15'))!
    expect(later.actNow).toBe(true)       // inside 90 days
    expect(later.daysToFile).toBe(-15)    // and already 15 days late to file
  })

  it('knows when it has expired', () => {
    const s = renewalState(d('2026-03-31'), 90, d('2026-09-04'))!
    expect(s.expired).toBe(true)
    expect(s.daysToExpiry).toBeLessThan(0)
  })

  it('says nothing when there is no expiry date', () => {
    expect(renewalState(null)).toBeNull()
  })
})

describe('can this work be taken on this registration', () => {
  const ask = (r: RegistrationShape, value: number, opts: Partial<{
    committed: number; isNomination: boolean; asOf: string
  }> = {}) => checkEligibility({
    registration: r,
    valuePaise: paise(value) as Paise,
    committedThisYearPaise: paise(opts.committed ?? 0) as Paise,
    isNomination: opts.isNomination ?? false,
    asOf: d(opts.asOf ?? '2026-09-04'),
  })

  it('lets a ₹42 lakh work onto the वर्ग-४ registration', () => {
    expect(ask(GENERAL, 42_00_000_00).verdict).toBe('eligible')
  })

  it('refuses that same work on the वर्ग-५अ registration', () => {
    // ₹42 lakh against a ₹30 lakh class capacity. This is the check that
    // caught a 10× error in the seed data.
    const r = ask(NOMINATION, 42_00_000_00)
    expect(r.verdict).toBe('above_class_capacity')
    expect(r.reason).toContain('cannot be taken')
  })

  it('caps a nomination work at ₹5 lakh', () => {
    expect(ask(NOMINATION, 4_50_000_00, { isNomination: true }).verdict).toBe('eligible')
    expect(ask(NOMINATION, 6_00_000_00, { isNomination: true }).verdict)
      .toBe('above_per_work_cap')
  })

  it('counts the annual aggregate against what is already committed', () => {
    // ₹57 lakh taken this year, ₹60 lakh cap: ₹3 lakh of headroom left.
    const r = ask(NOMINATION, 4_00_000_00, { isNomination: true, committed: 57_00_000_00 })
    expect(r.verdict).toBe('insufficient_annual_headroom')
    expect(r.headroomPaise).toBe(paise(3_00_000_00))

    expect(ask(NOMINATION, 2_50_000_00, {
      isNomination: true, committed: 57_00_000_00,
    }).verdict).toBe('eligible')
  })

  it('closes the door when the five-year window has passed', () => {
    const r = ask(NOMINATION, 1_00_000_00, { isNomination: true, asOf: '2028-04-02' })
    expect(['window_closed', 'expired']).toContain(r.verdict)
  })

  it('refuses nomination work on a competitive registration', () => {
    expect(ask(GENERAL, 1_00_000_00, { isNomination: true }).verdict)
      .toBe('not_nomination_eligible')
  })

  it('refuses anything on an expired registration', () => {
    const expired = { ...GENERAL, validTo: d('2026-03-31') }
    const r = ask(expired, 1_00_000_00)
    expect(r.verdict).toBe('expired')
    expect(r.reason).toContain('expired')
  })

  it('reports headroom even when the verdict is not about headroom', () => {
    const r = ask(NOMINATION, 42_00_000_00, { committed: 10_00_000_00 })
    expect(r.verdict).toBe('above_class_capacity')
    expect(r.headroomPaise).toBe(paise(50_00_000_00))
  })
})

describe('a registration only covers its own department', () => {
  /* Nine certificates that arrived on 15-09-2026: Nilesh holds a ZP वर्ग-५अ at
     ₹30 lakh AND a PWD Class IV at ₹150 lakh. Prashant the same, Anand three.
     Before this the check compared a value against every registration a firm
     held and answered from whichever sorted first. */
  const zp: RegistrationShape = {
    category: 'educated_unemployed_engineer',
    authority: 'zp',
    monetaryLimitPaise: paise(30_00_000_00n),
    perWorkCapPaise: paise(5_00_000_00n),
    annualAggregateCapPaise: paise(60_00_000_00n),
    eligibilityYears: 5, eligibilityEndDate: d('2027-11-02'),
    validFrom: d('2022-11-03'), validTo: d('2027-11-02'),
    nominationEligible: true, subletProhibited: true,
    districtRestriction: 'Sangli', renewalLeadDays: 90,
  }
  const pwd: RegistrationShape = {
    ...zp, authority: 'pwd',
    monetaryLimitPaise: paise(150_00_000_00n),
    perWorkCapPaise: null, annualAggregateCapPaise: null,
    nominationEligible: false,
    validTo: d('2032-10-11'), eligibilityEndDate: null,
  }

  const work = paise(40_00_000_00n) // ₹40 lakh
  const asOf = d('2026-09-15')

  /* The bug, exactly. ₹40 lakh of PWD work is well inside Nilesh's ₹150 lakh
     PWD capacity and well outside his ₹30 lakh ZP one. */
  it('does not judge a PWD work against a ZP capacity', () => {
    const e = checkEligibility({
      registration: zp, valuePaise: work, committedThisYearPaise: paise(0n),
      isNomination: false, requiredAuthority: 'pwd', asOf,
    })
    expect(e.verdict).toBe('wrong_authority')
    expect(e.verdict).not.toBe('above_class_capacity')
    expect(e.reason).toMatch(/Zilla Parishad/)
    expect(e.reason).toMatch(/Public Works/)
  })

  it('allows the same work on the PWD registration', () => {
    const e = checkEligibility({
      registration: pwd, valuePaise: work, committedThisYearPaise: paise(0n),
      isNomination: false, requiredAuthority: 'pwd', asOf,
    })
    expect(e.verdict).toBe('eligible')
  })

  it('refuses the PWD registration for ZP work', () => {
    const e = checkEligibility({
      registration: pwd, valuePaise: work, committedThisYearPaise: paise(0n),
      isNomination: false, requiredAuthority: 'zp', asOf,
    })
    expect(e.verdict).toBe('wrong_authority')
  })

  /* Checked before capacity so the reason given is the real one. Told that a
     ₹200 lakh work is "above class capacity" on a ZP registration, somebody
     reasonably concludes a bigger class would fix it. */
  it('reports the authority, not the money, when both are wrong', () => {
    const e = checkEligibility({
      registration: zp, valuePaise: paise(200_00_000_00n),
      committedThisYearPaise: paise(0n),
      isNomination: false, requiredAuthority: 'pwd', asOf,
    })
    expect(e.verdict).toBe('wrong_authority')
  })

  /* A private client needs no registration, so the question does not arise and
     the check must not fail everything. */
  it('skips the authority check when none is required', () => {
    const e = checkEligibility({
      registration: zp, valuePaise: paise(20_00_000_00n),
      committedThisYearPaise: paise(0n),
      isNomination: false, requiredAuthority: null, asOf,
    })
    expect(e.verdict).toBe('eligible')
  })

  /* A registration loaded before 0030 has no authority. It must keep working
     rather than becoming ineligible everywhere the moment the column appears. */
  it('skips the check when the registration has no authority recorded', () => {
    const e = checkEligibility({
      registration: { ...zp, authority: null }, valuePaise: paise(20_00_000_00n),
      committedThisYearPaise: paise(0n),
      isNomination: false, requiredAuthority: 'pwd', asOf,
    })
    expect(e.verdict).toBe('eligible')
  })
})

describe('a registration that must be earned upwards', () => {
  /* GR संकीर्ण-२०२०/प्र.क्र.७०/बांध-२ dated 05-04-2023, clause 4.2, printed on
     Prashant's revised certificate: only after a work within ₹15 lakh has been
     successfully completed is the engineer eligible for work up to ₹50 lakh.
     His ₹50 lakh capacity is therefore conditional, and the check used to
     answer "eligible" for a ₹45 lakh work on the class capacity alone. */
  const prashant: RegistrationShape = {
    category: 'educated_unemployed_engineer',
    authority: 'zp',
    monetaryLimitPaise: paise(50_00_000_00n),
    progressionThresholdPaise: paise(15_00_000_00n),
    perWorkCapPaise: paise(5_00_000_00n),
    annualAggregateCapPaise: paise(60_00_000_00n),
    eligibilityYears: 10, eligibilityEndDate: d('2032-07-14'),
    validFrom: d('2022-07-15'), validTo: d('2032-07-14'),
    nominationEligible: true, subletProhibited: true,
    districtRestriction: 'Sangli', renewalLeadDays: 90,
  }
  const asOf = d('2026-09-15')
  const ask = (valuePaise: Paise, done: number) => checkEligibility({
    registration: prashant, valuePaise, committedThisYearPaise: paise(0n),
    isNomination: false, requiredAuthority: 'zp',
    qualifyingWorksCompleted: done, asOf,
  })

  it('refuses a work above the threshold with nothing completed', () => {
    const e = ask(paise(45_00_000_00n), 0)
    expect(e.verdict).toBe('progression_not_met')
    expect(e.verdict).not.toBe('eligible')
    expect(e.reason).toMatch(/COMPLETED/)
  })

  it('allows the same work once a qualifying one is completed', () => {
    expect(ask(paise(45_00_000_00n), 1).verdict).toBe('eligible')
  })

  /* At or below the threshold there is no prerequisite — that IS the work
     that earns the rest, and refusing it would make the condition impossible
     to satisfy. */
  it('allows a work at the threshold with nothing completed', () => {
    expect(ask(paise(15_00_000_00n), 0).verdict).toBe('eligible')
  })

  it('allows a work below the threshold with nothing completed', () => {
    expect(ask(paise(9_00_000_00n), 0).verdict).toBe('eligible')
  })

  it('still refuses a rupee above the threshold', () => {
    expect(ask(paise(15_00_000_01n), 0).verdict).toBe('progression_not_met')
  })

  /* Above the class capacity entirely: the money is the real answer, and
     saying "complete a first work" would send somebody to do one for nothing. */
  it('reports the capacity, not the progression, above the class limit', () => {
    expect(ask(paise(60_00_000_00n), 0).verdict).toBe('above_class_capacity')
  })

  /* Most registrations carry no such clause and must be untouched. */
  it('does not apply where no threshold is recorded', () => {
    const e = checkEligibility({
      registration: { ...prashant, progressionThresholdPaise: null },
      valuePaise: paise(45_00_000_00n), committedThisYearPaise: paise(0n),
      isNomination: false, requiredAuthority: 'zp',
      qualifyingWorksCompleted: 0, asOf,
    })
    expect(e.verdict).toBe('eligible')
  })

  /* A caller that does not supply the count must not be told everything is
     fine — an absent count is zero completed, not "assume satisfied". */
  it('treats an absent count as nothing completed', () => {
    const e = checkEligibility({
      registration: prashant, valuePaise: paise(45_00_000_00n),
      committedThisYearPaise: paise(0n), isNomination: false,
      requiredAuthority: 'zp', asOf,
    })
    expect(e.verdict).toBe('progression_not_met')
  })
})

describe('a lifetime quota is not an annual cap', () => {
  /* MahaTransco allows ₹50 lakh across the LIFE of the registration. The 2022
     ZP certificates allow ₹60 lakh a year, every year. Holding the first in
     the second's field shows an exhausted registration refilling each April. */
  const lifetime = (used: number, over: Partial<RegistrationShape> = {}):
    RegistrationShape => ({
      ...NOMINATION,
      authority: 'mahatransco',
      monetaryLimitPaise: paise(1_00_00_000),
      perWorkCapPaise: paise(20_00_000),
      annualAggregateCapPaise: null,
      lifetimeQuotaPaise: paise(50_00_000),
      lifetimeUsedPaise: paise(used),
      ...over,
    })

  const ask = (r: RegistrationShape, value: number) => checkEligibility({
    registration: r, valuePaise: paise(value),
    committedThisYearPaise: paise(0), isNomination: true,
    asOf: d('2026-09-16'),
  })

  it('allows a work inside what is left', () => {
    const e = ask(lifetime(30_00_000), 15_00_000)
    expect(e.verdict).toBe('eligible')
    expect(e.lifetimeRemainingPaise).toBe(paise(20_00_000))
  })

  it('refuses a work beyond it, and says it will never refill', () => {
    const e = ask(lifetime(45_00_000), 15_00_000)
    expect(e.verdict).toBe('lifetime_quota_exhausted')
    expect(e.lifetimeRemainingPaise).toBe(paise(5_00_000))
    // The distinction that matters: telling somebody to wait for April when
    // the registration is finished for good is the worst available answer.
    expect(e.reason).toContain('does NOT refill')
  })

  it('reports the annual cap first where both bite, because that one refills', () => {
    const e = ask(lifetime(0, {
      annualAggregateCapPaise: paise(10_00_000) }), 15_00_000)
    expect(e.verdict).toBe('insufficient_annual_headroom')
    expect(e.reason).toContain('refills in April')
  })

  it('leaves a registration with no such condition unaffected', () => {
    const e = ask(lifetime(0, { lifetimeQuotaPaise: null }), 15_00_000)
    expect(e.verdict).toBe('eligible')
    expect(e.lifetimeRemainingPaise).toBeNull()
  })

  it('does not apply the quota to competitively won work', () => {
    // The quota caps NOMINATION work. A tender won on merit is not against it.
    const e = checkEligibility({
      registration: lifetime(50_00_000), valuePaise: paise(15_00_000),
      committedThisYearPaise: paise(0), isNomination: false,
      asOf: d('2026-09-16'),
    })
    expect(e.verdict).toBe('eligible')
  })
})
