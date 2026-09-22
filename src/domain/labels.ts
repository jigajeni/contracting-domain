/**
 * Turning a database code into something a person reads.
 *
 * `contractors_all_risk` is a perfectly good enum value and a poor sentence.
 * The generic underscore-strip gets most of the way, but the names people
 * actually use are not derivable — nobody says "contractors all risk".
 *
 * Shared because the alert titles and the digest were solving it separately,
 * and one of them was going to drift.
 */

const NAMES: Record<string, string> = {
  contractors_all_risk: 'Contractors’ All Risk',
  workmen_compensation: 'Workmen’s Compensation',
  third_party: 'Third party',
  professional_indemnity: 'Professional indemnity',
  bank_guarantee: 'Bank guarantee',
  performance_bg: 'Performance BG',
  advance_bg: 'Advance BG',
  emd_bg: 'EMD BG',
  contractor_registration: 'Contractor registration',
  labour_licence: 'Labour licence',
  bocw_registration: 'BOCW registration',
  epf_registration: 'EPF registration',
  esic_registration: 'ESIC registration',
  shop_establishment: 'Shop & establishment',
  msme_udyam: 'MSME Udyam',
  society_registration: 'Society registration',
}

export function label(code: string | null | undefined): string {
  if (!code) return ''
  if (NAMES[code]) return NAMES[code]!
  const plain = code.replace(/_/g, ' ').replace(/\bbg\b/i, 'BG')
  return plain.charAt(0).toUpperCase() + plain.slice(1)
}
