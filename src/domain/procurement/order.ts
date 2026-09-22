import { ZERO, paise, pctOf, type Paise } from '../money'

/**
 * Purchase orders, what arrived against them, and what the supplier billed.
 *
 * Three records of the same load of metal, made by three different people at
 * three different moments, and the whole value of this module is in what they
 * say when they disagree:
 *
 *   the PO   — what the office ordered, at the rate agreed
 *   the GRN  — what the driver actually tipped out, signed at the road
 *   the bill — what the supplier says they sent, at their rate
 *
 * They disagree often and in ordinary ways: short deliveries, a rate that
 * moved between ordering and dispatch, material rejected at site and taken
 * back. None of that is fraud and none of it should block anything. What it
 * must not do is pass unnoticed, because the only version anybody checks
 * afterwards is the one that was paid.
 *
 * Pure. CLAUDE.md §5.
 */

/** Quantities are numeric(18,3) and arrive as strings. Held in thousandths. */
export type Qty = bigint & { readonly __brand: 'Qty' }

export const qty = (v: string | number): Qty => {
  const s = String(v).trim()
  if (!/^-?\d+(\.\d{1,3})?$/.test(s)) throw new RangeError(`not a quantity: ${v}`)
  const neg = s.startsWith('-')
  const [whole = '0', frac = ''] = (neg ? s.slice(1) : s).split('.')
  const n = BigInt(whole) * 1000n + BigInt(frac.padEnd(3, '0'))
  return (neg ? -n : n) as Qty
}

export const QTY_ZERO = qty(0)

export const formatQty = (q: Qty): string => {
  const neg = q < 0n
  const abs = neg ? -q : q
  const whole = abs / 1000n
  const frac = String(abs % 1000n).padStart(3, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole.toLocaleString('en-IN')}${frac ? `.${frac}` : ''}`
}

/** qty × rate, rounded half-up to the paise. */
export const lineValue = (q: Qty, ratePaise: Paise): Paise =>
  paise((q * ratePaise + 500n) / 1000n)

/* ------------------------------------------------------------------ */
/* What is still to come                                               */
/* ------------------------------------------------------------------ */

export interface OrderLine {
  materialId: string
  materialName: string
  unit: string
  orderedQty: Qty
  ratePaise: Paise
  /** Accepted at site across every GRN against this order. */
  receivedQty: Qty
}

export type LineState = 'pending' | 'part' | 'complete' | 'over'

export interface LineStatus {
  state: LineState
  outstandingQty: Qty
  /** How far past the order the deliveries have gone. Zero unless `over`. */
  excessQty: Qty
  note: string | null
}

/**
 * Where one line stands.
 *
 * **Over-delivery is a state, not an error.** A tipper carries what it
 * carries; ordering 400 cum and receiving 412 is Tuesday. It is recorded and
 * named and nothing is blocked — but the excess is what the supplier will bill
 * for, so it has to be visible before the bill arrives rather than discovered
 * inside it.
 */
export function lineStatus(l: OrderLine): LineStatus {
  const outstanding = (l.orderedQty - l.receivedQty) as Qty

  if (l.receivedQty <= QTY_ZERO) {
    return { state: 'pending', outstandingQty: outstanding,
             excessQty: QTY_ZERO, note: null }
  }
  if (outstanding > QTY_ZERO) {
    return { state: 'part', outstandingQty: outstanding, excessQty: QTY_ZERO,
             note: `${formatQty(outstanding)} ${l.unit} still to come` }
  }
  if (outstanding < QTY_ZERO) {
    const excess = (-outstanding) as Qty
    return { state: 'over', outstandingQty: QTY_ZERO, excessQty: excess,
             note: `${formatQty(excess)} ${l.unit} more than ordered — it will `
                 + 'be on their bill, so agree it now rather than at payment' }
  }
  return { state: 'complete', outstandingQty: QTY_ZERO, excessQty: QTY_ZERO,
           note: null }
}

export type OrderState = 'draft' | 'issued' | 'partly_received' | 'received'

/** The order's own state, read from its lines. Never stored and trusted. */
export function orderState(lines: OrderLine[], issued: boolean): OrderState {
  if (!issued) return 'draft'
  if (lines.length === 0) return 'issued'
  const states = lines.map((l) => lineStatus(l).state)
  if (states.every((s) => s === 'pending')) return 'issued'
  if (states.every((s) => s === 'complete' || s === 'over')) return 'received'
  return 'partly_received'
}

/* ------------------------------------------------------------------ */
/* Pricing what arrived                                                */
/* ------------------------------------------------------------------ */

export type ProblemKind = 'blocking' | 'warning'
export interface Problem { kind: ProblemKind; message: string }

export interface ReceiptLine {
  materialId: string
  materialName: string
  unit: string
  receivedQty: Qty
  /** What site accepted. The rest went back on the lorry. */
  acceptedQty: Qty
  /** Zero until the office prices it against the supplier's bill. */
  ratePaise: Paise
}

export interface PriceInput {
  lines: ReceiptLine[]
  /** The rate the order agreed, per material, where there is an order. */
  orderedRates: Map<string, Paise>
  gstPct: string
}

export interface PricedLine extends ReceiptLine {
  valuePaise: Paise
  /** rate − ordered rate. Zero where they agree or there is no order. */
  varianceRatePaise: Paise
  variancePct: number | null
}

export interface Priced {
  lines: PricedLine[]
  basicPaise: Paise
  gstPaise: Paise
  totalPaise: Paise
  problems: Problem[]
}

/**
 * Value a delivery.
 *
 * **Priced on the ACCEPTED quantity, never the received one.** Material
 * rejected at site went back on the lorry, and paying for it is the easiest
 * error here to make — because the challan the supplier bills from says what
 * they sent, not what we kept.
 *
 * A rate that differs from the order is reported, not corrected. Rates move
 * between ordering and dispatch and the supplier's is usually the current one;
 * but a ten per cent move is either a real increase somebody should know about
 * or a keying error, and both want a look before the money goes.
 */
export function priceReceipt(input: PriceInput): Priced {
  const problems: Problem[] = []

  const lines: PricedLine[] = input.lines.map((l) => {
    if (l.acceptedQty > l.receivedQty) {
      problems.push({ kind: 'blocking',
        message: `${l.materialName}: more accepted than was received.` })
    }
    const rejected = (l.receivedQty - l.acceptedQty) as Qty
    if (rejected > QTY_ZERO) {
      problems.push({ kind: 'warning',
        message: `${l.materialName}: ${formatQty(rejected)} ${l.unit} was `
          + 'rejected and is not being paid for. Their bill will still show it '
          + '— the challan says what they sent, not what we kept.' })
    }

    const ordered = input.orderedRates.get(l.materialId) ?? null
    const variance = ordered !== null ? ((l.ratePaise - ordered) as Paise) : ZERO
    const pct = ordered !== null && ordered > ZERO
      ? Number(variance * 10000n / ordered) / 100 : null

    if (pct !== null && Math.abs(pct) >= 10) {
      problems.push({ kind: 'warning',
        message: `${l.materialName}: billed at ${Math.abs(pct).toFixed(1)}% `
          + `${pct > 0 ? 'above' : 'below'} the ordered rate. Either the rate `
          + 'moved or somebody keyed it wrong, and both want a look before it '
          + 'is paid.' })
    }
    if (l.ratePaise <= ZERO) {
      problems.push({ kind: 'warning',
        message: `${l.materialName} has no rate yet, so it is at site and its `
          + "cost is in nobody's figures." })
    }

    return { ...l, valuePaise: lineValue(l.acceptedQty, l.ratePaise),
             varianceRatePaise: variance, variancePct: pct }
  })

  const basic = lines.reduce((a, l) => (a + l.valuePaise) as Paise, ZERO)
  /* Zero GST is ordinary, not missing data — a kachha bill from an
     unregistered dealer carries none. CLAUDE.md §2E. */
  const gst = pctOf(basic, input.gstPct)

  return { lines, basicPaise: basic, gstPaise: gst,
           totalPaise: (basic + gst) as Paise, problems }
}

export const blocking = (ps: Problem[]): Problem[] =>
  ps.filter((p) => p.kind === 'blocking')

/* ------------------------------------------------------------------ */
/* Three ways of counting one load                                     */
/* ------------------------------------------------------------------ */

export interface MatchInput {
  /** What the supplier's bill says, per material. */
  billedQty: Map<string, Qty>
  billedTotalPaise: Paise
  /** What site accepted, per material. */
  acceptedQty: Map<string, Qty>
  /** What our own pricing of those receipts comes to. */
  ourTotalPaise: Paise
  names: Map<string, { name: string; unit: string }>
}

export interface Mismatch {
  materialId: string
  materialName: string
  billedQty: Qty
  acceptedQty: Qty
  differenceQty: Qty
  message: string
}

export interface Match {
  agrees: boolean
  mismatches: Mismatch[]
  /** theirs − ours. Positive means they are asking for more. */
  differencePaise: Paise
  summary: string
}

/**
 * The bill against what we actually took in.
 *
 * Quantity first and money second, deliberately. Two totals that differ tell
 * nobody anything; a line saying *they billed 412 cum and site accepted 400*
 * is a phone call with a specific question in it.
 */
export function matchBill(input: MatchInput): Match {
  const ids = new Set([...input.billedQty.keys(), ...input.acceptedQty.keys()])
  const mismatches: Mismatch[] = []

  for (const id of ids) {
    const billed = input.billedQty.get(id) ?? QTY_ZERO
    const accepted = input.acceptedQty.get(id) ?? QTY_ZERO
    if (billed === accepted) continue
    const meta = input.names.get(id) ?? { name: id, unit: '' }
    const diff = (billed - accepted) as Qty
    mismatches.push({
      materialId: id, materialName: meta.name,
      billedQty: billed, acceptedQty: accepted, differenceQty: diff,
      message: accepted === QTY_ZERO
        ? `${meta.name}: billed ${formatQty(billed)} ${meta.unit} with no `
          + 'receipt at site at all.'
        : `${meta.name}: billed ${formatQty(billed)} ${meta.unit}, site `
          + `accepted ${formatQty(accepted)}`
          + (diff > QTY_ZERO
              ? ' — the difference was rejected or never arrived.' : '.'),
    })
  }

  const difference = (input.billedTotalPaise - input.ourTotalPaise) as Paise
  return {
    agrees: mismatches.length === 0 && difference === ZERO,
    mismatches, differencePaise: difference,
    summary: mismatches.length === 0 && difference === ZERO
      ? 'Their bill agrees with what site took in.'
      : mismatches.length > 0
        ? `${mismatches.length} material${mismatches.length === 1 ? '' : 's'} `
          + 'billed for a quantity site did not accept.'
        : difference > ZERO
          ? 'The quantities agree and their total is higher — a rate difference.'
          : 'The quantities agree and their total is lower — a rate difference '
            + 'in our favour, which is worth checking too.',
  }
}
