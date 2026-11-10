# Phase 2 Option C — retry backlog triage and soak

**Status:** Unit 4 implemented (read-only classifier, bounded reversible apply,
soak plan).
**Tracking:** #616.

## Baseline

Read-only production profile before Unit 4:

- **2,526** pending `RETRY_COMMUNITY_ACQUISITION` jobs for 2,526 distinct
  channels (no duplicate channel jobs).
- **2,024** had `attempts=0`; 1,996 were 7–30 days old and 205 were >30 days
  old by `first_enqueued_at`.
- 1,070 had never been claimed; 1,371 had only claims older than 7 days with no
  proven started work.
- Existing Phase 0 zombie reconciliation proposed only **5** channel-terminal
  closures; the rest were not provably terminal.

## Buckets

The classifier is pure and deliberately conservative: **age alone never
closes a job**.

| Bucket | Rule | Baseline |
|---|---|---:|
| **TERMINAL** | `scope_eligibility=OUT_OF_SCOPE`; `scan_status=SKIPPED_LOW_AUDIENCE`; terminal country/trading state; or `attempts >= max_attempts` | **46** |
| **QUARANTINE** | `scan_status=NEEDS_REVIEW`; or >7 days old with no proven started work (`failure_work_started_evidence=PROVEN_STARTED`) and no claim in the last 7 days | **2,075** |
| **RECOVERABLE** | Recent job, recent claim, or affirmative started-work evidence | **402** |

Channel-terminal Discord closures remain owned by the existing Phase 0 zombie
reconciliation (`phase0ZombieReconciliation.ts`), which already checks newer
retry-owning observations and the URL work ledger. Run it alongside the soak;
it proposed 5 closures at baseline.

## Quarantine semantics

Quarantine is a **reversible scheduling action**, not a deletion or a rewrite:

- the job stays `PENDING`; payload, attempts, channel, and observations are
  untouched;
- `retry_backlog_triage` records the reason, bounded evidence, original
  priority, original `run_after`, and the deferred-until timestamp;
- the apply sets `priority=-1000` and `run_after=now()+30 days`;
- the existing claim query (`run_after<=now()`) skips it; no claim-code change
  is needed;
- the original values are preserved for an operator reversal.

Terminal rows close the job with append-only `closed_reason='CHANNEL_TERMINAL'`,
`closed_evidence` (bucket/reason/evidence/actor), `closed_by`, and `closed_at`,
mirroring the Phase 0 closure contract.

## Apply procedure

1. Read-only report:

   ```bash
   npm run phase2:retry-triage -- --include-rows
   npm run phase2:retry-triage -- --check
   ```

2. Review the terminal/quarantine lists and evidence.
3. Bounded apply, first with a small batch:

   ```bash
   npm run phase2:retry-apply -- --apply --actor=operator@example \
     --max-actions=100 --max-scan=500 --include-rows
   ```

4. Repeat until the plan is exhausted. `--max-actions` is capped at 500;
   applied rows are excluded from subsequent scans.
5. Optionally close the Phase 0 zombie proposals with the existing operator
   procedure.
6. Run the soak report below.

The apply requires `--apply` **and** a non-empty `--actor`. Dry-run is the
default and writes nothing. A failure rolls the whole batch back.

## Soak verification

After applying:

- active (claimable) retry backlog: expected ~402 recoverable + any unclassified
  rows, down from ~2,480;
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
