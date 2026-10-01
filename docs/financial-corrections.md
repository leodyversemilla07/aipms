# PO and receipt cancellation safety

## Supported cancellation workflow

PO cancellation is a human approval, not a way to reverse a payment or a goods receipt.

1. Confirm that the PO is `issued` or `confirmed` and has not been paid.
2. Resolve every live payment reservation for its invoices. A planned line on a non-voided run blocks correction, including draft, approved, and executed runs.
   - A draft or approved run can be voided through the finance workflow.
   - An approved run's maker cannot also void it.
   - An executed run cannot be silently voided. Reconcile its actual bank outcomes; do not mark lines dishonored/rejected simply to unblock cancellation.
   - Voided runs and genuinely dishonored/rejected lines release their reservations. A paid invoice or paid payment line still blocks cancellation.
3. Resolve the PO's recorded receipts. Receipt cancellation must reflect a valid correction of the recorded goods/services; it is not a substitute for a return/refund workflow.
4. Request PO cancellation and obtain a different authorized human checker. Rejecting the cancellation request remains possible without changing the PO.
5. On approval, the application cancels the PO, demotes stale matched invoices to `exception` with `po_not_live`, releases the unpaid PO's full commitment, and emits domain events in the same transaction.

**Paid obligations cannot be cancelled or overridden through this path.** They require a separate return/refund accounting workflow, which is not implemented by these endpoints. Do not reset paid statuses or edit payment history to evade the guard.

## Budget release

- The PO is the authoritative source of the requisition/budget link. A mismatched cancellation approval is rejected.
- A standalone PO with no requisition has no budget release to invent.
- For a linked requisition, missing requisition/budget data, missing budget assignment, currency mismatch, invalid amounts, or an aggregate commitment below the PO total cause the transaction to fail.
- The budget is locked before an exact decrement. No floor-at-zero subtraction hides an inconsistent balance.
- Paid invoice/line checks prevent a previously settled order from consuming another order's remaining commitment.

Failure rolls back the approval decision, PO/invoice changes, budget update, and transactional events. The operator can reconcile the blocking condition and retry, or reject the cancellation request.

## Serialization contract

All correction callers hold the PO row lock before inspecting/modifying its invoices. This serializes invoice registration and receipt recording with cancellation.

The shared invoice correction guard then:

1. Locks **all** invoices for the PO with `ORDER BY id FOR UPDATE`.
2. Reads current invoice status and payment claims only after lock acquisition.
3. Refuses paid invoices, paid payment lines, and planned lines on live runs—even when the stored invoice status is not `matched`.
4. Holds those locks through eligibility changes and transaction commit/rollback.

Payment planning locks invoice IDs in the same order, then validates stored status, linked PO lifecycle, beneficiaries, and claims. It reads linked PO state without acquiring a PO lock after invoice locks, avoiding an inverse PO/invoice lock order.

- If planning wins the invoice lock, correction reads its committed claim and refuses to invalidate the invoice.
- If correction wins, planning reads the changed eligibility after it acquires the lock and refuses a non-payable invoice.
- Settlement also takes the invoice lock. A paid outcome cannot be hidden between correction's validation and commit.

## Regression coverage and limitations

- Database-blocked unit tests: `apps/api/test/unit/po-cancellation.spec.ts` and `payment-eligibility.spec.ts`.
- Real PostgreSQL rollback/concurrency cases: `apps/api/test/po-cancellation.spec.ts`. These include payment winning and receipt correction winning the invoice lock, PO cancellation racing planning, and a paid PO sharing a budget with another order.
- Run the guarded integration suite only with identical `DATABASE_URL` and `AIPMS_TEST_DATABASE_URL` pointing to an isolated disposable `*_test` database.

The unit ordering probe uses injected clients; it is not proof of PostgreSQL concurrency semantics. The new PostgreSQL cases have been typechecked but could not be executed locally because an isolated database/Docker daemon was unavailable. Database safeguards were not bypassed.

This change does **not** implement a per-PO commitment/settlement ledger, partial-payment accounting, refunds, or historical-data repair. Tolerance-variance settlement accounting and already inconsistent approved/executed runs still require dedicated hardening/reconciliation. New planning rejects a linked missing or non-live PO even when an old stored invoice match is stale.
