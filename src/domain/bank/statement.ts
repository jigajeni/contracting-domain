import { addDays, daysBetween, type ISODate } from '../dates'
import { ZERO, type Paise } from '../money'

/**
 * Reading a bank statement.
 *
 * Every rule here exists because a statement looks simple and is not. The
 * same bank exports newest-first from one screen and oldest-first from
 * another; puts two lines of account details above the table and a "Total"
 * row below it; writes 1,25,500.00 in one column and "1,25,500.00 Dr" in the
 * next; and prints a cash credit balance as a positive number that means we
 * owe it. Read carelessly, every one of those produces a ledger that looks
 * plausible and is wrong.
 *
 * So the statement is not trusted — it is CHECKED, against itself. Every row
 * of an Indian bank statement carries the running balance, and the running
 * balance has to follow from the row before it. A dropped row, a debit read as
 * a credit, a date read month-first, a column mapped to the wrong field: each
 * one breaks that chain at a specific line. Nothing is written to the ledger
 * while the chain is broken.
 *
 * Pure. CLAUDE.md §5.
 */

/* ------------------------------------------------------------------ */
/* Text into rows                                                      */
/* ------------------------------------------------------------------ */

/**
 * Split delimited text into rows, honouring quotes.
 *
 * The delimiter is detected, because this reads two things: a CSV downloaded
 * from net banking (commas) and a block copied out of Excel and pasted (tabs).
 * Pasting from Excel is how an .xls or .xlsx statement gets in without adding
 * a spreadsheet library — the same first-class paste path the BOQ uses.
 */
export function parseDelimited(text: string): string[][] {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const firstLines = clean.split('\n').slice(0, 20).join('\n')
  const count = (ch: string) => (firstLines.match(new RegExp(`\\${ch}`, 'g')) ?? []).length
  const delim = count('\t') > 0 && count('\t') >= count(',') / 2 ? '\t'
    : count(';') > count(',') ? ';' : ','

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i]!
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 1 }
        else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field.trim() === '') { quoted = true; field = ''; continue }
    if (ch === delim) { row.push(field.trim()); field = ''; continue }
    if (ch === '\n') {
      row.push(field.trim()); rows.push(row); row = []; field = ''
      continue
    }
    field += ch
  }
  if (field.length > 0 || row.length > 0) { row.push(field.trim()); rows.push(row) }
  /* Blank rows are KEPT. Every problem is reported by row number, and a person
     reads that number off their own spreadsheet — where the blank line under
     the account details is row 5. Dropping blanks before counting sends them
     to the wrong line of the statement. */
  return rows
}

/* ------------------------------------------------------------------ */
/* Amounts and dates                                                   */
/* ------------------------------------------------------------------ */

export type Side = 'dr' | 'cr'

export interface Amount {
  paise: Paise
  /** A Dr or Cr marker written beside the figure, where there was one. */
  side: Side | null
}

/**
 * An amount as Indian banks write it.
 *
 * `1,25,500.00`, `₹ 1,25,500.00`, `1,25,500.00 Dr`, `125500.00CR`, `(500.00)`,
 * `-500.00`. Lakh grouping is just commas to strip. Integer arithmetic only —
 * a float in here is how ₹0.01 goes missing across four hundred rows and the
 * balance chain breaks for a reason nobody can find.
 *
 * Returns null for a blank, a dash or a zero, because on a statement those
 * all mean "nothing in this column", which is different from a malformed
 * figure — that throws.
 */
export function parseAmount(raw: string): Amount | null {
  let s = raw.trim()
  if (s === '' || s === '-' || s === '—' || s === '–') return null

  let side: Side | null = null
  const marker = /\s*(dr|cr)\.?$/i.exec(s)
  if (marker) { side = marker[1]!.toLowerCase() as Side; s = s.slice(0, marker.index) }

  let negative = false
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1) }
  s = s.replace(/[₹\s,]/g, '').replace(/^rs\.?/i, '').replace(/^inr/i, '')
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1) }
  if (s.startsWith('+')) s = s.slice(1)

  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new RangeError(`not an amount: "${raw}"`)
  const [whole, frac = ''] = s.split('.')
  const p = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'))
  if (p === 0n && side === null) return null

  /* A leading minus and a "Dr" say the same thing, and saying it twice does
     not make it positive again. */
  if (negative && side === null) side = 'dr'
  return { paise: p as Paise, side }
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

/**
 * A date as Indian banks write it — always day first.
 *
 * `05-09-2026`, `05/09/2026`, `05.09.26`, `05-Sep-2026`, `05 Sep 2026`, and
 * ISO `2026-09-05`. **Never month first.** A statement read as MM/DD puts the
 * 5th of September in May, every row still parses, and nothing looks wrong
 * until the balance chain breaks — which is exactly what it is for.
 *
 * A date that does not exist on a calendar is refused, not rolled over:
 * 31-02-2026 is a misread, not the 3rd of March.
 */
export function parseDate(raw: string): ISODate | null {
  const s = raw.trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?$/i, '')
  if (s === '') return null

  let y: number, m: number, d: number
  let match: RegExpExecArray | null
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
    y = +match[1]!; m = +match[2]!; d = +match[3]!
  } else if ((match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s))) {
    d = +match[1]!; m = +match[2]!; y = +match[3]!
  } else if ((match = /^(\d{1,2})[-/\s]([A-Za-z]{3,4})[-/\s,]*(\d{2}|\d{4})$/.exec(s))) {
    d = +match[1]!
    const mm = MONTHS[match[2]!.toLowerCase()]
    if (!mm) return null
    m = mm; y = +match[3]!
  } else {
    return null
  }
  if (y < 100) y += 2000

  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` as ISODate
}

/* ------------------------------------------------------------------ */
/* Finding the table                                                   */
/* ------------------------------------------------------------------ */

export type Role =
  | 'date' | 'valueDate' | 'narration' | 'reference'
  | 'debit' | 'credit' | 'amount' | 'drcr' | 'balance' | 'ignore'

export type Mapping = Role[]

const HINTS: [Role, RegExp][] = [
  ['valueDate', /value\s*d(a)?te?/i],
  ['date', /(txn|tran|transaction|posting|post)?\s*date|^dt\.?$/i],
  ['reference', /ch(e)?q(ue)?|ref|utr|instr|cheque/i],
  ['narration', /narration|description|particulars|details|remarks/i],
  ['debit', /debit|withdraw|^dr\.?$|paid\s*out/i],
  ['credit', /credit|deposit|^cr\.?$|paid\s*in/i],
  ['balance', /balance|^bal\.?$/i],
  ['drcr', /^(dr\s*\/\s*cr|cr\s*\/\s*dr|type|txn\s*type)$/i],
  ['amount', /^(txn|transaction)?\s*amount|^amt\.?$/i],
]

/** What a header cell most likely is. Balance before debit: "Debit Balance". */
function roleOf(cell: string): Role {
  const c = cell.trim()
  if (/balance/i.test(c)) return 'balance'
  for (const [role, re] of HINTS) if (re.test(c)) return role
  return 'ignore'
}

export interface Header {
  /** Index into the rows where the header sits. Rows above are preamble. */
  index: number
  mapping: Mapping
}

/**
 * Find the header row and guess what each column is.
 *
 * A statement rarely starts with its table. Account number, branch, IFSC and
 * period sit above it, sometimes twenty lines deep. The header is the first
 * row that names a date AND a way of telling money in from money out — and if
 * no row does, that is said plainly rather than guessed, because a table read
 * from the wrong row maps "Account No." as a date.
 */
export function findHeader(rows: string[][]): Header | null {
  for (let i = 0; i < Math.min(rows.length, 40); i += 1) {
    const mapping = rows[i]!.map(roleOf)
    const has = (r: Role) => mapping.includes(r)
    const dated = has('date') || has('valueDate')
    const money = (has('debit') && has('credit')) || (has('amount') && has('drcr'))
      || (has('amount') && has('balance'))
    if (dated && money) {
      /* One of each. A second "date" column is the value date; a second
         narration is dropped rather than overwriting the first. */
      const seen = new Set<Role>()
      const deduped = mapping.map((r) => {
        if (r === 'ignore') return r
        if (r === 'date' && seen.has('date')) return seen.has('valueDate') ? 'ignore' : 'valueDate'
        if (seen.has(r)) return 'ignore'
        seen.add(r)
        return r
      })
      return { index: i, mapping: deduped }
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Rows into lines                                                     */
/* ------------------------------------------------------------------ */

export interface Line {
  /** The row's position in what was pasted, 1-based, for pointing at it. */
  row: number
  date: ISODate
  valueDate: ISODate | null
  narration: string
  reference: string | null
  direction: 'in' | 'out'
  amountPaise: Paise
  /** Signed: negative means overdrawn, which is normal on a cash credit account. */
  balancePaise: Paise | null
}

export type ProblemKind = 'blocking' | 'warning'
export interface Problem { kind: ProblemKind; row: number | null; message: string }

export interface Parsed {
  lines: Line[]
  /** The balance before the first line, where the statement lets us know it. */
  openingPaise: Paise | null
  closingPaise: Paise | null
  from: ISODate | null
  to: ISODate | null
  /** Whether the statement came newest-first and was turned round. */
  reversed: boolean
  problems: Problem[]
}

/** Rows that sit inside the table but are not transactions. */
const SUMMARY = /^(opening|closing|total|grand\s*total|balance\s*(b\/f|c\/f|brought|carried))/i

/**
 * Turn mapped rows into ledger lines.
 *
 * `overdraftAccount` is for cash credit and overdraft accounts, where a bank
 * often prints the balance with no Dr/Cr marker at all and means we owe it.
 * Read as positive, every line of such a statement would break the chain in
 * the same direction — so the sign is set from the account type, and the
 * chain check then confirms it rather than taking it on trust.
 */
export function readLines(
  rows: string[][], header: Header, overdraftAccount = false,
): Parsed {
  const col = (r: Role) => header.mapping.indexOf(r)
  const iDate = col('date') >= 0 ? col('date') : col('valueDate')
  const iValue = col('date') >= 0 ? col('valueDate') : -1
  const iNarr = col('narration')
  const iRef = col('reference')
  const iDr = col('debit')
  const iCr = col('credit')
  const iAmt = col('amount')
  const iDrCr = col('drcr')
  const iBal = col('balance')

  const problems: Problem[] = []
  const lines: Line[] = []
  let opening: Paise | null = null

  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '')

  for (let i = header.index + 1; i < rows.length; i += 1) {
    const r = rows[i]!
    const rowNo = i + 1
    const narr = cell(r, iNarr)

    /* A repeated header — statements split across pages carry one per page. */
    if (findHeader([r])) continue

    const dateCell = cell(r, iDate)
    if (SUMMARY.test(narr) || SUMMARY.test(dateCell)) {
      if (/^opening|b\/f|brought/i.test(narr || dateCell) && iBal >= 0) {
        try {
          const b = parseAmount(cell(r, iBal))
          if (b) opening = signed(b, overdraftAccount)
        } catch { /* a summary row that does not parse is simply skipped */ }
      }
      continue
    }

    const date = parseDate(dateCell)
    if (!date) {
      /* A row with no date and no money is a wrapped narration or a footer.
         A row with money and no readable date is a misread, and says so. */
      const moneyHere = [iDr, iCr, iAmt].some((c) => c >= 0 && cell(r, c) !== '')
      if (moneyHere) {
        problems.push({ kind: 'blocking', row: rowNo,
          message: `Row ${rowNo}: "${dateCell}" is not a date. Banks write the day `
            + 'first; if this column holds something else, map it differently.' })
      } else if (narr && lines.length > 0) {
        /* Continuation of the previous line's narration. */
        lines[lines.length - 1]!.narration += ` ${narr}`
      }
      continue
    }

    let direction: 'in' | 'out'
    let amount: Paise
    try {
      if (iDr >= 0 || iCr >= 0) {
        const dr = iDr >= 0 ? parseAmount(cell(r, iDr)) : null
        const cr = iCr >= 0 ? parseAmount(cell(r, iCr)) : null
        if (dr && cr) {
          problems.push({ kind: 'blocking', row: rowNo,
            message: `Row ${rowNo} has both a debit and a credit. A statement line `
              + 'moves money one way; the columns are probably mapped wrong.' })
          continue
        }
        if (!dr && !cr) {
          problems.push({ kind: 'warning', row: rowNo,
            message: `Row ${rowNo} has a date and no amount, and was skipped.` })
          continue
        }
        direction = dr ? 'out' : 'in'
        amount = (dr ?? cr)!.paise
      } else {
        const a = parseAmount(cell(r, iAmt))
        if (!a) {
          problems.push({ kind: 'warning', row: rowNo,
            message: `Row ${rowNo} has a date and no amount, and was skipped.` })
          continue
        }
        const marker = (cell(r, iDrCr) || a.side || '').toLowerCase()
        if (/^d/.test(marker)) direction = 'out'
        else if (/^c/.test(marker)) direction = 'in'
        else {
          problems.push({ kind: 'blocking', row: rowNo,
            message: `Row ${rowNo}: nothing says whether this was money in or out.` })
          continue
        }
        amount = a.paise
      }
    } catch (e) {
      problems.push({ kind: 'blocking', row: rowNo,
        message: `Row ${rowNo}: ${e instanceof Error ? e.message : 'unreadable amount'}.` })
      continue
    }

    let balance: Paise | null = null
    if (iBal >= 0) {
      try {
        const b = parseAmount(cell(r, iBal))
        balance = b ? signed(b, overdraftAccount) : (cell(r, iBal) === '' ? null : ZERO)
      } catch (e) {
        problems.push({ kind: 'blocking', row: rowNo,
          message: `Row ${rowNo}: the balance ${e instanceof Error ? e.message : 'is unreadable'}.` })
      }
    }

    const ref = cell(r, iRef)
    lines.push({
      row: rowNo, date,
      valueDate: iValue >= 0 ? parseDate(cell(r, iValue)) : null,
      narration: narr, reference: ref && ref !== '-' ? ref : null,
      direction, amountPaise: amount, balancePaise: balance,
    })
  }

  /* Newest-first statements are turned round. Decided on the dates alone,
     and only when they actually run backwards — a single-day statement is
     left in the order printed and the balance chain settles it. */
  let reversed = false
  if (lines.length > 1 && lines[0]!.date > lines[lines.length - 1]!.date) {
    lines.reverse()
    reversed = true
  } else if (lines.length > 1 && lines[0]!.date === lines[lines.length - 1]!.date
             && lines.every((l) => l.balancePaise !== null)) {
    if (chainBreaks(lines, null).length > chainBreaks([...lines].reverse(), null).length) {
      lines.reverse()
      reversed = true
    }
  }

  const first = lines[0]
  const last = lines[lines.length - 1]
  if (opening === null && first?.balancePaise !== null && first) {
    opening = (first.balancePaise! - effect(first)) as Paise
  }

  return {
    lines, openingPaise: opening,
    closingPaise: last?.balancePaise ?? null,
    from: first?.date ?? null, to: last?.date ?? null,
    reversed, problems,
  }
}

const effect = (l: Line): Paise =>
  (l.direction === 'in' ? l.amountPaise : -l.amountPaise) as Paise

function signed(a: Amount, overdraftAccount: boolean): Paise {
  if (a.side === 'dr') return (-a.paise) as Paise
  if (a.side === 'cr') return a.paise
  return (overdraftAccount ? -a.paise : a.paise) as Paise
}

/* ------------------------------------------------------------------ */
/* The chain                                                           */
/* ------------------------------------------------------------------ */

export interface Break {
  row: number
  expectedPaise: Paise
  statedPaise: Paise
}

/**
 * Every line whose stated balance does not follow from the one before.
 *
 * Exact to the paisa. A tolerance here would pass a dropped ₹0.50 bank charge
 * and every later balance would carry it forward, so the break is reported at
 * the line where it starts and nowhere else.
 */
export function chainBreaks(lines: Line[], opening: Paise | null): Break[] {
  const out: Break[] = []
  let running = opening
  for (const l of lines) {
    if (l.balancePaise === null) { running = null; continue }
    if (running !== null) {
      const expected = (running + effect(l)) as Paise
      if (expected !== l.balancePaise) {
        out.push({ row: l.row, expectedPaise: expected, statedPaise: l.balancePaise })
      }
    }
    running = l.balancePaise
  }
  return out
}

export interface ChainCheck {
  ok: boolean
  breaks: Break[]
  /** True where every line has a balance to check against. */
  complete: boolean
  message: string
}

export function checkChain(parsed: Parsed): ChainCheck {
  const withBalance = parsed.lines.filter((l) => l.balancePaise !== null).length
  const complete = parsed.lines.length > 0 && withBalance === parsed.lines.length
  const breaks = chainBreaks(parsed.lines, parsed.openingPaise)

  if (parsed.lines.length === 0) {
    return { ok: false, breaks, complete, message: 'No transactions were found.' }
  }
  if (withBalance === 0) {
    return { ok: true, breaks, complete, message: 'This statement carries no running '
      + 'balance, so nothing could be checked against it. Every line will be '
      + 'imported as read — look at the totals before confirming.' }
  }
  if (breaks.length === 0) {
    return { ok: true, breaks, complete,
      message: `Every balance follows from the line before it, across `
        + `${parsed.lines.length} line${parsed.lines.length === 1 ? '' : 's'}.` }
  }

  /* Most lines broken, all in the same pattern, is not a statement with a
     problem — it is a statement read with debit and credit the wrong way round. */
  const swapped = parsed.lines.map((l) => ({
    ...l, direction: (l.direction === 'in' ? 'out' : 'in') as 'in' | 'out' }))
  const swappedBreaks = chainBreaks(swapped, null)
  if (breaks.length >= 2 && swappedBreaks.length === 0) {
    return { ok: false, breaks, complete,
      message: 'Almost every balance is wrong in the same way. The debit and '
        + 'credit columns look swapped — map them the other way round.' }
  }

  return { ok: false, breaks, complete,
    message: `The running balance breaks at row ${breaks[0]!.row}`
      + `${breaks.length > 1 ? ` and ${breaks.length - 1} more place${breaks.length === 2 ? '' : 's'}` : ''}. `
      + 'A row was misread, dropped, or mapped to the wrong column. Nothing is '
      + 'imported until it follows through.' }
}

/* ------------------------------------------------------------------ */
/* Identity, for never importing the same line twice                   */
/* ------------------------------------------------------------------ */

const squash = (s: string | null) =>
  (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

/**
 * A stable identity for a statement line.
 *
 * Built from what the bank printed, so the same transaction arriving in next
 * month's statement — overlapping this one by a week — produces the same key,
 * and a unique index refuses the second copy.
 *
 * **The running balance is in it**, and that is what makes it work. Two ₹500
 * withdrawals on the same day with the same narration are two real
 * transactions and must both land; their balances differ, so their keys do.
 * Where a statement carries no balance at all, the n-th identical line gets
 * `#n` — weaker, because two statements cut on different days could number
 * the same pair differently, and the preview says so.
 */
export function fingerprint(l: Line, occurrence: number): string {
  return [
    l.date, l.direction, String(l.amountPaise),
    l.balancePaise === null ? `#${occurrence}` : String(l.balancePaise),
    squash(l.reference).slice(0, 24),
    squash(l.narration).slice(0, 40),
  ].join('|')
}

export function fingerprints(lines: Line[]): string[] {
  const seen = new Map<string, number>()
  return lines.map((l) => {
    const base = [l.date, l.direction, l.amountPaise, squash(l.reference),
                  squash(l.narration).slice(0, 40)].join('|')
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return fingerprint(l, n)
  })
}

/* ------------------------------------------------------------------ */
/* How the money moved                                                 */
/* ------------------------------------------------------------------ */

export type PaymentMode =
  | 'neft' | 'rtgs' | 'imps' | 'upi' | 'cheque' | 'dd' | 'cash' | 'bank_adjustment'

/**
 * The channel, read from the narration.
 *
 * Only for what the narration actually says. Where it says nothing
 * recognisable the line is `bank_adjustment` — which is honest about not
 * knowing, and is also right for what those lines usually are: interest,
 * charges, GST on charges, SMS fees.
 */
export function modeFrom(narration: string, reference: string | null): PaymentMode {
  const n = ` ${narration.toUpperCase()} `
  if (/\bRTGS\b/.test(n)) return 'rtgs'
  if (/\bNEFT\b/.test(n)) return 'neft'
  if (/\bIMPS\b|\bMMT\b/.test(n)) return 'imps'
  if (/\bUPI\b|@[A-Z]/.test(n)) return 'upi'
  if (/\bDD\b|DEMAND DRAFT/.test(n)) return 'dd'
  if (/\bCHQ\b|\bCHEQUE\b|\bCLG\b|CLEARING|\bINW\b|\bOUTW\b/.test(n)
      || (reference !== null && /^\d{6}$/.test(reference.trim()))) return 'cheque'
  if (/\bCASH\b|\bCSH\b|\bATM\b|\bSELF\b/.test(n)) return 'cash'
  return 'bank_adjustment'
}

/* ------------------------------------------------------------------ */
/* Against what is already in the ledger                               */
/* ------------------------------------------------------------------ */

export interface LedgerEntry {
  id: string
  date: ISODate
  direction: 'in' | 'out'
  amountPaise: Paise
  reference: string | null
  paymentMode: string | null
  /** Already tied to a statement line. Never matched again. */
  reconciled: boolean
}

export interface Match { lineIndex: number; entryId: string; daysApart: number }

export interface Reconciliation {
  matches: Match[]
  /** Statement lines with nothing in the ledger — these become new entries. */
  unmatchedLines: number[]
  /** Ledger entries in the period the bank has not shown — uncleared, or wrong. */
  unmatchedEntries: string[]
  /** Lines with more than one equally good candidate, left for a person. */
  ambiguous: number[]
}

/**
 * How far a date may drift and still be the same money.
 *
 * A cheque written on the 3rd clears on the 8th; an NEFT lands the same day.
 * Allowing a cheque's window to every transfer matches the ₹50,000 paid to
 * Shree Ganesh on the 2nd with a different ₹50,000 on the 6th.
 */
const window = (mode: string | null) => (mode === 'cheque' || mode === 'dd' ? 10 : 3)

/**
 * Pair statement lines with entries typed in by hand.
 *
 * A match needs the same direction and the same amount to the paisa, within
 * the date window. Among those, a matching cheque or UTR number wins outright,
 * then the nearest date.
 *
 * **A tie is not broken by guessing.** Two hand entries of ₹25,000 three days
 * apart and one statement line of ₹25,000 — picking either would be right half
 * the time and silently wrong the other half, and a wrong match is worse than
 * none: it marks a transaction as confirmed by the bank when a different one
 * was. So the line is left for somebody to decide.
 */
export function reconcile(
  lines: Line[], entries: LedgerEntry[],
): Reconciliation {
  const open = entries.filter((e) => !e.reconciled)
  const taken = new Set<string>()
  const matches: Match[] = []
  const ambiguous: number[] = []
  const unmatchedLines: number[] = []

  lines.forEach((l, i) => {
    const candidates = open
      .filter((e) => !taken.has(e.id)
        && e.direction === l.direction
        && e.amountPaise === l.amountPaise
        && Math.abs(daysBetween(e.date, l.date)) <= window(e.paymentMode))
      .map((e) => ({
        e,
        refHit: !!(e.reference && l.reference
          && squash(e.reference) !== '' && squash(e.reference) === squash(l.reference)),
        days: Math.abs(daysBetween(e.date, l.date)),
      }))
      .sort((a, b) => Number(b.refHit) - Number(a.refHit) || a.days - b.days)

    if (candidates.length === 0) { unmatchedLines.push(i); return }
    const best = candidates[0]!
    const tie = candidates[1]
      && candidates[1].refHit === best.refHit && candidates[1].days === best.days
    if (tie && !best.refHit) { ambiguous.push(i); return }

    taken.add(best.e.id)
    matches.push({ lineIndex: i, entryId: best.e.id, daysApart: best.days })
  })

  return {
    matches, unmatchedLines, ambiguous,
    unmatchedEntries: open.filter((e) => !taken.has(e.id)).map((e) => e.id),
  }
}

/* ------------------------------------------------------------------ */
/* Against the ledger's own balance                                    */
/* ------------------------------------------------------------------ */

export interface Continuity {
  ok: boolean
  differencePaise: Paise | null
  message: string | null
}

/**
 * Whether the statement picks up where our books leave off.
 *
 * The statement's opening balance should equal what the ledger says the
 * account held the day before its first line. When it does not, something
 * happened between our last entry and this statement that nobody recorded —
 * or a previous statement was never imported. Either way it is said before
 * the import, not discovered at the year end.
 */
export function continuity(
  statementOpening: Paise | null, ledgerBalanceBefore: Paise | null,
): Continuity {
  if (statementOpening === null || ledgerBalanceBefore === null) {
    return { ok: true, differencePaise: null, message: null }
  }
  const diff = (statementOpening - ledgerBalanceBefore) as Paise
  if (diff === ZERO) return { ok: true, differencePaise: ZERO, message: null }
  return { ok: false, differencePaise: diff,
    message: 'The statement opens at a different balance from the one our '
      + 'ledger holds for that day. Something between the two was never '
      + 'recorded — often a statement that was not imported.' }
}

/* ------------------------------------------------------------------ */
/* Before the cut-off                                                  */
/* ------------------------------------------------------------------ */

/**
 * Lines dated before the account's opening balance date.
 *
 * Refused, not imported: that money is already inside the opening figure the
 * account was set up with, and counting it again is invisible afterwards,
 * because both numbers look plausible. CLAUDE.md §2E.
 */
export function beforeCutOff(lines: Line[], cutOff: ISODate): number[] {
  return lines.map((l, i) => (l.date < cutOff ? i : -1)).filter((i) => i >= 0)
}

/** Dated in the future — a statement cannot contain tomorrow. */
export function inFuture(lines: Line[], today: ISODate): number[] {
  return lines.map((l, i) => (l.date > addDays(today, 0) ? i : -1)).filter((i) => i >= 0)
}
