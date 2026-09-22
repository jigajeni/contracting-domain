import { describe, it, expect } from 'vitest'
import { ZERO, paise } from '@/domain/money'
import {
  NOT_A_CONTEST, WON, byClient, premiumBands, premiumSummary, winRate,
  type Bid, type Result,
} from '@/domain/tender/analysis'

let n = 0
const bid = (result: Result, premiumPct: number | null,
             over: Partial<Bid> = {}): Bid => ({
  id: `b${n += 1}`, result, premiumPct,
  estimatedCostPaise: paise(50_00_000_00),
  quotedValuePaise: paise(46_00_000_00),
  clientId: 'zp', clientName: 'Zilla Parishad Sangli',
  firmId: 'f1', fyLabel: 'FY 2026-27', ...over,
})

describe('what counts as a contest', () => {
  it('counts only bids that were judged against other bidders', () => {
    const r = winRate([
      bid('l1', -8), bid('lost', -4), bid('l2', -6),
      bid('cancelled', -8), bid('submitted', null), bid('technical_rejected', -9),
    ])
    expect(r.contested).toBe(3)
    expect(r.won).toBe(1)
    expect(r.excluded).toBe(3)
    expect(r.ratePct).toBeCloseTo(33.3, 1)
  })

  it('leaves a cancelled notice out, or the rate measures the department', () => {
    // A cancelled tender was never decided. Counting it makes the win rate a
    // measure of how often departments cancel things.
    expect(NOT_A_CONTEST.has('cancelled')).toBe(true)
    expect(NOT_A_CONTEST.has('retendered')).toBe(true)
    expect(NOT_A_CONTEST.has('technical_rejected')).toBe(true)
  })

  it('treats L1 as won, because L1 normally becomes the award', () => {
    expect(WON.has('l1')).toBe(true)
    expect(WON.has('awarded')).toBe(true)
    expect(WON.has('l2')).toBe(false)
  })

  it('reports no rate at all rather than nought per cent', () => {
    // "0%" against nothing decided reads as a firm that never wins.
    const r = winRate([bid('submitted', null), bid('cancelled', -5)])
    expect(r.ratePct).toBeNull()
    expect(r.contested).toBe(0)
  })

  it('adds up what was won and what was contested', () => {
    const r = winRate([
      bid('l1', -8, { quotedValuePaise: paise(40_00_000_00) }),
      bid('lost', -4, { quotedValuePaise: paise(60_00_000_00) }),
    ])
    expect(r.valueWonPaise).toBe(paise(40_00_000_00))
    expect(r.valueContestedPaise).toBe(paise(1_00_00_000_00))
  })
})

describe('where the line is', () => {
  it('bands against the ASD rule, not round numbers', () => {
    const bands = premiumBands([
      bid('l1', -3), bid('lost', -4),
      bid('l1', -7), bid('l1', -8), bid('lost', -9),
      bid('l1', -14), bid('lost', -12),
    ])
    expect(bands.map((b) => b.bids)).toEqual([2, 3, 2])
    expect(bands[0]!.ratePct).toBeCloseTo(50, 0)
    expect(bands[1]!.ratePct).toBeCloseTo(66.7, 1)
    expect(bands[2]!.ratePct).toBeCloseTo(50, 0)
  })

  it('puts a bid at exactly 10% below in the middle band, not the ASD one', () => {
    // The rule is strictly more than 10%. A bid at exactly 10% owes nothing.
    const bands = premiumBands([bid('l1', -10)])
    expect(bands[1]!.bids).toBe(1)
    expect(bands[2]!.bids).toBe(0)
  })

  it('reports an empty band as unknown rather than nought', () => {
    const bands = premiumBands([bid('l1', -3)])
    expect(bands[2]!.bids).toBe(0)
    expect(bands[2]!.ratePct).toBeNull()
  })

  it('leaves out bids above the estimate rather than giving them a band', () => {
    const bands = premiumBands([bid('l1', 4), bid('l1', -3)])
    expect(bands.reduce((a, b) => a + b.bids, 0)).toBe(1)
  })
})

describe('what a win costs', () => {
  it('measures the gap between the average bid and the winning one', () => {
    const s = premiumSummary([
      bid('l1', -10), bid('l1', -12), bid('lost', -4), bid('lost', -6),
    ])
    expect(s.averagePct).toBeCloseTo(-8, 5)
    expect(s.winningAveragePct).toBeCloseTo(-11, 5)
    // Winning bids were three points cheaper than our average bid.
    expect(s.costOfWinningPct).toBeCloseTo(3, 5)
  })

  it('says nothing when nothing has been decided', () => {
    const s = premiumSummary([bid('submitted', null)])
    expect(s.averagePct).toBeNull()
    expect(s.costOfWinningPct).toBeNull()
  })

  it('reports a near-zero gap, which means price is not deciding these', () => {
    const s = premiumSummary([bid('l1', -8), bid('lost', -8)])
    expect(s.costOfWinningPct).toBeCloseTo(0, 5)
  })

  it('counts the decided bids that owe an additional security deposit', () => {
    const s = premiumSummary([
      bid('l1', -14), bid('lost', -11), bid('l1', -10), bid('l1', -3),
      bid('cancelled', -20),
    ])
    // Strictly more than 10, and the cancelled one was never a contest.
    expect(s.asdTriggering).toBe(2)
  })
})

describe('by department', () => {
  it('splits the rate per department, biggest first', () => {
    const rows = byClient([
      bid('l1', -8, { clientId: 'zp', clientName: 'ZP Sangli' }),
      bid('lost', -4, { clientId: 'zp', clientName: 'ZP Sangli' }),
      bid('l1', -6, { clientId: 'zp', clientName: 'ZP Sangli' }),
      bid('lost', -5, { clientId: 'pwd', clientName: 'PWD Jath' }),
    ])
    expect(rows[0]!.clientId).toBe('zp')
    expect(rows[0]!.bids).toBe(3)
    expect(rows[0]!.ratePct).toBeCloseTo(66.7, 1)
    expect(rows[1]!.ratePct).toBe(0)
  })

  it('keeps a department with one bid, and shows the count beside the rate', () => {
    // One bid is a real fact in a firm this size — but 100% off a sample of
    // one has to be readable as such.
    const rows = byClient([bid('l1', -8, { clientId: 'mjp', clientName: 'MJP' })])
    expect(rows[0]!.bids).toBe(1)
    expect(rows[0]!.ratePct).toBe(100)
  })

  it('drops a bid with no department rather than pooling it', () => {
    const rows = byClient([bid('l1', -8, { clientId: null, clientName: null })])
    expect(rows).toEqual([])
  })
})
