import { describe, expect, it } from 'vitest'
import { paise, type Paise } from '@/domain/money'
import {
  netArrangement, payerName,
  type ArrangementInput, type ArrangementTerms,
} from '@/domain/cashflow/arrangement'

/**
 * The two seeded arrangement works, which are real shapes: SIPL/2026/ARR/011
 * executed for Krishna Constructions at 4%, and SIPL/2026/ARR/012 executed
 * by Yashoda Buildcon at 4%. Both 2nd RA bills are outstanding.
 *
 * The figures below are the ones in the database, not invented: a ₹41.2 lakh
 * work value billing ₹48,61,600 with GST, and ₹30.2 lakh billing ₹33,82,400.
 */

const inward: ArrangementTerms = {
  model: 'executed_for_other',
  counterpartyName: 'Krishna Constructions, Miraj',
  commissionPct: '4.0000',
  commissionFixedPaise: null,
  basis: 'gross_bill',
}

const outward: ArrangementTerms = {
  ...inward,
  model: 'executed_by_other',
  counterpartyName: 'Yashoda Buildcon',
}

/** ARR/011 2nd RA: ₹48,61,600 payable on ₹41,20,000 of work. */
const ARR011_NET = paise(48_61_600_00n)
const ARR011_GROSS = paise(41_20_000_00n)
/** ARR/012 2nd RA: ₹33,82,400 payable on ₹30,20,000 of work. */
const ARR012_NET = paise(33_82_400_00n)
const ARR012_GROSS = paise(30_20_000_00n)

const bill = (over: Partial<ArrangementInput> = {}): ArrangementInput => ({
  netPayablePaise: ARR011_NET,
  grossPaise: ARR011_GROSS,
  agreedCommissionPaise: null,
  terms: inward,
  ...over,
})

describe('our own work', () => {
  it('is untouched', () => {
    const n = netArrangement(bill({
      netPayablePaise: ARR011_NET, grossPaise: ARR011_GROSS,
      terms: { ...inward, model: 'own' },
    }))
    expect(n.inflowPaise).toBe(ARR011_NET)
    expect(n.payer).toBe('department')
    expect(n.outflowPaise).toBe(0n as Paise)
    expect(n.commissionPaise).toBe(0n as Paise)
    expect(n.unresolved).toBeNull()
  })
})

describe('executed for another contractor — inward', () => {
  const n = netArrangement(bill({
    netPayablePaise: ARR011_NET, grossPaise: ARR011_GROSS, terms: inward,
  }))

  /* 4% of the WORK VALUE, not of the bill. Nobody takes a percentage of GST —
     it is collected for the government and passed on. */
  it('charges the commission on the work value, not on the bill', () => {
    expect(n.commissionPaise).toBe(1_64_800_00n as Paise)
    expect(n.commissionPaise).not.toBe(1_94_464_00n as Paise) // 4% of the bill
  })

  it('reduces what reaches the bank by exactly that', () => {
    expect(n.inflowPaise).toBe(46_96_800_00n as Paise)
    expect(n.inflowPaise + n.commissionPaise).toBe(ARR011_NET)
  })

  it('changes who pays — this is chased from the contract holder', () => {
    expect(n.payer).toBe('counterparty')
    expect(payerName(n, inward, 'Zilla Parishad Sangli'))
      .toBe('Krishna Constructions, Miraj')
  })

  it('creates no payment out — we were never holding their money', () => {
    expect(n.outflowPaise).toBe(0n as Paise)
  })

  it('marks the figure as computed until a settlement is recorded', () => {
    expect(n.estimated).toBe(true)
  })
})

describe('executed by another contractor — outward', () => {
  const n = netArrangement(bill({
    netPayablePaise: ARR012_NET, grossPaise: ARR012_GROSS, terms: outward,
  }))

  /* The dangerous one. The inflow was always right, which is why nothing
     looked wrong — the money that leaves again was simply absent. */
  it('keeps the full inflow, from the department', () => {
    expect(n.inflowPaise).toBe(ARR012_NET)
    expect(n.payer).toBe('department')
  })

  it('pays everything but our commission straight back out', () => {
    expect(n.commissionPaise).toBe(1_20_800_00n as Paise)
    expect(n.outflowPaise).toBe(32_61_600_00n as Paise)
  })

  it('leaves us exactly the commission', () => {
    expect(n.inflowPaise - n.outflowPaise).toBe(n.commissionPaise)
  })
})

describe('an agreed settlement beats the rate', () => {
  /* Same reason a department's deduction beats the statutory rate: a 4%
     understanding gets renegotiated, and the books follow what was agreed. */
  it('uses the settled figure and stops calling it an estimate', () => {
    const n = netArrangement(bill({
      netPayablePaise: ARR011_NET, grossPaise: ARR011_GROSS,
      agreedCommissionPaise: paise(2_00_000_00n), terms: inward,
    }))
    expect(n.commissionPaise).toBe(2_00_000_00n as Paise)
    expect(n.inflowPaise).toBe(46_61_600_00n as Paise)
    expect(n.estimated).toBe(false)
  })

  it('honours an agreed zero rather than falling back to the percentage', () => {
    const n = netArrangement(bill({
      netPayablePaise: ARR011_NET, grossPaise: ARR011_GROSS,
      agreedCommissionPaise: paise(0n), terms: inward,
    }))
    expect(n.commissionPaise).toBe(0n as Paise)
    expect(n.inflowPaise).toBe(ARR011_NET)
  })
})

describe('terms that cannot produce a per-bill figure', () => {
  /* A flat sum for the whole work charged against every bill triples it on a
     three-bill project. Refusing to guess is the only honest answer. */
  it('leaves a fixed commission unresolved and nets nothing', () => {
    const n = netArrangement(bill({
      netPayablePaise: ARR011_NET, grossPaise: ARR011_GROSS,
      terms: { ...inward, basis: 'fixed', commissionPct: null,
               commissionFixedPaise: paise(5_00_000_00n) },
    }))
    expect(n.unresolved).toMatch(/fixed commission/i)
    expect(n.inflowPaise).toBe(ARR011_NET)
    expect(n.commissionPaise).toBe(0n as Paise)
  })

  /* The payer is still wrong even when the amount cannot be fixed, and saying
     so costs nothing. */
  it('still corrects who pays on an unresolved inward work', () => {
    const n = netArrangement(bill({
      netPayablePaise: ARR011_NET, grossPaise: ARR011_GROSS,
      terms: { ...inward, basis: 'fixed', commissionPct: null,
               commissionFixedPaise: paise(5_00_000_00n) },
    }))
    expect(n.payer).toBe('counterparty')
  })

  it('says so when no rate is recorded at all', () => {
    const n = netArrangement(bill({
      netPayablePaise: ARR011_NET, grossPaise: ARR011_GROSS,
      terms: { ...inward, commissionPct: null, basis: null },
    }))
    expect(n.unresolved).toMatch(/no commission rate/i)
    expect(n.inflowPaise).toBe(ARR011_NET)
  })
})

describe('net_received is the basis that genuinely differs', () => {
  it('takes the percentage off the bill rather than the work value', () => {
    const n = netArrangement(bill({
      netPayablePaise: ARR011_NET, grossPaise: ARR011_GROSS,
      terms: { ...inward, basis: 'net_received' },
    }))
    expect(n.commissionPaise).toBe(1_94_464_00n as Paise)
  })

  it('work_value and gross_bill agree, because the allocation is proportional', () => {
    const g = netArrangement(bill({
      netPayablePaise: ARR011_NET, grossPaise: ARR011_GROSS,
      terms: { ...inward, basis: 'gross_bill' },
    }))
    const w = netArrangement(bill({
      netPayablePaise: ARR011_NET, grossPaise: ARR011_GROSS,
      terms: { ...inward, basis: 'work_value' },
    }))
    expect(w.commissionPaise).toBe(g.commissionPaise)
  })
})

describe('bad data is clamped and flagged, never absorbed', () => {
  /* A rate typed as 40 instead of 4, or a settlement against the wrong bill.
     A negative receipt in a forecast reads as a demand for money. */
  it('never nets an inflow below zero', () => {
    const n = netArrangement(bill({
      netPayablePaise: ARR011_NET, grossPaise: ARR011_GROSS,
      agreedCommissionPaise: paise(90_00_000_00n), terms: inward,
    }))
    expect(n.inflowPaise).toBe(0n as Paise)
    expect(n.commissionPaise).toBe(ARR011_NET)
    expect(n.unresolved).toMatch(/larger than the bill/i)
  })

  it('never projects a pass-through larger than what came in', () => {
    const n = netArrangement(bill({
      netPayablePaise: ARR012_NET, grossPaise: ARR012_GROSS,
      agreedCommissionPaise: paise(90_00_000_00n), terms: outward,
    }))
    expect(n.outflowPaise).toBe(0n as Paise)
    expect(n.inflowPaise).toBe(ARR012_NET)
  })
})
