# Phase 2 Option C — retry backlog triage and soak

**Status:** Unit 4 implemented (read-only classifier, bounded reversible apply,
bounded undo, soak plan).
**Tracking:** #616.

## Baseline

Read-only production profile:

- **2,526** pending `RETRY_COMMUNITY_ACQUISITION` jobs at the initial snapshot,
  **2,516** at the latest classification snapshot; 2,526 distinct channels (no
  duplicate channel jobs).
- 2,024 had `attempts=0`; 1,996 were 7–30 days old and 205 were >30 days old by
  `first_enqueued_at`.
- 1,070 had never been claimed; 1,371 had only claims older than 7 days.
- Existing Phase 0 zombie reconciliation proposed only **5** channel-terminal
  closures; the rest were not provably terminal.

## Buckets (latest snapshot)

The classifier is pure and deliberately conservative: **age alone never
closes a job**.

| Bucket | Rule | Count |
|---|---|---:|
| **TERMINAL** | `scope_eligibility=OUT_OF_SCOPE`; `scan_status=SKIPPED_LOW_AUDIENCE`; terminal country/trading state; or `max_attempts>0 AND attempts>=max_attempts` | **47** |
| **QUARANTINE** | `scan_status` or `trading_status = NEEDS_REVIEW`; or >7 days old with **no** `PROVEN_STARTED`/`communityInspectionStarted` attempt and no claim in the last 7 days | **734** (727 ancient + 7 human review) |
| **RECOVERABLE** | Recent job, recent claim, or affirmative started-work evidence | **1,735** (1,293 started + 442 recent) |

Channel-terminal Discord closures remain owned by the existing Phase 0 zombie
reconciliation (`phase0ZombieReconciliation.ts`), which already checks newer
retry-owning observations and the URL work ledger. Run it alongside the soak;
it proposed 5 closures at baseline.

The started-work proof matters: historical attempt logs may carry
`communityInspectionStarted` without a `failure_work_started_evidence` value.
Those jobs are **not** ancient no-progress jobs and are kept recoverable.

## Quarantine semantics

Quarantine is a **reversible scheduling action**, not a deletion or a rewrite:

- the job stays `PENDING`; payload, attempts, channel, observations, priority,
  and attempt history are untouched;
- `retry_backlog_triage` records the reason, bounded evidence, original
  priority, original `run_after`, and the deferred-until timestamp;
- the apply sets only `run_after=now()+30 days`; the existing claim query
  (`run_after<=now()`) skips it; no claim-code change is needed;
- the original priority is unchanged, so when the deferral expires the job
  returns at its normal priority (subject to the normal queue order);
- the original values are preserved for a bounded undo.

Terminal rows close the job with append-only
`closed_reason='RETRY_TRIAGE_TERMINAL'`, `closed_evidence`
(bucket/reason/evidence/actor), `closed_by`, and `closed_at`. The evidence table
is append-only except for the one-way `undone_at`/`undone_by` marker.

## Apply and undo procedure

1. Read-only report (one page at a time):

   ```bash
   npm run phase2:retry-triage -- --include-rows
   npm run phase2:retry-triage -- --cursor=<nextCursor> --include-rows
   npm run phase2:retry-triage -- --check
   ```

2. Review the terminal/quarantine lists and evidence.
3. Bounded apply, first with a small batch:

   ```bash
   npm run phase2:retry-apply -- --apply --actor=operator@example \
     --max-actions=100 --max-scan=500 --include-rows
   ```

4. Continue with `--cursor=<nextCursor>` only when the batch applied every
   eligible action in its examined window and the report does not warn
   `action_limit_reached` or `cursor_not_advanced_pending_actions`.
   `--max-actions` is capped at 500; applied rows are excluded from subsequent
   scans. If either warning is present, re-run **without** a cursor so the
   remaining eligible rows in that window are not skipped. The cursor is meant
   to page past windows that contain only non-actionable rows.

   `candidate_scan_limit_reached` means the scan window was full; use
   `nextCursor` only if neither pending-action warning is present. The apply
   probes beyond a full page with an unlocked query, so it never locks more
   than `--max-scan` jobs.
5. To reverse a mistaken quarantine (while it still carries the exact
   deferred `run_after`):

   ```bash
   npm run phase2:retry-apply -- --undo --actor=operator@example \
     --max-actions=100 --include-rows
   ```

   Undo restores `original_run_after`, records `undone_at`/`undone_by`, and
   refuses to overwrite a job whose queue state changed after apply.
6. Optionally close the Phase 0 zombie proposals with the existing operator
   procedure.
7. Run the soak report below.

The apply requires `--apply` **and** a non-empty `--actor`; undo requires
`--undo` **and** an actor. Dry-run is the default and writes nothing. A failure
rolls the whole batch back. Apply and undo are mutually exclusive.

After the 30-day deferral expires, a quarantined job becomes claimable again at
its original priority. The triage row remains as history and the job is not
automatically re-triaged. Undo remains available while the job still carries
the exact deferred `run_after` (including after expiry); after that, treat the
job as normal queue work. Undo is a one-way correction: it restores the original
`run_after`, records the actor, and the quarantined row is not re-applied by an
automated re-triage. For channel-terminal evidence after an undo, use the
existing Phase 0 zombie apply; otherwise review the job manually.

## Soak verification

After applying:

- active (claimable) retry backlog: expected ~1,735 recoverable + any
  unclassified rows; quarantine removes ~734 ancient/no-progress jobs from the
  active prefix;
- quarantined rows: recorded in `retry_backlog_triage` with `deferred_until`;
- terminal closures: `jobs.status='COMPLETED'` with `closed_evidence`;
- Phase 2 gates: rendered crawls/hour 40 nominal / 48 emergency, DISCOVERY
  share ≥35%, gate wait ≤90s;
- retry attempt p50/p90 and heartbeat-expired count;
- no mass deletion: `jobs` rows are never deleted; quarantine is reversible.

Useful read-only SQL:

```sql
SELECT bucket, count(*) FROM retry_backlog_triage GROUP BY 1;
SELECT count(*) FROM jobs
 WHERE type='RETRY_COMMUNITY_ACQUISITION' AND status='PENDING'
   AND run_after<=now();
SELECT count(*) FROM jobs
 WHERE type='RETRY_COMMUNITY_ACQUISITION' AND status='PENDING'
   AND run_after>now();
```

## Non-goals

- No mass deletion, payload rewrite, or historical observation rewrite.
- No new browser slot, worker pool, or server upgrade.
- No change to retry policy, lane admission, or the 60s crawl budget.
