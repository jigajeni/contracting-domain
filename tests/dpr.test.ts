import { describe, it, expect } from 'vitest'
import { isoDate } from '@/domain/dates'
import { paise, ZERO } from '@/domain/money'
import {
  BACKDATE_LIMIT_DAYS, checkDate, delaySuggestion, dieselAmount, isStopped,
  lineAmount, manDaysByParty, totalHeadcount, totalLabourCost, validate,
  type DprInput, type LabourLine,
} from '@/domain/site/dpr'

const d = (s: string) => isoDate(s)
const TODAY = d('2026-09-15')

const gang = (over: Partial<LabourLine> = {}): LabourLine => ({
  partyId: 'p1', trade: 'mason', headcount: 4, wageRatePaise: paise(70000), ...over,
})

const report = (over: Partial<DprInput> = {}): DprInput => ({
  reportDate: TODAY, weather: 'clear', workDoneSummary: 'CC road, ch 2/100 to 2/260',
  labour: [gang()], ...over,
})

describe('which day a report may be for', () => {
  it('refuses tomorrow', () => {
    const c = checkDate(d('2026-09-16'), TODAY)
    expect(c.verdict).toBe('future')
    expect(c.accepted).toBe(false)
  })

  it('accepts today and yesterday without comment', () => {
    expect(checkDate(TODAY, TODAY).verdict).toBe('today')
    expect(checkDate(d('2026-09-14'), TODAY).message).toBeNull()
  })

  it('accepts a report older than the limit but marks it late', () => {
    const c = checkDate(d('2026-09-01'), TODAY)
    expect(c.verdict).toBe('late')
    expect(c.daysLate).toBe(14)
    // Accepted deliberately: a late record beats none.
    expect(c.accepted).toBe(true)
    expect(c.message).toContain('14 days old')
  })

  it('draws the line exactly at the limit, not one day either side', () => {
    const edge = d('2026-09-08') // 7 days back
    expect(checkDate(edge, TODAY).daysLate).toBe(BACKDATE_LIMIT_DAYS)
    expect(checkDate(edge, TODAY).verdict).toBe('backdated')
    expect(checkDate(d('2026-09-07'), TODAY).verdict).toBe('late')
  })

  it('refuses a day before the work started', () => {
    const c = checkDate(d('2026-06-01'), TODAY, d('2026-07-01'))
    expect(c.verdict).toBe('before_start')
    expect(c.accepted).toBe(false)
  })
})

describe('labour', () => {
  it('multiplies headcount by rate', () => {
    expect(lineAmount(gang())).toBe(paise(280000))
  })

  it('sums the day', () => {
    const lines = [gang(), gang({ trade: 'helper', headcount: 6, wageRatePaise: paise(50000) })]
    expect(totalHeadcount(lines)).toBe(10)
    expect(totalLabourCost(lines)).toBe(paise(580000))
  })

  it('pools man-days by the gang that supplied them', () => {
    const m = manDaysByParty([
      gang({ partyId: 'a', headcount: 4 }),
      gang({ partyId: 'a', trade: 'helper', headcount: 6 }),
      gang({ partyId: 'b', headcount: 3 }),
    ])
    expect(m.get('a')).toBe(10)
    expect(m.get('b')).toBe(3)
  })

  it('drops man-days with nobody to allocate them to, rather than pooling them', () => {
    // A blank key would make the allocation sum to the payment and still be wrong.
    const m = manDaysByParty([gang({ partyId: null, headcount: 5 }), gang({ partyId: 'a' })])
    expect([...m.keys()]).toEqual(['a'])
    expect([...m.values()].reduce((a, b) => a + b, 0)).toBe(4)
  })
})

describe('diesel', () => {
  it('rounds half up on litres to the paise', () => {
    // 12.50 L at ₹94.37 = ₹1,179.625 → 117963 paise
    expect(dieselAmount('12.50', paise(9437))).toBe(paise(117963))
  })

  it('is zero when nothing was drawn', () => {
    expect(dieselAmount('0', paise(9437))).toBe(ZERO)
  })
})

describe('the stopped day', () => {
  it('is nobody on site and nothing written', () => {
    expect(isStopped(report({ labour: [], workDoneSummary: '' }))).toBe(true)
    expect(isStopped(report({ labour: [] }))).toBe(false)
    expect(isStopped(report({ workDoneSummary: '' }))).toBe(false)
  })

  it('offers a forgiven day when rain stopped it', () => {
    const s = delaySuggestion(report({ labour: [], workDoneSummary: '', weather: 'heavy_rain' }))
    expect(s.suggest).toBe(true)
    expect(s.attribution).toBe('neutral')
    expect(s.cause).toBe('rain_monsoon')
    expect(s.title).toContain('rainfall')
  })

  it('does not offer one for rain on a day work carried on', () => {
    expect(delaySuggestion(report({ weather: 'heavy_rain' })).suggest).toBe(false)
  })

  it('asks for a cause on an empty day with no weather, and never invents one', () => {
    const s = delaySuggestion(report({ labour: [], workDoneSummary: '', weather: null }))
    expect(s.suggest).toBe(true)
    // Never invents the reason — only the person who was there knows it.
    expect(s.title).toBe('')
  })

  it('treats light rain as a working day', () => {
    expect(delaySuggestion(report({ labour: [], workDoneSummary: '', weather: 'light_rain' }))
      .attribution).toBe('department')
  })
})

describe('what is wrong with the report', () => {
  const messages = (d: DprInput) => validate(d).map((p) => p.message).join(' | ')

  it('passes a plain working day', () => {
    expect(validate(report())).toEqual([])
  })

  it('never blocks on anything a person at a site could not fix', () => {
    const problems = validate(report({ labour: [gang({ partyId: null })], workDoneSummary: '' }))
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.every((p) => p.severity === 'warning')).toBe(true)
  })

  it('blocks a headcount that is not a whole number of people', () => {
    const problems = validate(report({ labour: [gang({ headcount: 2.5 })] }))
    expect(problems.some((p) => p.severity === 'blocking')).toBe(true)
  })

  it('warns when man-days have no gang to be allocated to', () => {
    expect(messages(report({ labour: [gang({ partyId: null })] })))
      .toContain('cannot be allocated')
  })

  it('warns on work with nobody on site, and on labour with no work', () => {
    expect(messages(report({ labour: [] }))).toContain('nobody on site')
    expect(messages(report({ workDoneSummary: '' }))).toContain('no work written down')
  })

  it('warns on an empty day with no reason at all, but not when one is given', () => {
    const empty = report({ labour: [], workDoneSummary: '', weather: null })
    expect(messages(empty)).toContain('liquidated')
    expect(messages({ ...empty, weather: 'heavy_rain' })).not.toContain('liquidated')
    expect(messages({ ...empty, issueTitle: 'Land not handed over' })).not.toContain('liquidated')
  })
})
