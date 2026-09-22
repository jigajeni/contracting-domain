import { describe, it, expect } from 'vitest'
import { isoDate } from '@/domain/dates'
import { ZERO, paise } from '@/domain/money'
import {
  blocking, buildExport, checkVoucher, entriesTotal, escapeXml, ledgerName,
  rupees, safeLedger, tallyDate, type Voucher,
} from '@/domain/export/tally'

const d = (s: string) => isoDate(s)

/** A supplier bill: cost and GST debited, the supplier credited. */
const purchase = (over: Partial<Voucher> = {}): Voucher => ({
  key: 'expense:abc',
  type: 'Purchase',
  date: d('2026-09-12'),
  number: 'SSC/2026/1188',
  narration: 'OPC 53 Cement, 242 bags — Umadi',
  partyLedger: 'Deccan Steel & Cement Agency',
  entries: [
    { ledger: 'Material Purchases', amountPaise: paise(9486400), costCentre: 'SIPL/2026/PWD/001' },
    { ledger: 'Input GST', amountPaise: paise(1707552) },
    { ledger: 'Deccan Steel & Cement Agency', amountPaise: paise(-11193952) },
  ],
  ...over,
})

describe('a voucher has to balance', () => {
  it('accepts one that comes to exactly nothing', () => {
    expect(entriesTotal(purchase().entries)).toBe(ZERO)
    expect(blocking(checkVoucher(purchase()))).toEqual([])
  })

  it('refuses one that is out by a single paisa', () => {
    // Not "within a rupee". A tolerance exports something quietly wrong by
    // the tolerance, every time, for a year.
    const v = purchase({ entries: [
      { ledger: 'Material Purchases', amountPaise: paise(9486400) },
      { ledger: 'Deccan Steel & Cement Agency', amountPaise: paise(-9486401) },
    ] })
    expect(blocking(checkVoucher(v))[0]!.message).toContain('differ by -0.01')
  })

  it('refuses a one-sided voucher', () => {
    const v = purchase({ entries: [
      { ledger: 'Material Purchases', amountPaise: ZERO }] })
    expect(blocking(checkVoucher(v)).length).toBeGreaterThan(0)
  })

  it('refuses a blank ledger name, which would create a ledger called nothing', () => {
    const v = purchase({ entries: [
      { ledger: '  ', amountPaise: paise(100) },
      { ledger: 'Cash', amountPaise: paise(-100) },
    ] })
    expect(blocking(checkVoucher(v))[0]!.message).toContain('ledger called nothing')
  })

  it('warns about a missing narration without refusing it', () => {
    const p = checkVoucher(purchase({ narration: '' }))
    expect(blocking(p)).toEqual([])
    expect(p.some((x) => x.message.includes('a year from now'))).toBe(true)
  })
})

describe('ledger names', () => {
  it('prefers what the office told us their Tally calls it', () => {
    expect(ledgerName('TDS Payable 194C', 'Income Tax TDS')).toBe('TDS Payable 194C')
    expect(ledgerName(null, 'Income Tax TDS')).toBe('Income Tax TDS')
    expect(ledgerName('   ', 'Income Tax TDS')).toBe('Income Tax TDS')
  })

  it('keeps Marathi exactly as it is — Tally is Unicode', () => {
    const r = safeLedger('पांडुरंग मजूर सहकारी संस्था')
    expect(r.name).toBe('पांडुरंग मजूर सहकारी संस्था')
    expect(r.changed).toBe(false)
  })

  it('removes only what Tally itself refuses, and says it did', () => {
    const r = safeLedger('Sadguru Brothers / Earthwork')
    expect(r.name).toBe('Sadguru Brothers - Earthwork')
    expect(r.changed).toBe(true)
  })
})

describe('the shapes Tally wants', () => {
  it('writes dates without separators', () => {
    expect(tallyDate(d('2026-09-12'))).toBe('20260912')
  })

  it('converts paise to rupees at this one boundary and nowhere else', () => {
    expect(rupees(paise(11193952))).toBe('111939.52')
    expect(rupees(paise(-11193952))).toBe('-111939.52')
    expect(rupees(paise(5))).toBe('0.05')
    expect(rupees(ZERO)).toBe('0.00')
  })

  it('escapes what would otherwise break the file', () => {
    expect(escapeXml('Shah & Co <Jath>')).toBe('Shah &amp; Co &lt;Jath&gt;')
  })
})

describe('the file', () => {
  it('writes a debit as ISDEEMEDPOSITIVE Yes with a NEGATIVE amount', () => {
    /* Tally's convention, and getting the pair the wrong way round produces a
       file it accepts and posts backwards — nothing errors and every balance
       is inverted. */
    const out = buildExport({ companyName: 'Sahyadri Infra Projects Pvt Ltd',
                              vouchers: [purchase()] })
    const debit = out.xml.slice(out.xml.indexOf('Material Purchases'))
    expect(debit).toContain('<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>')
    expect(debit.slice(0, 400)).toContain('<AMOUNT>-94864.00</AMOUNT>')

    const credit = out.xml.slice(out.xml.lastIndexOf('Deccan Steel'))
    expect(credit).toContain('<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>')
    expect(credit).toContain('<AMOUNT>111939.52</AMOUNT>')
  })

  it('carries the project as a cost centre, only where there is one', () => {
    const out = buildExport({ companyName: 'X', vouchers: [purchase()] })
    expect(out.xml).toContain('<NAME>SIPL/2026/PWD/001</NAME>')
    // The GST line has no project and gets no allocation block.
    const gst = out.xml.slice(out.xml.indexOf('Input GST'),
                             out.xml.indexOf('Deccan Steel & Cement Agency</LEDGERNAME>'))
    expect(gst).not.toContain('COSTCENTREALLOCATIONS')
  })

  it('carries our own row id so a second import updates rather than doubles', () => {
    const out = buildExport({ companyName: 'X', vouchers: [purchase()] })
    expect(out.xml).toContain('<REMOTEID>expense:abc</REMOTEID>')
  })

  it('names the company exactly as Tally spells it', () => {
    const out = buildExport({ companyName: 'Sahyadri Infra Projects Pvt Ltd', vouchers: [] })
    expect(out.xml).toContain(
      '<SVCURRENTCOMPANY>Sahyadri Infra Projects Pvt Ltd</SVCURRENTCOMPANY>')
  })

  it('holds an unbalanced voucher back and names the row', () => {
    // Tally would take the file, reject this one, and report a total. A
    // voucher missing from this file is found now; one missing from Tally is
    // found at the audit.
    const bad = purchase({ key: 'expense:bent', entries: [
      { ledger: 'Material Purchases', amountPaise: paise(100) },
      { ledger: 'Deccan Steel & Cement Agency', amountPaise: paise(-90) },
    ] })
    const out = buildExport({ companyName: 'X', vouchers: [purchase(), bad] })
    expect(out.written).toBe(1)
    expect(out.held).toHaveLength(1)
    expect(out.held[0]!.key).toBe('expense:bent')
    expect(out.xml).not.toContain('expense:bent')
  })

  it('drops a zero entry and says so rather than writing it', () => {
    const v = purchase({ entries: [
      { ledger: 'Material Purchases', amountPaise: paise(10000) },
      { ledger: 'Rounding', amountPaise: ZERO },
      { ledger: 'Deccan Steel & Cement Agency', amountPaise: paise(-10000) },
    ] })
    const out = buildExport({ companyName: 'X', vouchers: [v] })
    expect(out.written).toBe(1)
    expect(out.xml).not.toContain('Rounding')
    expect(out.warnings.some((w) => w.message.includes('Rounding'))).toBe(true)
  })

  it('produces a well-formed envelope even with nothing to send', () => {
    const out = buildExport({ companyName: 'X', vouchers: [] })
    expect(out.written).toBe(0)
    expect(out.xml.startsWith('<ENVELOPE>')).toBe(true)
    expect(out.xml.trimEnd().endsWith('</ENVELOPE>')).toBe(true)
  })
})
