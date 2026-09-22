import { describe, expect, it } from 'vitest'
import { paise, type Paise } from '@/domain/money'
import { computeAsd, describeAsd, type AsdRule } from '@/domain/tender/asd'

/** Confirmed for PWD and ZP Sangli: below 10%, on the full differential. */
const RULE: AsdRule = { thresholdPct: '10.0000', basis: 'full_differential' }
const CRORE = paise(1_00_00_000_00n)

describe('bidding below the estimate', () => {
  /* The worked example, and the reason the sign matters: premium_pct is stored
     NEGATIVE for below-estimate — CLAUDE.md §1. */
  it('demands the whole difference past the threshold', () => {
    const a = computeAsd({
      estimatedCostPaise: CRORE, premiumPct: '-12.0000', rule: RULE,
    })
    expect(a.applies).toBe(true)
    expect(a.belowPct).toBe(12)
    expect(a.requiredPaise).toBe(12_00_000_00n as Paise)
  })

  /* Not merely the 2% beyond the threshold. Getting this wrong furnishes a
     ₹2 lakh guarantee where ₹12 lakh was demanded, and the agreement is
     refused at the counter. */
  it('is not just the part beyond the threshold', () => {
    const a = computeAsd({
      estimatedCostPaise: CRORE, premiumPct: '-12.0000', rule: RULE,
    })
    expect(a.requiredPaise).not.toBe(2_00_000_00n as Paise)
  })

  it('charges nothing inside the threshold', () => {
    const a = computeAsd({
      estimatedCostPaise: CRORE, premiumPct: '-8.0000', rule: RULE,
    })
    expect(a.applies).toBe(false)
    expect(a.requiredPaise).toBe(0n as Paise)
    /* The differential is still reported — it is what the work is worth less
       than the estimate, which matters for margin whether or not ASD applies. */
    expect(a.differentialPaise).toBe(8_00_000_00n as Paise)
  })

  /* Departments write "more than 10% below". Exactly ten is not more than ten. */
  it('treats exactly the threshold as inside it', () => {
    const a = computeAsd({
      estimatedCostPaise: CRORE, premiumPct: '-10.0000', rule: RULE,
    })
    expect(a.applies).toBe(false)
    expect(a.requiredPaise).toBe(0n as Paise)
  })

  it('applies a whisker past it', () => {
    const a = computeAsd({
      estimatedCostPaise: CRORE, premiumPct: '-10.0100', rule: RULE,
    })
    expect(a.applies).toBe(true)
    expect(a.requiredPaise).toBe(10_01_000_00n as Paise)
  })
})

describe('bidding at or above the estimate', () => {
  it('owes nothing when above', () => {
    const a = computeAsd({
      estimatedCostPaise: CRORE, premiumPct: '4.5000', rule: RULE,
    })
    expect(a.applies).toBe(false)
    expect(a.belowPct).toBe(0)
    expect(a.differentialPaise).toBe(0n as Paise)
    expect(a.unknown).toBeNull()
  })

  /* And an unrecorded rule does not matter above the estimate, so it must not
     produce a warning — noise on the tenders list is how real warnings get
     ignored. */
  it('says nothing about an unrecorded rule when at the estimate', () => {
    const a = computeAsd({
      estimatedCostPaise: CRORE, premiumPct: '0',
      rule: { thresholdPct: null, basis: 'full_differential' },
    })
    expect(a.unknown).toBeNull()
  })
})

describe('what is not known is not zero', () => {
  /* The failure this guards: an unrecorded rule reading as "nothing due" is
     exactly how a guarantee gets missed and the work lost. */
  it('refuses to answer when the department rule is unrecorded', () => {
    const a = computeAsd({
      estimatedCostPaise: CRORE, premiumPct: '-14.0000',
      rule: { thresholdPct: null, basis: 'full_differential' },
    })
    expect(a.applies).toBe(false)
    expect(a.requiredPaise).toBe(0n as Paise)
    expect(a.unknown).toMatch(/not been recorded/i)
    expect(a.unknown).toMatch(/not the same as nothing being due/i)
    /* But it still says how far below, because that much is known. */
    expect(a.belowPct).toBe(14)
    expect(a.differentialPaise).toBe(14_00_000_00n as Paise)
  })

  it('refuses to answer when no premium is recorded', () => {
    const a = computeAsd({
      estimatedCostPaise: CRORE, premiumPct: null, rule: RULE,
    })
    expect(a.unknown).toMatch(/no premium/i)
  })
})

describe('the other basis', () => {
  /* Kept because departments differ and the schema holds the rule per
     department. Only the part below the threshold. */
  it('charges only the excess below the threshold', () => {
    const a = computeAsd({
      estimatedCostPaise: CRORE, premiumPct: '-12.0000',
      rule: { thresholdPct: '10.0000', basis: 'excess_below_threshold' },
    })
    expect(a.requiredPaise).toBe(2_00_000_00n as Paise)
    expect(a.differentialPaise).toBe(12_00_000_00n as Paise)
  })
})

describe('saying it in words', () => {
  it('names the threshold and what must be furnished', () => {
    const a = computeAsd({
      estimatedCostPaise: CRORE, premiumPct: '-12.0000', rule: RULE,
    })
    const s = describeAsd(a, RULE)
    expect(s).toContain('12%')
    expect(s).toContain('10%')
    expect(s).toMatch(/whole difference/)
    expect(s).toMatch(/before the agreement/)
  })

  it('is reassuring, and specific, inside the threshold', () => {
    const a = computeAsd({
      estimatedCostPaise: CRORE, premiumPct: '-8.0000', rule: RULE,
    })
    expect(describeAsd(a, RULE)).toMatch(/inside the 10% threshold/)
  })
})
