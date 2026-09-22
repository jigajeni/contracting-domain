import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseMahatendersBoq, reconcile } from '@/domain/boq/mahatenders'
import { paise, formatINR, type Paise } from '@/domain/money'

/**
 * Tested against the actual Ankale BOQ downloaded from Mahatenders — the
 * veterinary dispensary at Ankale, e-tender 2025_SANGL_1140037_1. The point of
 * an importer is that it agrees with the work order, so that is what is
 * asserted rather than a row count.
 */
const rows: string[][] = JSON.parse(
  readFileSync('tests/fixtures/boq-ankale.json', 'utf8'),
)

describe('reading a Mahatenders percentage BOQ', () => {
  const boq = parseMahatendersBoq(rows)

  it('picks up the header block', () => {
    expect(boq.workName).toMatch(/VETERANARY DISPENSARY/i)
    expect(boq.workName).toMatch(/Ankale/i)
    expect(boq.tenderInvitingAuthority).toMatch(/Zilla Parishad Sangli/i)
    expect(boq.bidderName).toBe('Sahyadri Infra Projects Pvt Ltd')
    expect(boq.boqType).toBe('Percentage')
  })

  it('reads every priced item and no template noise', () => {
    expect(boq.items).toHaveLength(77)
    expect(boq.warnings).toEqual([])
  })

  it('reads the first and last item correctly', () => {
    const first = boq.items[0]!
    expect(first.slNo).toBe('1')
    expect(first.description).toMatch(/^Excavation for foundation in earth/)
    expect(first.quantity).toBe('66.64')
    expect(first.unit).toBe('Cubic Metre')
    expect(formatINR(first.ratePaise)).toBe('₹207')
    expect(formatINR(first.amountPaise)).toBe('₹13,794.48')

    const last = boq.items[76]!
    expect(last.slNo).toBe('77')
    expect(last.description).toMatch(/wire fencing/i)
  })

  it('totals to the amount put to tender', () => {
    // Each item's amount is rounded to the paisa because that is what the
    // column stores, so the total is the sum of stored items — ₹.90 — where
    // the exact product sum is ₹.89. Both round to the work order's
    // ₹63,28,492, and the stored figure is the one the system must agree with.
    expect(formatINR(boq.totalPaise)).toBe('₹63,28,491.90')
    const advertised = paise(632_849_200)
    const drift = boq.totalPaise - advertised
    expect(drift < 100n && drift > -100n).toBe(true)   // inside one rupee
  })

  it('strips the "per" that the portal prefixes to every unit', () => {
    for (const item of boq.items) expect(item.unit).not.toMatch(/^per\s/i)
  })
})

describe('reconciling against the work order', () => {
  const boq = parseMahatendersBoq(rows)

  it('agrees with both the advertised and the accepted figure', () => {
    const r = reconcile(boq, {
      advertisedPaise: paise(632_849_200),   // ₹63,28,492
      acceptedPaise: paise(631_267_100),     // ₹63,12,671
      premiumPct: '-0.25',                   // 0.25% below
    })
    expect(r.matches).toBe(true)
    expect(Number(r.advertisedDiffPaise)).toBeLessThanOrEqual(100)
    expect(Number(r.acceptedDiffPaise)).toBeLessThanOrEqual(100)
  })

  it('refuses to match a work order the file does not belong to', () => {
    const r = reconcile(boq, { advertisedPaise: paise(500_000_000) })
    expect(r.matches).toBe(false)
    // The importer must surface this rather than importing a mismatched BOQ.
    expect(formatINR(r.advertisedDiffPaise!)).toBe('₹13,28,491.90')
  })
})

describe('rejecting files that are not a BOQ', () => {
  it('explains itself rather than importing nothing', () => {
    expect(() => parseMahatendersBoq([['Invoice'], ['Date', '01-04-2026']]))
      .toThrow(/does not look like a Mahatenders BOQ/i)
  })

  it('reports a BOQ with no priced rows', () => {
    const headerOnly = rows.slice(0, 12)
    expect(() => parseMahatendersBoq(headerOnly)).toThrow(/No priced items/i)
  })
})
