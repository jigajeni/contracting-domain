import { type ISODate } from '../dates'
import { ZERO, type Paise } from '../money'

/**
 * Tally XML export.
 *
 * **Tally remains the statutory book of record** — CLAUDE.md §12 — and this
 * does not change that. It exists so the CA does not re-key a year of
 * vouchers that already exist here with their dates, parties and project
 * references intact. Everything it produces is a proposal for Tally to
 * accept, never an accounting record in its own right.
 *
 * Three rules shape the whole file:
 *
 *   **A voucher that does not balance is rejected — silently.** Tally will
 *   take an import of four hundred vouchers, reject the eleven that do not
 *   balance, and report a total. So nothing unbalanced is ever written: it is
 *   held back and named, because a voucher missing from Tally is found at the
 *   audit and a voucher missing from this file is found now.
 *
 *   **A ledger name is an identity, not a label.** Tally matches on the exact
 *   string; "Shree Datta Traders" and "Shree Datta Traders." are two
 *   suppliers with two balances. Names come from one place and are never
 *   composed differently in two exports.
 *
 *   **What cannot be built honestly is listed, never approximated.** A
 *   receipt whose bank account nobody recorded is not a cash receipt. It is an
 *   unexportable row with a reason.
 *
 * Pure. CLAUDE.md §5.
 */

export type VoucherType =
  | 'Sales' | 'Purchase' | 'Payment' | 'Receipt' | 'Journal'

export interface Entry {
  /** The exact ledger name in Tally. Matched on, not displayed. */
  ledger: string
  /** Positive debits, negative credits. Paise. */
  amountPaise: Paise
  /** Project, carried as a Tally cost centre. */
  costCentre?: string | null
}

export interface Voucher {
  /** Our row's id, sent as REMOTEID so a re-import updates rather than doubles. */
  key: string
  type: VoucherType
  date: ISODate
  /** The voucher number as it exists on paper, where there is one. */
  number: string | null
  narration: string
  /** The party the voucher is against, for Tally's PARTYLEDGERNAME. */
  partyLedger: string | null
  entries: Entry[]
}

export type ProblemKind = 'blocking' | 'warning'
export interface Problem {
  kind: ProblemKind
  /** The row this is about, so it can be found and fixed. */
  key: string
  message: string
}

/* ------------------------------------------------------------------ */
/* Balance                                                             */
/* ------------------------------------------------------------------ */

export const entriesTotal = (entries: Entry[]): Paise =>
  entries.reduce((a, e) => (a + e.amountPaise) as Paise, ZERO)

/**
 * Whether a voucher can be written at all.
 *
 * Debits and credits must come to exactly nothing. Not "within a rupee" —
 * Tally takes it or it does not, and a tolerance here would export a voucher
 * that is quietly wrong by the tolerance, every time, for a year.
 */
export function checkVoucher(v: Voucher): Problem[] {
  const out: Problem[] = []

  if (v.entries.length < 2) {
    out.push({ kind: 'blocking', key: v.key,
      message: 'A voucher with fewer than two sides is not a voucher.' })
  }
  const total = entriesTotal(v.entries)
  if (total !== ZERO) {
    out.push({ kind: 'blocking', key: v.key,
      message: `Debits and credits differ by ${rupees(total)}. Tally would `
        + 'reject this one and report a total, so it is held back here where '
        + 'it can still be found.' })
  }
  for (const e of v.entries) {
    if (!e.ledger.trim()) {
      out.push({ kind: 'blocking', key: v.key,
        message: 'An entry has no ledger name. Tally matches on the exact '
          + 'string, so a blank one creates a ledger called nothing.' })
    }
    if (e.amountPaise === ZERO) {
      out.push({ kind: 'warning', key: v.key,
        message: `The ${e.ledger} entry is zero and will be dropped.` })
    }
  }
  if (!v.narration.trim()) {
    out.push({ kind: 'warning', key: v.key,
      message: 'No narration. It is the only thing that explains this voucher '
        + 'to somebody reading it in Tally a year from now.' })
  }
  return out
}

export const blocking = (ps: Problem[]): Problem[] =>
  ps.filter((p) => p.kind === 'blocking')

/* ------------------------------------------------------------------ */
/* Ledger names                                                        */
/* ------------------------------------------------------------------ */

/**
 * One place that decides what a ledger is called.
 *
 * Tally matches on the exact string and creates what it cannot find, so two
 * spellings across two exports is two ledgers with half a balance each. The
 * hint stored against a deduction type or a cost category wins where the
 * office has set one — they know what their own Tally calls things.
 */
export function ledgerName(
  preferred: string | null | undefined, fallback: string,
): string {
  const s = (preferred ?? '').trim()
  return s.length > 0 ? s : fallback.trim()
}

/** Tally forbids these outright in a name. */
const FORBIDDEN = /[\\/:*?"<>|]/g

/**
 * A name Tally will accept.
 *
 * Marathi is fine — Tally is Unicode — and nothing here transliterates. What
 * is removed is the handful of characters Tally itself refuses, and the result
 * is reported when it differs so nobody wonders later why their ledger has a
 * different name from their bill.
 */
export function safeLedger(name: string): { name: string; changed: boolean } {
  const cleaned = name.replace(FORBIDDEN, '-').replace(/\s+/g, ' ').trim()
  return { name: cleaned, changed: cleaned !== name.trim() }
}

/* ------------------------------------------------------------------ */
/* Serialising                                                         */
/* ------------------------------------------------------------------ */

/** Tally dates are YYYYMMDD with no separators. */
export const tallyDate = (d: ISODate): string => d.replace(/-/g, '')

/**
 * Rupees with two decimals, as Tally wants them.
 *
 * The conversion from paise happens here and nowhere else. Money is integer
 * paise everywhere in this system — CLAUDE.md §0.1 — and this is the single
 * boundary where it becomes a decimal string, which is the only form Tally
 * will read.
 */
export function rupees(p: Paise): string {
  const neg = p < ZERO
  const abs = neg ? -p : p
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const tag = (name: string, value: string): string =>
  `<${name}>${escapeXml(value)}</${name}>`

/**
 * One voucher.
 *
 * `ISDEEMEDPOSITIVE` is Tally's way of saying "this is the debit side", and
 * the AMOUNT it wants alongside is NEGATIVE for a debit. Getting that pair
 * the wrong way round produces a file Tally accepts and posts backwards,
 * which is the worst outcome available here — nothing errors and every
 * balance is inverted.
 */
function voucherXml(v: Voucher): string {
  const entries = v.entries
    .filter((e) => e.amountPaise !== ZERO)
    .map((e) => {
      const debit = e.amountPaise > ZERO
      /* Tally's AMOUNT is the NEGATIVE of ours, both ways round: our positive
         debit becomes its negative amount, and our negative credit becomes its
         positive one. Writing the credit through unchanged looks right — it is
         already negative — and inverts every creditor balance in the company.
         One sign, applied once, is the whole of it. */
      const amount = rupees((-e.amountPaise) as Paise)
      const lines = [
        tag('LEDGERNAME', e.ledger),
        tag('ISDEEMEDPOSITIVE', debit ? 'Yes' : 'No'),
        tag('AMOUNT', amount),
      ]
      if (e.costCentre) {
        lines.push(
          '<CATEGORYALLOCATIONS.LIST>',
          tag('CATEGORY', 'Primary Cost Category'),
          '<ISDEEMEDPOSITIVE>' + (debit ? 'Yes' : 'No') + '</ISDEEMEDPOSITIVE>',
          '<COSTCENTREALLOCATIONS.LIST>',
          tag('NAME', e.costCentre),
          tag('AMOUNT', amount),
          '</COSTCENTREALLOCATIONS.LIST>',
          '</CATEGORYALLOCATIONS.LIST>',
        )
      }
      return `<ALLLEDGERENTRIES.LIST>\n${lines.join('\n')}\n</ALLLEDGERENTRIES.LIST>`
    })

  return [
    `<VOUCHER VCHTYPE="${escapeXml(v.type)}" ACTION="Create" `
      + `OBJVIEW="Accounting Voucher View">`,
    tag('DATE', tallyDate(v.date)),
    tag('EFFECTIVEDATE', tallyDate(v.date)),
    tag('VOUCHERTYPENAME', v.type),
    v.number ? tag('VOUCHERNUMBER', v.number) : '',
    v.partyLedger ? tag('PARTYLEDGERNAME', v.partyLedger) : '',
    tag('NARRATION', v.narration),
    /* So a second import of the same period updates these vouchers instead of
       creating a second copy of every one. */
    tag('REMOTEID', v.key),
    ...entries,
    '</VOUCHER>',
  ].filter(Boolean).join('\n')
}

export interface ExportInput {
  /** The Tally company name, exactly as it is spelt there. */
  companyName: string
  vouchers: Voucher[]
}

export interface TallyExport {
  xml: string
  written: number
  /** Vouchers held back, with the reason. */
  held: Problem[]
  warnings: Problem[]
}

/**
 * The file.
 *
 * Only vouchers that balance are written. Everything else comes back as a
 * named problem against its own row, because a voucher missing from this file
 * is found now and a voucher missing from Tally is found at the audit.
 */
export function buildExport(input: ExportInput): TallyExport {
  const held: Problem[] = []
  const warnings: Problem[] = []
  const good: Voucher[] = []

  for (const v of input.vouchers) {
    const problems = checkVoucher(v)
    const hard = blocking(problems)
    if (hard.length > 0) { held.push(...hard); continue }
    warnings.push(...problems)
    good.push(v)
  }

  const xml = [
    '<ENVELOPE>',
    '<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>',
    '<BODY>',
    '<IMPORTDATA>',
    '<REQUESTDESC>',
    tag('REPORTNAME', 'Vouchers'),
    `<STATICVARIABLES>${tag('SVCURRENTCOMPANY', input.companyName)}</STATICVARIABLES>`,
    '</REQUESTDESC>',
    '<REQUESTDATA>',
    ...good.map((v) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">\n${voucherXml(v)}\n</TALLYMESSAGE>`),
    '</REQUESTDATA>',
    '</IMPORTDATA>',
    '</BODY>',
    '</ENVELOPE>',
  ].join('\n')

  return { xml, written: good.length, held, warnings }
}
