import { describe, expect, it } from 'vitest'
import { isoDate } from '@/domain/dates'
import { paise, ZERO, type Paise } from '@/domain/money'
import {
  agePayables, dayOfWeek, describeTerms, dueDateFor, statementGap,
  type Payable, type PaymentTerms,
} from '@/domain/expense/payables'

/**
 * Driven by a real supplier statement: Pooja Ceramic, bill E/18744 dated
 * 02-09-2026, ₹200 for two packets of tile levelling clips, against a previous
 * due of ₹14,68,795.60.
 *
 * The "SATURDAY CLOSE" printed across that bill means THE SHOP SHUTS ON
 * SATURDAYS. It was once read here as a weekly settlement day, and the whole
 * `weekly` terms kind was built on that reading. Settlement on these accounts
 * is really by cash availability, discussed with the supplier — so `on_demand`
 * is the normal case, not the fallback.
 */
const SATURDAY = 6
const weekly: PaymentTerms = { kind: 'weekly', settlementDow: SATURDAY }

describe('when a bill falls due', () => {
  /* 02-09-2026 is a Wednesday. The next Saturday is the 5th. */
  it('takes a weekly account to its next settlement day', () => {
    expect(dayOfWeek(isoDate('2026-09-02'))).toBe(3)
    expect(dueDateFor(isoDate('2026-09-02'), weekly)).toBe(isoDate('2026-09-05'))
  })

  /* A bill handed over on the settlement day itself settles that day rather
     than waiting a week — that is what walking in on Saturday means. */
  it('settles a bill dated on the settlement day that same day', () => {
    expect(dueDateFor(isoDate('2026-09-05'), weekly)).toBe(isoDate('2026-09-05'))
  })

  it('rolls a bill dated the day after into the following week', () => {
    expect(dueDateFor(isoDate('2026-09-06'), weekly)).toBe(isoDate('2026-09-12'))
  })

  it('counts net days from the bill date', () => {
    expect(dueDateFor(isoDate('2026-09-02'), { kind: 'days', creditDays: 30 }))
      .toBe(isoDate('2026-10-02'))
  })

  describe('monthly', () => {
    const tenth: PaymentTerms = { kind: 'monthly', settlementDay: 10 }

    it('uses this month when the day has not passed', () => {
      expect(dueDateFor(isoDate('2026-09-02'), tenth)).toBe(isoDate('2026-09-10'))
    })

    it('rolls to next month when it has', () => {
      expect(dueDateFor(isoDate('2026-09-11'), tenth)).toBe(isoDate('2026-10-10'))
    })

    it('crosses the year end', () => {
      expect(dueDateFor(isoDate('2026-12-20'), tenth)).toBe(isoDate('2027-01-10'))
    })

    /* Capped at 28 in the schema for the same reason loan EMI days are:
       February. A test here so nobody relaxes the constraint without seeing it. */
    it('is never asked for a day that some month lacks', () => {
      expect(dueDateFor(isoDate('2026-01-30'), { kind: 'monthly', settlementDay: 28 }))
        .toBe(isoDate('2026-02-28'))
    })
  })

  /* The honest default for a supplier nobody has agreed terms with. It does
     not claim they will be paid today — it makes the balance show as overdue,
     which is the point. An unpriced liability sitting quietly at zero days is
     the comfortable answer and the wrong one. */
  it('treats an unknown account as owed now', () => {
    expect(dueDateFor(isoDate('2026-09-02'), { kind: 'on_demand' }))
      .toBe(isoDate('2026-09-02'))
  })
})

describe('describing terms', () => {
  it('reads the way the bill does', () => {
    expect(describeTerms(weekly)).toBe('weekly, Saturday')
    expect(describeTerms({ kind: 'days', creditDays: 30 })).toBe('30 days')
    expect(describeTerms({ kind: 'monthly', settlementDay: 1 })).toBe('monthly, 1st')
    expect(describeTerms({ kind: 'on_demand' })).toBe('on demand')
  })
})

describe('aging by supplier', () => {
  const TODAY = isoDate('2026-09-13')

  const rows = [
    { supplierId: 'pooja', supplierName: 'Pooja Ceramic', terms: weekly,
      billDate: isoDate('2026-09-02'), amountPaise: paise(200_00n) },
    { supplierId: 'pooja', supplierName: 'Pooja Ceramic', terms: weekly,
      billDate: isoDate('2026-08-20'), amountPaise: paise(14_68_795_60n) },
    { supplierId: 'steel', supplierName: 'Deccan Steel', terms: { kind: 'days' as const, creditDays: 30 },
      billDate: isoDate('2026-09-10'), amountPaise: paise(17_04_400_00n) },
  ]

  const aged = agePayables(rows, TODAY)

  it('sums what each supplier is owed', () => {
    const pooja = aged.find((a) => a.supplierId === 'pooja')!
    expect(pooja.totalPaise).toBe(14_68_995_60n as Paise)
    expect(pooja.count).toBe(2)
  })

  /* Both Pooja bills were due on a Saturday already past. */
  it('marks past-due balances overdue and counts the days', () => {
    const pooja = aged.find((a) => a.supplierId === 'pooja')!
    expect(pooja.overduePaise).toBe(14_68_995_60n as Paise)
    expect(pooja.oldestOverdueDays).toBe(22) // due 22-08, today 13-09
    expect(pooja.nextDue).toBeNull()
  })

  it('leaves a bill inside its terms out of overdue', () => {
    const steel = aged.find((a) => a.supplierId === 'steel')!
    expect(steel.overduePaise).toBe(0n as Paise)
    expect(steel.nextDue).toBe(isoDate('2026-10-10'))
    expect(steel.oldestOverdueDays).toBe(0)
  })

  /* Sorted by what is OVERDUE, not by the total. A ₹14 lakh account settled
     every Saturday and not yet due is ordinary; ₹40,000 a month late is
     somebody who stops supplying. */
  it('puts the most overdue supplier first', () => {
    const small = agePayables([
      { supplierId: 'big', supplierName: 'Big', terms: { kind: 'days', creditDays: 60 },
        billDate: isoDate('2026-09-12'), amountPaise: paise(50_00_000_00n) },
      { supplierId: 'late', supplierName: 'Late', terms: { kind: 'on_demand' },
        billDate: isoDate('2026-07-01'), amountPaise: paise(40_000_00n) },
    ], TODAY)
    expect(small[0]!.supplierId).toBe('late')
  })
})

describe('our books against their statement', () => {
  /* The single most useful number on a supplier screen, and nothing else
     computes it. Positive means they say we owe more than we have booked —
     usually a bill nobody entered. */
  it('reports what they say we owe beyond what we booked', () => {
    expect(statementGap(paise(14_68_795_60n), paise(14_68_995_60n)))
      .toBe(200_00n as Paise)
  })

  it('goes negative when we have booked more than they are asking', () => {
    expect(statementGap(paise(14_68_995_60n), paise(14_68_795_60n)))
      .toBe(-200_00n as Paise)
  })

  it('is null when there is no statement to compare against', () => {
    expect(statementGap(paise(100n), null)).toBeNull()
  })
})

describe('what was actually agreed', () => {
  const bill = (over: Partial<Payable> = {}): Payable => ({
    supplierId: 's1', supplierName: 'Shree Datta Traders',
    terms: { kind: 'on_demand' },
    billDate: isoDate('2026-08-20'), amountPaise: paise(4_05_720), ...over,
  })

  it('marks a supplier who agreed nothing as not agreed', () => {
    // Nearly every account. Settlement is by cash availability, discussed with
    // the supplier — so "overdue" would assert a promise nobody made.
    const [s] = agePayables([bill()], isoDate('2026-09-16'))
    expect(s!.agreed).toBe(false)
    // The debt is still live and still ages — it just is not a broken promise.
    expect(s!.overduePaise).toBe(paise(4_05_720))
    expect(s!.oldestOverdueDays).toBe(27)
  })

  it('marks a supplier who did give terms as agreed', () => {
    const [s] = agePayables(
      [bill({ terms: { kind: 'days', creditDays: 30 } })], isoDate('2026-09-16'))
    expect(s!.agreed).toBe(true)
    expect(s!.overduePaise).toBe(ZERO)
    expect(s!.nextDue).toBe('2026-09-19')
  })

  it('does not treat a shop holiday as a settlement day', () => {
    // "SATURDAY CLOSE" printed on a bill means the shop shuts on Saturdays.
    // Weekly terms exist for a supplier who genuinely settles on a fixed day,
    // and that is the exception, not the reading of that notice.
    const [s] = agePayables([bill()], isoDate('2026-09-16'))
    expect(s!.terms.kind).toBe('on_demand')
    expect(s!.terms.settlementDow ?? null).toBeNull()
  })
})
