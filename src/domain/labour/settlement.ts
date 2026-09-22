import { type ISODate } from '../dates'
import { ZERO, type Paise } from '../money'
import {
  computeTds as tds194c, type TdsInput, type TdsResult,
} from '../tax/tds194c'

/**
 * Settling with a mukadam.
 *
 * A gang leader is engaged by the **firm**, not by a project — CLAUDE.md §1.
 * The same crew works three days at Umadi, two at Dafalapur and one at
 * Sonyal, and is paid once, periodically, for all of it. So a settlement is
 * one payment that has to be split across several works, and the split is the
 * whole point of this module: the alternative is booking it against whichever
 * site somebody happens to be looking at, which mis-costs every project at
 * once and leaves no trace.
 *
 * **This is labour engagement, not sub-contracting.** It does not breach the
 * sub-contracting prohibition printed on a ZP work order, and nothing here
 * should be presented as though it might.
 *
 * Pure. CLAUDE.md §5.
 */

export interface Deployment {
  projectId: string
  date: ISODate
  trade: string
  headcount: number
  wageRatePaise: Paise
  amountPaise: Paise
}

/* ------------------------------------------------------------------ */
/* The split                                                           */
/* ------------------------------------------------------------------ */

export interface ProjectDays {
  projectId: string
  manDays: number
  /** What the daily rates in the register add up to, for this work. */
  computedPaise: Paise
}

/** Man-days and the register's own figure, per work, over the period. */
export function byProject(deployments: Deployment[]): ProjectDays[] {
  const map = new Map<string, ProjectDays>()
  for (const d of deployments) {
    const n = Math.max(0, Math.trunc(d.headcount))
    const row = map.get(d.projectId)
      ?? { projectId: d.projectId, manDays: 0, computedPaise: ZERO }
    row.manDays += n
    row.computedPaise = (row.computedPaise + d.amountPaise) as Paise
    map.set(d.projectId, row)
  }
  return [...map.values()].sort((a, b) => b.manDays - a.manDays)
}

/** The `allocation_basis` enum, as far as this module uses it. */
export type Basis = 'man_days' | 'measured_work'

export interface Allocation {
  projectId: string
  manDays: number
  amountPaise: Paise
}

export interface Split {
  basis: Basis
  allocations: Allocation[]
  /** Why that basis, in the words shown on the screen. */
  reason: string
}

/**
 * Split one payment across the works it covers.
 *
 * **The basis is the register's own money where the register has any**, and
 * man-days only where it does not. Man-days look like the neutral choice and
 * are not: a mason-day and a helper-day are not the same money, so a site that
 * ran a cheap gang and a site that ran an expensive one get the same share per
 * head. On real figures that moved nearly two thousand rupees onto the wrong
 * work — not because anyone estimated badly, but because the estimate threw
 * away information the register already held.
 *
 * Man-days remain the fallback, and they are what CLAUDE.md §8.7 names,
 * because site often does not know the rate and records a headcount alone.
 * Then heads are all there is, and heads are far better than a guess.
 *
 * Either way it is largest remainder, so **the parts sum to the whole**.
 * Rounding each share on its own strands paise, and a split that does not add
 * back to the payment gets papered over with a rounding line.
 *
 * Works the gang was never on get nothing, never an equal share: they are in
 * the list because somebody selected them, not because anybody worked there.
 */
export function allocate(netPaise: Paise, rows: ProjectDays[]): Split {
  const money = rows.reduce((a, r) => (a + r.computedPaise) as Paise, ZERO)
  const byMoney = money > ZERO
  const weights = rows.map((r) => (byMoney ? r.computedPaise : BigInt(r.manDays)))
  const total = weights.reduce((a, w) => a + w, 0n)

  const nothing = (): Split => ({
    basis: 'man_days',
    allocations: rows.map((r) => ({ projectId: r.projectId, manDays: r.manDays,
                                    amountPaise: ZERO })),
    reason: 'Nothing recorded to split by.',
  })
  if (total === 0n || rows.length === 0) return nothing()

  const exact = weights.map((w) => (w * netPaise) / total)
  let remainder = netPaise - exact.reduce((s, v) => s + v, 0n)

  const order = weights
    .map((w, i) => ({ i, rem: (w * netPaise) % total }))
    .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : 0))

  const out = exact.slice()
  for (const { i } of order) {
    if (remainder <= 0n) break
    out[i] = out[i]! + 1n
    remainder -= 1n
  }

  return {
    basis: byMoney ? 'measured_work' : 'man_days',
    allocations: rows.map((r, i) => ({ projectId: r.projectId, manDays: r.manDays,
                                       amountPaise: out[i]! as Paise })),
    reason: byMoney
      ? 'Split by what each work\'s own days come to at the rates recorded, '
        + 'so a cheaper gang does not subsidise an expensive one.'
      : 'Split by man-days — no rates were recorded at site, so heads are all '
        + 'there is to go on.',
  }
}

/* ------------------------------------------------------------------ */
/* Tax                                                                 */
/* ------------------------------------------------------------------ */

/* 194C lives in `domain/tax/tds194c.ts`. It is the same section for a
   mukadam's fortnight and a subcontractor's running bill, and two copies of it
   is how the rate gets corrected in only one place. Re-exported so callers of
   this module do not have to know where it moved to. */
export {
  ANNUAL_THRESHOLD as TDS_ANNUAL_THRESHOLD,
  NO_PAN_PCT, SINGLE_THRESHOLD as TDS_SINGLE_THRESHOLD, TDS_PCT, computeTds,
  type PayeeKind, type TdsInput, type TdsResult,
} from '../tax/tds194c'

/* ------------------------------------------------------------------ */
/* The settlement                                                      */
/* ------------------------------------------------------------------ */

export interface SettlementInput {
  periodFrom: ISODate
  periodTo: ISODate
  deployments: Deployment[]
  /** The figure actually agreed. Null means take the register's. */
  agreedGrossPaise?: Paise | null
  advanceRecoveredPaise: Paise
  tds: TdsInput
  /** Periods already settled with this party, to catch a day paid twice. */
  settledPeriods: { from: ISODate; to: ISODate; ref: string }[]
}

export type ProblemKind = 'blocking' | 'warning'
export interface Problem { kind: ProblemKind; message: string }

export interface Settlement {
  manDays: number
  /** What the register's own daily rates come to. */
  computedGrossPaise: Paise
  /** What is being settled — the agreed figure where there is one. */
  grossPaise: Paise
  /** agreed − computed. Negative means he accepted less than the register. */
  differencePaise: Paise
  tds: TdsResult
  netPaise: Paise
  split: Split
  problems: Problem[]
}

export function computeSettlement(input: SettlementInput): Settlement {
  const rows = byProject(input.deployments)
  const manDays = rows.reduce((n, r) => n + r.manDays, 0)
  const computedGross = rows.reduce(
    (a, r) => (a + r.computedPaise) as Paise, ZERO)

  /* A negotiated figure beats the register, exactly as a department's own
     deduction beats the statutory rate — the paperwork is the record and our
     books have to agree with it. The register is kept on screen beside it
     because the gap is the interesting number. */
  const gross = input.agreedGrossPaise ?? computedGross
  const tds = tds194c({ ...input.tds, grossPaise: gross })
  const net = (gross - input.advanceRecoveredPaise - tds.tdsPaise) as Paise

  const problems: Problem[] = []

  if (input.periodTo < input.periodFrom) {
    problems.push({ kind: 'blocking', message: 'The period ends before it begins.' })
  }

  /* The same days settled twice is this module's version of claiming the same
     fortnight in two extensions: both payments look right on their own and
     only the total is wrong. */
  for (const s of input.settledPeriods) {
    if (s.from <= input.periodTo && s.to >= input.periodFrom) {
      problems.push({ kind: 'blocking',
        message: `These days overlap the settlement for ${s.ref}. Those `
          + 'man-days have already been paid for once.' })
    }
  }

  if (manDays === 0) {
    problems.push({ kind: 'warning',
      message: 'No man-days are recorded for this gang in the period, so there '
        + 'is nothing to split the payment by. Whatever is entered here is a '
        + 'manual allocation and nothing checks it.' })
  }
  if (net < ZERO) {
    problems.push({ kind: 'blocking',
      message: 'The recovery and the tax come to more than the payment. '
        + 'Recover less now and carry the rest to the next settlement.' })
  }
  if (input.advanceRecoveredPaise < ZERO) {
    problems.push({ kind: 'blocking', message: 'A recovery cannot be negative.' })
  }
  if (!input.tds.hasPan && gross > ZERO) {
    problems.push({ kind: 'warning',
      message: 'No PAN on file for this gang. Below the thresholds it costs '
        + 'nothing; above them it is 20% instead of 1%.' })
  }

  const difference = (gross - computedGross) as Paise
  if (computedGross > ZERO && difference !== 0n) {
    const pct = Math.abs(Number(difference * 10000n / computedGross) / 100)
    if (pct >= 10) {
      problems.push({ kind: 'warning',
        message: `The agreed figure is ${pct.toFixed(1)}% `
          + `${difference > 0n ? 'above' : 'below'} what the daily rates in the `
          + 'register come to. One of the two is wrong and it is worth knowing '
          + 'which before it is paid.' })
    }
  }

  return {
    manDays, computedGrossPaise: computedGross, grossPaise: gross,
    differencePaise: difference, tds, netPaise: net,
    split: allocate(net > ZERO ? net : ZERO, rows),
    problems,
  }
}

export const blocking = (ps: Problem[]): Problem[] =>
  ps.filter((p) => p.kind === 'blocking')
