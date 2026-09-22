import { describe, expect, it } from 'vitest'
import {
  EXPECTED_PAN_TYPE, checkCin, checkGstin, checkIfsc, checkPan, checkPincode,
  checkTan, gstinCheckDigit, normaliseId, panFromGstin, panHolderType,
} from '@/domain/firms/identifiers'

/**
 * A wrong identifier is not caught by anything downstream — it surfaces months
 * later as a rejected return or a TDS credit that never appears. The check
 * digit is the part that earns its keep, so it is pinned against GSTINs known
 * to be real.
 */

describe('PAN', () => {
  it('accepts the firms actually on the system', () => {
    expect(checkPan('DEMCA1234K').ok).toBe(true)   // Sahyadri Infra Projects Pvt Ltd
    expect(checkPan('DEMAP5678N').ok).toBe(true)   // Shivneri society
    expect(checkPan('DEMPP4321N').ok).toBe(true)   // an individual licence
  })

  it('tolerates how a certificate is typed', () => {
    expect(checkPan('  demca1234k ').ok).toBe(true)
    expect(normaliseId(' 27-demca 1234k ')).toBe('27DEMCA1234K')
  })

  it('rejects a wrong shape', () => {
    expect(checkPan('DEMC1234K').ok).toBe(false)     // nine characters
    expect(checkPan('DEMCA1234').ok).toBe(false)     // no trailing letter
    expect(checkPan('DEMCA123AK').ok).toBe(false)    // letter among the digits
  })

  it('rejects an impossible holder type', () => {
    // The fourth character is the holder type; 'X' is not one.
    const r = checkPan('DEMXA1234K')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('fourth position')
  })

  it('reads the holder type, which is how a mismatched PAN gets caught', () => {
    expect(panHolderType('DEMCA1234K')).toBe('company')
    expect(panHolderType('DEMPP4321N')).toBe('individual')
    expect(panHolderType('DEMAP5678N')).toBe('association of persons')
  })

  it('knows what each entity type should carry', () => {
    // A society's PAN reading 'company' means the wrong certificate was typed.
    expect(EXPECTED_PAN_TYPE.private_limited).toBe('C')
    expect(EXPECTED_PAN_TYPE.labour_society).toBe('A')
    expect(EXPECTED_PAN_TYPE.individual_licence).toBe('P')
  })
})

describe('GSTIN check digit', () => {
  it('reproduces the digit on real GSTINs', () => {
    expect(gstinCheckDigit('27DEMFU8765F1Z')).toBe('7')
    expect(gstinCheckDigit('29DEMCB9012J1Z')).toBe('1')
    expect(gstinCheckDigit('27DEMCA1234K1Z')).toBe('C')   // Sahyadri Infra
  })

  it('catches a transposition, which a format check never would', () => {
    // 2814 typed as 2841 — right shape, wrong number.
    expect(checkGstin('27DEMCA1243K1ZC').ok).toBe(false)
    expect(checkGstin('27DEMCA1243K1ZC').reason).toContain('check digit')
  })

  it('catches a single wrong character', () => {
    expect(checkGstin('27DEMCA1234K1ZD').ok).toBe(false)
  })
})

describe('GSTIN', () => {
  it('accepts a correct one', () => {
    expect(checkGstin('27DEMCA1234K1ZC').ok).toBe(true)
  })

  it('rejects a wrong length or shape', () => {
    expect(checkGstin('27DEMCA1234K1Z').ok).toBe(false)      // fourteen
    expect(checkGstin('27DEMCA1234K1AC').ok).toBe(false)     // no Z in place 14
  })

  it('rejects an impossible state code', () => {
    const r = checkGstin('99DEMCA1234K1ZC')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('state code')
  })

  it('refuses a GSTIN that does not carry the firm’s own PAN', () => {
    // The commonest real error: a GSTIN pasted from another firm's letterhead.
    const r = checkGstin('27DEMFU8765F1Z7', 'DEMCA1234K')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('DEMFU8765F')
  })

  it('agrees when the PAN does match', () => {
    expect(checkGstin('27DEMCA1234K1ZC', 'DEMCA1234K').ok).toBe(true)
  })

  it('extracts the PAN so entering one fills the other', () => {
    expect(panFromGstin('27DEMCA1234K1ZC')).toBe('DEMCA1234K')
    expect(panFromGstin('27ABBCA')).toBeNull()
  })
})

describe('TAN', () => {
  it('accepts the right shape and rejects the rest', () => {
    expect(checkTan('PNEA12345B').ok).toBe(true)
    expect(checkTan('PNE12345B').ok).toBe(false)
    expect(checkTan('PNEA1234SB').ok).toBe(false)
  })
})

describe('IFSC', () => {
  it('accepts a real one', () => {
    expect(checkIfsc('SBIN0004321').ok).toBe(true)
    expect(checkIfsc('BARB0JATHXX').ok).toBe(true)
  })

  it('insists on the zero in the fifth place', () => {
    // The character people get wrong, because it looks like a letter O.
    const r = checkIfsc('SBINO004321')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('zero')
  })
})

describe('pincode', () => {
  it('accepts Jath and rejects nonsense', () => {
    expect(checkPincode('416404').ok).toBe(true)
    expect(checkPincode('41640').ok).toBe(false)
    expect(checkPincode('016404').ok).toBe(false)   // cannot start with zero
  })
})

describe('CIN', () => {
  it('accepts a private limited CIN', () => {
    expect(checkCin('U45200MH2015PTC123456').ok).toBe(true)
  })

  it('rejects a wrong shape', () => {
    expect(checkCin('45200MH2015PTC123456').ok).toBe(false)
    expect(checkCin('U45200MH2015PTC12345').ok).toBe(false)
  })
})
