import { formatINR, type Paise } from '../money'
import type { BillStatus } from './stages'

/**
 * Revising a bill after it has left the office.
 *
 * A bill that has been passed is a document the department is holding. Ours
 * has to keep matching theirs, so corrections do happen — but they cannot
 * happen silently, because the difference between what we billed and what they
 * passed is the only evidence anyone has when a payment comes up short.
 * CLAUDE.md §2: after `passed`, edits require a `ra_bill_revisions` record.
 *
 * Pure. What is stored is decided here; where it is stored is the action's
 * problem.
 */

/**
 * Once a bill has been passed it is out of our hands, so any change to it is a
 * revision. Before that it is still a working document.
 *
 * `rejected` is deliberately not included: the department has sent it back to
 * be redone, and redoing it is the point.
 */
export function revisionRequired(status: BillStatus): boolean {
  return status === 'passed' || status === 'sent_treasury' || status === 'paid'
}

/** A bill nobody may touch at all. */
export const isFrozen = (status: BillStatus): boolean => status === 'cancelled'

/**
 * The figures a revision is about.
 *
 * Deliberately not every column. A remark or a period date changing is
 * housekeeping; these are the numbers the department will disagree with.
 */
export interface BillSnapshot {
  linesTotalPaise: string
  limitedTotalPaise: string | null
  workValuePaise: string
  gstBasePaise: string
  cgstPaise: string
  sgstPaise: string
  igstPaise: string
  additionsPaise: string
  deductionBasePaise: string
  cumulativeTotalPaise: string
  previousPaise: string
  payablePaise: string
  totalDeductionsPaise: string
  netPayablePaise: string
  /** item_no → cumulative quantity, so a moved quantity is visible. */
  quantities: Record<string, string>
  /** deduction code → this-bill amount. */
  deductions: Record<string, string>
}

const LABELS: Record<string, string> = {
  linesTotalPaise: 'Sum of items',
  limitedTotalPaise: 'Limited to',
  workValuePaise: 'Work value',
  gstBasePaise: 'GST base',
  cgstPaise: 'CGST',
  sgstPaise: 'SGST',
  igstPaise: 'IGST',
  additionsPaise: 'Additions',
  deductionBasePaise: 'Deduction base',
  cumulativeTotalPaise: 'Cumulative to date',
  previousPaise: 'Less paid so far',
  payablePaise: 'Payable this bill',
  totalDeductionsPaise: 'Total deductions',
  netPayablePaise: 'Net payable',
}

export interface Change {
  field: string
  label: string
  before: string
  after: string
  /** Money fields render as rupees; quantities as they are. */
  kind: 'money' | 'quantity'
  /** Signed movement in paise, for money. */
  deltaPaise?: Paise
}

const money = (v: string | null): Paise => (v === null ? 0n : BigInt(v)) as Paise

/**
 * What actually changed between two states of a bill.
 *
 * Returns nothing when the figures are identical — a "revision" that changes
 * no number is a note, and recording it as a revision would bury the ones that
 * matter.
 */
export function diffBill(before: BillSnapshot, after: BillSnapshot): Change[] {
  const out: Change[] = []

  for (const field of Object.keys(LABELS)) {
    const b = (before as any)[field] as string | null
    const a = (after as any)[field] as string | null
    if (String(b ?? '') === String(a ?? '')) continue
    out.push({
      field, label: LABELS[field]!,
      before: formatINR(money(b)), after: formatINR(money(a)),
      kind: 'money',
      deltaPaise: (money(a) - money(b)) as Paise,
    })
  }

  /* Quantities: a bill whose totals happen to match can still have had a
     quantity moved between items, and the department will notice. */
  const items = new Set([
    ...Object.keys(before.quantities), ...Object.keys(after.quantities),
  ])
  for (const item of [...items].sort()) {
    const b = before.quantities[item] ?? '0'
    const a = after.quantities[item] ?? '0'
    if (Number(b) === Number(a)) continue
    out.push({
      field: `qty:${item}`, label: `Item ${item} quantity`,
      before: b, after: a, kind: 'quantity',
    })
  }

  const codes = new Set([
    ...Object.keys(before.deductions), ...Object.keys(after.deductions),
  ])
  for (const code of [...codes].sort()) {
    const b = before.deductions[code] ?? '0'
    const a = after.deductions[code] ?? '0'
    if (b === a) continue
    out.push({
      field: `ded:${code}`, label: `${code} deduction`,
      before: formatINR(money(b)), after: formatINR(money(a)),
      kind: 'money',
      deltaPaise: (money(a) - money(b)) as Paise,
    })
  }

  return out
}

/** Whether anything worth recording actually moved. */
export const isMaterial = (changes: Change[]): boolean => changes.length > 0

/**
 * The one line that goes at the top of a revision.
 *
 * The net payable is what everyone asks about, so it leads even when other
 * figures also moved.
 */
export function summarise(changes: Change[]): string {
  const net = changes.find((c) => c.field === 'netPayablePaise')
  if (net && net.deltaPaise !== undefined) {
    const up = net.deltaPaise > 0n
    const size = net.deltaPaise < 0n ? -net.deltaPaise : net.deltaPaise
    return `Net payable ${up ? 'up' : 'down'} ${formatINR(size as Paise)} ` +
           `— ${net.before} to ${net.after}`
  }
  if (changes.length === 0) return 'No figures changed.'
  return `${changes.length} figure${changes.length > 1 ? 's' : ''} changed, ` +
         `net payable unchanged.`
}
