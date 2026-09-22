import { describe, expect, it } from 'vitest'
import { paise, type Paise } from '@/domain/money'
import { computePnl, confidenceOf, type PnlInput } from '@/domain/project/pnl'

const base: PnlInput = {
  revenuePaise: paise(1_00_00_000_00n),
  directByBucket: [
    { bucket: 'material', totalPaise: paise(45_00_000_00n) },
    { bucket: 'labour', totalPaise: paise(15_00_000_00n) },
  ],
  overheadByBucket: [
    { bucket: 'office_overhead', totalPaise: paise(5_00_000_00n) },
  ],
  unmeasuredRevenuePaise: paise(0n),
  unmeasuredWorks: 0,
}

describe('the shape of the result', () => {
  const p = computePnl(base)

  it('takes direct cost off revenue for gross', () => {
    expect(p.directCostPaise).toBe(60_00_000_00n as Paise)
    expect(p.grossPaise).toBe(40_00_000_00n as Paise)
    expect(p.grossPct).toBe(40)
  })

  it('takes overhead off gross for operating', () => {
    expect(p.operatingPaise).toBe(35_00_000_00n as Paise)
    expect(p.operatingPct).toBe(35)
  })

  /* Overhead belongs to the firm, not to a work, so it must never be inside
     the gross figure — the two answer different questions. */
  it('keeps overhead out of gross', () => {
    expect(p.grossPaise).not.toBe(p.operatingPaise)
  })

  it('orders buckets biggest first, so the reader starts where the money is', () => {
    expect(p.directByBucket[0]!.bucket).toBe('material')
  })
})

describe('a loss', () => {
  it('reports it plainly rather than clamping at zero', () => {
    const p = computePnl({
      ...base,
      directByBucket: [{ bucket: 'material', totalPaise: paise(1_20_00_000_00n) }],
    })
    expect(p.grossPaise).toBe(-20_00_000_00n as Paise)
    expect(p.grossPct).toBe(-20)
  })
})

describe('how much of it can be believed', () => {
  /* The same discipline as the profitability screen. A quarter of revenue
     with no cost behind it is not a footnote on a margin; it is the
     difference between a firm that made money and one that has not finished
     counting. */
  it('is good when nearly everything is measured', () => {
    expect(confidenceOf(computePnl(base))).toBe('good')
  })

  it('is partial past a tenth', () => {
    const p = computePnl({ ...base,
      unmeasuredRevenuePaise: paise(25_00_000_00n), unmeasuredWorks: 3 })
    expect(p.unmeasuredPct).toBe(25)
    expect(confidenceOf(p)).toBe('partial')
  })

  it('is unusable past a half', () => {
    const p = computePnl({ ...base,
      unmeasuredRevenuePaise: paise(60_00_000_00n), unmeasuredWorks: 8 })
    expect(confidenceOf(p)).toBe('unusable')
  })

  it('is unusable when there is no revenue to measure against', () => {
    const p = computePnl({ ...base, revenuePaise: paise(0n) })
    expect(p.unmeasuredPct).toBeNull()
    expect(confidenceOf(p)).toBe('unusable')
  })
})

describe('a firm with nothing booked', () => {
  it('divides by nothing rather than reporting zero per cent', () => {
    const p = computePnl({
      revenuePaise: paise(0n), directByBucket: [], overheadByBucket: [],
      unmeasuredRevenuePaise: paise(0n), unmeasuredWorks: 0,
    })
    expect(p.grossPct).toBeNull()
    expect(p.operatingPct).toBeNull()
    expect(p.operatingPaise).toBe(0n as Paise)
  })
})
