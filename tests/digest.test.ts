import { describe, expect, it } from 'vitest'
import type { ISODate } from '@/domain/dates'
import {
  SECTION_CAP, buildDigest, renderText, worthSending, type DigestItem,
} from '@/domain/notifications/digest'

const d = (s: string) => s as ISODate
const TODAY = d('2026-09-09')

const task = (
  o: Omit<Partial<DigestItem>, 'dueDate'> & { dueDate: string | null },
): DigestItem => ({
  title: 'A task', priority: 'normal', firmName: 'Sahyadri Infra',
  projectCode: null, ...o,
  dueDate: o.dueDate === null ? null : d(o.dueDate),
})

const build = (tasks: DigestItem[], expiring: any[] = []) =>
  buildDigest({ userName: 'Rajesh Phadnis', today: TODAY, tasks, expiring })

describe('what goes in which section', () => {
  it('splits by lateness, not by priority', () => {
    const digest = build([
      task({ dueDate: '2026-09-01', title: 'Late' }),
      task({ dueDate: '2026-09-09', title: 'Today' }),
      task({ dueDate: '2026-09-14', title: 'This week' }),
      task({ dueDate: '2026-10-30', title: 'Far off' }),
    ])
    expect(digest.sections.map((s) => s.key)).toEqual(['overdue', 'today', 'week'])
    // Something six weeks away is not news at seven in the morning.
    expect(renderText(digest, '#')).not.toContain('Far off')
  })

  it('leaves undated work out entirely', () => {
    /* A task with no date is not urgent by omission. Putting it in "today"
       because null sorts low is how a digest starts lying. */
    expect(build([task({ dueDate: null, title: 'Someday' })]).total).toBe(0)
  })

  it('puts escalations at the top of the overdue block and says so', () => {
    const digest = build([
      task({ dueDate: '2026-09-08', title: 'Merely late' }),
      task({ dueDate: '2026-06-01', title: 'Ignored', escalated: true }),
    ])
    const overdue = digest.sections.find((s) => s.key === 'overdue')!
    expect(overdue.items[0]).toContain('Ignored')
    expect(overdue.items[0]).toContain('escalated to you')
    expect(overdue.items[1]).not.toContain('escalated')
  })

  it('counts the days late from the due date', () => {
    const digest = build([task({ dueDate: '2026-09-02', title: 'x' })])
    expect(digest.sections[0]!.items[0]).toContain('(7 days late)')
  })
})

describe('the cap', () => {
  it('shows a handful and says how many were left', () => {
    /* Forty lines is a wall nobody reads to the bottom of. Eight and a count
       is a prompt to open the system, which is where the work happens. */
    const many = Array.from({ length: 40 }, (_, i) =>
      task({ dueDate: '2026-09-01', title: `Task ${i}` }))
    const overdue = build(many).sections[0]!
    expect(overdue.items).toHaveLength(SECTION_CAP)
    expect(overdue.more).toBe(40 - SECTION_CAP)
    expect(renderText(build(many), '#')).toContain(`...and ${40 - SECTION_CAP} more`)
  })

  it('still counts everything, so the subject is not capped too', () => {
    const many = Array.from({ length: 40 }, () => task({ dueDate: '2026-09-01' }))
    expect(build(many).total).toBe(40)
    expect(build(many).subject).toBe('40 overdue')
  })
})

describe('the subject line', () => {
  it('leads with what is wrong', () => {
    expect(build([
      task({ dueDate: '2026-09-01' }), task({ dueDate: '2026-09-09' }),
    ]).subject).toBe('1 overdue, 1 due today')
  })

  it('falls back to what is due, then to what is coming', () => {
    expect(build([task({ dueDate: '2026-09-09' })]).subject).toBe('1 due today')
    expect(build([task({ dueDate: '2026-09-12' })]).subject).toBe('1 coming up')
  })
})

describe('when nothing is sent', () => {
  it('says nothing rather than saying nothing is wrong', () => {
    /* A daily mail that sometimes reads "no items" teaches people to filter
       the sender — and then the one that mattered lands in the same folder. */
    expect(worthSending(build([]))).toBe(false)
    expect(worthSending(build([task({ dueDate: null })]))).toBe(false)
  })

  it('sends as soon as there is one real thing', () => {
    expect(worthSending(build([task({ dueDate: '2026-09-09' })]))).toBe(true)
    expect(worthSending(build([], [
      { label: 'Bank guarantee X', on: d('2026-09-20'), firmName: 'Sahyadri Infra' },
    ]))).toBe(true)
  })
})

describe('the rendered mail', () => {
  it('greets by first name and links back', () => {
    const text = renderText(build([task({ dueDate: '2026-09-09' })]), 'https://ops.example/dashboard')
    expect(text.startsWith('Good morning, Rajesh.')).toBe(true)
    expect(text).toContain('https://ops.example/dashboard')
  })
})
