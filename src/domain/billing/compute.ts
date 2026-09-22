import { pctOf, qtyTimesRate, roundToRupee, type Paise } from '../money'

/**
 * The RA bill computation.
 *
 * Pure, so it can be tested against real departmental bills. Every rule here
 * came out of one: the Ankale bills for the (A)/(B) chain and the quantity
 * cap, Suslad for the deduction block, the PWD Miraj Form 47 for the fact that
 * the GST base rule is departmental rather than universal.
 *
 * Cumulative is the model throughout. The department states a figure up to
 * date and subtracts what it has already paid; the "since previous" column is
 * informational. CLAUDE.md §2.
 */

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export interface BillLineInput {
  boqItemId: string
  itemNo: string
  description: string
  unit: string
  /** From the BOQ. Executing beyond this needs a deviation statement. */
  tenderedQty: string
  /** What the department is allowing. May be below the BOQ rate. */
  ratePaise: Paise
  boqRatePaise?: Paise
  /** Cumulative quantity on the previous bill. */
  previousQty: string
  /** Cumulative quantity being certified now — the only figure entered. */
  cumulativeQty: string
}

export interface ComputedLine extends BillLineInput {
  thisBillQty: string
  cumulativeAmountPaise: Paise
  previousAmountPaise: Paise
  thisBillAmountPaise: Paise
  exceedsTendered: boolean
  rateReducedPaise: Paise
}

/** Subtract two 3-decimal quantities without going near a float. */
function subtractQty(a: string, b: string): string {
  const thousandths = (v: string) => BigInt(Math.round(Number(v || '0') * 1000))
  const d = thousandths(a) - thousandths(b)
  const neg = d < 0n
  const abs = neg ? -d : d
  const whole = abs / 1000n
  const frac = (abs % 1000n).toString().padStart(3, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`
}

export function computeLine(input: BillLineInput): ComputedLine {
  const cumulativeAmount = qtyTimesRate(input.cumulativeQty, input.ratePaise)
  const previousAmount = qtyTimesRate(input.previousQty, input.ratePaise)
  return {
    ...input,
    thisBillQty: subtractQty(input.cumulativeQty, input.previousQty),
    cumulativeAmountPaise: cumulativeAmount,
    previousAmountPaise: previousAmount,
    thisBillAmountPaise: (cumulativeAmount - previousAmount) as Paise,
    exceedsTendered: Number(input.cumulativeQty) > Number(input.tenderedQty),
    rateReducedPaise: input.boqRatePaise
      ? ((input.boqRatePaise - input.ratePaise) as Paise)
      : (0n as Paise),
  }
}

// ---------------------------------------------------------------------------
// The bill-level chain
// ---------------------------------------------------------------------------

export interface BillChainInput {
  lines: ComputedLine[]
  /** "limited rs" — the department capping the cumulative. Null when uncapped. */
  limitCumulativeToPaise?: Paise | null
  /**
   * Signed. Negative is quoted below. On a percentage-rate contract this is
   * applied to the bill TOTAL, never to item rates.
   */
  premiumPct: string
  /** Royalty and testing within the cumulative. */
  passThroughPaise: Paise
  /** ZP Sangli keeps pass-through out of the GST base; PWD Miraj does not. */
  passThroughInGstBase: boolean
  gstRatePct: string
  igst?: boolean
  /**
   * Worker insurance, contingency and the like. They ride in the cumulative
   * and appear once, so they are supplied as a cumulative figure.
   */
  cumulativeAdditionsPaise: Paise
  /** Everything already paid on this work. */
  previousBillsTotalPaise: Paise
  /**
   * The "Work Portion" the department prints, where it differs from our work
   * value.
   *
   * Percentage deductions are taken on this and never on the bill total
   * (CLAUDE.md §2). Usually it equals the work value and is left null. It does
   * not always: on the Suslad final bill the work value is ₹5,39,143.63 while
   * the authorisation computes every deduction on ₹5,16,800, and CGST TDS is
   * exactly 1% of that. Deriving the base instead of accepting it made all
   * eight heads wrong on that bill, each needing a hand override to reach a
   * figure one entered number gives.
   */
  deductionBaseOverridePaise?: Paise | null
}

export interface ComputedBill {
  linesTotalPaise: Paise
  limitedTotalPaise: Paise | null
  premiumPaise: Paise
  workValuePaise: Paise
  passThroughPaise: Paise
  gstBasePaise: Paise
  cgstPaise: Paise
  sgstPaise: Paise
  igstPaise: Paise
  gstPaise: Paise
  additionsPaise: Paise
  cumulativeTotalPaise: Paise
  previousPaise: Paise
  payablePaise: Paise
  /**
   * What percentages are taken on. The bill prints it as "Work Portion".
   * The entered figure where the department gave one, otherwise the work value.
   */
  deductionBasePaise: Paise
}

export function computeBill(input: BillChainInput): ComputedBill {
  const linesTotal = input.lines.reduce(
    (s, l) => (s + l.cumulativeAmountPaise) as Paise,
    0n as Paise,
  )

  const limited = input.limitCumulativeToPaise ?? null
  const base = limited ?? linesTotal

  // Below reduces, above adds. The sign lives in the percentage.
  const magnitude = pctOf(base, input.premiumPct.replace('-', ''))
  const premium = input.premiumPct.trim().startsWith('-')
    ? magnitude
    : (-magnitude as Paise)
  const workValue = (base - premium) as Paise

  const gstBase = input.passThroughInGstBase
    ? workValue
    : ((workValue - input.passThroughPaise) as Paise)

  /* The bill prints CGST and SGST as two lines and the department adds them,
     so the total has to be the sum of the halves and not a separately rounded
     18%. On the Suslad bill 9% of ₹5,39,143.63 rounds up twice to ₹97,045.86
     where 18% rounds once to ₹97,045.85 — a paisa, and a paisa is the
     difference between a bill that ties out and one that comes back. IGST is a
     single line, so there it is rounded once. */
  const half = input.igst
    ? (0n as Paise)
    : pctOf(gstBase, (Number(input.gstRatePct) / 2).toString())
  const gstTotal = input.igst
    ? pctOf(gstBase, input.gstRatePct)
    : ((half + half) as Paise)

  const cumulativeTotal = (workValue +
    gstTotal +
    input.cumulativeAdditionsPaise) as Paise

  return {
    linesTotalPaise: linesTotal,
    limitedTotalPaise: limited,
    premiumPaise: premium,
    workValuePaise: workValue,
    passThroughPaise: input.passThroughPaise,
    gstBasePaise: gstBase,
    cgstPaise: half,
    sgstPaise: half,
    igstPaise: input.igst ? gstTotal : (0n as Paise),
    gstPaise: gstTotal,
    additionsPaise: input.cumulativeAdditionsPaise,
    cumulativeTotalPaise: cumulativeTotal,
    previousPaise: input.previousBillsTotalPaise,
    payablePaise: (cumulativeTotal - input.previousBillsTotalPaise) as Paise,
    deductionBasePaise: input.deductionBaseOverridePaise ?? workValue,
  }
}

// ---------------------------------------------------------------------------
// Deductions
// ---------------------------------------------------------------------------

export interface DeductionInput {
  code: string
  name: string
  /**
   * 'pct_of_gross' and 'pct_of_taxable' both mean a percentage of the base the
   * bill prints; 'manual' and 'schedule' are entered by hand.
   */
  basis: string
  ratePct?: string | null
  previousCumulativePaise: Paise
  /** What the department actually applied, where it differs from our working. */
  overridePaise?: Paise | null
  overrideReason?: string | null
}

export interface ComputedDeduction {
  code: string
  name: string
  ratePct: string | null
  cumulativePaise: Paise
  previousCumulativePaise: Paise
  computedPaise: Paise
  thisBillPaise: Paise
  isOverridden: boolean
  overrideReason: string | null
}

/**
 * Deductions are cumulative like everything else: this bill's figure is the
 * cumulative less what was already deducted. Percentages are taken on the
 * deduction base — the "Work Portion" the bill prints — and never on the total
 * with GST.
 */
export function computeDeductions(
  basePaise: Paise,
  inputs: DeductionInput[],
): ComputedDeduction[] {
  return inputs.map((d) => {
    const isPercentage = d.basis.startsWith('pct_') && d.ratePct != null
    /* A manual or scheduled head has no formula, so with nothing entered it
       contributes nothing THIS bill — its cumulative stays where the last bill
       left it. Defaulting the cumulative to zero instead would subtract
       everything already deducted under that head and show a negative
       royalty. */
    const cumulativeComputed = isPercentage
      ? roundToRupee(pctOf(basePaise, d.ratePct!))
      : d.previousCumulativePaise

    const cumulative = d.overridePaise ?? cumulativeComputed
    return {
      code: d.code,
      name: d.name,
      ratePct: d.ratePct ?? null,
      cumulativePaise: cumulative,
      previousCumulativePaise: d.previousCumulativePaise,
      computedPaise: (cumulativeComputed - d.previousCumulativePaise) as Paise,
      thisBillPaise: (cumulative - d.previousCumulativePaise) as Paise,
      isOverridden:
        d.overridePaise != null && d.overridePaise !== cumulativeComputed,
      overrideReason: d.overrideReason ?? null,
    }
  })
}

export const totalDeductions = (ds: ComputedDeduction[]): Paise =>
  ds.reduce((s, d) => (s + d.thisBillPaise) as Paise, 0n as Paise)

// ---------------------------------------------------------------------------
// What is wrong with this bill
// ---------------------------------------------------------------------------

/**
 * The checks that stand between a typo and a bill the department sends back.
 *
 * Here rather than in the action because the entry screen computes live in the
 * browser and the server recomputes on save; two copies of these sentences
 * would eventually disagree about which one is the rule.
 */
export function billWarnings(
  lines: ComputedLine[],
  bill: ComputedBill,
  deductions: ComputedDeduction[],
): string[] {
  const out: string[] = []

  for (const l of lines) {
    if (Number(l.thisBillQty) < 0) {
      out.push(
        `Item ${l.itemNo}: the cumulative is below the previous bill's ` +
        `${l.previousQty}. That reduces a certified quantity — right only if ` +
        `the department has actually revised it down.`,
      )
    }
    if (l.exceedsTendered) {
      out.push(
        `Item ${l.itemNo}: ${l.cumulativeQty} ${l.unit} executed against ` +
        `${l.tenderedQty} tendered. Needs a deviation statement.`,
      )
    }
  }

  if (bill.limitedTotalPaise !== null && bill.limitedTotalPaise > bill.linesTotalPaise) {
    out.push(
      'The "limited to" figure is above the sum of the items. A cap reduces a ' +
      'bill; check which figure the department actually wrote.',
    )
  }

  if (bill.payablePaise < 0n) {
    out.push(
      'This bill is negative — the cumulative has fallen below what has already ' +
      'been paid. Check the quantities before going further.',
    )
  }

  for (const d of deductions) {
    if (d.isOverridden && !d.overrideReason) {
      out.push(`${d.name}: an overridden figure needs a reason recorded against it.`)
    }
  }

  return out
}

/** Net payable after the department's cuts — the cheque. */
export const netPayable = (bill: ComputedBill, ds: ComputedDeduction[]): Paise =>
  (bill.payablePaise - totalDeductions(ds)) as Paise
