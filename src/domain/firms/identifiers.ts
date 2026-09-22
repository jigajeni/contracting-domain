/**
 * Statutory identifiers.
 *
 * These are typed once, off a certificate, and then flow into every bill,
 * every TDS entry and eventually a Tally export. A transposed digit in a
 * GSTIN is not caught by anything downstream — it surfaces months later as a
 * rejected return. All of them carry a check that a format regex alone does
 * not, so they are worth validating properly at the point of entry.
 *
 * Pure. No database, no framework.
 */

export interface Check {
  ok: boolean
  /** What is wrong, in words the person typing can act on. */
  reason?: string
}

const ok: Check = { ok: true }
const bad = (reason: string): Check => ({ ok: false, reason })

/** Uppercase, strip spaces and hyphens. Certificates print them inconsistently. */
export const normaliseId = (s: string): string =>
  s.trim().toUpperCase().replace(/[\s-]/g, '')

// ---------------------------------------------------------------------------
// PAN
// ---------------------------------------------------------------------------

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/

/**
 * The fourth character encodes the holder type, and getting it wrong usually
 * means the PAN belongs to something other than what was claimed — an
 * individual's PAN entered against the Pvt Ltd, most often.
 */
export const PAN_HOLDER_TYPE: Record<string, string> = {
  C: 'company', P: 'individual', H: 'Hindu undivided family', F: 'partnership firm',
  A: 'association of persons', T: 'trust', B: 'body of individuals',
  L: 'local authority', J: 'artificial juridical person', G: 'government',
}

export function checkPan(raw: string): Check {
  const pan = normaliseId(raw)
  if (!pan) return bad('Enter the PAN.')
  if (pan.length !== 10) return bad('A PAN is ten characters — five letters, four digits, one letter.')
  if (!PAN_RE.test(pan)) return bad('That is not a PAN. The pattern is AAAAA9999A.')
  if (!PAN_HOLDER_TYPE[pan[3]!]) {
    return bad(`"${pan[3]}" is not a valid holder type in the fourth position.`)
  }
  return ok
}

export const panHolderType = (raw: string): string | null =>
  PAN_HOLDER_TYPE[normaliseId(raw)[3] ?? ''] ?? null

/**
 * The holder type a given entity type should carry. Used to warn, never to
 * block — a proprietorship legitimately bids on the proprietor's own PAN.
 */
export const EXPECTED_PAN_TYPE: Record<string, string> = {
  private_limited: 'C',
  labour_society: 'A',
  partnership: 'F',
  llp: 'F',
  proprietorship: 'P',
  individual_licence: 'P',
  joint_venture: 'A',
}

// ---------------------------------------------------------------------------
// GSTIN
// ---------------------------------------------------------------------------

const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * The GSTIN check digit. Base-36, alternating weights of 1 and 2, summing the
 * quotient and remainder of each product. This is what catches a transposed
 * pair of characters, which a regex never will.
 */
export function gstinCheckDigit(first14: string): string {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_ALPHABET.indexOf(first14[i]!)
    if (value === -1) return ''
    const product = value * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(product / 36) + (product % 36)
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36]!
}

/** Maharashtra. Every firm here is registered in 27 unless it registers elsewhere. */
export const MAHARASHTRA_STATE_CODE = '27'

export function checkGstin(raw: string, pan?: string): Check {
  const gstin = normaliseId(raw)
  if (!gstin) return bad('Enter the GSTIN.')
  if (gstin.length !== 15) return bad('A GSTIN is fifteen characters.')
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/.test(gstin)) {
    return bad('That is not a GSTIN. The pattern is 99AAAAA9999A9Z9.')
  }

  const state = Number(gstin.slice(0, 2))
  if (state < 1 || state > 38) return bad(`"${gstin.slice(0, 2)}" is not a state code.`)

  const expected = gstinCheckDigit(gstin.slice(0, 14))
  if (gstin[14] !== expected) {
    return bad(
      'That GSTIN fails its own check digit — a character is wrong or two are ' +
      'swapped. Read it off the certificate again.',
    )
  }

  // Characters 3–12 are the holder's PAN. If both are on screen they must agree.
  if (pan) {
    const p = normaliseId(pan)
    if (p.length === 10 && gstin.slice(2, 12) !== p) {
      return bad(`This GSTIN carries PAN ${gstin.slice(2, 12)}, not ${p}.`)
    }
  }
  return ok
}

/** The PAN embedded in a GSTIN, so entering one can fill the other. */
export const panFromGstin = (raw: string): string | null => {
  const g = normaliseId(raw)
  return g.length === 15 ? g.slice(2, 12) : null
}

// ---------------------------------------------------------------------------
// TAN, IFSC, pincode
// ---------------------------------------------------------------------------

/** Required to deduct TDS. Without it the firm cannot file a 26Q. */
export function checkTan(raw: string): Check {
  const tan = normaliseId(raw)
  if (!tan) return bad('Enter the TAN.')
  if (!/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(tan)) {
    return bad('That is not a TAN. The pattern is AAAA99999A.')
  }
  return ok
}

export function checkIfsc(raw: string): Check {
  const ifsc = normaliseId(raw)
  if (!ifsc) return bad('Enter the IFSC.')
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
    // The fifth character is always zero, and it is the one people get wrong.
    return bad('That is not an IFSC. Four letters, then a zero, then six characters.')
  }
  return ok
}

export function checkPincode(raw: string): Check {
  const pin = normaliseId(raw)
  if (!/^[1-9][0-9]{5}$/.test(pin)) return bad('A pincode is six digits.')
  return ok
}

/**
 * CIN — only a company has one, and only a Pvt Ltd among our firms.
 * 21 characters: listing status, industry code, state, year, ownership, number.
 */
export function checkCin(raw: string): Check {
  const cin = normaliseId(raw)
  if (!cin) return bad('Enter the CIN.')
  if (!/^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/.test(cin)) {
    return bad('That is not a CIN. The pattern is U99999XX9999XXX999999.')
  }
  return ok
}
