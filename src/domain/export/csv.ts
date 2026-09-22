/**
 * CSV, because it is boring and it opens.
 *
 * Excel and PDF writers are both a dependency, and CLAUDE.md §5 keeps that
 * list short on purpose. A CSV opens in Excel, in LibreOffice, in Tally's
 * import, in a text editor when something has gone wrong, and it will still
 * open in ten years on a machine nobody has thought about yet. A PDF of a
 * register is a screen print, and the browser already makes those.
 *
 * Pure. CLAUDE.md §5.
 */

export interface Column<T> {
  header: string
  value: (row: T) => string | number | null | undefined
}

/**
 * One field, quoted the way a spreadsheet expects.
 *
 * Two traps, both of which corrupt data silently rather than erroring:
 *
 * **A leading `=`, `+`, `-` or `@` is a formula to Excel**, and opening a
 * register that contains `-8%` as a premium runs it as arithmetic. Prefixed
 * with a tab so the cell stays text and still reads correctly.
 *
 * **A work code like `SIPL/2026/PWD/001` survives; a long number does not.**
 * Nothing here can stop Excel turning a 16-digit account number into
 * scientific notation, so reference numbers are written with the same tab
 * guard rather than left bare.
 */
export function field(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (s === '') return ''
  const risky = /^[=+\-@\t\r]/.test(s) || /^\d{12,}$/.test(s)
  const body = risky ? `\t${s}` : s
  return /[",\n\r\t]/.test(body) ? `"${body.replace(/"/g, '""')}"` : body
}

export function toCsv<T>(columns: Column<T>[], rows: T[]): string {
  const lines = [columns.map((c) => field(c.header)).join(',')]
  for (const row of rows) {
    lines.push(columns.map((c) => field(c.value(row))).join(','))
  }
  /* CRLF and a BOM: Excel on Windows opens a UTF-8 CSV as Latin-1 without
     one, and every Marathi name in the file becomes mojibake. The office
     opens these on Windows. */
  return `﻿${lines.join('\r\n')}\r\n`
}

/** A filename that sorts by date and says what it is. */
export function csvName(register: string, scope: string, asOf: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '')
  return `${safe(scope)}-${safe(register)}-${asOf}.csv`
}
