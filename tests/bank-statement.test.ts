import { describe, it, expect } from 'vitest'
import { isoDate } from '@/domain/dates'
import { ZERO, paise } from '@/domain/money'
import {
  beforeCutOff, chainBreaks, checkChain, continuity, findHeader, fingerprints,
  modeFrom, parseAmount, parseDate, parseDelimited, readLines, reconcile,
  type LedgerEntry, type Line,
} from '@/domain/bank/statement'

const d = (s: string) => isoDate(s)

/** Read a whole statement the way the import screen does. */
function read(text: string, overdraft = false) {
  const rows = parseDelimited(text)
  const header = findHeader(rows)
  if (!header) throw new Error('no header')
  return readLines(rows, header, overdraft)
}

/* A current account, BOI-style CSV: preamble, header, oldest first. */
const BOI_CSV = `Bank of India,Jath Branch
Account Number,123456789012345
Account Name,SAHYADRI INFRA PROJECTS PRIVATE LIMITED
Statement Period,01-09-2026 to 10-09-2026

Txn Date,Value Date,Description,Cheque No,Debit,Credit,Balance
01-09-2026,01-09-2026,Opening Balance,,,,"12,50,000.00"
02-09-2026,02-09-2026,NEFT-SHREE GANESH TRADERS-GSB,,"4,05,720.00",,"8,44,280.00"
04-09-2026,04-09-2026,RTGS-ZP SANGLI-RA BILL 1,,,"34,46,000.00","42,90,280.00"
05-09-2026,08-09-2026,CHQ PAID-SADGURU BROTHERS,445201,"50,000.00",,"42,40,280.00"
07-09-2026,07-09-2026,SMS CHARGES,,17.70,,"42,40,262.30"
Total,,,,"4,55,737.70","34,46,000.00",
`

describe('amounts, as Indian banks write them', () => {
  it('strips lakh grouping and the rupee sign without a float anywhere', () => {
    expect(parseAmount('12,50,000.00')!.paise).toBe(paise(125000000))
    expect(parseAmount('₹ 1,25,500.00')!.paise).toBe(paise(12550000))
    expect(parseAmount('17.70')!.paise).toBe(paise(1770))
    expect(parseAmount('Rs. 500')!.paise).toBe(paise(50000))
  })

  it('reads a Dr/Cr marker, with or without a space or a full stop', () => {
    expect(parseAmount('1,25,000.00 Dr')).toEqual({ paise: 12500000n, side: 'dr' })
    expect(parseAmount('125000.00CR')).toEqual({ paise: 12500000n, side: 'cr' })
    expect(parseAmount('500.00 Dr.')!.side).toBe('dr')
  })

  it('treats brackets and a leading minus as a debit, but never both as a double negative', () => {
    expect(parseAmount('(500.00)')!.side).toBe('dr')
    expect(parseAmount('-500.00')!.side).toBe('dr')
  })

  it('reads blank, dash and zero as nothing in the column', () => {
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('-')).toBeNull()
    expect(parseAmount('0.00')).toBeNull()
  })

  it('throws on a figure that is not an amount rather than guessing', () => {
    expect(() => parseAmount('12,50,000.005')).toThrow()
    expect(() => parseAmount('NEFT')).toThrow()
  })
})

describe('dates, always day first', () => {
  it('reads the common forms', () => {
    expect(parseDate('05-09-2026')).toBe('2026-09-05')
    expect(parseDate('05/09/2026')).toBe('2026-09-05')
    expect(parseDate('05.09.26')).toBe('2026-09-05')
    expect(parseDate('05-Sep-2026')).toBe('2026-09-05')
    expect(parseDate('5 Sep 2026')).toBe('2026-09-05')
    expect(parseDate('2026-09-05')).toBe('2026-09-05')
    expect(parseDate('05/09/2026 14:32:10')).toBe('2026-09-05')
  })

  it('never reads month first', () => {
    // 04/09 is the 4th of September. Read as MM/DD it is the 9th of April,
    // every row still parses, and only the balance chain would notice.
    expect(parseDate('04/09/2026')).toBe('2026-09-04')
  })

  it('refuses a date that is not on the calendar rather than rolling it over', () => {
    expect(parseDate('31-02-2026')).toBeNull()
    expect(parseDate('Account Number')).toBeNull()
  })
})

describe('finding the table', () => {
  it('skips the preamble and finds the header', () => {
    const rows = parseDelimited(BOI_CSV)
    const h = findHeader(rows)!
    expect(rows[h.index]![0]).toBe('Txn Date')
    expect(h.mapping).toEqual(
      ['date', 'valueDate', 'narration', 'reference', 'debit', 'credit', 'balance'])
  })

  it('maps an HDFC-style header too', () => {
    const h = findHeader([[
      'Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.',
      'Deposit Amt.', 'Closing Balance']])!
    expect(h.mapping).toEqual(
      ['date', 'narration', 'reference', 'valueDate', 'debit', 'credit', 'balance'])
  })

  it('says there is no table rather than reading one from the wrong row', () => {
    expect(findHeader([['Account Number', '123'], ['Name', 'SIPL']])).toBeNull()
  })

  it('reads a block pasted out of Excel, which arrives tab-separated', () => {
    const pasted = 'Txn Date\tDescription\tDebit\tCredit\tBalance\n'
      + '02-09-2026\tNEFT-X\t1,000.00\t\t9,000.00'
    const rows = parseDelimited(pasted)
    expect(rows[1]).toEqual(['02-09-2026', 'NEFT-X', '1,000.00', '', '9,000.00'])
  })

  it('keeps a quoted comma inside one cell', () => {
    expect(parseDelimited('a,"12,50,000.00",b')[0]).toEqual(['a', '12,50,000.00', 'b'])
  })
})

describe('reading the lines', () => {
  it('reads a whole statement, skipping the opening and total rows', () => {
    const p = read(BOI_CSV)
    expect(p.lines).toHaveLength(4)
    expect(p.openingPaise).toBe(paise(125000000))
    expect(p.closingPaise).toBe(paise(424026230))
    expect(p.from).toBe('2026-09-02')
    expect(p.to).toBe('2026-09-07')
    expect(p.lines[0]).toMatchObject({ direction: 'out', amountPaise: 40572000n })
    expect(p.lines[1]).toMatchObject({ direction: 'in', amountPaise: 344600000n })
    expect(p.lines[2]!.reference).toBe('445201')
    expect(p.lines[2]!.valueDate).toBe('2026-09-08')
  })

  it('turns a newest-first statement round', () => {
    const newest = `Txn Date,Description,Debit,Credit,Balance
07-09-2026,SMS CHARGES,17.70,,"42,40,262.30"
05-09-2026,CHQ PAID,"50,000.00",,"42,40,280.00"
04-09-2026,RTGS-ZP,,"34,46,000.00","42,90,280.00"
02-09-2026,NEFT-SGT,"4,05,720.00",,"8,44,280.00"`
    const p = read(newest)
    expect(p.reversed).toBe(true)
    expect(p.lines.map((l) => l.date)).toEqual(
      ['2026-09-02', '2026-09-04', '2026-09-05', '2026-09-07'])
    expect(checkChain(p).ok).toBe(true)
  })

  it('reads a single amount column with a Dr/Cr column beside it', () => {
    const p = read(`Date,Particulars,Amount,Dr/Cr,Balance
02-09-2026,NEFT OUT,"1,000.00",DR,"9,000.00"
03-09-2026,NEFT IN,"500.00",CR,"9,500.00"`)
    expect(p.lines.map((l) => l.direction)).toEqual(['out', 'in'])
    expect(checkChain(p).ok).toBe(true)
  })

  it('joins a narration that wrapped onto its own row', () => {
    const p = read(`Txn Date,Description,Debit,Credit,Balance
02-09-2026,NEFT-SHREE GANESH,"1,000.00",,"9,000.00"
,TRADERS JATH GSB SUPPLY,,,`)
    expect(p.lines).toHaveLength(1)
    expect(p.lines[0]!.narration).toBe('NEFT-SHREE GANESH TRADERS JATH GSB SUPPLY')
  })

  it('ignores a header repeated at the top of each page', () => {
    const p = read(`Txn Date,Description,Debit,Credit,Balance
02-09-2026,A,"1,000.00",,"9,000.00"
Txn Date,Description,Debit,Credit,Balance
03-09-2026,B,,"500.00","9,500.00"`)
    expect(p.lines).toHaveLength(2)
    expect(checkChain(p).ok).toBe(true)
  })

  it('refuses a row with both a debit and a credit', () => {
    const p = read(`Txn Date,Description,Debit,Credit,Balance
02-09-2026,X,"1,000.00","1,000.00","9,000.00"`)
    expect(p.problems[0]).toMatchObject({ kind: 'blocking', row: 2 })
  })

  it('refuses money with a date it cannot read', () => {
    const p = read(`Txn Date,Description,Debit,Credit,Balance
13/13/2026,X,"1,000.00",,"9,000.00"`)
    expect(p.problems[0]!.kind).toBe('blocking')
    expect(p.problems[0]!.message).toContain('day first')
  })
})

describe('a cash credit account', () => {
  it('reads Dr balances as money owed to the bank', () => {
    const p = read(`Txn Date,Description,Debit,Credit,Balance
02-09-2026,CC DRAWN,"5,00,000.00",,"45,00,000.00 Dr"
03-09-2026,RTGS ZP,,"10,00,000.00","35,00,000.00 Dr"`)
    expect(p.lines[0]!.balancePaise).toBe(paise(-450000000))
    expect(p.openingPaise).toBe(paise(-400000000))
    expect(checkChain(p).ok).toBe(true)
  })

  it('treats an unmarked CC balance as owed, and the chain proves it', () => {
    const text = `Txn Date,Description,Debit,Credit,Balance
02-09-2026,CC DRAWN,"5,00,000.00",,"45,00,000.00"
03-09-2026,RTGS ZP,,"10,00,000.00","35,00,000.00"`
    // Read as a current account the balances run the wrong way…
    expect(checkChain(read(text, false)).ok).toBe(false)
    // …read as the overdraft it is, they follow through.
    expect(checkChain(read(text, true)).ok).toBe(true)
  })
})

describe('the balance chain', () => {
  it('passes a statement that follows through, to the paisa', () => {
    const c = checkChain(read(BOI_CSV))
    expect(c.ok).toBe(true)
    expect(c.complete).toBe(true)
  })

  it('finds a dropped row at the line where it starts, by spreadsheet row', () => {
    // The ₹50,000 cheque is missing; the SMS charge line no longer follows.
    // Counted as a person counts it — the blank line under the account details
    // is a row too, so the SMS line is row 10 of what they pasted.
    const dropped = BOI_CSV.replace(/05-09-2026.*\n/, '')
    const c = checkChain(read(dropped))
    expect(c.ok).toBe(false)
    expect(c.breaks).toHaveLength(1)
    expect(c.breaks[0]!.row).toBe(10)
    expect(parseDelimited(dropped)[9]![2]).toBe('SMS CHARGES')
  })

  it('is exact — fifty paise out is a break', () => {
    const off = BOI_CSV.replace('"42,40,262.30"', '"42,40,262.80"')
    expect(checkChain(read(off)).ok).toBe(false)
  })

  it('recognises debit and credit mapped the wrong way round', () => {
    const swapped = `Txn Date,Description,Credit,Debit,Balance
01-09-2026,Opening Balance,,,"10,000.00"
02-09-2026,A,"1,000.00",,"9,000.00"
03-09-2026,B,"2,000.00",,"7,000.00"
04-09-2026,C,,"500.00","7,500.00"`
    const c = checkChain(read(swapped))
    expect(c.ok).toBe(false)
    expect(c.message).toContain('look swapped')
  })

  it('says plainly when there is no balance to check against', () => {
    const c = checkChain(read(`Txn Date,Description,Debit,Credit,Amount
02-09-2026,A,"1,000.00",,`))
    expect(c.message).toContain('nothing could be checked')
  })

  it('checks from the stated opening balance, not only between lines', () => {
    const lines: Line[] = [{
      row: 2, date: d('2026-09-02'), valueDate: null, narration: 'X',
      reference: null, direction: 'out', amountPaise: paise(100),
      balancePaise: paise(900),
    }]
    expect(chainBreaks(lines, paise(1000))).toEqual([])
    expect(chainBreaks(lines, paise(1100))).toHaveLength(1)
  })
})

describe('never importing the same line twice', () => {
  it('gives the same line the same key in an overlapping statement', () => {
    const a = read(BOI_CSV)
    const b = read(BOI_CSV.replace(/02-09-2026.*\n/, ''))
    const keysA = fingerprints(a.lines)
    const keysB = fingerprints(b.lines)
    // The RTGS on the 4th is in both statements and must key identically.
    expect(keysB).toContain(keysA[1])
  })

  it('keeps two genuine identical withdrawals apart by their balances', () => {
    const p = read(`Txn Date,Description,Debit,Credit,Balance
02-09-2026,ATM CASH,"500.00",,"9,500.00"
02-09-2026,ATM CASH,"500.00",,"9,000.00"`)
    const [k1, k2] = fingerprints(p.lines)
    expect(k1).not.toBe(k2)
  })

  it('numbers identical lines where there is no balance to separate them', () => {
    const line: Line = { row: 2, date: d('2026-09-02'), valueDate: null,
      narration: 'ATM CASH', reference: null, direction: 'out',
      amountPaise: paise(50000), balancePaise: null }
    const [k1, k2] = fingerprints([line, { ...line, row: 3 }])
    expect(k1).toContain('#1')
    expect(k2).toContain('#2')
  })
})

describe('how the money moved', () => {
  it('reads the channel from the narration', () => {
    expect(modeFrom('RTGS-ZP SANGLI-RA BILL', null)).toBe('rtgs')
    expect(modeFrom('NEFT-SHREE GANESH', null)).toBe('neft')
    expect(modeFrom('IMPS/P2A/6123', null)).toBe('imps')
    expect(modeFrom('UPI/PRASHANT@OKAXIS', null)).toBe('upi')
    expect(modeFrom('CHQ PAID-SADGURU', null)).toBe('cheque')
    expect(modeFrom('ATM WDL JATH', null)).toBe('cash')
  })

  it('calls a six-digit reference a cheque', () => {
    expect(modeFrom('PAID TO SADGURU BROTHERS', '445201')).toBe('cheque')
  })

  it('does not pretend to know what it does not', () => {
    expect(modeFrom('SMS CHARGES', null)).toBe('bank_adjustment')
    expect(modeFrom('INT.COLL', null)).toBe('bank_adjustment')
  })
})

describe('matching against what was typed in by hand', () => {
  const lines = read(BOI_CSV).lines
  const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
    id: 'e1', date: d('2026-09-02'), direction: 'out',
    amountPaise: paise(40572000), reference: null, paymentMode: 'neft',
    reconciled: false, ...over,
  })

  it('pairs a hand entry with its statement line', () => {
    const r = reconcile(lines, [entry({})])
    expect(r.matches).toEqual([{ lineIndex: 0, entryId: 'e1', daysApart: 0 }])
    expect(r.unmatchedLines).toEqual([1, 2, 3])
  })

  it('allows a cheque to clear days after it was written, but not a transfer', () => {
    const cheque = entry({ id: 'c', date: d('2026-08-28'), amountPaise: paise(5000000),
                           paymentMode: 'cheque' })
    expect(reconcile(lines, [cheque]).matches[0]!.lineIndex).toBe(2)

    const neft = entry({ id: 'n', date: d('2026-08-26'), paymentMode: 'neft' })
    expect(reconcile(lines, [neft]).matches).toEqual([])
  })

  it('needs the amount to the paisa and the same direction', () => {
    expect(reconcile(lines, [entry({ amountPaise: paise(40572001) })]).matches).toEqual([])
    expect(reconcile(lines, [entry({ direction: 'in' })]).matches).toEqual([])
  })

  it('prefers a matching cheque number over a nearer date', () => {
    const near = entry({ id: 'near', date: d('2026-09-05'), amountPaise: paise(5000000),
                         paymentMode: 'cheque' })
    const byRef = entry({ id: 'ref', date: d('2026-09-01'), amountPaise: paise(5000000),
                          paymentMode: 'cheque', reference: '445201' })
    expect(reconcile(lines, [near, byRef]).matches[0]!.entryId).toBe('ref')
  })

  it('refuses to guess between two equally good candidates', () => {
    // Picking either would be right half the time and silently wrong the other.
    const a = entry({ id: 'a', date: d('2026-09-01') })
    const b = entry({ id: 'b', date: d('2026-09-03') })
    const r = reconcile(lines, [a, b])
    expect(r.ambiguous).toEqual([0])
    expect(r.matches).toEqual([])
  })

  it('never matches an entry the bank has already confirmed', () => {
    expect(reconcile(lines, [entry({ reconciled: true })]).matches).toEqual([])
  })

  it('lists what is in our books and not on the statement', () => {
    const ghost = entry({ id: 'ghost', amountPaise: paise(99900) })
    expect(reconcile(lines, [ghost]).unmatchedEntries).toEqual(['ghost'])
  })
})

describe('against the ledger', () => {
  it('passes when the statement opens where our books close', () => {
    expect(continuity(paise(125000000), paise(125000000)).ok).toBe(true)
  })

  it('names the gap when it does not', () => {
    const c = continuity(paise(125000000), paise(120000000))
    expect(c.ok).toBe(false)
    expect(c.differencePaise).toBe(paise(5000000))
  })

  it('says nothing when there is nothing to compare', () => {
    expect(continuity(null, paise(1)).ok).toBe(true)
    expect(continuity(paise(1), null).ok).toBe(true)
  })

  it('refuses lines inside the opening balance', () => {
    const p = read(BOI_CSV)
    expect(beforeCutOff(p.lines, d('2026-09-05'))).toEqual([0, 1])
    expect(beforeCutOff(p.lines, d('2026-04-01'))).toEqual([])
  })
})

describe('arithmetic', () => {
  it('never produces a zero amount line', () => {
    expect(read(BOI_CSV).lines.every((l) => l.amountPaise > ZERO)).toBe(true)
  })
})
