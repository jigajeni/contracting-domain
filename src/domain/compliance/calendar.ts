import { addMonths, daysBetween, todayIST, type ISODate } from '../dates'

/**
 * The statutory calendar.
 *
 * Everything the firms owe the government on a repeating date: GST returns,
 * TDS, EPF, ESIC, professional tax, the income tax return, the ROC filings,
 * and the co-operative audit and AGM that only the society has.
 *
 * Unlike every other alert rule, this one has nothing to watch. A bank
 * guarantee has an expiry date sitting in a row; the 20th of next month is
 * not in any table. So the calendar generates the obligation first — a row in
 * `compliance_items` — and the ordinary alert engine then chases that row like
 * anything else. Two stages, because a filed return has to be recordable:
 * a reminder you can only dismiss teaches people to dismiss reminders.
 *
 * **Only for firms where the obligation applies** — CLAUDE.md §3. A labour
 * society does not file MGT-7 and a firm below the EPF threshold does not file
 * an ECR. The applicability flags live on `firms` and are Admin-entered, so
 * the default for every one of them is "no": a firm generates nothing until
 * somebody says what it is liable for.
 *
 * Pure — no database, no clock beyond what is passed in.
 */

export type Periodicity = 'monthly' | 'quarterly' | 'annual'
export type GstRegistration = 'regular' | 'composition' | 'unregistered'

/** What the calendar needs to know about a firm. Nothing else. */
export interface FirmProfile {
  id: string
  shortName: string
  /** `firms.entity_type`. A company's return is always the later date. */
  entityType: string
  gstApplicable: boolean
  gstRegistration: GstRegistration
  epfApplicable: boolean
  esicApplicable: boolean
  tdsDeductor: boolean
  rocApplicable: boolean
  societyAuditApplicable: boolean
  taxAuditApplicable: boolean
  professionalTaxApplicable: boolean
}

export interface Period {
  kind: Periodicity
  /** Goes into the dedupe key: '2026-07', '2026-Q1', '2025-26'. */
  key: string
  /** What a person reads: 'Jul-2026', 'Q1 FY 2026-27', 'FY 2025-26'. */
  label: string
  /** The financial year this period sits in, as its starting year. */
  fyStart: number
}

export interface Obligation {
  /** Stable, and part of the dedupe key — never rename one in place. */
  code: string
  /** The `compliance_type` enum value it is stored as. */
  complianceType: string
  title: string
  periodicity: Periodicity
  applies: (f: FirmProfile) => boolean
  dueDate: (p: Period, f: FirmProfile) => ISODate
  /** Why it matters, in the words somebody chasing it would use. */
  note: string
  /**
   * How far ahead it appears in the register.
   *
   * A GST return needs a fortnight; an income tax audit needs a quarter,
   * because the work is assembling a year of books rather than pressing
   * submit. The alert offsets stay at T−7/T−3/T−1 either way — this only
   * controls when the obligation becomes visible on the compliance screen.
   */
  lookaheadDays: number
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

const pad = (n: number) => String(n).padStart(2, '0')
const date = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}` as ISODate

const fyLabelOf = (fyStart: number) =>
  `FY ${fyStart}-${pad((fyStart + 1) % 100)}`

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/** The month being reported on — July's return is filed in August. */
export function monthPeriod(year: number, month: number): Period {
  return {
    kind: 'monthly',
    key: `${year}-${pad(month)}`,
    label: `${MONTHS[month - 1]}-${year}`,
    fyStart: month >= 4 ? year : year - 1,
  }
}

/** Quarters of the financial year. Q1 is April–June. */
export function quarterPeriod(fyStart: number, q: 1 | 2 | 3 | 4): Period {
  return {
    kind: 'quarterly',
    key: `${fyStart}-Q${q}`,
    label: `Q${q} ${fyLabelOf(fyStart)}`,
    fyStart,
  }
}

/** A whole financial year, identified by the year it starts in. */
export function annualPeriod(fyStart: number): Period {
  return {
    kind: 'annual',
    key: `${fyStart}-${pad((fyStart + 1) % 100)}`,
    label: fyLabelOf(fyStart),
    fyStart,
  }
}

/** Day D of the month after the one being reported on. */
function monthAfter(p: Period, day: number): ISODate {
  const [y, m] = p.key.split('-').map(Number) as [number, number]
  return m === 12 ? date(y + 1, 1, day) : date(y, m + 1, day)
}

function lastDayOf(anyDayInMonth: ISODate): ISODate {
  const [y, m] = anyDayInMonth.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return date(y, m, last)
}

// ---------------------------------------------------------------------------
// The obligations
// ---------------------------------------------------------------------------

/**
 * Whose accounts are audited, which is what moves the return to 31 October.
 *
 * Not the same question as the tax audit flag. A private limited company is
 * audited under the Companies Act however small it is, so its return is the
 * later date even in a year where section 44AB does not apply to it.
 */
const audited = (f: FirmProfile) =>
  f.taxAuditApplicable || f.entityType === 'private_limited' || f.entityType === 'llp'

const gstRegular = (f: FirmProfile) =>
  f.gstApplicable && f.gstRegistration === 'regular'
const gstComposition = (f: FirmProfile) =>
  f.gstApplicable && f.gstRegistration === 'composition'

export const OBLIGATIONS: Obligation[] = [
  /* --- GST, monthly for a regular registration ------------------------- */
  {
    code: 'gstr_1', complianceType: 'gstr_1', periodicity: 'monthly',
    title: 'GSTR-1 — outward supplies',
    applies: gstRegular,
    dueDate: (p) => monthAfter(p, 11),
    note: 'Due the 11th. Filed before GSTR-3B, and the department’s GSTR-2B '
        + 'is built from it — a late GSTR-1 delays somebody else’s credit.',
    lookaheadDays: 45,
  },
  {
    code: 'gstr_3b', complianceType: 'gstr_3b', periodicity: 'monthly',
    title: 'GSTR-3B — monthly summary return',
    applies: gstRegular,
    dueDate: (p) => monthAfter(p, 20),
    note: 'Due the 20th. Late fee ₹50 per day and interest at 18% a year on '
        + 'the cash liability — and the next return cannot be filed until this one is.',
    lookaheadDays: 45,
  },
  {
    code: 'gstr_9', complianceType: 'gstr_9', periodicity: 'annual',
    title: 'GSTR-9 — annual GST return',
    applies: gstRegular,
    dueDate: (p) => date(p.fyStart + 1, 12, 31),
    note: 'Due 31 December after the year ends. Mandatory above ₹2 crore '
        + 'aggregate turnover; optional below it — mark it not applicable if it is.',
    lookaheadDays: 120,
  },

  /* --- GST, composition ------------------------------------------------ */
  {
    code: 'cmp_08', complianceType: 'cmp_08', periodicity: 'quarterly',
    title: 'CMP-08 — quarterly statement and payment',
    applies: gstComposition,
    dueDate: (p) => quarterAfter(p, 18),
    note: 'Due the 18th of the month after the quarter.',
    lookaheadDays: 45,
  },
  {
    code: 'gstr_4', complianceType: 'gstr_4', periodicity: 'annual',
    title: 'GSTR-4 — annual return (composition)',
    applies: gstComposition,
    dueDate: (p) => date(p.fyStart + 1, 6, 30),
    note: 'Due 30 June after the year ends.',
    lookaheadDays: 120,
  },

  /* --- income tax deducted from what we pay out ------------------------ */
  {
    code: 'tds_payment', complianceType: 'tds_payment', periodicity: 'monthly',
    title: 'TDS payment — challan ITNS-281',
    applies: (f) => f.tdsDeductor,
    dueDate: (p) => {
      const [y, m] = p.key.split('-').map(Number) as [number, number]
      // March is the exception: 30 April, not 7 April.
      return m === 3 ? date(y, 4, 30) : monthAfter(p, 7)
    },
    note: 'Due the 7th, except March which is 30 April. Interest runs at 1.5% per '
        + 'month from the date of deduction, counted in whole months — a day late '
        + 'costs a month.',
    lookaheadDays: 45,
  },
  {
    code: 'tds_return', complianceType: 'tds_return', periodicity: 'quarterly',
    title: 'TDS quarterly return 26Q',
    applies: (f) => f.tdsDeductor,
    dueDate: (p) => {
      const q = Number(p.key.slice(-1))
      // Q4 gets two months, the rest one.
      if (q === 1) return date(p.fyStart, 7, 31)
      if (q === 2) return date(p.fyStart, 10, 31)
      if (q === 3) return date(p.fyStart + 1, 1, 31)
      return date(p.fyStart + 1, 5, 31)
    },
    note: 'Late filing is ₹200 a day until it is filed. Until it is, the '
        + 'deductee cannot see the credit in their 26AS — which is how a '
        + 'sub-contractor finds out and asks.',
    lookaheadDays: 60,
  },

  /* --- labour ---------------------------------------------------------- */
  {
    code: 'epf', complianceType: 'epf', periodicity: 'monthly',
    title: 'EPF monthly ECR and payment',
    applies: (f) => f.epfApplicable,
    dueDate: (p) => monthAfter(p, 15),
    note: 'Due the 15th. The employee’s share is money already deducted from '
        + 'wages; paying it late is a different kind of default from paying tax late.',
    lookaheadDays: 45,
  },
  {
    code: 'esic', complianceType: 'esic', periodicity: 'monthly',
    title: 'ESIC monthly contribution',
    applies: (f) => f.esicApplicable,
    dueDate: (p) => monthAfter(p, 15),
    note: 'Due the 15th. An unpaid month can leave a worker’s treatment '
        + 'unclaimable at the ESIC hospital.',
    lookaheadDays: 45,
  },
  {
    code: 'ptrc', complianceType: 'professional_tax', periodicity: 'monthly',
    title: 'Professional tax — PTRC monthly return',
    applies: (f) => f.professionalTaxApplicable,
    dueDate: (p) => lastDayOf(monthAfter(p, 1)),
    note: 'Maharashtra PTRC, deducted from salaries. Due the last day of the '
        + 'following month for a monthly filer.',
    lookaheadDays: 45,
  },
  {
    code: 'ptec', complianceType: 'professional_tax', periodicity: 'annual',
    title: 'Professional tax — PTEC annual payment',
    applies: (f) => f.professionalTaxApplicable,
    dueDate: (p) => date(p.fyStart + 1, 6, 30),
    note: 'The firm’s own enrolment certificate. ₹2,500 a year, due 30 June.',
    lookaheadDays: 90,
  },

  /* --- the year end ---------------------------------------------------- */
  {
    code: 'tax_audit', complianceType: 'tax_audit', periodicity: 'annual',
    title: 'Tax audit report — Form 3CA/3CD',
    applies: (f) => f.taxAuditApplicable,
    dueDate: (p) => date(p.fyStart + 1, 9, 30),
    note: 'Due 30 September, and it must be filed before the return. The books '
        + 'have to be with the auditor well before this — a month is not enough.',
    lookaheadDays: 120,
  },
  {
    code: 'itr', complianceType: 'itr', periodicity: 'annual',
    title: 'Income tax return',
    applies: () => true,
    dueDate: (p, f) => audited(f)
      ? date(p.fyStart + 1, 10, 31)
      : date(p.fyStart + 1, 7, 31),
    note: 'Due 31 October where the accounts are audited, 31 July otherwise. '
        + 'A company is always the later date — it is audited under the '
        + 'Companies Act whether or not section 44AB applies. Filing late '
        + 'forfeits the right to carry a loss forward.',
    lookaheadDays: 120,
  },

  /* --- company filings ------------------------------------------------- */
  {
    code: 'roc_aoc4', complianceType: 'roc_annual', periodicity: 'annual',
    title: 'ROC — AOC-4, financial statements',
    applies: (f) => f.rocApplicable,
    dueDate: (p) => date(p.fyStart + 1, 10, 30),
    note: 'Within thirty days of the AGM. ₹100 a day, with no ceiling and no '
        + 'waiver — this is the filing that quietly becomes expensive.',
    lookaheadDays: 120,
  },
  {
    code: 'roc_mgt7', complianceType: 'roc_annual', periodicity: 'annual',
    title: 'ROC — MGT-7, annual return',
    applies: (f) => f.rocApplicable,
    dueDate: (p) => date(p.fyStart + 1, 11, 29),
    note: 'Within sixty days of the AGM. Same ₹100 a day.',
    lookaheadDays: 120,
  },

  /* --- the society, which files nothing a company files ---------------- */
  {
    code: 'society_audit', complianceType: 'society_audit', periodicity: 'annual',
    title: 'Statutory co-operative audit',
    applies: (f) => f.societyAuditApplicable,
    dueDate: (p) => date(p.fyStart + 1, 7, 31),
    note: 'Within four months of the year end, by an auditor from the panel the '
        + 'Dy. Registrar allots. An unaudited society is not eligible for '
        + 'reserved work.',
    lookaheadDays: 120,
  },
  {
    code: 'society_agm', complianceType: 'society_agm', periodicity: 'annual',
    title: 'Co-operative society AGM',
    applies: (f) => f.societyAuditApplicable,
    dueDate: (p) => date(p.fyStart + 1, 9, 30),
    note: 'By 30 September. The audited accounts are placed before it, so the '
        + 'audit has to be finished first.',
    lookaheadDays: 120,
  },
]

/** Day D of the month following a quarter. */
function quarterAfter(p: Period, day: number): ISODate {
  const q = Number(p.key.slice(-1))
  if (q === 1) return date(p.fyStart, 7, day)
  if (q === 2) return date(p.fyStart, 10, day)
  if (q === 3) return date(p.fyStart + 1, 1, day)
  return date(p.fyStart + 1, 4, day)
}

// ---------------------------------------------------------------------------
// What is due
// ---------------------------------------------------------------------------

export interface DueItem {
  obligationCode: string
  complianceType: string
  title: string
  period: Period
  dueDate: ISODate
  note: string
}

/**
 * The periods worth considering around a date.
 *
 * Deliberately a short fixed span rather than arithmetic on due dates: the
 * rules differ per obligation (March TDS is paid in April, Q4 returns are
 * filed in May), and generating a few periods and letting the due date decide
 * is easier to check by eye than a closed-form inverse.
 */
function periodsAround(kind: Periodicity, today: ISODate): Period[] {
  const [y, m] = today.split('-').map(Number) as [number, number]
  const fyStart = m >= 4 ? y : y - 1

  if (kind === 'monthly') {
    return [-4, -3, -2, -1, 0, 1].map((d) => {
      const shifted = addMonths(`${y}-${pad(m)}-01` as ISODate, d)
      const [sy, sm] = shifted.split('-').map(Number) as [number, number]
      return monthPeriod(sy, sm)
    })
  }
  if (kind === 'quarterly') {
    return [fyStart - 1, fyStart].flatMap((f) =>
      ([1, 2, 3, 4] as const).map((q) => quarterPeriod(f, q)))
  }
  return [fyStart - 2, fyStart - 1, fyStart].map(annualPeriod)
}

/**
 * Everything this firm owes that falls due from today onwards, inside each
 * obligation's own lookahead.
 *
 * **Forward only.** Generating what was due last month would fill the register
 * with items marked pending that were in fact filed on time, and a compliance
 * screen that is wrong about the past is worse than one that starts empty. The
 * calendar begins working from the day it is switched on; anything older is
 * entered by hand if it matters.
 */
export function dueFor(firm: FirmProfile, today: ISODate = todayIST()): DueItem[] {
  const out: DueItem[] = []

  for (const ob of OBLIGATIONS) {
    if (!ob.applies(firm)) continue
    for (const period of periodsAround(ob.periodicity, today)) {
      const dueDate = ob.dueDate(period, firm)
      if (dueDate < today) continue
      if (daysBetween(today, dueDate) > ob.lookaheadDays) continue
      out.push({
        obligationCode: ob.code,
        complianceType: ob.complianceType,
        title: ob.title,
        period,
        dueDate,
        note: ob.note,
      })
    }
  }

  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate)
    || a.obligationCode.localeCompare(b.obligationCode))
}

/**
 * (firm, obligation, period) — matching the shape already used for these in
 * the seed. Not the engine's (rule, entity, trigger date): the obligation
 * exists once per period whatever day the job happens to run, and the task
 * chasing it is keyed separately.
 */
export const complianceDedupeKey = (
  firmId: string, obligationCode: string, periodKey: string,
): string => `STATUTORY:firm:${firmId}:${obligationCode}:${periodKey}`
