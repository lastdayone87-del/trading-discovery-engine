# Classification resolution recovery dry run v1

**Status:** read-only production snapshot. No backfill, job enqueue, channel update, or settings change was executed.

Snapshot: 2026-11-11, production main `a157e72a` (pre-resolution-migration, so terminal failure classes are inferred from the existing error text). The new recovery code and migration were not deployed.

## Inventory

### Orphan `ENRICHMENT_PENDING` (no active job)

| Age | Rows |
|---|---:|
| < 1 day | 78 |
| 1–7 days | 67 |
| 7–30 days | 201 |
| 30+ days | 50 |
| **Total** | **397** |

Proposed forward action: one bounded `ENRICH_CHANNEL` recovery pass per row, using the existing idempotent recovery key and 3-cycle ceiling. No automatic trading decision.

### Generic terminal enrichment failures

- Failed `ENRICH_CHANNEL` jobs total: 703.
- Operationally blocked/provider/quota: 677.
- Generic failures outside those markers: **26 jobs**.
- Channels currently `UNCERTAIN / FAILED` with a generic latest failure: **17**.
- Error text matching permanent input markers (`not found`, `invalid`, `private`, `deleted`): **0**; after the migration, `terminal_failure_class` will make this explicit.

Proposed forward action: bounded recovery for retryable/unknown classes; `FAILED_PERMANENT` for confirmed permanent input. Cycle exhaustions become human review, never a terminal trading decision.

### Legacy unresolved inventory

| State | Eligibility | Rows | Automatic action |
|---|---|---:|---:|
| `UNCERTAIN / COMPLETED` | no projection | 3,149 | 0 |
| `UNCERTAIN / COMPLETED` | `DEFERRED` | 384 | 0 |
| `UNCERTAIN / FAILED` | `DEFERRED` | 39 | 0 |
| **Total** | | **3,572** | **0** |

No legacy row has a pending review. These rows predate the forward-recovery cutoff and are **reported only**. A later operator-approved, bounded backfill can materialize review or recovery; the maintenance sweep will not create thousands of reviews automatically.

## Action preview

| Action | Rows |
|---|---:|
| Bounded enrichment recovery | 397 orphan + 26 generic = **423** |
| Exhausted-review materialization | 0 at first run (all have 0 recovery cycles) |
| Permanent-failure projection | 0 inferred before the migration |
| Legacy rows skipped by cutoff | **3,572** |
| Automatic terminal trading decisions | **0** |

## Quota protection snapshot

- Daily limit: 580,000 units.
- Used at snapshot: 6,387 units (new Pacific quota day).
- Recent 7-day consumption: autonomous **748,800**; enrichment **54,117**.
- Due enrichment: 5,819 stage 1 and 19 stage 2.
- Estimated due demand: 13,595 units.
- Dynamic protected reserve: **13,595 units (10%)**, released as the backlog falls.
- Available to autonomous discovery: **560,018 units**.
- No fixed quota partition was introduced.

## Safety notes

- The dry-run script defaults to no writes; `--apply` requires explicit operator approval.
- The maintenance sweep is forward-only until its cutoff; legacy rows are not mutated.
- No worker, provider, key, or evidence-threshold changes are part of this report.
