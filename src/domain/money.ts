/**
 * Money. Integer paise, always. Never float, never rupees in the database.
 * CLAUDE.md §0.1
 *
 * The only place rupees exist is the presentation layer, and only on the way out.
 */

/** Paise. A branded bigint so a plain number can never be passed by accident. */
export type Paise = bigint & { readonly __brand: 'Paise' }

export const paise = (n: bigint | number | string): Paise => {
  if (typeof n === 'bigint') return n as Paise
  if (typeof n === 'string') return BigInt(n) as Paise
  if (!Number.isInteger(n)) throw new RangeError(`paise must be a whole number, got ${n}`)
  return BigInt(n) as Paise
}

export const ZERO = paise(0)

/** ₹1,234.56 entered as a decimal string → 123456 paise. No floating point. */
export function rupeesToPaise(input: string | number): Paise {
  const s = String(input).trim().replace(/[₹,\s]/g, '')
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new RangeError(`not a rupee amount: ${input}`)
  const neg = s.startsWith('-')
  const [whole = '0', frac = ''] = (neg ? s.slice(1) : s).split('.')
  const v = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'))
  return (neg ? -v : v) as Paise
}

export const add = (...xs: Paise[]): Paise => xs.reduce((a, b) => a + b, 0n) as Paise
export const sub = (a: Paise, b: Paise): Paise => (a - b) as Paise
export const neg = (a: Paise): Paise => -a as Paise
export const isNegative = (a: Paise): boolean => a < 0n

/**
 * Percentage of an amount, in paise, rounded half-up on the absolute value so
 * that -x behaves as the mirror of +x. Percentages are numeric(7,4) in the
 * database, so they arrive as strings like "2.0000".
 */
export function pctOf(amount: Paise, pct: string | number): Paise {
  const scaled = BigInt(Math.round(Number(pct) * 10_000)) // 4 dp → integer
  const neg = amount < 0n
  const abs = neg ? -amount : amount
  const num = abs * scaled
  const den = 1_000_000n // 100 * 10^4
  const q = num / den
  const r = num % den
  const rounded = r * 2n >= den ? q + 1n : q
  return (neg ? -rounded : rounded) as Paise
}

/** quantity (3 dp, as a string from numeric(18,3)) × rate in paise → paise. */
export function qtyTimesRate(qty: string | number, ratePaise: Paise): Paise {
  const q = BigInt(Math.round(Number(qty) * 1000))
  const neg = q < 0n !== ratePaise < 0n
  const num = (q < 0n ? -q : q) * (ratePaise < 0n ? -ratePaise : ratePaise)
  const den = 1000n
  const quo = num / den
  const rem = num % den
  const rounded = rem * 2n >= den ? quo + 1n : quo
  return (neg ? -rounded : rounded) as Paise
}

/** Round paise to whole rupees — departments bill in whole rupees. */
export function roundToRupee(a: Paise): Paise {
  const neg = a < 0n
  const abs = neg ? -a : a
  const r = abs % 100n
  const up = r >= 50n ? abs - r + 100n : abs - r
  return (neg ? -up : up) as Paise
}

/**
 * Indian numbering: last three digits, then groups of two.
 * 125500000 paise → "12,55,000.00"
 */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits
  const last3 = digits.slice(-3)
  const rest = digits.slice(0, -3)
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3
}

export interface FormatOptions {
  /** Show the ₹ symbol. Default true. */
  symbol?: boolean
  /** Show paise. Default false — bills are in whole rupees. */
  paise?: boolean
}

/** 4520495000n → "₹4,52,04,950" */
export function formatINR(amount: Paise | bigint, opts: FormatOptions = {}): string {
  const { symbol = true, paise: showPaise = false } = opts
  const neg = amount < 0n
  const abs = neg ? -amount : amount
  const whole = abs / 100n
  const frac = abs % 100n
  let out = groupIndian(whole.toString())
  if (showPaise || frac !== 0n) out += '.' + frac.toString().padStart(2, '0')
  return `${neg ? '-' : ''}${symbol ? '₹' : ''}${out}`
}

/**
 * Compact form for dashboard tiles: "₹4.52 Cr", "₹12.55 L", "₹8,400".
 * The exact value belongs in a tooltip beside it — never only this.
 */
export function formatINRCompact(amount: Paise | bigint): string {
  const neg = amount < 0n
  const abs = neg ? -amount : amount
  const rupees = abs / 100n
  const sign = neg ? '-' : ''
  if (rupees >= 10_000_000n) return `${sign}₹${scaledTo2dp(abs, 1_000_000_000n)} Cr`
  if (rupees >= 100_000n) return `${sign}₹${scaledTo2dp(abs, 10_000_000n)} L`
  return `${sign}₹${groupIndian(rupees.toString())}`
}

/** "150.00 L" style capacity label used on registration screens. */
export function formatLakh(amount: Paise | bigint): string {
  const neg = amount < 0n
  const abs = neg ? -amount : amount
  return `${neg ? '-' : ''}${scaledTo2dp(abs, 10_000_000n)} L`
}

/**
 * Two decimal places of `paiseAmount / unitInPaise`, rounded half up in bigint.
 *
 * Doing this with Number().toFixed(2) silently rounds ₹1,25,50,000 down to
 * "1.25 Cr", because 1.255 is not representable in binary floating point.
 * CLAUDE.md §6 documents that figure as ₹1.26 Cr, and a dashboard that
 * disagrees with the spec by a lakh is not a dashboard anyone trusts.
 */
function scaledTo2dp(paiseAmount: bigint, unitInPaise: bigint): string {
  const den = unitInPaise / 100n // scale so the quotient carries 2 decimals
  const q = paiseAmount / den
  const r = paiseAmount % den
  const rounded = r * 2n >= den ? q + 1n : q
  const whole = rounded / 100n
  const frac = rounded % 100n
  return `${groupIndian(whole.toString())}.${frac.toString().padStart(2, '0')}`
}
