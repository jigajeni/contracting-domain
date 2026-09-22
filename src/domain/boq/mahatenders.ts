import { paise, qtyTimesRate, pctOf, type Paise } from '../money'

/**
 * Parser for the Mahatenders "Percentage BoQ" workbook.
 *
 * Pure: it takes rows of strings and returns items and totals. Turning an .xls
 * into rows happens in the action layer, so this can be tested against a real
 * BOQ without a spreadsheet library or a database.
 *
 * The template is fixed by the portal — bidders are told not to modify it —
 * but the header block drifts by a row or two between works, so the parser
 * finds its landmarks rather than trusting fixed offsets.
 */

export interface BoqItem {
  slNo: string
  description: string
  itemCode: string | null
  quantity: string          // kept as a string: numeric(18,3), never a float
  unit: string
  ratePaise: Paise
  amountPaise: Paise        // quantity × rate, computed not read
}

export interface ParsedBoq {
  workName: string | null
  tenderInvitingAuthority: string | null
  contractNo: string | null
  bidderName: string | null
  currency: string
  /** 'percentage' — one quoted percentage against the whole schedule. */
  boqType: string | null
  items: BoqItem[]
  /** Σ quantity × rate. The figure the department advertises. */
  totalPaise: Paise
  warnings: string[]
}

const HEADER_LABELS = ['sl no', 'item description']

/** Header cells arrive as "Sl.\nNo." — collapse whitespace and drop dots so a
 *  wrapped column heading still matches. Missing a column here does not fail
 *  loudly: it silently shifts every later column and imports the portal's
 *  column-number strip as a priced item. */
const norm = (v: unknown) =>
  (v ?? '').toString().toLowerCase().replace(/[.\u00a0]/g, '').replace(/\s+/g, ' ').trim()

/** Cell access that never throws on a short row. */
const at = (rows: string[][], r: number, c: number): string =>
  (rows[r]?.[c] ?? '').toString().trim()

function findLabel(rows: string[][], needle: string, limit = 20): string | null {
  const n = needle.toLowerCase()
  for (let r = 0; r < Math.min(rows.length, limit); r++) {
    for (const cell of rows[r] ?? []) {
      const v = (cell ?? '').toString()
      if (v.toLowerCase().includes(n)) {
        // Value may follow the colon in the same cell, or sit in the next one.
        const afterColon = v.split(':').slice(1).join(':').trim()
        if (afterColon) return afterColon
        const idx = (rows[r] ?? []).indexOf(cell)
        const next = at(rows, r, idx + 1)
        if (next) return next
      }
    }
  }
  return null
}

/** The row carrying "Sl. No." / "Item Description" — items begin two rows below. */
function findHeaderRow(rows: string[][]): number {
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const joined = (rows[r] ?? []).map(norm).join('|')
    if (HEADER_LABELS.every((l) => joined.includes(l))) return r
    if (joined.includes('item description') && joined.includes('quantity')) return r
  }
  return -1
}

/** '1,234.567' or '1234.567' → '1234.567'. Rejects anything else. */
function toQty(raw: string): string | null {
  const s = raw.replace(/,/g, '').trim()
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  return s
}

function toPaise(raw: string): Paise | null {
  const s = raw.replace(/[₹,\s]/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  // Rates carry two decimals; guard against a third appearing.
  const [whole = '0', frac = ''] = s.split('.')
  const cents = (frac + '00').slice(0, 2)
  const v = BigInt(whole) * 100n + BigInt(cents)
  return (s.startsWith('-') ? -v : v) as Paise
}

export function parseMahatendersBoq(rows: string[][]): ParsedBoq {
  const warnings: string[] = []

  const headerRow = findHeaderRow(rows)
  if (headerRow < 0) {
    throw new Error(
      'This does not look like a Mahatenders BOQ: no "Sl. No. / Item Description" header row found.',
    )
  }

  // Column positions are read off the header row rather than assumed, because
  // the template has 55 columns and only a handful carry anything.
  const header = (rows[headerRow] ?? []).map(norm)
  const col = (...needles: string[]) => {
    for (const n of needles) {
      const i = header.findIndex((h) => h.includes(n))
      if (i >= 0) return i
    }
    return -1
  }
  const cSl = col('sl no', 'sr no', 'item no')
  const cDesc = col('item description', 'description')
  const cCode = col('item code')
  const cQty = col('quantity')
  const cUnit = col('units', 'unit')
  const cRate = col('estimated rate', 'rate')

  /* Every column is required. A missing one shifts the rest and produces a
     plausible but wrong import, so fail here rather than downstream. */
  for (const [name, idx] of [
    ['Sl. No.', cSl], ['Item Description', cDesc],
    ['Quantity', cQty], ['Estimated Rate', cRate],
  ] as const) {
    if (idx < 0) throw new Error(`Mahatenders BOQ is missing its "${name}" column.`)
  }

  const items: BoqItem[] = []
  let total = 0n as Paise

  for (let r = headerRow + 1; r < rows.length; r++) {
    const sl = at(rows, r, cSl)
    const desc = at(rows, r, cDesc)
    if (!desc) continue
    // The row directly under the header is the portal's column-number strip
    // (1, 2, 3, …55). Every cell is its own index.
    if (/^\d+$/.test(sl) && /^\d+$/.test(desc) && Number(desc) === Number(sl) + 1) continue
    if (!sl) { warnings.push(`Row ${r + 1}: skipped, no serial number.`); continue }

    const qty = toQty(at(rows, r, cQty))
    const rate = toPaise(at(rows, r, cRate))
    if (qty === null || rate === null) {
      warnings.push(`Row ${r + 1}: skipped, quantity or rate is not a number.`)
      continue
    }

    const amount = qtyTimesRate(qty, rate)
    items.push({
      slNo: sl || String(items.length + 1),
      description: desc,
      itemCode: cCode >= 0 ? at(rows, r, cCode) || null : null,
      quantity: qty,
      unit: at(rows, r, cUnit).replace(/^per\s+/i, ''),
      ratePaise: rate,
      amountPaise: amount,
    })
    total = (total + amount) as Paise
  }

  if (items.length === 0) throw new Error('No priced items found in this BOQ.')

  return {
    workName: findLabel(rows, 'name of work'),
    tenderInvitingAuthority: findLabel(rows, 'tender inviting authority'),
    contractNo: findLabel(rows, 'contract no'),
    bidderName: findLabel(rows, 'bidder name'),
    currency: at(rows, 1, 4) || 'INR',
    boqType: at(rows, 1, 1) || null,
    items,
    totalPaise: total,
    warnings,
  }
}

/**
 * Checks a parsed BOQ against the figures on the work order, which is the only
 * thing that proves the file was read correctly. An importer that silently
 * mis-reads a column produces a plausible total and a wrong contract.
 */
export interface Reconciliation {
  parsedTotalPaise: Paise
  advertisedPaise: Paise | null
  acceptedPaise: Paise | null
  premiumPct: string | null
  advertisedDiffPaise: Paise | null
  acceptedDiffPaise: Paise | null
  matches: boolean
}

export function reconcile(
  parsed: ParsedBoq,
  against: { advertisedPaise?: Paise; acceptedPaise?: Paise; premiumPct?: string },
  tolerancePaise = 100n,          // a rupee either way, for the department's own rounding
): Reconciliation {
  const advertised = against.advertisedPaise ?? null
  const accepted = against.acceptedPaise ?? null
  const pct = against.premiumPct ?? null

  const advertisedDiff =
    advertised === null ? null : ((parsed.totalPaise - advertised) as Paise)

  let acceptedDiff: Paise | null = null
  if (accepted !== null && pct !== null) {
    // A negative premium is quoted "below"; the sign lives in the number.
    const reduction = pctOf(parsed.totalPaise, pct.replace('-', ''))
    const derived = (parsed.totalPaise - reduction) as Paise
    acceptedDiff = (derived - accepted) as Paise
  }

  const within = (d: Paise | null) => d === null || (d < 0n ? -d : d) <= tolerancePaise

  return {
    parsedTotalPaise: parsed.totalPaise,
    advertisedPaise: advertised,
    acceptedPaise: accepted,
    premiumPct: pct,
    advertisedDiffPaise: advertisedDiff,
    acceptedDiffPaise: acceptedDiff,
    matches: within(advertisedDiff) && within(acceptedDiff),
  }
}
