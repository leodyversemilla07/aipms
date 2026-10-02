# Policy revision and resolution contract

Requisition submission, agent event wakes, sourcing comparison/award, and tax
configuration use one policy resolver. A policy's last edit time is not its
business precedence.

## Scope and precedence

For a decision carrying a cost center:

1. An enabled exact `costCenter:<id>` policy overrides global policies.
2. If no exact rule exists, use the global rule.
3. Within that scope, use the highest enabled version.
4. Two enabled heads at that version are ambiguous: fail closed, not an
   arbitrary ID/edit-time winner.
5. Validate the selected configuration. A malformed current rule does not
   permit falling back to an older permissive rule.

Bare scopes such as `IT-PROD` normalize to `costCenter:IT-PROD`.
Missing scope or `*` denotes a global policy. A different cost center's rule
is never a fallback. New scoped writes retain the canonical scope spelling.

Calls without a cost center resolve global policies only. This includes the
public `policy.activeByKind` preview and global tax computation. Tax rules
currently reject scope; scoped tax treatment is not implemented.

No applicable threshold means human review, not automatic approval.
Accepted sourcing awards remain authoritative over preferred-vendor rules.
A configured preferred vendor that cannot be found fails the wake rather than
silently substituting an arbitrary vendor.

## Publishing revisions

`policy.create` remains admin-only and idempotent. Creation:

- Holds the PostgreSQL transaction advisory lock `policy-version:<kind>`.
- Allocates `max(version) + 1` across that kind, including disabled revisions
  and other scopes. Gaps within an individual scope are expected.
- Checks that `supersedesId`, when supplied, belongs to the same kind/scope
  and is at the latest historical version within that scope.
- Rejects missing, cross-kind, cross-scope, and stale references.
- For an enabled publication, retires all enabled predecessors in that same
  kind/scope, including legacy competing heads.
- For a disabled draft, leaves the active rule unchanged.
- Commits creation/retirement with the router's audit and idempotency outcome.
  The returned/audited `retiredPolicyIds` identifies the retired revisions.

Omitting `supersedesId` means an unconditional new admin publication.
Provide the current historical head when optimistic concurrency is needed.
Concurrent replacements of the same explicit head cannot fork: one succeeds
and the other must reload. Standalone service callers also get a real
transaction; callers already inside a transaction share that transaction.

Old configurations and version numbers are not rewritten. Retirement changes
only activation metadata. A failed surrounding transaction restores the old
activation and consumes no version.

The unique-version guarantee applies to participating API/seed writers under
the shared lock, not arbitrary direct SQL. Existing duplicate historical
versions are not silently renumbered or erased. The new migration adds a
resolution index only; ambiguous enabled heads still require a reviewed
replacement.

## Supported configuration fields

Operational kinds reject unknown fields so misspellings cannot silently change
the effective rule.

| Kind | Fields |
| --- | --- |
| `threshold` | Optional `scope`, nonnegative integer `autoApproveUpTo` in minor units (database Int range), boolean `budgetRequired`, and string-array `approvalChain`. |
| `preferredVendor` | Optional `scope`; one unambiguous `vendorId` or supported legacy alias `vendor_id`. |
| `evaluationCriterion` | Optional `scope`; `criterion: lowestCost \| bestValue`; optional numeric `priceWeight` from 0 to 1. |
| `taxRule` | Optional integer `vatRateBps`, `ewtRatesBps` keyed by goods/services/professional/rental/other, and edition `version`. Rates range from 0 to 10,000 basis points. |
| `approvalChain`, `budgetControl` | Object configuration with optional scope. Storage does not imply additional standalone gates are implemented. |

`autoApproveUpToMinor`, `mearb`, percentage-weight aliases, string-valued tax
rates, and arbitrary operational config keys are not supported. Existing
malformed active rules need a correctly authored replacement; do not downgrade
validation to make them resolve.

Partial valid tax configuration still receives the deterministic PH defaults.
Configured tax computations now cite `policy:<id>@v<revision>`; the config's
edition label remains visible in the policy record but is not confused with
the database revision. When no tax rule is configured, computations retain the
existing PH-default edition. Numeric validation is not tax/legal approval.

## Traceability and bootstrap

Threshold decisions retain their policy citations. Successful event wakes also
retain the threshold decision and selected preferred-policy ID/version.
Sourcing comparison and award events retain the evaluation-policy ID/version.

Invoice registration resolves tax configuration in its caller's transaction.
These are policy reads at decision time, not a globally atomic policy epoch
or continuous locks across an entire procurement workflow. A revision may be
published after a decision's read. Prior financial artifacts are not recomputed
by changing a policy.

Master-data seeding uses the same threshold allocator lock and creates a default
only when there is no threshold history at all. It does not re-enable an
administrator's disabled/replaced rules.

Stop old API/seed writers before rollout: old binaries do not participate in
the new publication/selection contract. Apply the index migration through the
normal deployment workflow. Do not directly reactivate retired revisions as a
production rollback procedure.

## Verification boundaries

Database-blocked tests cover precedence, scope aliases, malformed and ambiguous
heads, author-time schemas, revision allocation/retirement, supersession guards,
and seed preservation.

Guarded PostgreSQL tests cover parallel creators, competing explicit-head
replacements, transaction rollback, audit/idempotency replay, legacy ambiguity,
and scope precedence. Workflow tests use real requisitions/quotes/policies and
the real event-wake handler, with relay/command delivery injected; they do not
claim a live agent or provider operation. Existing integration/browser/image
suites exercise the remaining runtime boundaries.

Integration tests require identical explicit `DATABASE_URL` and
`AIPMS_TEST_DATABASE_URL` targeting a disposable `*_test` database. Policy
activation restoration in test fixtures is disposable-database cleanup only,
never a production recovery strategy.
