# contracting-domain

The rules a civil contractor's money actually follows, as pure TypeScript
functions with no dependencies.

```bash
npm install && npm test
```

This is the domain layer of an operations system running a construction firm in
Maharashtra — government and private works, six legal vehicles, bills that pass
through four departmental desks before anybody is paid. The application around
it is private. This part is published because it contains no client data, and
because it is where the interesting problems are.

Every function here is pure: arguments in, value out, no database, no network,
no framework, **no third-party runtime dependency of any kind**. That is not
minimalism for its own sake — it is what lets each rule below be stated as a
test and checked in milliseconds.

## Why any of this is hard

Each of these was believed to be simple, implemented, and found to be wrong
against real paperwork. The comment above each function says which document
taught it.

**A running-account bill is not `lines + GST`.** It is a chain:

```
sum of bill lines
  → capped where executed quantity exceeded tendered quantity
  → less the tender premium %, applied to the BILL TOTAL, not to item rates
  = work value
  → less pass-through items (royalty, laboratory testing)
  = GST base                     ← GST is charged on this, never on the gross
  + GST
  + one-off additions (worker insurance, contingency)
  = cumulative total
  → less all previous bills = payable now
```

Deductions are cumulative too: this bill's TDS is the TDS due on everything
built to date, minus what has already been deducted. Compute it per bill and
the numbers drift apart over a year-long project — slowly, and in a direction
nobody checks.

**The percentage is charged on a figure the bill prints separately.** Income
tax, both halves of GST TDS and the labour cess are computed on the *work
portion*, which excludes GST and excludes the pass-through items. Taking them
on the gross overstates every deduction by the GST rate. `src/domain/billing/`.

**Cash and a cash-credit facility are never added together.** A CC account
carries a negative balance, because it is money owed to the bank. Summing it
with the current accounts reported one firm ₹5.57 crore short when it had
₹3.55 crore to spend and ₹5.88 crore it could still borrow. Three separate
facts, three separate fields, and only two of them belong in a forecast.
`src/domain/cashflow/`.

**An advance is not a cost.** Money handed to a site supervisor has moved, not
been spent. Booking both the advance and the voucher against it overstates
every project the holder touched, by the whole advance, invisibly.
`src/domain/expense/imprest.ts`.

**Most supplier accounts have no agreed due date at all** — settlement is by
cash availability, discussed with the supplier. So "overdue" is a claim about a
promise that was never made, and printing it is how a report stops being
believed. Such a balance is *outstanding*, aged from the bill date, and it
still belongs in the forecast at full value. `src/domain/expense/payables.ts`.

**TDS is charged on the amount before GST, and the cost booked includes it.**
It is not a discount: part of the bill goes to the government instead of the
supplier. The rate depends on the payee, not the category — 1% to an
individual, 2% to a company, nil for a transporter who has filed a
declaration. `src/domain/tax/tds194c.ts`.

**A bank statement is checked against itself.** Every imported row must carry
the running balance forward exactly, to the paisa, or the import is refused —
that single check catches a truncated download, a mis-parsed sign and a
duplicated page, none of which look wrong row by row.
`src/domain/bank/statement.ts`.

**A deadline counts back from the date the thing is due**, never forward from
the event that started the clock. Anchoring three warnings on the work-order
date instead of the deadline fired them twelve to fifteen days *before* the
order existed, with the wrong date printed on each — and looked like it was
working. `src/domain/alerts/engine.ts`.

## Conventions worth stealing

- **Money is `bigint` paise.** Never a float, never a decimal string in
  arithmetic. `Paise` is a branded type, so rupees and paise cannot be added
  by accident. `src/domain/money.ts`.
- **The financial year runs April to March.** A "year" filter that means
  January is a bug in this country. `src/domain/fy.ts`.
- **Dates are day-first and timezone-free.** Business dates are plain dates;
  only events carry a time. `src/domain/dates.ts`.
- **A departmental figure always wins over a computed one.** Where the
  department's arithmetic differs from ours, our bill must match theirs, so
  every computed value can be overridden with a recorded reason. Correcting a
  department is not a feature.

## Layout

| Directory | What lives there |
|---|---|
| `billing/` | the bill chain, cumulative deductions, stages, revisions, variance |
| `cashflow/` | thirteen-week forecast, receipts, arrangement works, review |
| `expense/` | supplier bills, imprest advances, payables ageing |
| `tax/` | 194C TDS thresholds and rates |
| `bank/` | statement import, balance chain, reconciliation matching |
| `works/` | measurement books, deviation, extension of time, delays |
| `tender/` | bid analysis, additional security deposit rules |
| `firms/` | registration classes, capacity, eligibility |
| `alerts/` | the deadline engine |
| `compliance/` | the statutory calendar |
| `export/` | Tally XML, CSV, statutory registers |
| `labour/` | gang settlement split across projects by man-days |
| `notifications/` | digest composition, web push encryption (RFC 8291) |

## Tests

`npm test` runs the whole suite in a couple of seconds. The tests are written
as statements about the domain rather than about the code — `a settlement is
split by the register's money, not by head count`, `a bill's deduction is the
difference between two cumulative figures` — so they double as the
specification, and a reader can start with any file in `tests/` and learn what
the rule is before reading how it is implemented.

## Provenance

Extracted from a private repository by a script that rewrites every name,
firm, identifier and address it carries, then re-reads its own output and
refuses to publish anything that still names somebody. The rules are real; the
names in the examples are not.

MIT licensed.
