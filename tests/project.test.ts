import { describe, expect, it } from 'vitest'
import { formatINR, paise, type Paise } from '@/domain/money'
import type { ISODate } from '@/domain/dates'
import {
  acceptedFromEstimate, checkProject, derive, dlpEnd, effectiveCompletion,
  errorsOf, formalitiesDue, stipulatedCompletion, warningsOf, type ProjectShape,
} from '@/domain/works/project'

const d = (s: string) => s as ISODate

/**
 * Pinned to the real work orders: Ankale (ZP, days) and the Jath–Umadi road
 * (PWD, months). The two departments state the time of completion in
 * different units and 6 months is not 180 days.
 */

describe('the completion date', () => {
  it('counts days when the work order states days — ZP', () => {
    // कामाची मुदत, stated in days on ZP form B-1.
    expect(stipulatedCompletion(d('2025-06-10'), null, 180)).toBe('2025-12-07')
  })

  it('counts months when the work order states months — PWD', () => {
    expect(stipulatedCompletion(d('2025-06-10'), 6, null)).toBe('2025-12-10')
  })

  it('does not treat six months as a hundred and eighty days', () => {
    const byDays = stipulatedCompletion(d('2025-06-10'), null, 180)
    const byMonths = stipulatedCompletion(d('2025-06-10'), 6, null)
    expect(byDays).not.toBe(byMonths)
  })

  it('prefers days when a work order somehow carries both', () => {
    expect(stipulatedCompletion(d('2025-06-10'), 6, 180)).toBe('2025-12-07')
  })

  it('says nothing without a start or a duration', () => {
    expect(stipulatedCompletion(null, 6, null)).toBeNull()
    expect(stipulatedCompletion(d('2025-06-10'), null, null)).toBeNull()
    expect(stipulatedCompletion(d('2025-06-10'), 0, 0)).toBeNull()
  })

  it('uses the revised date once an EOT is granted', () => {
    expect(effectiveCompletion(d('2025-12-07'), d('2026-03-31'))).toBe('2026-03-31')
    expect(effectiveCompletion(d('2025-12-07'), null)).toBe('2025-12-07')
  })
})

describe('the deadlines a work order starts', () => {
  it('gives fifteen days for EMD, bond and documents', () => {
    // Missed, the work goes elsewhere and the registration is suspended —
    // two years on a वर्ग-५अ. CLAUDE.md §3.
    expect(formalitiesDue(d('2025-06-10'))).toBe('2025-06-25')
    expect(formalitiesDue(d('2025-06-10'), 10)).toBe('2025-06-20')
  })

  it('runs the DLP from actual completion, not from the stipulated date', () => {
    expect(dlpEnd(d('2026-01-20'), 12)).toBe('2027-01-20')
    expect(dlpEnd(d('2026-01-20'), 60)).toBe('2031-01-20')
    expect(dlpEnd(null, 12)).toBeNull()   // nothing to run from yet
  })
})

describe('the accepted value', () => {
  it('reproduces the Ankale work order', () => {
    // ₹63,28,491.89 advertised, quoted 0.25% below.
    const accepted = acceptedFromEstimate(paise(632_849_189), '-0.25')
    expect(formatINR(accepted)).toBe('₹63,12,670.66')
  })

  it('adds when the quote is above the estimate', () => {
    expect(formatINR(acceptedFromEstimate(paise(10_000_000), '5'))).toBe('₹1,05,000')
    expect(formatINR(acceptedFromEstimate(paise(10_000_000), '0'))).toBe('₹1,00,000')
  })
})

describe('checkProject', () => {
  const base: ProjectShape = {
    workOrderDate: d('2025-06-10'),
    agreementDate: d('2025-06-18'),
    stipulatedStartDate: d('2025-06-10'),
    timeOfCompletionMonths: null,
    timeOfCompletionDays: 180,
    stipulatedCompletionDate: d('2025-12-07'),
    actualCompletionDate: null,
    dlpMonths: 12,
    contractValuePaise: paise(631_267_100) as Paise,
    estimatedCostPaise: paise(632_849_189) as Paise,
    tenderPremiumPct: '-0.25',
    licenceId: 'a-licence',
    isNominationWork: false,
    subcontractingAllowed: false,
    executionModel: 'own',
    counterpartyPartyId: null,
    commissionPct: null,
    commissionFixedPaise: null,
    gstTreatment: 'extra',
  }

  it('accepts the Ankale work as recorded', () => {
    const f = checkProject(base)
    expect(errorsOf(f)).toHaveLength(0)
    expect(warningsOf(f)).toHaveLength(0)
  })

  it('insists every work names a registration', () => {
    // Choosing the wrong vehicle is how a registration gets suspended.
    const e = errorsOf(checkProject({ ...base, licenceId: null }))
    expect(e.some((x) => x.field === 'licenceId')).toBe(true)
  })

  it('insists on an accepted value', () => {
    expect(errorsOf(checkProject({ ...base, contractValuePaise: null }))[0]!.field)
      .toBe('contractValuePaise')
    expect(errorsOf(checkProject({ ...base, contractValuePaise: paise(0) as Paise }))[0]!.field)
      .toBe('contractValuePaise')
  })

  it('catches a contract value that does not follow from the estimate', () => {
    // The premium, the estimate and the accepted value must agree or the BOQ
    // will never reconcile against the work order.
    const w = warningsOf(checkProject({ ...base, contractValuePaise: paise(600_000_000) as Paise }))
    expect(w.some((x) => x.field === 'contractValuePaise')).toBe(true)
  })

  it('tolerates rounding of a rupee', () => {
    const w = warningsOf(checkProject({ ...base, contractValuePaise: paise(631_267_066) as Paise }))
    expect(w).toHaveLength(0)
  })

  it('refuses completion before the start', () => {
    const e = errorsOf(checkProject({
      ...base, stipulatedCompletionDate: d('2025-06-01'),
    }))
    expect(e.some((x) => x.field === 'stipulatedCompletionDate')).toBe(true)
  })

  it('flags a completion date the work order does not support', () => {
    const w = warningsOf(checkProject({
      ...base, stipulatedCompletionDate: d('2026-06-30'),
    }))
    expect(w[0]!.message).toContain('2025-12-07')
    // Stated as a check, not a correction — the department's date wins.
    expect(w[0]!.severity).toBe('warning')
  })

  it('flags both months and days being set', () => {
    const w = warningsOf(checkProject({ ...base, timeOfCompletionMonths: 6 }))
    expect(w.some((x) => x.message.includes('ZP states days'))).toBe(true)
  })

  it('warns when nothing will ever chase the deadline', () => {
    const w = warningsOf(checkProject({
      ...base, timeOfCompletionDays: null, stipulatedCompletionDate: null,
    }))
    expect(w.some((x) => x.field === 'timeOfCompletionDays')).toBe(true)
  })

  it('warns when the SD second part will never be claimed', () => {
    const w = warningsOf(checkProject({ ...base, dlpMonths: 0 }))
    expect(w.some((x) => x.field === 'dlpMonths')).toBe(true)
  })

  it('notices an agreement dated before its own work order', () => {
    const w = warningsOf(checkProject({ ...base, agreementDate: d('2025-06-01') }))
    expect(w.some((x) => x.field === 'agreementDate')).toBe(true)
  })
})

describe('execution arrangements', () => {
  const arranged: ProjectShape = {
    workOrderDate: d('2025-06-10'), agreementDate: null,
    stipulatedStartDate: d('2025-06-10'),
    timeOfCompletionMonths: null, timeOfCompletionDays: 180,
    stipulatedCompletionDate: d('2025-12-07'), actualCompletionDate: null,
    dlpMonths: 12,
    contractValuePaise: paise(10_000_000) as Paise,
    estimatedCostPaise: null, tenderPremiumPct: null,
    licenceId: 'a-licence', isNominationWork: false,
    subcontractingAllowed: true,
    executionModel: 'executed_for_other',
    counterpartyPartyId: null, commissionPct: null, commissionFixedPaise: null,
    gstTreatment: 'extra',
  }

  it('needs the other contractor named and the terms recorded', () => {
    const e = errorsOf(checkProject(arranged))
    expect(e.map((x) => x.field)).toEqual(['counterpartyPartyId', 'commissionPct'])
  })

  it('is satisfied by a percentage alone', () => {
    expect(errorsOf(checkProject({
      ...arranged, counterpartyPartyId: 'p', commissionPct: '4',
    }))).toHaveLength(0)
  })

  it('is satisfied by a fixed amount alone', () => {
    expect(errorsOf(checkProject({
      ...arranged, counterpartyPartyId: 'p', commissionFixedPaise: paise(50_000_00) as Paise,
    }))).toHaveLength(0)
  })

  it('says plainly that it is sub-letting where the work order forbids it', () => {
    // Never suppressed, and never made to look routine. CLAUDE.md §2A.
    const w = warningsOf(checkProject({
      ...arranged, counterpartyPartyId: 'p', commissionPct: '4',
      subcontractingAllowed: false,
    }))
    expect(w.some((x) => x.message.includes('sub-letting'))).toBe(true)
  })
})

describe('derive', () => {
  it('fills what the work order implies', () => {
    const r = derive({
      workOrderDate: d('2025-06-10'),
      stipulatedStartDate: null,
      timeOfCompletionMonths: null,
      timeOfCompletionDays: 180,
      actualCompletionDate: d('2026-01-20'),
      dlpMonths: 12,
      formalitiesDeadlineDays: 15,
      estimatedCostPaise: paise(632_849_189) as Paise,
      tenderPremiumPct: '-0.25',
    })
    expect(r.stipulatedCompletionDate).toBe('2025-12-07')
    expect(r.formalitiesDueDate).toBe('2025-06-25')
    expect(r.dlpEndDate).toBe('2027-01-20')
    expect(formatINR(r.acceptedFromEstimatePaise!)).toBe('₹63,12,670.66')
  })

  it('falls back to the work order date when no start is given', () => {
    const r = derive({
      workOrderDate: d('2025-06-10'), stipulatedStartDate: null,
      timeOfCompletionMonths: 6, timeOfCompletionDays: null,
      actualCompletionDate: null, dlpMonths: 12, formalitiesDeadlineDays: 15,
      estimatedCostPaise: null, tenderPremiumPct: null,
    })
    expect(r.stipulatedCompletionDate).toBe('2025-12-10')
    expect(r.acceptedFromEstimatePaise).toBeNull()
    expect(r.dlpEndDate).toBeNull()
  })
})
