import { describe, expect, it } from 'vitest'
import {
  BILL_STAGES, ageInStage, canTransition, checkTransition, isClosed,
  isWithDepartment, isWithUs, label, nextStages, stageHealth, stageIndex,
  type BillStatus,
} from '@/domain/billing/stages'
import type { ISODate } from '@/domain/dates'

const d = (s: string) => s as ISODate

describe('the pipeline', () => {
  it('runs draft to paid in the order the department works it', () => {
    expect([...BILL_STAGES]).toEqual([
      'draft', 'prepared', 'submitted_je', 'checked_dye', 'checked_ee',
      'passed', 'sent_treasury', 'paid',
    ])
  })

  it('walks the whole chain one step at a time', () => {
    for (let i = 0; i < BILL_STAGES.length - 1; i++) {
      expect(canTransition(BILL_STAGES[i]!, BILL_STAGES[i + 1]!)).toBe(true)
    }
  })

  it('refuses to skip a desk', () => {
    // The commonest wrong instinct: the bill "went to the EE" so mark it there.
    expect(canTransition('submitted_je', 'checked_ee')).toBe(false)
    expect(canTransition('prepared', 'passed')).toBe(false)
    expect(canTransition('draft', 'paid')).toBe(false)
  })

  it('refuses to walk backwards', () => {
    expect(canTransition('checked_ee', 'checked_dye')).toBe(false)
    expect(canTransition('paid', 'sent_treasury')).toBe(false)
  })

  it('treats paid and cancelled as the end', () => {
    expect(nextStages('paid')).toEqual([])
    expect(nextStages('cancelled')).toEqual([])
    expect(isClosed('paid')).toBe(true)
    expect(isClosed('cancelled')).toBe(true)
  })
})

describe('rejection', () => {
  it('can happen at any departmental desk', () => {
    for (const s of ['submitted_je', 'checked_dye', 'checked_ee', 'passed', 'sent_treasury'] as const) {
      expect(canTransition(s, 'rejected')).toBe(true)
    }
  })

  it('sends the bill back to prepared, not to where it was', () => {
    // The department has returned it to be redone. Resuming mid-pipeline
    // would hide the days spent correcting it. CLAUDE.md §2.
    expect(nextStages('rejected')).toEqual(['prepared', 'cancelled'])
    expect(canTransition('rejected', 'checked_dye')).toBe(false)
  })

  it('cannot reject a draft — it has never left the office', () => {
    expect(canTransition('draft', 'rejected')).toBe(false)
    expect(canTransition('prepared', 'rejected')).toBe(false)
  })
})

describe('whose desk it is on', () => {
  it('separates our delay from theirs', () => {
    expect(isWithUs('draft')).toBe(true)
    expect(isWithUs('prepared')).toBe(true)
    expect(isWithUs('rejected')).toBe(true)      // back with us to redo
    expect(isWithDepartment('submitted_je')).toBe(true)
    expect(isWithDepartment('sent_treasury')).toBe(true)
    expect(isWithDepartment('paid')).toBe(false)
    expect(isWithUs('checked_ee')).toBe(false)
  })
})

describe('aging', () => {
  it('measures from the current stage, never from when the bill was raised', () => {
    // A bill raised in April and passed in September has not been stuck 150
    // days if it reached the EE last week.
    expect(ageInStage(d('2026-08-25'), d('2026-09-03'))).toBe(9)
  })

  it('is zero when the stage date is missing', () => {
    expect(ageInStage(null, d('2026-09-03'))).toBe(0)
  })
})

describe('stage health', () => {
  const sla = 15

  it('flags a bill past the per-stage limit', () => {
    const h = stageHealth('checked_dye', d('2026-08-01'), sla, d('2026-09-03'))
    expect(h.days).toBe(33)
    expect(h.overdue).toBe(true)
    expect(h.severe).toBe(true)     // more than twice the limit
  })

  it('leaves a bill inside the limit alone', () => {
    const h = stageHealth('submitted_je', d('2026-08-28'), sla, d('2026-09-03'))
    expect(h.days).toBe(6)
    expect(h.overdue).toBe(false)
  })

  it('does not age a paid bill', () => {
    const h = stageHealth('paid', d('2026-01-01'), sla, d('2026-09-03'))
    expect(h.days).toBe(245)        // still reported
    expect(h.overdue).toBe(false)   // but it is not a delay
  })

  it('does not age our own draft', () => {
    // An unfinished draft is a to-do, not a bill the department is sitting on.
    const h = stageHealth('draft', d('2026-06-01'), sla, d('2026-09-03'))
    expect(h.overdue).toBe(false)
  })
})

describe('checkTransition', () => {
  it('allows a legal step and says what it needs', () => {
    const c = checkTransition('checked_ee', 'passed')
    expect(c.ok).toBe(true)
    expect(c.needsDate).toBe(true)
    expect(c.needsRemarks).toBe(false)
    expect(c.needsAmount).toBe(false)
  })

  it('demands a reason for a rejection', () => {
    const c = checkTransition('checked_dye', 'rejected')
    expect(c.ok).toBe(true)
    expect(c.needsRemarks).toBe(true)
  })

  it('demands the amount actually received when marking paid', () => {
    // The credit is rarely the net payable — the department deducts again at
    // treasury more often than anyone expects.
    expect(checkTransition('sent_treasury', 'paid').needsAmount).toBe(true)
  })

  it('explains a skipped desk instead of just refusing', () => {
    const c = checkTransition('submitted_je', 'passed')
    expect(c.ok).toBe(false)
    expect(c.reason).toContain('with the JE')
    expect(c.reason).toContain('with the DyE')
  })

  it('sends a correction to a paid bill down the revision route', () => {
    const c = checkTransition('paid', 'sent_treasury')
    expect(c.ok).toBe(false)
    expect(c.reason).toContain('revision')
  })

  it('rejects a no-op', () => {
    expect(checkTransition('passed', 'passed').ok).toBe(false)
  })
})

describe('stageIndex', () => {
  it('places a bill on the rail', () => {
    expect(stageIndex('draft')).toBe(0)
    expect(stageIndex('passed')).toBe(5)
    expect(stageIndex('paid')).toBe(7)
  })

  it('keeps rejected and cancelled off it', () => {
    expect(stageIndex('rejected')).toBeNull()
    expect(stageIndex('cancelled')).toBeNull()
  })
})

describe('labels', () => {
  it('names the desk, not the enum', () => {
    expect(label('submitted_je')).toBe('with the JE')
    expect(label('checked_dye')).toBe('with the DyE')
    expect(label('sent_treasury')).toBe('at treasury')
  })

  it('never leaks a raw enum value into a sentence', () => {
    // 'prepared' and 'paid' already read as English; the ones with an
    // underscore must not reach a screen as they are.
    const all: BillStatus[] = [...BILL_STAGES, 'rejected', 'cancelled']
    for (const s of all) {
      expect(label(s)).toBeTruthy()
      expect(label(s)).not.toContain('_')
    }
  })
})
