# Rollback proof — migrations 146/147 (2026-10-19)

Status: **PASS.** GitHub Actions run
[39472633816](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39472633816)
(branch `phase1-hardening`, head `89974f8`) is green on a disposable
`postgres:17` service container. It verifies the current fixes: numeric
`<=145` pre-state selection, preservation of the pre-existing migration-130
`youtube-innertube` provider row, ledger-row guard, and `ON_ERROR_STOP`.
Earlier run
[39330317684](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39330317684)
(head `ee5d172`) was the prior historical proof; 39320564700/head `92686a5`
used the older pre-rebase lineage 144. Production untouched; scratch database
only.

## Why CI (environment note)

This sandbox is a proot/Termux container where PostgreSQL's shared-memory
probe kills the process tree (`initdb` and postmaster both abort the session
at "selecting default shared_buffers"). Local Postgres cannot run here.
GitHub Actions with a `postgres:17` service container is the existing
approved disposable pattern (used by `corpus-claim-budget-pg.yml` and
`research-bootstrap-e2e.yml`); the rollback proof reuses it.

## Procedure executed by `.github/workflows/phase1-rollback-proof.yml`

1. Create scratch DB `tde_rollback`; `schema_migrations` bootstrap mirrors
   `scripts/runMigrations.ts`.
2. Apply migrations **001–145 only** (runner semantics: per-file transaction
   + version row). Captured: `pre_state_max_version=145`.
3. Capture pre-state: staging-table constraint definitions + full
   `pg_dump --schema-only`.
4. Apply **146 + 147** with the same semantics.
5. Verify expected changes: staging checks now admit `EVIDENCE_EXTRACTION`,
   `EVIDENCE_ONLY`, `SEARCH_TERM`; `discovery_probe_ledger` exists with its
   three explicit indexes plus the unique-attempt index;
   `discovery_provider_registry` rows for `evidence_extraction` and
   `youtube-innertube` present; `schema_migrations` rows 146+147 present.
6. Guard test: INSERT one evidence-only staging row, run
   `scripts/rollback_146_147.sql` → must abort with
   `rollback_146_147 blocked: 1 … row(s)`; assert row and ledger still
   present (non-destructive); remove the test row.
7. Run `scripts/rollback_146_147.sql` (observed transcript: `BEGIN → DO → DO
   → DROP TABLE → 9 × ALTER TABLE (constraint restore) → DELETE 1
   (evidence_extraction registry row) → DELETE 0 (migration-130
   youtube-innertube row preserved) → DELETE 2 (schema_migrations 146/147) →
   COMMIT`).
8. Post-rollback verification: `diff` of constraint definitions and of full
   schema dumps must be empty; ledger absent; `evidence_extraction` registry row absent and the
   pre-existing migration-130 `youtube-innertube` row preserved;
   `schema_migrations` rows absent; `max(version)=145`.
9. Re-apply proof: re-apply 146+147 → ledger present → run rollback again →
   transcript identical, using the same per-file transaction/version-row
   semantics as the runner.

## Verdict — byte-identical, zero drift

- `constraints_pre.txt == constraints_final.txt` —
  sha256 `870ec871aa5e364816429333da0409dfe6894bebcadcf6caff04b3af3b8d3dee`
- `schema_pre.sql == schema_final.sql` —
  sha256 `140cc55b19ceb51b5ae654adc08fb74b484fb39cffc00f30b10a7b573eebe7ea`
  (current run; the historical run's dump hash differed, so only the current
  observed value is cited here)
- `constraints_diff.txt` = 0 bytes, `schema_diff.txt` = 0 bytes.
- Guard refusal log: `psql:scripts/rollback_146_147.sql:40: ERROR:
  rollback_146_147 blocked …` (row/ledger preserved; nothing deleted).
- PostgreSQL `17.11`; `pre_state_max_version=145`.

## Evidence inventory

The durable evidence for the current green run is the
`phase1-rollback-proof` GitHub Actions artifact attached to run 39472633816: `server_version.txt`,
`pre_state_max_version.txt`, `constraints_pre.txt`, `constraints_post.txt`,
`constraints_final.txt`, `constraints_diff.txt`, `schema_pre.sql`,
`schema_final.sql`, `schema_diff.txt`, `rollback_guard_blocked.log`,
`rollback_execution.log`, `rollback_second_run.log`.

Earlier failed runs (harness assertion bugs, fixed in `c0dd00f` and
`92686a5`): 39319683794 (index-count assertion), 39320205159 (guard INSERT
missing `canonical_candidate_key`, NOT NULL since migration 113).

## Reproduction

Re-run the workflow from the Actions UI ("Phase 1 rollback proof (146-147)")
or locally on any real Postgres 17:

```
psql "$URL" -f scripts/rollback_146_147.sql   # after 001–147 applied via the runner
```

The script is single-transaction and idempotent; it refuses (non-
destructively) while evidence-only staging rows exist.

## Current fix verification (2026-10-20)

- CI run (success): https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39472633816 · HEAD `89974f8`
- PostgreSQL 17.11; `pre_state_max_version=145`
- Guard refusal preserved: `rollback_146_147 blocked: 1 … row(s)`
- Transcript: `BEGIN → DO → DO → DROP TABLE → 9×ALTER TABLE → DELETE 1 → DELETE 0 → DELETE 2 → COMMIT`
- Re-apply + second rollback identical; `constraints_diff.txt` 0 bytes; `schema_diff.txt` 0 bytes
- Artifacts: `phase1-rollback-proof` artifact on the run above (12 files).

## Historical post-rebase re-verification (Unit 4, 2026-10-19)

The branch was rebased onto `origin/main` `82e60e7` (which includes migration
145). The proof applies the pre-146 lineage `001..145` and asserts
`max(version)=145` both before and after rollback.

- CI run (success): https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39330317684 · HEAD `ee5d172`
- PostgreSQL 17.11; `pre_state_max_version=145`
- Guard refusal preserved: `rollback_146_147 blocked: 1 … row(s)`
- Re-apply + second rollback identical; `constraints_diff.txt` 0 bytes; `schema_diff.txt` 0 bytes
- Artifacts: `phase1-rollback-proof` artifact on that historical run (12 files).
