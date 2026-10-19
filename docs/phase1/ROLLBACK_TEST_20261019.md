# Rollback proof — migrations 146/147 (2026-10-19)

Status: **PASS** — verified on a disposable `postgres:17` service container in
GitHub Actions run [39320564700](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39320564700)
(branch `phase1-hardening`, head `92686a5`). Production untouched; scratch
database only.

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
2. Apply migrations **001–144 only** (runner semantics: per-file transaction
   + version row). Captured: `pre_state_max_version=144`.
3. Capture pre-state: staging-table constraint definitions + full
   `pg_dump --schema-only`.
4. Apply **146 + 147** with the same semantics.
5. Verify expected changes: staging checks now admit `EVIDENCE_EXTRACTION`,
   `EVIDENCE_ONLY`, `SEARCH_TERM`; `discovery_probe_ledger` exists with its
   four explicit indexes; `discovery_provider_registry` row present;
   `schema_migrations` rows 146+147 present.
6. Guard test: INSERT one evidence-only staging row, run
   `scripts/rollback_146_147.sql` → must abort with
   `rollback_146_147 blocked: 1 … row(s)`; assert row and ledger still
   present (non-destructive); remove the test row.
7. Run `scripts/rollback_146_147.sql` (transcript: `BEGIN → DO → DROP TABLE →
   6 × ALTER TABLE (constraint restore) → DELETE 1 (registry row) →
   DELETE 2 (schema_migrations 146/147) → COMMIT`).
8. Post-rollback verification: `diff` of constraint definitions and of full
   schema dumps must be empty; ledger absent; registry row absent;
   `schema_migrations` rows absent; `max(version)=144`.
9. Re-apply proof: re-apply 146+147 → ledger present → run rollback again →
   transcript identical. The version-keyed runner cannot silently skip.

## Verdict — byte-identical, zero drift

- `constraints_pre.txt == constraints_final.txt` —
  sha256 `870ec871aa5e364816429333da0409dfe6894bebcadcf6caff04b3af3b8d3dee`
- `schema_pre.sql == schema_final.sql` —
  sha256 `eb183df144ea35bc8a0bcb6b481c67fb1bd4a77c8ad8d291edcb7835c3527ed7`
- `constraints_diff.txt` = 0 bytes, `schema_diff.txt` = 0 bytes.
- Guard refusal log: `psql:scripts/rollback_146_147.sql:38: ERROR:
  rollback_146_147 blocked …` (row/ledger preserved; nothing deleted).

## Evidence inventory

Artifact `phase1-rollback-proof` (run 39320564700), stored at
`/tmp/opencode/evidence/rollback_unit2/ci-run3/`:
`server_version.txt`, `pre_state_max_version.txt`, `constraints_pre.txt`,
`constraints_post.txt`, `constraints_final.txt`, `constraints_diff.txt`,
`schema_pre.sql`, `schema_final.sql`, `schema_diff.txt`,
`rollback_guard_blocked.log`, `rollback_execution.log`,
`rollback_second_run.log`.

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
