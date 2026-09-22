import { addDays, addMonths, type ISODate } from '../dates'
import { pctOf, type Paise } from '../money'

/**
 * The rules that turn a work order into a project record.
 *
 * Two dates and one figure decide most of what the system later does to a
 * work: the stipulated completion date is what liquidated damages are measured
 * against, the formalities deadline is when the work is lost if the bond is
 * not in, and the contract value has to reconcile to the estimate and the
 * premium or the BOQ will never tie out.
 *
 * Pure. CLAUDE.md §1, §2B, §8.9.
 */

export interface Finding {
  field?: string
  message: string
  severity: 'error' | 'warning'
}

export const errorsOf = (f: Finding[]) => f.filter((x) => x.severity === 'error')
export const warningsOf = (f: Finding[]) => f.filter((x) => x.severity === 'warning')

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * The stipulated completion date.
 *
 * ZP states the time of completion in **days**, PWD in **months**, and they
 * are not interchangeable — 6 months is not 180 days. Whichever the work order
 * gives is the one used; days wins if both are somehow present, because the
 * ZP form is the one that states it that way.
 */
export function stipulatedCompletion(
  start: ISODate | null,
  months: number | null,
  days: number | null,
): ISODate | null {
  if (!start) return null
  if (days && days > 0) return addDays(start, days)
  if (months && months > 0) return addMonths(start, months)
  return null
}

/**
 * When EMD, bond and documents must be in.
 *
 * Miss it and the work goes to someone else and the registration is suspended
 * — three to six months for a general contractor, two years for an Educated
 * Unemployed Engineer. CLAUDE.md §3, WORK_ORDER_FORMALITIES.
 */
export const formalitiesDue = (workOrderDate: ISODate, withinDays = 15): ISODate =>
  addDays(workOrderDate, withinDays)

/** The DLP runs from actual completion, not from the stipulated date. */
export const dlpEnd = (actualCompletion: ISODate | null, months: number): ISODate | null =>
  actualCompletion ? addMonths(actualCompletion, months) : null

/**
 * The date LD is measured against: the revised date once an EOT is granted,
 * the stipulated one until then.
 */
export const effectiveCompletion = (
  stipulated: ISODate | null,
  revised: ISODate | null,
): ISODate | null => revised ?? stipulated

// ---------------------------------------------------------------------------
// Contract value
// ---------------------------------------------------------------------------

/**
 * What the accepted value should be, given the estimate and the quoted
 * percentage. Signed: negative is below the estimate.
 *
 * Proven on the Ankale work order — ₹63,28,491.89 advertised, 0.25% below,
 * ₹63,12,671 accepted.
 */
export function acceptedFromEstimate(estimate: Paise, premiumPct: string): Paise {
  const magnitude = pctOf(estimate, premiumPct.replace('-', ''))
  return (premiumPct.trim().startsWith('-')
    ? estimate - magnitude
    : estimate + magnitude) as Paise
}

// ---------------------------------------------------------------------------
// The whole record
// ---------------------------------------------------------------------------

export interface ProjectShape {
  workOrderDate: ISODate | null
  agreementDate: ISODate | null
  stipulatedStartDate: ISODate | null
  timeOfCompletionMonths: number | null
  timeOfCompletionDays: number | null
  stipulatedCompletionDate: ISODate | null
  actualCompletionDate: ISODate | null
  dlpMonths: number

  contractValuePaise: Paise | null
  estimatedCostPaise: Paise | null
  tenderPremiumPct: string | null

  licenceId: string | null
  isNominationWork: boolean
  subcontractingAllowed: boolean

  executionModel: 'own' | 'executed_for_other' | 'executed_by_other'
  counterpartyPartyId: string | null
  commissionPct: string | null
  commissionFixedPaise: Paise | null

  gstTreatment: 'inclusive' | 'extra' | 'exempt'
}

/**
 * What must be true before this project is worth saving.
 *
 * Errors block. Warnings are stated and allowed, because a departmental figure
 * that disagrees with our arithmetic is the department's to explain, not ours
 * to overwrite — CLAUDE.md §2.
 */
export function checkProject(p: ProjectShape): Finding[] {
  const out: Finding[] = []

  /* Every work is taken on a registration. Without one, nothing can check
     class capacity, per-work caps or annual headroom, and choosing the wrong
     vehicle is how a registration gets suspended. CLAUDE.md §8.9. */
  if (!p.licenceId) {
    out.push({
      field: 'licenceId', severity: 'error',
      message: 'Every work is taken on a registration. Without one the system ' +
               'cannot check class capacity or annual headroom.',
    })
  }

  if (p.agreementDate && p.workOrderDate && p.agreementDate < p.workOrderDate) {
    // The work order comes first and the agreement is executed after it.
    out.push({
      field: 'agreementDate', severity: 'warning',
      message: 'The agreement is dated before the work order. Usually it is the ' +
               'other way round — check both dates.',
    })
  }

  const derived = stipulatedCompletion(
    p.stipulatedStartDate ?? p.workOrderDate,
    p.timeOfCompletionMonths,
    p.timeOfCompletionDays,
  )
  if (!p.stipulatedCompletionDate && !derived) {
    out.push({
      field: 'timeOfCompletionDays', severity: 'warning',
      message: 'No completion date and no time of completion, so nothing will ' +
               'warn about LD, EOT or the approaching deadline.',
    })
  }
  if (p.stipulatedCompletionDate && derived && p.stipulatedCompletionDate !== derived) {
    out.push({
      field: 'stipulatedCompletionDate', severity: 'warning',
      message: `The work order's time of completion gives ${derived}. Keep the ` +
               `department's own date if it differs — this is only a check.`,
    })
  }
  if (
    p.stipulatedCompletionDate && p.stipulatedStartDate &&
    p.stipulatedCompletionDate < p.stipulatedStartDate
  ) {
    out.push({
      field: 'stipulatedCompletionDate', severity: 'error',
      message: 'Completion is before the start.',
    })
  }

  if (p.timeOfCompletionMonths && p.timeOfCompletionDays) {
    out.push({
      field: 'timeOfCompletionDays', severity: 'warning',
      message: 'Both months and days are set. ZP states days, PWD states months ' +
               '— record whichever the work order gives, not both.',
    })
  }

  if (p.dlpMonths <= 0) {
    out.push({
      field: 'dlpMonths', severity: 'warning',
      message: 'No defect liability period, so the second part of the security ' +
               'deposit will never be claimed.',
    })
  }

  if (!p.contractValuePaise || p.contractValuePaise <= 0n) {
    out.push({
      field: 'contractValuePaise', severity: 'error',
      message: 'A work needs its accepted value. Excluding GST — CLAUDE.md §2.',
    })
  }

  /* The accepted value is the estimate moved by the quoted percentage. Where
     all three are present they must agree, or the BOQ will never reconcile. */
  if (p.contractValuePaise && p.estimatedCostPaise && p.tenderPremiumPct) {
    const expected = acceptedFromEstimate(p.estimatedCostPaise, p.tenderPremiumPct)
    const diff = p.contractValuePaise - expected
    const off = diff < 0n ? -diff : diff
    // A rupee either way is rounding; more is a wrong figure somewhere.
    if (off > 100n) {
      out.push({
        field: 'contractValuePaise', severity: 'warning',
        message: `The estimate at ${p.tenderPremiumPct}% gives a different ` +
                 `accepted value. One of the three figures is wrong — check the ` +
                 `work order.`,
      })
    }
  }

  if (p.executionModel !== 'own') {
    if (!p.counterpartyPartyId) {
      out.push({
        field: 'counterpartyPartyId', severity: 'error',
        message: 'An execution arrangement needs the other contractor named.',
      })
    }
    if (!p.commissionPct && !p.commissionFixedPaise) {
      out.push({
        field: 'commissionPct', severity: 'error',
        message: 'An execution arrangement needs its agreed terms recorded.',
      })
    }
    /* This is sub-letting. Where the work order forbids it the arrangement
       breaches a printed condition, and the system must say so plainly rather
       than let the UI imply it is routine. CLAUDE.md §2A. */
    if (!p.subcontractingAllowed) {
      out.push({
        field: 'executionModel', severity: 'warning',
        message: 'This work order forbids sub-contracting, and an execution ' +
                 'arrangement is sub-letting. It will be listed under ' +
                 'arrangement exposure.',
      })
    }
  }

  if (p.isNominationWork && !p.licenceId) {
    out.push({
      field: 'isNominationWork', severity: 'error',
      message: 'A nomination work must name the registration it was nominated on.',
    })
  }

  return out
}

/**
 * Everything a work order implies, so the form can fill it rather than ask.
 * Each is a suggestion the user can overwrite — the department's own figure
 * always wins.
 */
export interface Derived {
  stipulatedCompletionDate: ISODate | null
  formalitiesDueDate: ISODate | null
  dlpEndDate: ISODate | null
  acceptedFromEstimatePaise: Paise | null
}

export function derive(p: {
  workOrderDate: ISODate | null
  stipulatedStartDate: ISODate | null
  timeOfCompletionMonths: number | null
  timeOfCompletionDays: number | null
  actualCompletionDate: ISODate | null
  dlpMonths: number
  formalitiesDeadlineDays: number
  estimatedCostPaise: Paise | null
  tenderPremiumPct: string | null
}): Derived {
  return {
    stipulatedCompletionDate: stipulatedCompletion(
      p.stipulatedStartDate ?? p.workOrderDate,
      p.timeOfCompletionMonths,
      p.timeOfCompletionDays,
    ),
    formalitiesDueDate: p.workOrderDate
      ? formalitiesDue(p.workOrderDate, p.formalitiesDeadlineDays)
      : null,
    dlpEndDate: dlpEnd(p.actualCompletionDate, p.dlpMonths),
    acceptedFromEstimatePaise:
      p.estimatedCostPaise && p.tenderPremiumPct
        ? acceptedFromEstimate(p.estimatedCostPaise, p.tenderPremiumPct)
        : null,
  }
}
