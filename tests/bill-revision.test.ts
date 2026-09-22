import { describe, expect, it } from 'vitest'
import {
  diffBill, isFrozen, isMaterial, revisionRequired, summarise,
  type BillSnapshot,
} from '@/domain/billing/revision'
import { BILL_STAGES, type BillStatus } from '@/domain/billing/stages'

/**
 * A passed bill is a document the department is holding. Corrections happen —
 * ours has to keep matching theirs — but never silently, because the
 * difference between what we billed and what they passed is the only evidence
 * anyone has when the payment comes up short. CLAUDE.md §2.
 */

const snap = (o: Partial<BillSnapshot> = {}): BillSnapshot => ({
  linesTotalPaise: '1000000',
  limitedTotalPaise: null,
  workValuePaise: '1000000',
  gstBasePaise: '1000000',
  cgstPaise: '90000',
  sgstPaise: '90000',
  igstPaise: '0',
  additionsPaise: '0',
  deductionBasePaise: '1000000',
  cumulativeTotalPaise: '1180000',
  previousPaise: '0',
  payablePaise: '1180000',
  totalDeductionsPaise: '50000',
  netPayablePaise: '1130000',
  quantities: { '1': '10', '2': '5.5' },
  deductions: { IT_TDS: '20000', SD: '30000' },
  ...o,
})

describe('when a revision is required', () => {
  it('is required once the bill has left the office', () => {
    expect(revisionRequired('passed')).toBe(true)
    expect(revisionRequired('sent_treasury')).toBe(true)
    expect(revisionRequired('paid')).toBe(true)
  })

  it('is not required while the bill is still a working document', () => {
    expect(revisionRequired('draft')).toBe(false)
    expect(revisionRequired('prepared')).toBe(false)
    expect(revisionRequired('submitted_je')).toBe(false)
    expect(revisionRequired('checked_dye')).toBe(false)
    expect(revisionRequired('checked_ee')).toBe(false)
  })

  it('is not required on a rejected bill — redoing it is the point', () => {
    expect(revisionRequired('rejected')).toBe(false)
  })

  it('covers every stage from passed onwards, and none before', () => {
    // Pinned against the pipeline itself, so adding a stage cannot silently
    // fall outside the rule.
    const at = (s: string) => BILL_STAGES.indexOf(s as any)
    for (const s of BILL_STAGES) {
      expect(revisionRequired(s)).toBe(at(s) >= at('passed'))
    }
  })

  it('freezes a cancelled bill entirely', () => {
    expect(isFrozen('cancelled')).toBe(true)
    expect(isFrozen('paid')).toBe(false)
  })
})

describe('what changed', () => {
  it('says nothing when nothing moved', () => {
    const d = diffBill(snap(), snap())
    expect(d).toHaveLength(0)
    expect(isMaterial(d)).toBe(false)
    expect(summarise(d)).toBe('No figures changed.')
  })

  it('ignores a change that is not one of the figures', () => {
    // Remarks and period dates are housekeeping, not a revision.
    const d = diffBill(snap(), { ...snap(), ...({ remarks: 'new note' } as any) })
    expect(d).toHaveLength(0)
  })

  it('reports a money change with its direction', () => {
    const d = diffBill(snap(), snap({ netPayablePaise: '1030000' }))
    expect(d).toHaveLength(1)
    expect(d[0]!.label).toBe('Net payable')
    expect(d[0]!.before).toBe('₹11,300')
    expect(d[0]!.after).toBe('₹10,300')
    expect(d[0]!.deltaPaise).toBe(-100000n)
  })

  it('leads on the net payable, because that is what gets asked about', () => {
    const d = diffBill(snap(), snap({
      workValuePaise: '900000', netPayablePaise: '1030000',
    }))
    expect(summarise(d)).toBe('Net payable down ₹1,000 — ₹11,300 to ₹10,300')
  })

  it('catches a quantity moved between items when the totals still match', () => {
    // The bill totals the same and the department still notices.
    const d = diffBill(snap(), snap({ quantities: { '1': '8', '2': '7.5' } }))
    expect(d.map((c) => c.label)).toEqual(['Item 1 quantity', 'Item 2 quantity'])
    expect(d[0]!.kind).toBe('quantity')
    expect(summarise(d)).toBe('2 figures changed, net payable unchanged.')
  })

  it('does not report a quantity that only changed how it was written', () => {
    // 5.5 and 5.500 are the same measurement.
    const d = diffBill(snap(), snap({ quantities: { '1': '10', '2': '5.500' } }))
    expect(d).toHaveLength(0)
  })

  it('reports an item that appears or disappears', () => {
    const d = diffBill(snap(), snap({ quantities: { '1': '10', '2': '5.5', '3': '2' } }))
    expect(d).toHaveLength(1)
    expect(d[0]!.label).toBe('Item 3 quantity')
    expect(d[0]!.before).toBe('0')
  })

  it('reports a deduction the department applied differently', () => {
    const d = diffBill(snap(), snap({
      deductions: { IT_TDS: '18000', SD: '30000' },
      totalDeductionsPaise: '48000',
      netPayablePaise: '1132000',
    }))
    const labels = d.map((c) => c.label)
    expect(labels).toContain('IT_TDS deduction')
    expect(labels).toContain('Total deductions')
    expect(labels).toContain('Net payable')
  })

  it('handles a cap being applied where there was none', () => {
    const d = diffBill(snap(), snap({ limitedTotalPaise: '950000' }))
    expect(d).toHaveLength(1)
    expect(d[0]!.label).toBe('Limited to')
    expect(d[0]!.before).toBe('₹0')
    expect(d[0]!.after).toBe('₹9,500')
  })

  it('sorts quantities by item so a long diff reads in bill order', () => {
    const before = snap({ quantities: { '1': '1', '2': '1', '10': '1' } })
    const after = snap({ quantities: { '1': '2', '2': '2', '10': '2' } })
    expect(diffBill(before, after).map((c) => c.label))
      .toEqual(['Item 1 quantity', 'Item 10 quantity', 'Item 2 quantity'])
  })
})
