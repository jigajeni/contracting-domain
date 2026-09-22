import { describe, expect, it } from 'vitest'
import { paise, type Paise } from '@/domain/money'
import {
  allocateOverhead, profitabilityOf, type ProjectEconomics,
} from '@/domain/project/profitability'

const base: ProjectEconomics = {
  contractValuePaise: paise(1_00_00_000_00n),   // ₹1 crore
  billedPaise: paise(60_00_000_00n),            // ₹60 lakh
  receivedPaise: paise(40_00_000_00n),          // ₹40 lakh
  revenuePaise: paise(60_00_000_00n),
  costPaise: paise(45_00_000_00n),              // ₹45 lakh
  executionModel: 'own',
  imprestOutstandingPaise: paise(0n),
  costEntries: 12,
}

describe('an ordinary work', () => {
  const p = profitabilityOf(base)

  it('reports margin, and margin over revenue', () => {
    expect(p.marginPaise).toBe(15_00_000_00n as Paise)
    expect(p.marginPct).toBe(25)
  })

  it('reports progress and collection separately', () => {
    expect(p.billedPct).toBe(60)
    expect(p.collectedPct).toBe(66)
    expect(p.outstandingPaise).toBe(20_00_000_00n as Paise)
  })

  it('has nothing to warn about', () => {
    expect(p.costCoverage).toBe('booked')
    expect(p.caveat).toBeNull()
  })
})

describe('the trap: a work with no cost booked', () => {
  /* The whole reason this module exists. Until expenses went in last week
     every work had zero cost, and a margin column would have shown every one
     of them at a hundred per cent. Profitable and unmeasured look identical
     in that column and are completely different in life. */
  const p = profitabilityOf({ ...base, costPaise: paise(0n), costEntries: 0 })

  it('refuses to report a margin percentage', () => {
    expect(p.marginPct).toBeNull()
    expect(p.marginPct).not.toBe(100)
  })

  it('says so in words', () => {
    expect(p.costCoverage).toBe('none')
    expect(p.caveat).toMatch(/not a profitable work/i)
    expect(p.caveat).toMatch(/unmeasured/i)
  })

  /* Billed and collected are still true — they come from bills, not costs. */
  it('still reports what is known', () => {
    expect(p.billedPct).toBe(60)
    expect(p.outstandingPaise).toBe(20_00_000_00n as Paise)
  })
})

describe('site cash not yet accounted for', () => {
  const p = profitabilityOf({ ...base, imprestOutstandingPaise: paise(18_800_00n) })

  it('flags the cost as understated rather than final', () => {
    expect(p.costCoverage).toBe('partial')
    expect(p.caveat).toMatch(/understated/i)
    /* The margin is still computed — it is the best figure available, and
       suppressing it would hide a work that is losing money. */
    expect(p.marginPct).toBe(25)
  })
})

describe('execution arrangements', () => {
  /* Outward: somebody else executes it, we earn the commission and bear no
     cost. Zero cost is the right answer, not a gap, so it must not be flagged
     as unmeasured. */
  it('does not treat an outward work as unmeasured', () => {
    const p = profitabilityOf({
      ...base, executionModel: 'executed_by_other',
      revenuePaise: paise(2_40_000_00n), costPaise: paise(0n), costEntries: 0,
    })
    expect(p.costCoverage).toBe('booked')
    expect(p.marginPct).toBe(100)
    expect(p.caveat).toMatch(/commission and nothing else/i)
  })

  it('explains an inward work rather than leaving the revenue unexplained', () => {
    const p = profitabilityOf({ ...base, executionModel: 'executed_for_other' })
    expect(p.caveat).toMatch(/less the commission/i)
  })
})

describe('a work that is losing money', () => {
  it('reports a negative margin plainly', () => {
    const p = profitabilityOf({ ...base, costPaise: paise(70_00_000_00n) })
    expect(p.marginPaise).toBe(-10_00_000_00n as Paise)
    expect(p.marginPct).toBe(-16)
  })
})

describe('nothing billed yet', () => {
  it('divides by nothing rather than reporting zero', () => {
    const p = profitabilityOf({
      ...base, billedPaise: paise(0n), receivedPaise: paise(0n),
      revenuePaise: paise(0n),
    })
    expect(p.collectedPct).toBeNull()
    expect(p.marginPct).toBeNull()
    expect(p.billedPct).toBe(0)
  })
})

describe('overhead allocation', () => {
  const rows = [
    { revenuePaise: paise(60_00_000_00n) },
    { revenuePaise: paise(30_00_000_00n) },
    { revenuePaise: paise(10_00_000_00n) },
  ]

  it('splits in proportion to revenue', () => {
    const a = allocateOverhead(rows, paise(10_00_000_00n))
    expect(a[0]).toBe(6_00_000_00n as Paise)
    expect(a[1]).toBe(3_00_000_00n as Paise)
    expect(a[2]).toBe(1_00_000_00n as Paise)
  })

  /* An overhead total that does not match the overhead is the kind of
     discrepancy somebody spends an afternoon on. */
  it('always sums to exactly the overhead, however it divides', () => {
    const odd = [
      { revenuePaise: paise(1n) }, { revenuePaise: paise(1n) },
      { revenuePaise: paise(1n) },
    ]
    const a = allocateOverhead(odd, paise(100n))
    expect(a.reduce((s, v) => s + v, 0n)).toBe(100n)
  })

  it('allocates nothing when there is no revenue to allocate against', () => {
    const a = allocateOverhead([{ revenuePaise: paise(0n) }], paise(5_00_000_00n))
    expect(a[0]).toBe(0n as Paise)
  })
})
