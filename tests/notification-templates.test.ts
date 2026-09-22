import { describe, expect, it } from 'vitest'
import { compose, INBOX_DAYS } from '@/domain/notifications/templates'

/**
 * What an inbox is allowed to say.
 *
 * These are short because the rule they enforce is short: a notification
 * describes something that happened, at a moment, once. The temptation is to
 * restate the task list — "you have eleven critical items" — which is true
 * every day and therefore worth reading on none of them.
 */

describe('an escalated task', () => {
  it('says who it is now on and why', () => {
    const c = compose('TASK_ESCALATED', {
      taskTitle: 'GSTR-3B — monthly summary return — Jul-2026',
      daysOverdue: 20, firmName: 'Sahyadri Infra',
    })
    expect(c.subject).toBe('Escalated to you: GSTR-3B — monthly summary return — Jul-2026')
    expect(c.body).toBe('20 days overdue and nobody has acted on it. Sahyadri Infra')
  })

  it('does not claim an overdue count it does not have', () => {
    /* A task can escalate without a due date having passed — the rule's own
       patience is measured from when it was raised. "0 days overdue" would be
       a small lie and the sort that erodes trust in the whole inbox. */
    const c = compose('TASK_ESCALATED', { taskTitle: 'Renew the DSC', daysOverdue: null })
    expect(c.body).toBe('Nobody has acted on it since it was raised.')
    expect(c.body).not.toContain('0 days')
  })

  it('names the work when there is one, and stays quiet when there is not', () => {
    const withWork = compose('TASK_ESCALATED', {
      taskTitle: 'x', daysOverdue: 3, firmName: 'Sahyadri Infra', projectCode: 'SIPL/2026/ZP/002',
    })
    expect(withWork.body).toContain('Sahyadri Infra · SIPL/2026/ZP/002')

    const firmOnly = compose('TASK_ESCALATED', {
      taskTitle: 'x', daysOverdue: 3, firmName: 'Shivneri Sanstha',
    })
    // No trailing separator where the project would have been.
    expect(firmOnly.body).toBe('3 days overdue and nobody has acted on it. Shivneri Sanstha')
  })
})

describe('a bill changing stage', () => {
  it('reads as a sentence, not as enum values', () => {
    const c = compose('BILL_STAGE_CHANGED', {
      billNo: 2, fromStage: 'submitted_je', toStage: 'checked_dye',
      actorName: 'Rajesh Phadnis', projectCode: 'SIPL/2026/PWD/001', amount: '₹1.38 Cr',
    })
    expect(c.subject).toBe('Bill #2 moved to checked dye')
    expect(c.body).toBe('From submitted je. Moved by Rajesh Phadnis. SIPL/2026/PWD/001 · ₹1.38 Cr')
  })

  it('copes with a first transition, where there is no previous stage', () => {
    const c = compose('BILL_STAGE_CHANGED', { billNo: 1, toStage: 'prepared' })
    expect(c.subject).toBe('Bill #1 moved to prepared')
    expect(c.body).toBe('')
  })
})

describe('the inbox window', () => {
  it('is a month, so a fortnight away is not a fortnight of reading', () => {
    expect(INBOX_DAYS).toBe(30)
  })
})
