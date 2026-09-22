import { describe, it, expect } from 'vitest'
import { isoDate } from '@/domain/dates'
import { ZERO, paise } from '@/domain/money'
import {
  NO_PAN_PCT, TDS_ANNUAL_THRESHOLD, TDS_SINGLE_THRESHOLD, allocate, blocking,
  byProject, computeSettlement, computeTds,
  type Deployment, type SettlementInput,
} from '@/domain/labour/settlement'

const d = (s: string) => isoDate(s)

const dep = (over: Partial<Deployment> = {}): Deployment => ({
  projectId: 'umadi', date: d('2026-09-01'), trade: 'mason',
  headcount: 5, wageRatePaise: paise(70000), amountPaise: paise(350000), ...over,
})

describe('what the period says', () => {
  it('pools man-days and money per work, biggest first', () => {
    const rows = byProject([
      dep({ projectId: 'umadi', headcount: 5 }),
      dep({ projectId: 'umadi', headcount: 3, amountPaise: paise(210000) }),
      dep({ projectId: 'sonyal', headcount: 10, amountPaise: paise(700000) }),
    ])
    expect(rows.map((r) => r.projectId)).toEqual(['sonyal', 'umadi'])
    expect(rows[1]!.manDays).toBe(8)
    expect(rows[1]!.computedPaise).toBe(paise(560000))
  })
})

describe('splitting one payment across works', () => {
  const equal = (n: number) => ({ projectId: String(n), manDays: 3, computedPaise: ZERO })

  it('adds back to the payment exactly, even when it does not divide', () => {
    // ₹100.00 over three equal works — 3333.33 each leaves a paisa behind.
    const out = allocate(paise(10000), [equal(1), equal(2), equal(3)]).allocations
    expect(out.reduce((s, a) => s + a.amountPaise, 0n)).toBe(10000n)
    expect(out.map((a) => Number(a.amountPaise)).sort()).toEqual([3333, 3333, 3334])
  })

  it('splits by the register\'s own money where the register has rates', () => {
    // The basis that matters. 30 cheap days and 10 expensive ones are not
    // three-to-one in money, and man-days would say they were.
    const out = allocate(paise(1_00_000), [
      { projectId: 'cheap', manDays: 30, computedPaise: paise(60_000) },
      { projectId: 'dear', manDays: 10, computedPaise: paise(40_000) },
    ])
    expect(out.basis).toBe('measured_work')
    expect(out.allocations[0]!.amountPaise).toBe(paise(60_000))
    expect(out.allocations[1]!.amountPaise).toBe(paise(40_000))
  })

  it('falls back to man-days when site recorded no rates at all', () => {
    const out = allocate(paise(1_00_000), [
      { projectId: 'a', manDays: 30, computedPaise: ZERO },
      { projectId: 'b', manDays: 10, computedPaise: ZERO },
    ])
    expect(out.basis).toBe('man_days')
    expect(out.allocations[0]!.amountPaise).toBe(paise(75_000))
    expect(out.allocations[1]!.amountPaise).toBe(paise(25_000))
    expect(out.reason).toContain('heads are all')
  })

  it('gives nothing to a work the gang was never on', () => {
    const out = allocate(paise(10000), [
      { projectId: 'a', manDays: 10, computedPaise: paise(10000) },
      { projectId: 'b', manDays: 0, computedPaise: ZERO },
    ]).allocations
    expect(out[1]!.amountPaise).toBe(ZERO)
    expect(out[0]!.amountPaise).toBe(paise(10000))
  })

  it('allocates nothing at all when there is nothing to go by', () => {
    const out = allocate(paise(10000), [{ projectId: 'a', manDays: 0, computedPaise: ZERO }])
    expect(out.allocations[0]!.amountPaise).toBe(ZERO)
    expect(out.reason).toContain('Nothing recorded')
  })
})

describe('194C', () => {
  const base = { payeeKind: 'individual' as const, hasPan: true,
                 paidThisFyPaise: ZERO, grossPaise: paise(50_000_00) }

  it('deducts nothing below both thresholds', () => {
    const r = computeTds({ ...base, grossPaise: paise(9_000_00) })
    expect(r.tdsPaise).toBe(ZERO)
    expect(r.reason).toContain('Under both')
  })

  it('bites on a single payment over ₹30,000', () => {
    const r = computeTds(base)
    expect(r.ratePct).toBe('1.0000')
    expect(r.tdsPaise).toBe(paise(50_000))
  })

  it('bites on the year even when every payment is small', () => {
    // A mukadam on ₹9,000 a fortnight never trips the single limit. Reading
    // the payment alone under-deducts all year.
    const r = computeTds({ ...base, grossPaise: paise(9_000_00),
      paidThisFyPaise: paise(95_000_00) })
    expect(r.tdsPaise).toBe(paise(9_000))
    expect(r.reason).toContain("year's payments")
  })

  it('draws the threshold strictly above, not at', () => {
    expect(computeTds({ ...base, grossPaise: TDS_SINGLE_THRESHOLD }).tdsPaise).toBe(ZERO)
    expect(computeTds({ ...base, grossPaise: paise(9_000_00),
      paidThisFyPaise: (TDS_ANNUAL_THRESHOLD - paise(9_000_00)) as never,
    }).tdsPaise).toBe(ZERO)
  })

  it('charges two per cent to anyone who is not an individual', () => {
    expect(computeTds({ ...base, payeeKind: 'society' }).ratePct).toBe('2.0000')
  })

  it('charges twenty per cent with no PAN — section 206AA', () => {
    const r = computeTds({ ...base, hasPan: false })
    expect(r.ratePct).toBe(NO_PAN_PCT)
    expect(r.tdsPaise).toBe(paise(10_00_000))
  })

  it('lets an entered figure stand over every rule', () => {
    const r = computeTds({ ...base, hasPan: false, enteredPaise: paise(50_000) })
    expect(r.tdsPaise).toBe(paise(50_000))
    expect(r.entered).toBe(true)
  })
})

describe('the settlement', () => {
  const input = (over: Partial<SettlementInput> = {}): SettlementInput => ({
    periodFrom: d('2026-09-01'), periodTo: d('2026-09-15'),
    deployments: [
      dep({ projectId: 'umadi', headcount: 30, amountPaise: paise(2_10_000) }),
      dep({ projectId: 'sonyal', headcount: 10, amountPaise: paise(70_000) }),
    ],
    agreedGrossPaise: null,
    advanceRecoveredPaise: ZERO,
    tds: { grossPaise: ZERO, payeeKind: 'individual', hasPan: true,
           paidThisFyPaise: ZERO },
    settledPeriods: [],
    ...over,
  })

  it('takes the register when nothing was renegotiated, and splits it', () => {
    const s = computeSettlement(input())
    expect(s.manDays).toBe(40)
    expect(s.grossPaise).toBe(paise(2_80_000))
    expect(s.tds.tdsPaise).toBe(ZERO) // under ₹30,000
    expect(s.netPaise).toBe(paise(2_80_000))
    expect(s.split.allocations.reduce((a, x) => a + x.amountPaise, 0n)).toBe(280000n)
    expect(s.split.allocations[0]!.amountPaise).toBe(paise(2_10_000))
  })

  it('lets the agreed figure beat the register, and keeps the gap visible', () => {
    const s = computeSettlement(input({ agreedGrossPaise: paise(2_50_000) }))
    expect(s.grossPaise).toBe(paise(2_50_000))
    expect(s.computedGrossPaise).toBe(paise(2_80_000))
    expect(s.differencePaise).toBe(paise(-30_000))
    // Still splits the AGREED figure, not the register's.
    expect(s.split.allocations.reduce((a, x) => a + x.amountPaise, 0n)).toBe(250000n)
  })

  it('warns when the agreed figure is far from the register', () => {
    const s = computeSettlement(input({ agreedGrossPaise: paise(2_00_000) }))
    expect(s.problems.some((p) => p.message.includes('One of the two is wrong'))).toBe(true)
  })

  it('refuses a period overlapping one already settled', () => {
    // The same days paid twice: both payments look right alone.
    const s = computeSettlement(input({ settledPeriods: [
      { from: d('2026-09-10'), to: d('2026-09-20'),
        ref: '10-09-2026 – 20-09-2026' }] }))
    // Named by its period: an id fragment tells nobody which fortnight to move off.
    expect(blocking(s.problems)[0]!.message).toContain('10-09-2026 – 20-09-2026')
  })

  it('allows a period that merely abuts one already settled', () => {
    const s = computeSettlement(input({ settledPeriods: [
      { from: d('2026-08-16'), to: d('2026-08-31'), ref: 'August' }] }))
    expect(blocking(s.problems)).toEqual([])
  })

  it('refuses to pay out less than nothing', () => {
    const s = computeSettlement(input({ advanceRecoveredPaise: paise(5_00_000) }))
    expect(blocking(s.problems)[0]!.message).toContain('Recover less now')
  })

  it('says plainly when there is nothing to split by', () => {
    const s = computeSettlement(input({ deployments: [] }))
    expect(s.manDays).toBe(0)
    expect(s.problems.some((p) => p.message.includes('nothing checks it'))).toBe(true)
  })

  it('recovers an advance before the split, so the works carry the net', () => {
    const s = computeSettlement(input({ advanceRecoveredPaise: paise(80_000) }))
    expect(s.netPaise).toBe(paise(2_00_000))
    expect(s.split.allocations.reduce((a, x) => a + x.amountPaise, 0n)).toBe(200000n)
  })
})
