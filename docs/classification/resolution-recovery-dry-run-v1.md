# Classification resolution recovery dry run v1

**Status:** read-only production snapshot. No backfill, job enqueue, channel update, or settings change was executed.

Snapshot: 2026-11-11, production main `a157e72a` (pre-resolution-migration, so terminal failure classes are inferred from the existing error text). The new recovery code and migration were not deployed. Counts are a moving read-only snapshot.

## Inventory

### Orphan `ENRICHMENT_PENDING` (no active job)

| Age | Rows |
|---|---:|
| < 1 day | 90 |
| 1–7 days | 71 |
| 7–30 days | 196 |
| 30+ days | 49 |
| **Total** | **406** |

Proposed forward action: one bounded `ENRICH_CHANNEL` recovery pass per row, using the existing idempotent recovery key and 3-cycle ceiling. No automatic trading decision.

### Generic terminal enrichment failures

- Failed `ENRICH_CHANNEL` jobs total: 703.
- Operationally blocked/provider/quota: 677.
- Generic failures outside those markers: **26 jobs**.
- Channels currently `UNCERTAIN / FAILED` with a generic latest failure: **17**.
- Of these 423 forward candidates, **91** are still inside the 24-hour recovery cooldown (90 orphan + 1 generic).
- Error text matching permanent input markers (`not found`, `invalid`, `private`, `deleted`): **0**; after the migration, `terminal_failure_class` will make this explicit.

Proposed forward action: bounded recovery for retryable/unknown classes; `FAILED_PERMANENT` for confirmed permanent input. Cycle exhaustions become human review, never a terminal trading decision.

### Legacy unresolved inventory

| State | Eligibility | Rows | Automatic action |
|---|---|---:|---:|
| `UNCERTAIN / COMPLETED` | no projection | 3,323 | 0 |
| `UNCERTAIN / COMPLETED` | `DEFERRED` | 412 | 0 |
| `UNCERTAIN / FAILED` | `DEFERRED` | 37 | 0 |
| **Total** | | **3,772** | **0** |

No legacy row has a pending review. These rows predate the forward-recovery cutoff and are **reported only**. A later operator-approved, bounded backfill can materialize review or recovery; the maintenance sweep will not create thousands of reviews automatically.

## Action preview

| Action | Rows |
|---|---:|
| Forward candidates | 406 orphan + 17 generic channels = **423** |
| Immediate bounded recovery (outside cooldown) | **332** (316 orphan + 16 generic) |
| Deferred by 24-hour cooldown | **91** (90 orphan + 1 generic) |
| Exhausted-review materialization at first run | 0 (no recovery cycles yet) |
| Permanent-failure projection | 0 inferred before the migration |
| Legacy rows skipped by cutoff | **3,772** |
| Automatic terminal trading decisions | **0** |

## Quota protection snapshot

- Daily limit: 580,000 units.
- Used at snapshot: 109,311 units (current Pacific quota day).
- Recent 7-day consumption: autonomous **793,500**; enrichment **54,808**.
- Due enrichment: 5,885 stage 1 and 19 stage 2.
- Estimated due demand: 13,727 units.
- Dynamic protected reserve: **13,727 units** (demand-driven; protected share is 10% at this snapshot, within the policy's 10%–50% range based on recent enrichment share), released as the backlog falls.
- Available to autonomous discovery: **456,962 units**.
- No fixed quota partition was introduced.

## Safety notes

- The dry-run script defaults to no writes; `--apply` requires explicit operator approval. A dry run never creates the cutoff row.
- The maintenance sweep is forward-only until its cutoff; legacy rows are not mutated.
- The maintenance sweep is read-only unless `CLASSIFICATION_RESOLUTION_RECOVERY_APPLY` is set to `true` after trimming surrounding whitespace and comparing case-insensitively. Absent, false, or any other value keeps the scheduled sweep in dry-run mode.
- No worker, provider, key, or evidence-threshold changes are part of this report.
