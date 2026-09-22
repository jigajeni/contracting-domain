import { describe, expect, it } from 'vitest'
import type { ISODate } from '@/domain/dates'
import {
  OBLIGATIONS, annualPeriod, complianceDedupeKey, dueFor, monthPeriod,
  quarterPeriod, type FirmProfile,
} from '@/domain/compliance/calendar'

const d = (s: string) => s as ISODate
const TODAY = d('2026-09-04')

const ob = (code: string) => {
  const found = OBLIGATIONS.find((o) => o.code === code)
  if (!found) throw new Error(`no obligation ${code}`)
  return found
}

/** Nothing applies. Every flag on `firms` defaults to false for a reason. */
const bare: FirmProfile = {
  id: 'f1', shortName: 'Test', entityType: 'proprietorship',
  gstApplicable: false, gstRegistration: 'unregistered',
  epfApplicable: false, esicApplicable: false, tdsDeductor: false,
  rocApplicable: false, societyAuditApplicable: false,
  taxAuditApplicable: false, professionalTaxApplicable: false,
}

/** The Pvt Ltd: GST, TDS, EPF, ESIC, ROC, and an audit case. */
const company: FirmProfile = {
  ...bare, id: 'sipl', shortName: 'Sahyadri Infra', entityType: 'private_limited',
  gstApplicable: true, gstRegistration: 'regular',
  epfApplicable: true, esicApplicable: true, tdsDeductor: true,
  rocApplicable: true, taxAuditApplicable: true,
}

/** The labour society: GST and TDS, an audit and an AGM, no ROC and no EPF. */
const society: FirmProfile = {
  ...bare, id: 'soc', shortName: 'Rajgad', entityType: 'labour_society',
  gstApplicable: true, gstRegistration: 'regular',
  tdsDeductor: true, societyAuditApplicable: true,
}

const due = (f: FirmProfile, today = TODAY) => dueFor(f, today)
const codes = (f: FirmProfile, today = TODAY) =>
  due(f, today).map((x) => x.obligationCode)
const dateOf = (f: FirmProfile, code: string, today = TODAY) =>
  due(f, today).filter((x) => x.obligationCode === code).map((x) => x.dueDate)

describe('the dates the government actually fixed', () => {
  it('puts GSTR-1 on the 11th and GSTR-3B on the 20th of the next month', () => {
    const july = monthPeriod(2026, 7)
    expect(ob('gstr_1').dueDate(july, company)).toBe('2026-08-11')
    expect(ob('gstr_3b').dueDate(july, company)).toBe('2026-08-20')
  })

  it('rolls a December return into January', () => {
    expect(ob('gstr_3b').dueDate(monthPeriod(2026, 12), company)).toBe('2027-01-20')
  })

  it('pays TDS by the 7th — except March, which is 30 April', () => {
    expect(ob('tds_payment').dueDate(monthPeriod(2026, 7), company)).toBe('2026-08-07')
    /* The one exception everybody forgets, and the only month where being
       wrong costs a full month of interest at 1.5%. */
    expect(ob('tds_payment').dueDate(monthPeriod(2026, 3), company)).toBe('2026-04-30')
  })

  it('files the TDS return a month after each quarter, but two after the fourth', () => {
    expect(ob('tds_return').dueDate(quarterPeriod(2026, 1), company)).toBe('2026-07-31')
    expect(ob('tds_return').dueDate(quarterPeriod(2026, 2), company)).toBe('2026-10-31')
    expect(ob('tds_return').dueDate(quarterPeriod(2026, 3), company)).toBe('2027-01-31')
    expect(ob('tds_return').dueDate(quarterPeriod(2026, 4), company)).toBe('2027-05-31')
  })

  it('pays EPF and ESIC by the 15th', () => {
    expect(ob('epf').dueDate(monthPeriod(2026, 8), company)).toBe('2026-09-15')
    expect(ob('esic').dueDate(monthPeriod(2026, 8), company)).toBe('2026-09-15')
  })

  it('puts PTRC at the end of the following month, whatever its length', () => {
    expect(ob('ptrc').dueDate(monthPeriod(2026, 1), company)).toBe('2026-02-28')
    expect(ob('ptrc').dueDate(monthPeriod(2027, 1), company)).toBe('2027-02-28')
    expect(ob('ptrc').dueDate(monthPeriod(2026, 3), company)).toBe('2026-04-30')
  })

  it('moves the income tax return by three months for an audit case', () => {
    const fy = annualPeriod(2025)
    const sole = { ...bare, entityType: 'proprietorship' }
    expect(ob('itr').dueDate(fy, sole)).toBe('2026-07-31')
    expect(ob('itr').dueDate(fy, { ...sole, taxAuditApplicable: true })).toBe('2026-10-31')
    /* A company is audited under the Companies Act whatever its size, so its
       return is the later date even with no section 44AB audit. */
    expect(ob('itr').dueDate(fy, { ...company, taxAuditApplicable: false })).toBe('2026-10-31')
    expect(ob('itr').dueDate(fy, company)).toBe('2026-10-31')
    // And the audit report itself has to be in before the return.
    expect(ob('tax_audit').dueDate(fy, company)).toBe('2026-09-30')
    expect(ob('tax_audit').dueDate(fy, company) < ob('itr').dueDate(fy, company)).toBe(true)
  })

  it('separates the two ROC filings, because they are a month apart', () => {
    const fy = annualPeriod(2025)
    expect(ob('roc_aoc4').dueDate(fy, company)).toBe('2026-10-30')
    expect(ob('roc_mgt7').dueDate(fy, company)).toBe('2026-11-29')
  })

  it('audits the society within four months, and holds the AGM by September', () => {
    const fy = annualPeriod(2025)
    expect(ob('society_audit').dueDate(fy, society)).toBe('2026-07-31')
    expect(ob('society_agm').dueDate(fy, society)).toBe('2026-09-30')
    // The audited accounts go before the meeting, so the order matters.
    expect(ob('society_audit').dueDate(fy, society) < ob('society_agm').dueDate(fy, society))
      .toBe(true)
  })
})

describe('who owes what', () => {
  it('generates nothing but the return for a firm with no flags set', () => {
    /* Every applicability flag defaults to false, so a half-entered firm is
       silent rather than wrong. The income tax return is the one thing every
       firm files. */
    expect(new Set(codes(bare, d('2026-06-01')))).toEqual(new Set(['itr']))
  })

  it('does not send the society an EPF or a ROC reminder', () => {
    const c = codes(society)
    expect(c).not.toContain('epf')
    expect(c).not.toContain('esic')
    expect(c).not.toContain('roc_aoc4')
    expect(c).not.toContain('roc_mgt7')
  })

  it('does not send the company a co-operative audit', () => {
    expect(codes(company)).not.toContain('society_audit')
  })

  it('gives a composition dealer CMP-08 and GSTR-4, not GSTR-1 and 3B', () => {
    /* The flag could already say composition and there was nothing to record
       the result as — so such a firm would have been chased for returns it
       does not file, and left unchased for the ones it does. */
    const comp = { ...company, gstRegistration: 'composition' as const }
    const c = codes(comp)
    expect(c).not.toContain('gstr_1')
    expect(c).not.toContain('gstr_3b')
    expect(codes(comp, d('2026-09-20'))).toContain('cmp_08')
  })

  it('says nothing about GST to a firm that is not registered', () => {
    const c = codes({ ...company, gstApplicable: false })
    expect(c.filter((x) => x.startsWith('gst') || x.startsWith('cmp'))).toEqual([])
  })

  it('leaves professional tax alone until somebody says it applies', () => {
    expect(codes(company)).not.toContain('ptrc')
    expect(codes({ ...company, professionalTaxApplicable: true })).toContain('ptrc')
  })
})

describe('the window', () => {
  it('never generates something already past due', () => {
    /* Forward only. Filling the register with items marked pending that were
       in fact filed on time would make the compliance screen wrong about the
       past, which is worse than starting empty. */
    expect(due(company).every((x) => x.dueDate >= TODAY)).toBe(true)
  })

  it('keeps a monthly return to about a fortnight of notice', () => {
    for (const x of due(company).filter((i) => i.period.kind === 'monthly')) {
      expect(x.dueDate <= '2026-10-19').toBe(true)
    }
  })

  it('gives an annual filing a full quarter, because the work is a year of books', () => {
    // On 04-09-2026 the audit (30-09), the return (31-10) and both ROC filings
    // are already visible; a fortnight's notice on any of them is useless.
    const annual = codes(company).filter((c) =>
      ['tax_audit', 'itr', 'roc_aoc4', 'roc_mgt7'].includes(c))
    expect(new Set(annual)).toEqual(new Set(['tax_audit', 'itr', 'roc_aoc4', 'roc_mgt7']))
  })

  it('produces one GSTR-3B, not six', () => {
    expect(dateOf(company, 'gstr_3b')).toEqual(['2026-09-20'])
  })

  it('is stable — running it twice asks for exactly the same things', () => {
    expect(due(company)).toEqual(due(company))
  })

  it('comes back in date order', () => {
    const dates = due(company).map((x) => x.dueDate)
    expect([...dates].sort()).toEqual(dates)
  })
})

describe('period labels and keys', () => {
  it('reads the way the office writes it', () => {
    expect(monthPeriod(2026, 7).label).toBe('Jul-2026')
    expect(quarterPeriod(2026, 1).label).toBe('Q1 FY 2026-27')
    expect(annualPeriod(2025).label).toBe('FY 2025-26')
  })

  it('keys a period the way it is already keyed in the database', () => {
    expect(monthPeriod(2026, 7).key).toBe('2026-07')
    expect(quarterPeriod(2026, 1).key).toBe('2026-Q1')
    expect(annualPeriod(2025).key).toBe('2025-26')
  })

  it('puts a January month in the previous financial year', () => {
    // CLAUDE.md §0.3 — a "year" that means calendar year is a bug.
    expect(monthPeriod(2027, 1).fyStart).toBe(2026)
    expect(monthPeriod(2026, 4).fyStart).toBe(2026)
    expect(monthPeriod(2026, 3).fyStart).toBe(2025)
  })

  it('builds the dedupe key the shape the database already holds', () => {
    expect(complianceDedupeKey('abc', 'gstr_3b', '2026-07'))
      .toBe('STATUTORY:firm:abc:gstr_3b:2026-07')
  })

  it('gives every obligation of a firm a distinct key', () => {
    const keys = due(company).map((x) =>
      complianceDedupeKey(company.id, x.obligationCode, x.period.key))
    expect(new Set(keys).size).toBe(keys.length)
  })
})
