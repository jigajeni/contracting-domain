import { describe, expect, it } from 'vitest'
import { paise, type Paise } from '@/domain/money'
import { computeVariance, totalVariance } from '@/domain/billing/variance'

/**
 * The Ankale concrete item is the standing example: ZP allows cement concrete
 * at ₹126 per cum below the schedule where SCADA is not used on the batching
 * plant, and that difference is invisible in any total that only looks at
 * quantities.
 */
const base = {
  boqItemId: 'b1', itemNo: '4', description: 'M-25 cement concrete',
  unit: 'cum',
  tenderedQty: '100.000',
  executedQty: '100.000',
  boqRatePaise: paise(6_500_00n),      // ₹6,500 per cum
  allowedRatePaise: paise(6_500_00n),
}

describe('an item executed exactly as tendered at the scheduled rate', () => {
  const v = computeVariance(base)
  it('has no variance of any kind', () => {
    expect(v.variancePaise).toBe(0n as Paise)
    expect(v.quantityVariancePaise).toBe(0n as Paise)
    expect(v.rateVariancePaise).toBe(0n as Paise)
    expect(v.driver).toBe('none')
  })
})

describe('the SCADA deduction', () => {
  /* Same quantity, ₹126 per cum less. A quantity-only view sees nothing. */
  const v = computeVariance({
    ...base, allowedRatePaise: paise(6_374_00n),
  })

  it('is entirely a rate variance', () => {
    expect(v.rateVariancePaise).toBe(-12_600_00n as Paise)
    expect(v.quantityVariancePaise).toBe(0n as Paise)
    expect(v.driver).toBe('rate')
  })

  it('shows as money lost against the schedule', () => {
    expect(v.estimatePaise).toBe(6_50_000_00n as Paise)
    expect(v.earnedPaise).toBe(6_37_400_00n as Paise)
    expect(v.variancePaise).toBe(-12_600_00n as Paise)
  })
})

describe('doing more work than tendered', () => {
  const v = computeVariance({ ...base, executedQty: '130.000' })

  it('is entirely a quantity variance', () => {
    expect(v.quantityVariancePaise).toBe(1_95_000_00n as Paise)
    expect(v.rateVariancePaise).toBe(0n as Paise)
    expect(v.driver).toBe('quantity')
  })

  it('reports the deviation as a quantity and a percentage', () => {
    expect(v.deviationQty).toBe('30')
    expect(v.deviationPct).toBe('30')
  })

  /* Worth a look, NOT a breach. The contract's permitted deviation applies to
     the statement as a whole — an item at +40% inside a statement netting +3%
     breaches nothing, and calling it a breach sends somebody to the department
     for an approval they do not need. */
  it('flags an item that moved more than the notice threshold', () => {
    expect(computeVariance({
      ...base, executedQty: '130.000', noticeThresholdPct: '25',
    }).largeDeviation).toBe(true)
    expect(computeVariance({
      ...base, executedQty: '120.000', noticeThresholdPct: '25',
    }).largeDeviation).toBe(false)
  })

  it('flags a saving past the limit too — it is still a deviation', () => {
    expect(computeVariance({
      ...base, executedQty: '60.000', noticeThresholdPct: '25',
    }).largeDeviation).toBe(true)
  })
})

describe('both at once', () => {
  const v = computeVariance({
    ...base, executedQty: '130.000', allowedRatePaise: paise(6_374_00n),
  })

  /* The identity the whole module rests on: QaRa − QeRe expands to
     (Qa−Qe)Re + Qa(Ra−Re) with nothing left over. A decomposition whose parts
     do not sum to the whole is worse than none — somebody reconciles it for an
     afternoon and finds nothing. */
  it('splits exactly, with nothing left over', () => {
    expect(v.quantityVariancePaise + v.rateVariancePaise).toBe(v.variancePaise)
  })

  it('names the quantity as the driver when it is more than twice the rate', () => {
    expect(v.quantityVariancePaise).toBe(1_95_000_00n as Paise)
    expect(v.rateVariancePaise).toBe(-16_380_00n as Paise)
    expect(v.driver).toBe('quantity')
  })

  it('says "both" rather than forcing a winner when they are close', () => {
    const close = computeVariance({
      ...base, executedQty: '102.000', allowedRatePaise: paise(6_374_00n),
    })
    expect(close.driver).toBe('both')
  })
})

describe('the identity holds on awkward numbers', () => {
  it('survives thirds of a cum and odd rates', () => {
    const v = computeVariance({
      ...base,
      tenderedQty: '33.333', executedQty: '41.667',
      boqRatePaise: paise(7_777_77n), allowedRatePaise: paise(6_666_66n),
    })
    expect(v.quantityVariancePaise + v.rateVariancePaise).toBe(v.variancePaise)
    expect(v.earnedPaise - v.estimatePaise).toBe(v.variancePaise)
  })
})

describe('an extra item', () => {
  const v = computeVariance({
    ...base, tenderedQty: '0', executedQty: '18.500', isExtra: true,
  })

  it('has no deviation percentage, because there is nothing to divide by', () => {
    expect(v.deviationPct).toBeNull()
    expect(v.largeDeviation).toBe(false)
  })

  it('is all quantity variance against a nil estimate', () => {
    expect(v.estimatePaise).toBe(0n as Paise)
    expect(v.quantityVariancePaise).toBe(1_20_250_00n as Paise)
  })
})

describe('totals', () => {
  it('adds the halves and counts what needs attention', () => {
    const lines = [
      computeVariance({ ...base, allowedRatePaise: paise(6_374_00n) }),
      computeVariance({ ...base, executedQty: '130.000',
                        noticeThresholdPct: '25' }),
      computeVariance(base),
    ]
    const t = totalVariance(lines)
    expect(t.items).toBe(3)
    expect(t.losingItems).toBe(1)
    expect(t.largeDeviations).toBe(1)
    expect(t.quantityVariancePaise + t.rateVariancePaise).toBe(t.variancePaise)
  })
})

describe('the statement-level limit, which is the one that matters', () => {
  /* The contract's permitted deviation applies to the schedule as a whole.
     Individual items swinging in both directions can each look alarming while
     the statement nets to almost nothing, and that statement needs no
     approval at all. */
  it('nets opposing item movements out', () => {
    const rate = paise(1_000_00n)
    const t = totalVariance([
      computeVariance({ ...base, boqRatePaise: rate, allowedRatePaise: rate,
                        tenderedQty: '100', executedQty: '140',
                        noticeThresholdPct: '25' }),
      computeVariance({ ...base, boqItemId: 'b2', boqRatePaise: rate,
                        allowedRatePaise: rate,
                        tenderedQty: '100', executedQty: '62',
                        noticeThresholdPct: '25' }),
    ])
    /* Both items moved far enough to be worth a look. */
    expect(t.largeDeviations).toBe(2)
    /* The statement itself moved 1%, and needs nothing. */
    expect(t.netDeviationPct).toBe(1)
  })

  it('has no net percentage where the schedule priced nothing', () => {
    const t = totalVariance([
      computeVariance({ ...base, tenderedQty: '0', executedQty: '5',
                        isExtra: true }),
    ])
    expect(t.netDeviationPct).toBeNull()
  })
})

describe('a work still in progress', () => {
  /* Caught by looking at the real Ankale road rather than at the tests. It is
     43% billed, and treating every unreached item as a −100% deviation made
     the page report the schedule as having "moved −56.1%". A road at sub-base
     stage has not deviated; it is unfinished. Every work in progress would
     have looked like a catastrophe, and a number that always screams is a
     number nobody reads — which is how a real deviation slips past. */
  const rate = paise(1_000_00n)
  const started = computeVariance({
    ...base, boqRatePaise: rate, allowedRatePaise: rate,
    tenderedQty: '100', executedQty: '98', noticeThresholdPct: '25',
  })
  const untouched = computeVariance({
    ...base, boqItemId: 'b2', boqRatePaise: rate, allowedRatePaise: rate,
    tenderedQty: '900', executedQty: '0', noticeThresholdPct: '25',
  })

  it('marks an untouched item as not started, not as a deviation', () => {
    expect(untouched.notStarted).toBe(true)
    expect(untouched.largeDeviation).toBe(false)
    expect(started.notStarted).toBe(false)
  })

  it('leaves it out of the net, which reads the started work honestly', () => {
    const t = totalVariance([started, untouched])
    expect(t.netDeviationPct).toBe(-2)
    /* Including it would have given −90.2%, which is not a fact about the
       schedule — it is a fact about the calendar. */
    expect(t.netDeviationPct).not.toBe(-90.2)
  })

  it('reports what is untouched rather than hiding it', () => {
    const t = totalVariance([started, untouched])
    expect(t.notStarted).toBe(1)
    expect(t.notStartedPaise).toBe(9_00_000_00n as Paise)
  })

  /* A work that really did finish under its quantities still shows it: the
     item was started, so it counts. */
  it('still counts a genuine saving on a started item', () => {
    const saving = computeVariance({
      ...base, boqRatePaise: rate, allowedRatePaise: rate,
      tenderedQty: '100', executedQty: '60', noticeThresholdPct: '25',
    })
    expect(saving.notStarted).toBe(false)
    expect(saving.largeDeviation).toBe(true)
    expect(totalVariance([saving]).netDeviationPct).toBe(-40)
  })
})
