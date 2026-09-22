import { describe, it, expect } from 'vitest'
import { ZERO, paise } from '@/domain/money'
import {
  QTY_ZERO, blocking, formatQty, lineStatus, lineValue, matchBill, orderState,
  priceReceipt, qty, type OrderLine, type ReceiptLine,
} from '@/domain/procurement/order'

const GSB = 'm-gsb'
const CEMENT = 'm-cem'

const line = (over: Partial<OrderLine> = {}): OrderLine => ({
  materialId: GSB, materialName: 'Granular Sub Base', unit: 'cum',
  orderedQty: qty('400'), ratePaise: paise(92000), receivedQty: QTY_ZERO,
  ...over,
})

describe('quantities', () => {
  it('keeps three decimals exactly, with no float anywhere', () => {
    expect(qty('412.375')).toBe(412375n)
    expect(formatQty(qty('412.375'))).toBe('412.375')
    expect(formatQty(qty('1200'))).toBe('1,200')
    expect(formatQty(qty('0.5'))).toBe('0.5')
  })

  it('refuses something that is not a quantity', () => {
    expect(() => qty('12.3456')).toThrow()
    expect(() => qty('lots')).toThrow()
  })

  it('multiplies by a rate and rounds half up to the paise', () => {
    // 412.375 cum at ₹920.00 = ₹379,385.00
    expect(lineValue(qty('412.375'), paise(92000))).toBe(paise(37938500))
    // 0.333 at ₹1.00 rounds up rather than truncating a paisa away
    expect(lineValue(qty('0.333'), paise(100))).toBe(paise(33))
  })
})

describe('where a line stands', () => {
  it('is pending before anything arrives', () => {
    expect(lineStatus(line()).state).toBe('pending')
  })

  it('counts what is still to come', () => {
    const s = lineStatus(line({ receivedQty: qty('280') }))
    expect(s.state).toBe('part')
    expect(formatQty(s.outstandingQty)).toBe('120')
    expect(s.note).toContain('120 cum still to come')
  })

  it('is complete when the order is met exactly', () => {
    const s = lineStatus(line({ receivedQty: qty('400') }))
    expect(s.state).toBe('complete')
    expect(s.note).toBeNull()
  })

  it('treats over-delivery as a state, not an error', () => {
    // A tipper carries what it carries. Nothing is blocked — but the excess
    // is what they will bill for, so it has to be visible beforehand.
    const s = lineStatus(line({ receivedQty: qty('412') }))
    expect(s.state).toBe('over')
    expect(formatQty(s.excessQty)).toBe('12')
    expect(s.outstandingQty).toBe(QTY_ZERO)
    expect(s.note).toContain('agree it now rather than at payment')
  })
})

describe('the order as a whole', () => {
  it('is read from its lines, never from a stored status', () => {
    expect(orderState([line()], true)).toBe('issued')
    expect(orderState([line({ receivedQty: qty('400') })], true)).toBe('received')
    expect(orderState([line({ receivedQty: qty('412') })], true)).toBe('received')
    expect(orderState([line({ receivedQty: qty('100') }), line()], true))
      .toBe('partly_received')
  })

  it('stays draft until it is issued, whatever the lines say', () => {
    expect(orderState([line({ receivedQty: qty('400') })], false)).toBe('draft')
  })
})

describe('pricing a delivery', () => {
  const receipt = (over: Partial<ReceiptLine> = {}): ReceiptLine => ({
    materialId: GSB, materialName: 'Granular Sub Base', unit: 'cum',
    receivedQty: qty('400'), acceptedQty: qty('400'), ratePaise: paise(92000),
    ...over,
  })

  it('prices the ACCEPTED quantity, never what was sent', () => {
    // The easiest error here: their challan says what they sent, not what we
    // kept, and paying off it pays for material that went back on the lorry.
    const p = priceReceipt({
      lines: [receipt({ receivedQty: qty('400'), acceptedQty: qty('385') })],
      orderedRates: new Map(), gstPct: '18',
    })
    expect(p.basicPaise).toBe(paise(35420000))   // 385 × ₹920
    expect(p.problems.some((x) => x.message.includes('rejected'))).toBe(true)
  })

  it('adds GST, and treats none as ordinary rather than missing', () => {
    const withGst = priceReceipt({
      lines: [receipt()], orderedRates: new Map(), gstPct: '18' })
    expect(withGst.gstPaise).toBe(paise(6624000))
    expect(withGst.totalPaise).toBe(paise(43424000))

    // A kachha bill from an unregistered dealer carries no GST at all.
    const none = priceReceipt({
      lines: [receipt()], orderedRates: new Map(), gstPct: '0' })
    expect(none.gstPaise).toBe(ZERO)
    expect(none.problems.filter((x) => x.kind === 'blocking')).toEqual([])
  })

  it('reports a rate that has moved without correcting it', () => {
    const p = priceReceipt({
      lines: [receipt({ ratePaise: paise(105000) })],
      orderedRates: new Map([[GSB, paise(92000)]]), gstPct: '18',
    })
    expect(p.lines[0]!.varianceRatePaise).toBe(paise(13000))
    expect(p.lines[0]!.variancePct).toBeCloseTo(14.13, 1)
    // The rate stands. It is their current one more often than not.
    expect(p.lines[0]!.valuePaise).toBe(paise(42000000))
    expect(p.problems.some((x) => x.message.includes('above the ordered rate'))).toBe(true)
  })

  it('stays quiet about a small rate move', () => {
    const p = priceReceipt({
      lines: [receipt({ ratePaise: paise(95000) })],
      orderedRates: new Map([[GSB, paise(92000)]]), gstPct: '18',
    })
    expect(p.problems.some((x) => x.message.includes('ordered rate'))).toBe(false)
  })

  it('says when a delivery is still unpriced rather than valuing it at zero', () => {
    const p = priceReceipt({
      lines: [receipt({ ratePaise: ZERO })], orderedRates: new Map(), gstPct: '18' })
    expect(p.basicPaise).toBe(ZERO)
    expect(p.problems.some((x) => x.message.includes("nobody's figures"))).toBe(true)
  })

  it('blocks accepting more than arrived', () => {
    const p = priceReceipt({
      lines: [receipt({ receivedQty: qty('400'), acceptedQty: qty('420') })],
      orderedRates: new Map(), gstPct: '18',
    })
    expect(blocking(p.problems)[0]!.message).toContain('more accepted than was received')
  })
})

describe('their bill against what site took in', () => {
  const names = new Map([
    [GSB, { name: 'Granular Sub Base', unit: 'cum' }],
    [CEMENT, { name: 'OPC 53 Cement', unit: 'bag' }],
  ])

  it('agrees when the quantities and the money both agree', () => {
    const m = matchBill({
      billedQty: new Map([[GSB, qty('400')]]), billedTotalPaise: paise(36800000),
      acceptedQty: new Map([[GSB, qty('400')]]), ourTotalPaise: paise(36800000),
      names,
    })
    expect(m.agrees).toBe(true)
    expect(m.mismatches).toEqual([])
  })

  it('names the material and both figures, not just a total', () => {
    // "₹11,040 apart" is not a phone call. "They billed 412 and we took 400" is.
    const m = matchBill({
      billedQty: new Map([[GSB, qty('412')]]), billedTotalPaise: paise(37904000),
      acceptedQty: new Map([[GSB, qty('400')]]), ourTotalPaise: paise(36800000),
      names,
    })
    expect(m.agrees).toBe(false)
    expect(m.mismatches[0]!.message)
      .toContain('billed 412 cum, site accepted 400')
    expect(formatQty(m.mismatches[0]!.differenceQty)).toBe('12')
  })

  it('catches a material billed with no receipt at all', () => {
    const m = matchBill({
      billedQty: new Map([[GSB, qty('400')], [CEMENT, qty('100')]]),
      billedTotalPaise: paise(40000000),
      acceptedQty: new Map([[GSB, qty('400')]]), ourTotalPaise: paise(36800000),
      names,
    })
    expect(m.mismatches[0]!.message).toContain('no receipt at site at all')
  })

  it('calls a pure money gap a rate difference, in either direction', () => {
    const over = matchBill({
      billedQty: new Map([[GSB, qty('400')]]), billedTotalPaise: paise(38000000),
      acceptedQty: new Map([[GSB, qty('400')]]), ourTotalPaise: paise(36800000),
      names,
    })
    expect(over.summary).toContain('their total is higher')
    expect(over.differencePaise).toBe(paise(1200000))

    const under = matchBill({
      billedQty: new Map([[GSB, qty('400')]]), billedTotalPaise: paise(36000000),
      acceptedQty: new Map([[GSB, qty('400')]]), ourTotalPaise: paise(36800000),
      names,
    })
    // Worth checking too: a credit we have not taken is still our money.
    expect(under.summary).toContain('in our favour')
  })
})
