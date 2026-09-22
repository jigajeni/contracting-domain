import { daysBetween, daysSince, type ISODate } from '../dates'

/**
 * The bill pipeline.
 *
 * A bill's life is a queue at four desks and a treasury, and the only thing
 * anyone wants to know is how long it has been sitting at the one it is at.
 * CLAUDE.md §2.
 *
 *   draft → prepared → submitted_je → checked_dye → checked_ee → passed
 *         → sent_treasury → paid
 *
 * Pure. The transition rules are the thing worth testing, and they cannot be
 * tested through a server action without a database.
 */

export const BILL_STAGES = [
  'draft', 'prepared', 'submitted_je', 'checked_dye', 'checked_ee',
  'passed', 'sent_treasury', 'paid',
] as const

export type BillStage = (typeof BILL_STAGES)[number]
export type BillStatus = BillStage | 'rejected' | 'cancelled'

/** Where a bill can go from where it is. */
const FORWARD: Record<BillStatus, BillStatus[]> = {
  draft:         ['prepared', 'cancelled'],
  prepared:      ['submitted_je', 'cancelled'],
  submitted_je:  ['checked_dye', 'rejected'],
  checked_dye:   ['checked_ee', 'rejected'],
  checked_ee:    ['passed', 'rejected'],
  passed:        ['sent_treasury', 'rejected'],
  sent_treasury: ['paid', 'rejected'],
  paid:          [],
  /* A rejected bill goes back to prepared and starts again. It does not
     resume where it was: the department has sent it back to be redone, and
     pretending otherwise loses the days it spent being corrected. */
  rejected:      ['prepared', 'cancelled'],
  cancelled:     [],
}

export const nextStages = (from: BillStatus): BillStatus[] => FORWARD[from] ?? []

export const canTransition = (from: BillStatus, to: BillStatus): boolean =>
  nextStages(from).includes(to)

/** Terminal: nothing further happens to this bill. */
export const isClosed = (s: BillStatus): boolean => s === 'paid' || s === 'cancelled'

/** In the department's hands, so the clock is running and someone must chase. */
export const isWithDepartment = (s: BillStatus): boolean =>
  s === 'submitted_je' || s === 'checked_dye' || s === 'checked_ee' ||
  s === 'passed' || s === 'sent_treasury'

/** Still ours: not yet handed over, so a delay here is our own. */
export const isWithUs = (s: BillStatus): boolean =>
  s === 'draft' || s === 'prepared' || s === 'rejected'

/**
 * Where the bill sits on the pipeline, 0-based, for a progress rail.
 * Rejected and cancelled are not on it and return null.
 */
export function stageIndex(s: BillStatus): number | null {
  const i = (BILL_STAGES as readonly string[]).indexOf(s)
  return i === -1 ? null : i
}

/**
 * Days at the current desk. Aging is measured from current_stage_since and
 * never from created_at — a bill raised in April and passed in September has
 * not been "stuck 150 days" if it reached the EE last week. CLAUDE.md §2.
 */
export const ageInStage = (currentStageSince: ISODate | null, asOf?: ISODate): number =>
  currentStageSince === null
    ? 0
    : asOf
      ? daysBetween(currentStageSince, asOf)
      : daysSince(currentStageSince)

export interface StageHealth {
  days: number
  slaDays: number
  /** Past the per-stage limit — this is what BILL_STUCK fires on. */
  overdue: boolean
  /** Well past it. Not a different rule, just a louder one. */
  severe: boolean
}

export function stageHealth(
  status: BillStatus,
  currentStageSince: ISODate | null,
  slaDays: number,
  asOf?: ISODate,
): StageHealth {
  const days = ageInStage(currentStageSince, asOf)
  // A closed bill has no clock. Neither has one still on our own desk as a
  // draft — that is a to-do, not a delay the department owns.
  const counts = !isClosed(status) && status !== 'draft'
  return {
    days,
    slaDays,
    overdue: counts && days > slaDays,
    severe: counts && days > slaDays * 2,
  }
}

/**
 * What a transition needs before it is allowed.
 *
 * Returned rather than thrown so the screen can grey a button and say why,
 * instead of letting someone press it and read a stack trace.
 */
export interface TransitionCheck {
  ok: boolean
  reason?: string
  /** The transition demands a date the user must supply. */
  needsDate: boolean
  /** Rejections and cancellations are meaningless without one. */
  needsRemarks: boolean
  /** Paid needs the amount actually received — it is rarely the net payable. */
  needsAmount: boolean
}

export function checkTransition(from: BillStatus, to: BillStatus): TransitionCheck {
  const base = {
    needsDate: true,
    needsRemarks: to === 'rejected' || to === 'cancelled',
    needsAmount: to === 'paid',
  }

  if (from === to) {
    return { ...base, ok: false, reason: `The bill is already ${label(to)}.` }
  }
  if (isClosed(from)) {
    return {
      ...base, ok: false,
      reason: from === 'paid'
        ? 'A paid bill is closed. A later correction is a revision, not a stage change.'
        : 'A cancelled bill cannot be moved.',
    }
  }
  if (!canTransition(from, to)) {
    return {
      ...base, ok: false,
      reason: `A bill cannot go from ${label(from)} to ${label(to)}. ` +
        `From here it can only be ${nextStages(from).map(label).join(' or ')}.`,
    }
  }
  return { ...base, ok: true }
}

/**
 * The date column each stage stamps on the bill header, so a list screen can
 * show the pipeline without walking the event table.
 */
export const STAGE_DATE_COLUMN: Partial<Record<BillStatus, string>> = {
  prepared:      'prepared_date',
  submitted_je:  'submitted_je_date',
  checked_dye:   'checked_dye_date',
  checked_ee:    'checked_ee_date',
  passed:        'passed_date',
  sent_treasury: 'sent_treasury_date',
  paid:          'payment_received_date',
}

const LABELS: Record<BillStatus, string> = {
  draft: 'a draft',
  prepared: 'prepared',
  submitted_je: 'with the JE',
  checked_dye: 'with the DyE',
  checked_ee: 'with the EE',
  passed: 'passed',
  sent_treasury: 'at treasury',
  paid: 'paid',
  rejected: 'rejected',
  cancelled: 'cancelled',
}

export const label = (s: BillStatus): string => LABELS[s] ?? s
