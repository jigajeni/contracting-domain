/**
 * Which registers can be downloaded, and what they are called.
 *
 * Here rather than beside the queries because a `'use server'` file may only
 * export async functions — a plain constant in one makes the whole route
 * fail to compile, which is how this list ended up on its own.
 *
 * The order is the order they are offered in: what somebody is most likely to
 * want first.
 */
export const REGISTERS = [
  { key: 'works', label: 'Works' },
  { key: 'bills', label: 'RA bills' },
  { key: 'tenders', label: 'Tenders' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'delays', label: 'Delays' },
] as const

export type RegisterKey = (typeof REGISTERS)[number]['key']
