import { type Paise } from '../money'

/**
 * A receipt landing against a bill.
 *
 * The forecast opens from "in the bank", and until now nothing could put
 * anything there: marking a bill paid wrote `payment_received_paise` on the
 * bill and no money moved in any account. The two halves of the same event
 * were recorded in different places, and only one of them was recorded at all.
 *
 * This is the arithmetic of joining them, kept pure because the ways it goes
 * wrong are all arithmetic. A department rarely pays a bill exactly:
 *
 *   **Short.** A deduction we did not book, or a part payment against a fund
 *   release. The bill stays outstanding for the balance and keeps appearing on
 *   the review — which is right, because the balance is still owed.
 *   **Exact.** The ordinary case.
 *   **Over.** Almost always a receipt posted against the wrong bill. Allowed,
 *   because refusing it would leave somebody unable to record money that
 *   genuinely arrived, but never silently: it is flagged, and the excess is
 *   stated rather than absorbed into the bill.
 *
 * Nothing here decides policy. It returns what the numbers are; the action
 * decides what to refuse.
 */

export type ReceiptFit = 'short' | 'exact' | 'over'

export interface ReceiptInput {
  /** The bill's net payable — the department's figure. */
  netPayablePaise: Paise
  /** Already received against it before this receipt. */
  alreadyReceivedPaise: Paise
  /** What is landing now. */
  amountPaise: Paise
}

export interface Receipt {
  fit: ReceiptFit
  /** Cumulative received after this one. */
  receivedPaise: Paise
  /** Still owed after this one. Zero on an exact or over receipt. */
  outstandingPaise: Paise
  /** How much of this receipt exceeds what was owed. Zero unless `over`. */
  excessPaise: Paise
  /** True once the bill is fully settled and drops out of the forecast. */
  settles: boolean
}

const ZERO = 0n as Paise

export function applyReceipt(input: ReceiptInput): Receipt {
  const owed = (input.netPayablePaise - input.alreadyReceivedPaise) as Paise
  const received = (input.alreadyReceivedPaise + input.amountPaise) as Paise

  if (input.amountPaise > owed) {
    return {
      fit: 'over',
      receivedPaise: received,
      outstandingPaise: ZERO,
      excessPaise: (input.amountPaise - owed) as Paise,
      settles: true,
    }
  }

  const outstanding = (owed - input.amountPaise) as Paise
  return {
    fit: outstanding === 0n ? 'exact' : 'short',
    receivedPaise: received,
    outstandingPaise: outstanding,
    excessPaise: ZERO,
    /* A bill already over-received stays settled: `owed` is negative, so a
       further receipt of zero would otherwise read as short. */
    settles: outstanding <= 0n,
  }
}

/**
 * What a receipt does to an account's balance.
 *
 * Signed by direction and nothing else. A cash credit account holds a negative
 * balance because it is money owed to the bank, and a receipt into it reduces
 * what is drawn rather than adding to cash — which is the same arithmetic, and
 * is why this does not special-case account type. What must not happen is the
 * two being ADDED together somewhere upstream; that is the job of
 * `openingBalance`, which keeps them apart.
 */
export function signedAmount(direction: 'in' | 'out', amountPaise: Paise): Paise {
  return (direction === 'in' ? amountPaise : -amountPaise) as Paise
}
