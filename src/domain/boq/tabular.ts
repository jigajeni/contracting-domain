import { qtyTimesRate, type Paise } from '../money'
import type { BoqItem, ParsedBoq } from './mahatenders'

/**
 * Parser for a priced schedule pasted as text.
 *
 * Most works never have a Mahatenders BOQ workbook: PWD prices from an
 * estimate, and nothing under ten lakh gets a BOQ at all. The schedule still
 * exists — the Suslad final bill has twenty-two items — it just arrives as
 * something a person can select and copy. So: accept a paste from Excel, from
 * a PDF estimate, or typed by hand.
 *
 * Tab-separated is what Excel puts on the clipboard. Comma and pipe are
 * accepted too, and the column order is detected from a header row when there
 * is one so nobody has to rearrange their spreadsheet first.
 */

export type ColumnKey = 'itemNo' | 'description' | 'unit' | 'quantity' | 'rate' | 'ssrRef' | 'ignore'

export interface TabularOptions {
  /** Explicit left-to-right column order. Omit to detect from a header row. */
  columns?: ColumnKey[]
}

const HEADINGS: Record<string, ColumnKey> = {
  'item': 'itemNo', 'item no': 'itemNo', 'itemno': 'itemNo', 'sl no': 'itemNo',
  'sr no': 'itemNo', 'no': 'itemNo', 'अ क्र': 'itemNo', 'क्र': 'itemNo',
  'description': 'description', 'item description': 'description', 'particulars': 'description',
  'तपशील': 'description', 'बाब': 'description',
  'unit': 'unit', 'units': 'unit', 'एकमान': 'unit',
  'quantity': 'quantity', 'qty': 'quantity', 'tendered qty': 'quantity', 'परिमाण': 'quantity',
  'rate': 'rate', 'estimated rate': 'rate', 'दर': 'rate',
  'ssr': 'ssrRef', 'ssr ref': 'ssrRef', 'ssr no': 'ssrRef',
  'amount': 'ignore', 'रक्कम': 'ignore',
}

const DEFAULT_ORDER: ColumnKey[] =
  ['itemNo', 'description', 'unit', 'quantity', 'rate']

const norm = (v: string) =>
  v.toLowerCase().replace(/[.:#()]/g, '').replace(/\s+/g, ' ').trim()

function splitRows(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return []
  // Whichever delimiter appears most consistently wins. Tab first: it is what
  // a spreadsheet paste uses and it never appears inside a description.
  const delim = ['\t', '|', ','].find((d) => lines[0]!.includes(d)) ?? '\t'
  return lines.map((l) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, '')))
}

function detectColumns(row: string[]): ColumnKey[] | null {
  const mapped = row.map((c) => HEADINGS[norm(c)] ?? null)
  const named = mapped.filter(Boolean).length
  // A header row is one where most cells are recognisable headings.
  if (named < 3 || named < Math.floor(row.length / 2)) return null
  return mapped.map((m) => m ?? 'ignore')
}

const cleanNumber = (raw: string) => raw.replace(/[₹,\s]/g, '')

function toQty(raw: string): string | null {
  const s = cleanNumber(raw)
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null
}

function toPaise(raw: string): Paise | null {
  const s = cleanNumber(raw)
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  const [whole = '0', frac = ''] = s.replace('-', '').split('.')
  const v = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2))
  return (s.startsWith('-') ? -v : v) as Paise
}

export function parseTabularBoq(text: string, options: TabularOptions = {}): ParsedBoq {
  const rows = splitRows(text)
  if (rows.length === 0) throw new Error('Nothing was pasted.')

  let columns = options.columns
  let start = 0
  if (!columns) {
    const detected = detectColumns(rows[0]!)
    if (detected) { columns = detected; start = 1 }
    else columns = DEFAULT_ORDER
  }

  const indexOf = (key: ColumnKey) => columns!.indexOf(key)
  const iDesc = indexOf('description')
  const iQty = indexOf('quantity')
  const iRate = indexOf('rate')
  if (iDesc < 0 || iQty < 0 || iRate < 0) {
    throw new Error(
      'The paste needs at least a description, a quantity and a rate. ' +
      'Include a header row, or set the column order.',
    )
  }

  const items: BoqItem[] = []
  const warnings: string[] = []
  let unpriced = 0
  let total = 0n as Paise

  for (let r = start; r < rows.length; r++) {
    const row = rows[r]!
    const desc = (row[iDesc] ?? '').trim()
    if (!desc) continue

    const rawQty = (row[iQty] ?? '').trim()
    const rawRate = (row[iRate] ?? '').trim()

    /* A line with neither a quantity nor a rate is a section heading or a
       carried-forward sub-total. Real estimates are full of them, so they are
       skipped quietly and counted. A line that HAS a value which will not
       parse is a different matter — that is a row someone meant to price, and
       silently dropping it would understate the schedule. */
    if (!rawQty && !rawRate) { unpriced++; continue }

    const qty = toQty(rawQty)
    const rate = toPaise(rawRate)
    if (qty === null || rate === null) {
      warnings.push(
        `Line ${r + 1}: skipped, "${desc.slice(0, 40)}" has an unreadable ` +
        `${qty === null ? 'quantity' : 'rate'}.`,
      )
      continue
    }

    const iNo = indexOf('itemNo')
    const iUnit = indexOf('unit')
    const iSsr = indexOf('ssrRef')
    const amount = qtyTimesRate(qty, rate)

    items.push({
      slNo: (iNo >= 0 ? row[iNo] ?? '' : '').trim() || String(items.length + 1),
      description: desc,
      itemCode: iSsr >= 0 ? (row[iSsr] ?? '').trim() || null : null,
      quantity: qty,
      unit: (iUnit >= 0 ? row[iUnit] ?? '' : '').trim().replace(/^per\s+/i, ''),
      ratePaise: rate,
      amountPaise: amount,
    })
    total = (total + amount) as Paise
  }

  if (items.length === 0) {
    throw new Error(
      'No priced rows were found. Each line needs a description, a quantity and a rate.',
    )
  }

  if (unpriced > 0) {
    warnings.push(
      `${unpriced} line${unpriced > 1 ? 's' : ''} without a quantity or rate treated as ` +
      `headings or sub-totals and left out.`,
    )
  }

  return {
    workName: null, tenderInvitingAuthority: null, contractNo: null, bidderName: null,
    currency: 'INR', boqType: 'pasted',
    items, totalPaise: total, warnings,
  }
}
