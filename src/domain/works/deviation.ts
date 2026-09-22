import { formatINR, qtyTimesRate, type Paise } from '../money'

/**
 * Deviation statements and extra items.
 *
 * The formal excess/savings statement, item by item: what was tendered against
 * what was executed. Two things make it matter rather than being paperwork.
 *
 * A quantity executed beyond its tendered figure is not payable simply because
 * it was done — the department caps the bill at the tendered quantity until a
 * deviation is approved. And an **extra item** is work not in the original BOQ
 * at all: it needs a rate analysis and departmental approval before it has a
 * rate to be billed at.
 *
 * Pure. CLAUDE.md §1.
 */

/** numeric(18,3) quantities, as everywhere. */
export const QTY_SCALE = 3
export const QTY_UNIT = 1000n
const SCALE = QTY_SCALE
const UNIT = QTY_UNIT

export function parseQty(v: string | number | null | undefined): bigint {
  if (v === null || v === undefined || String(v).trim() === '') return 0n
  const s = String(v).trim()
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '-' || s === '.') {
    throw new RangeError(`not a quantity: ${v}`)
  }
  const neg = s.startsWith('-')
  const [whole = '0', frac = ''] = (neg ? s.slice(1) : s).split('.')
  const n = BigInt(whole || '0') * UNIT + BigInt((frac + '000').slice(0, SCALE))
  return neg ? -n : n
}

/**
 * Exported so the variance module reuses this rather than writing its own.
 * Two implementations of fixed-point quantity parsing drift, and the drift
 * shows up as a few paise nobody can account for.
 */
export function formatQty(t: bigint): string {
  const neg = t < 0n
  const a = neg ? -t : t
  const frac = (a % UNIT).toString().padStart(SCALE, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${a / UNIT}${frac ? '.' + frac : ''}`
}

export interface DeviationInput {
  boqItemId: string
  itemNo: string
  description: string
  unit: string
  tenderedQty: string
  executedQty: string
  ratePaise: Paise
  /** An item not in the original BOQ. Its tendered quantity is nil. */
  isExtra?: boolean
  reason?: string | null
}

export interface DeviationLine extends DeviationInput {
  /** Executed less tendered. Positive is excess, negative is a saving. */
  deviationQty: string
  amountPaise: Paise
  /** Of the tendered quantity. Null for an extra item — nothing to divide by. */
  deviationPct: string | null
  kind: 'excess' | 'saving' | 'extra' | 'nil'
}

export function computeDeviation(input: DeviationInput): DeviationLine {
  const tendered = parseQty(input.tenderedQty)
  const executed = parseQty(input.executedQty)
  const diff = executed - tendered

  const kind: DeviationLine['kind'] =
    input.isExtra || tendered === 0n ? (executed === 0n ? 'nil' : 'extra')
    : diff > 0n ? 'excess'
    : diff < 0n ? 'saving'
    : 'nil'

  /* A percentage of nothing is not zero, it is undefined — an extra item is
     not "infinite deviation", it is a different thing entirely. */
  const pct = tendered === 0n
    ? null
    : ((diff * 1_000_000n) / tendered).toString()

  return {
    ...input,
    deviationQty: formatQty(diff),
    amountPaise: qtyTimesRate(formatQty(diff), input.ratePaise),
    deviationPct: pct === null ? null : formatPct(pct),
    kind,
  }
}

/** The scaled integer back to a two-decimal percentage. */
function formatPct(scaled: string): string {
  const v = BigInt(scaled)
  const neg = v < 0n
  const a = neg ? -v : v
  // scaled is diff/tendered × 10^6; a percentage is that × 100 / 10^6 × 100.
  const hundredths = (a + 50n) / 100n
  return `${neg ? '-' : ''}${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`
}

export interface DeviationTotals {
  excessPaise: Paise
  savingsPaise: Paise
  netPaise: Paise
  extraPaise: Paise
  /** Net movement as a percentage of the contract value, where one is known. */
  netPctOfContract: string | null
}

export function totalsOf(
  lines: DeviationLine[],
  contractValuePaise?: Paise | null,
): DeviationTotals {
  let excess = 0n
  let savings = 0n
  let extra = 0n
  for (const l of lines) {
    if (l.kind === 'extra') extra += l.amountPaise
    else if (l.amountPaise > 0n) excess += l.amountPaise
    else savings += l.amountPaise      // already negative
  }
  const net = excess + savings + extra
  return {
    excessPaise: excess as Paise,
    savingsPaise: savings as Paise,
    extraPaise: extra as Paise,
    netPaise: net as Paise,
    netPctOfContract:
      contractValuePaise && contractValuePaise > 0n
        ? formatPct(((net * 1_000_000n) / contractValuePaise).toString())
        : null,
  }
}

// ---------------------------------------------------------------------------
// What needs approving
// ---------------------------------------------------------------------------

/**
 * The limit beyond which a deviation needs sanction.
 *
 * Departmental, and it varies — this is the common figure, kept as an argument
 * so a work order that states its own can carry it. It is a limit on the
 * statement as a whole, not on any one item.
 */
export const DEFAULT_PERMITTED_PCT = 10

export interface Finding {
  itemNo?: string
  message: string
  severity: 'error' | 'warning'
}

/**
 * What is wrong with this statement.
 *
 * The check that earns its place: an item executed beyond its tendered
 * quantity, on a statement nobody has had approved, is a quantity the
 * department will cap the bill at. Saying so here is the difference between
 * finding out now and finding out when the bill comes back.
 */
export function checkStatement(
  lines: DeviationLine[],
  opts: {
    status: string
    contractValuePaise?: Paise | null
    permittedPct?: number
  },
): Finding[] {
  const out: Finding[] = []
  const totals = totalsOf(lines, opts.contractValuePaise)
  const permitted = opts.permittedPct ?? DEFAULT_PERMITTED_PCT
  const approved = opts.status === 'approved'

  for (const l of lines) {
    if (l.kind === 'extra' && l.ratePaise <= 0n) {
      out.push({
        itemNo: l.itemNo, severity: 'error',
        message: `Item ${l.itemNo} is an extra item with no rate. An extra item ` +
                 `needs a rate analysis approved by the department before it can ` +
                 `be billed.`,
      })
    }
    if (l.kind === 'extra' && !l.reason?.trim()) {
      out.push({
        itemNo: l.itemNo, severity: 'error',
        message: `Item ${l.itemNo} is an extra item with no justification. The ` +
                 `department will not sanction it without one.`,
      })
    }
    if (l.kind === 'excess' && !l.reason?.trim()) {
      out.push({
        itemNo: l.itemNo, severity: 'warning',
        message: `Item ${l.itemNo} exceeds its tendered quantity with no reason ` +
                 `recorded.`,
      })
    }
  }

  if (totals.netPctOfContract !== null) {
    const net = Math.abs(Number(totals.netPctOfContract))
    if (net > permitted && !approved) {
      out.push({
        severity: 'warning',
        message: `The net deviation is ${totals.netPctOfContract}% of the contract ` +
                 `value, past the ${permitted}% normally permitted. It needs ` +
                 `sanction before these quantities can be billed.`,
      })
    }
  }

  if (lines.length === 0) {
    out.push({ severity: 'error', message: 'A deviation statement needs at least one item.' })
  }

  return out
}

export const errorsOf = (f: Finding[]) => f.filter((x) => x.severity === 'error')
export const warningsOf = (f: Finding[]) => f.filter((x) => x.severity === 'warning')

/** One line for the top of the statement. */
export function summarise(t: DeviationTotals): string {
  const parts: string[] = []
  if (t.excessPaise > 0n) parts.push(`${formatINR(t.excessPaise)} excess`)
  if (t.savingsPaise < 0n) parts.push(`${formatINR(-t.savingsPaise as Paise)} savings`)
  if (t.extraPaise !== 0n) parts.push(`${formatINR(t.extraPaise)} extra items`)
  if (parts.length === 0) return 'No deviation.'
  const net = t.netPaise >= 0n ? 'up' : 'down'
  const size = t.netPaise < 0n ? (-t.netPaise as Paise) : t.netPaise
  return `${parts.join(', ')} — net ${net} ${formatINR(size)}` +
         (t.netPctOfContract !== null ? ` (${t.netPctOfContract}% of contract)` : '')
}
