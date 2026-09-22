/**
 * The measurement book.
 *
 * मोजणी पुस्तक — the statutory record of what was physically measured at site,
 * signed by us and checked by the department. An RA bill is built from it, so
 * a quantity that disagrees with the MB is a quantity the department will not
 * pass.
 *
 * Every entry is `nos × length × breadth × depth`, with whatever dimensions
 * the item actually has. The arithmetic is done in scaled integers because
 * floating point gets it wrong at the third decimal — 2.5 × 1.2 is
 * 3.0000000000000004 — and the MB is checked against the department's own
 * arithmetic to three places.
 *
 * Pure. CLAUDE.md §1.
 */

/** numeric(18,3) throughout: nos, each dimension, and the quantity. */
const SCALE = 3
const UNIT = 1000n

/** A decimal string as an exact integer of thousandths. Blank means absent. */
function parse(v: string | number | null | undefined): bigint | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (s === '') return null
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '-' || s === '.') {
    throw new RangeError(`not a measurement: ${v}`)
  }
  const neg = s.startsWith('-')
  const [whole = '0', frac = ''] = (neg ? s.slice(1) : s).split('.')
  if (frac.length > SCALE) {
    // An MB is written to three places. More is a typo, not extra precision.
    throw new RangeError(`a measurement carries three decimals at most: ${v}`)
  }
  const n = BigInt(whole || '0') * UNIT + BigInt((frac + '000').slice(0, SCALE))
  return neg ? -n : n
}

/** Back to the string a numeric(18,3) column holds. */
function format(thousandths: bigint): string {
  const neg = thousandths < 0n
  const a = neg ? -thousandths : thousandths
  const frac = (a % UNIT).toString().padStart(SCALE, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${a / UNIT}${frac ? '.' + frac : ''}`
}

export interface Dimensions {
  /** Count. Negative deducts — an opening measured out of a wall. */
  nos?: string | number | null
  length?: string | number | null
  breadth?: string | number | null
  depth?: string | number | null
}

/**
 * `nos × L × B × D`, with absent dimensions simply not multiplied.
 *
 * A linear item gives length only, an area gives length and breadth, a volume
 * all three. Passing 1 for the ones that do not apply would be the same
 * arithmetic but a worse record: the MB has to show which dimensions were
 * actually taken.
 *
 * Rounded half away from zero to three places, which is what the department
 * writes and what the column holds.
 */
export function measure(d: Dimensions): string {
  const parts = [parse(d.nos), parse(d.length), parse(d.breadth), parse(d.depth)]
    .filter((p): p is bigint => p !== null)

  if (parts.length === 0) return '0'

  // Multiply exactly, tracking the scale, then round once at the end.
  let product = parts[0]!
  for (let i = 1; i < parts.length; i++) product = product * parts[i]!

  const extraScale = parts.length - 1
  return format(roundScaled(product, extraScale))
}

/** Divide out the surplus scale, rounding half away from zero. */
function roundScaled(value: bigint, extraScale: number): bigint {
  if (extraScale <= 0) return value
  const divisor = UNIT ** BigInt(extraScale)
  const neg = value < 0n
  const a = neg ? -value : value
  const q = a / divisor
  const r = a % divisor
  const rounded = r * 2n >= divisor ? q + 1n : q
  return neg ? -rounded : rounded
}

/** Which dimensions an entry actually carries, for showing the working. */
export function workingOf(d: Dimensions): string {
  const shown: string[] = []
  for (const v of [d.nos, d.length, d.breadth, d.depth]) {
    const p = parse(v as any)
    if (p !== null) shown.push(format(p))
  }
  return shown.length ? shown.join(' × ') : '—'
}

// ---------------------------------------------------------------------------
// Rolling up into a bill
// ---------------------------------------------------------------------------

export interface MbEntry {
  boqItemId: string
  quantity: string
}

/** Total per BOQ item, summed exactly. */
export function rollUp(entries: MbEntry[]): Record<string, string> {
  const totals = new Map<string, bigint>()
  for (const e of entries) {
    const q = parse(e.quantity) ?? 0n
    totals.set(e.boqItemId, (totals.get(e.boqItemId) ?? 0n) + q)
  }
  return Object.fromEntries(
    [...totals].map(([id, q]) => [id, format(q)]),
  )
}

export interface Reconciliation {
  boqItemId: string
  itemNo: string
  measuredQty: string
  billedQty: string
  differenceQty: string
  agrees: boolean
}

/**
 * The MB against the bill.
 *
 * The MB is optional — a bill can be raised without a single entry, and often
 * is on a small work. So an item with no measurements is silent, not a
 * disagreement. What matters is an item measured at one figure and billed at
 * another, because the department checks the MB.
 */
export function reconcileWithBill(
  measured: Record<string, string>,
  billed: { boqItemId: string; itemNo: string; cumulativeQty: string }[],
): Reconciliation[] {
  const out: Reconciliation[] = []
  for (const line of billed) {
    const m = measured[line.boqItemId]
    if (m === undefined) continue          // never measured — nothing to say
    const diff = (parse(m) ?? 0n) - (parse(line.cumulativeQty) ?? 0n)
    out.push({
      boqItemId: line.boqItemId,
      itemNo: line.itemNo,
      measuredQty: m,
      billedQty: line.cumulativeQty,
      differenceQty: format(diff),
      agrees: diff === 0n,
    })
  }
  return out
}

export const disagreements = (r: Reconciliation[]): Reconciliation[] =>
  r.filter((x) => !x.agrees)
