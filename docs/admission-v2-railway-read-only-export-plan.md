# Admission V2 Railway read-only export and restore plan

**Prepared:** 2026-08-09  
**Scope:** operational plan only  
**Permitted source operations:** metadata reads, `SELECT`, consistent logical dump,
or provider-managed backup restore  
**Prohibited:** production migrations, application startup against production,
feature/settings changes, writes, backfills, synthetic labels, and serving changes

## 1. Objective and stop conditions

The objective is to place an exact historical copy of the required immutable
creator-evaluation data in a network-isolated PostgreSQL database, give the POC a
`SELECT`-only account, and run the existing CLI by sealed dataset UUID.

Stop immediately if any of these conditions occurs:

- the source identity or environment cannot be proven;
- the supplied role has write privileges or cannot force read-only transactions;
- the source lacks the required tables or a sealed dataset;
- the export cutoff/checksum cannot be recorded;
- the restored constraints, row counts, or checksums differ from the source;
- the evaluator would need to contact a provider or production service;
- exact-version Creator Intelligence or coverage snapshots are absent;
- production application credentials would have to be installed in the evaluator.

An empty schema is not an evaluation corpus. Do not apply migrations to production
or create placeholder rows merely to make the loader start.

## 2. Roles and environments

Use four separate identities:

| Identity | Minimum privilege | Must not have |
| --- | --- | --- |
| Railway backup operator | Create/restore a backup into a new service | Application deployment or data-edit access unless separately required |
| Source inventory/export role | `CONNECT`, schema `USAGE`, and `SELECT` on required tables; read-only default | `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, DDL, ownership, replication administration |
| Isolated restore owner | Create the evaluator database and restore objects | Any route or credential to production |
| Admission evaluator role | `CONNECT`, schema `USAGE`, `SELECT`; read-only default | Object ownership, DDL/DML, provider secrets, production API credentials |

Use a new isolated Railway project/environment or a separately controlled
PostgreSQL instance. It must not share application services, workers, cron jobs,
queues, public routes, or environment-variable groups with production. Egress
should be disabled except for the operator's administration path. Never deploy the
application server or worker to it; only invoke the offline CLI.

## 3. Phase A — identify every possible source read-only

### A1. Record source identities

For production, staging, each read replica, and each restored backup, record:

- Railway project, environment, PostgreSQL service, and backup/restore timestamp;
- database host fingerprint without credentials, database name, PostgreSQL
  version, and current database time;
- application release/commit associated with the data period;
- whether the target is primary, replica, or isolated restore;
- operator, ticket/change reference, and investigation timestamp.

Do not paste connection URLs into tickets or shell history. Use a temporary
`PGPASSFILE` with mode `0600`, a secret manager, or Railway variable injection.

### A2. Confirm the session is read-only

Connect with `psql` and run:

```sql
BEGIN TRANSACTION READ ONLY;

SELECT current_database(), current_user, version(), now(),
       current_setting('transaction_read_only') AS transaction_read_only,
       pg_is_in_recovery() AS is_replica;

SELECT has_database_privilege(current_user, current_database(), 'CREATE')
         AS can_create_in_database,
       has_schema_privilege(current_user, 'public', 'CREATE')
         AS can_create_in_public;

ROLLBACK;
```

`transaction_read_only` must be `on`. Prefer a replica or restored backup. If the
role can create objects or perform DML, replace it with a dedicated least-privilege
role before continuing; do not rely only on operator discipline.

### A3. Reconcile the migration ledger and tables

Run the following in another read-only transaction:

```sql
BEGIN TRANSACTION READ ONLY;

SELECT version, name, applied_at
FROM schema_migrations
WHERE version IN (36, 37, 55, 56, 57, 63)
ORDER BY version;

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'evaluation_sampling_policies',
    'evaluation_cohort_assignments',
    'evaluation_ground_truth_labels',
    'decision_evaluation_datasets',
    'decision_evaluation_examples',
    'decision_benchmark_runs',
    'calibration_artifacts',
    'production_classification_diagnostics',
    'creator_type_adjudications',
    'evidence_documents',
    'evidence_assertions',
    'evidence_coverage_snapshots',
    'creator_focus_policy_versions',
    'creator_focus_classification_snapshots'
  )
ORDER BY table_name;

ROLLBACK;
```

If migration 037 is recorded but its tables are absent, quarantine that source as
a broken migration invariant. If 037, 056, or 057 is absent, check an older/newer
backup or staging source; applying those migrations now would not manufacture the
historical observations.

## 4. Phase B — qualify the corpus before exporting

### B1. Inventory sealed datasets

```sql
BEGIN TRANSACTION READ ONLY;

SELECT d.id, d.dataset_key, d.version, d.status, d.cutoff_at,
       d.example_count, d.checksum, d.created_at,
       count(*) FILTER (WHERE e.split = 'TRAIN') AS train_count,
       count(*) FILTER (WHERE e.split = 'CALIBRATION') AS calibration_count,
       count(*) FILTER (WHERE e.split = 'TEST') AS test_count
FROM decision_evaluation_datasets d
LEFT JOIN decision_evaluation_examples e ON e.dataset_id = d.id
GROUP BY d.id
ORDER BY d.cutoff_at DESC, d.id;

ROLLBACK;
```

Reject zero-example, zero-TEST, retired, or checksum-unverifiable candidates. Keep
each candidate UUID and cutoff for the exact loader-compatibility query.

### B2. Use the POC's exact pinned versions

The loader imports its expected versions from the checked-out code. Record them
from the exact commit that will run the evaluation; do not guess or select the
latest database version. Supply those values as `:focus_classifier_version`,
`:focus_policy_version`, and `:coverage_policy_version` below.

```sql
BEGIN TRANSACTION READ ONLY;

WITH test AS (
  SELECT e.*
  FROM decision_evaluation_examples e
  WHERE e.dataset_id = :'dataset_id'::uuid AND e.split = 'TEST'
), eligible AS (
  SELECT t.example_key, t.channel_id, t.ground_truth_label,
         t.inclusion_probability, t.segment,
         f.id AS focus_id, c.id AS coverage_id
  FROM test t
  JOIN decision_evaluation_datasets d ON d.id = t.dataset_id
  LEFT JOIN LATERAL (
    SELECT f.id
    FROM creator_focus_classification_snapshots f
    WHERE f.classification_diagnostic_id = t.decision_diagnostic_id
      AND f.observed_at <= d.cutoff_at
      AND f.classifier_version = :'focus_classifier_version'
      AND f.policy_version = :'focus_policy_version'
    ORDER BY f.observed_at DESC, f.id DESC LIMIT 1
  ) f ON true
  LEFT JOIN LATERAL (
    SELECT c.id
    FROM evidence_coverage_snapshots c
    WHERE c.classification_diagnostic_id = t.decision_diagnostic_id
      AND c.observed_at <= d.cutoff_at
      AND c.policy_version = :'coverage_policy_version'
    ORDER BY c.observed_at DESC, c.id DESC LIMIT 1
  ) c ON true
)
SELECT count(*) AS test_examples,
       count(*) FILTER (WHERE focus_id IS NOT NULL
                         AND coverage_id IS NOT NULL) AS eligible_examples,
       count(*) FILTER (WHERE focus_id IS NULL) AS missing_focus,
       count(*) FILTER (WHERE coverage_id IS NULL) AS missing_coverage,
       count(*) FILTER (WHERE ground_truth_label = 'TRADING_CONFIRMED')
         AS genuine_examples,
       count(*) FILTER (WHERE ground_truth_label = 'NON_TRADING')
         AS non_trading_examples,
       count(DISTINCT segment->>'country') AS countries,
       count(DISTINCT segment->>'language') AS languages,
       count(DISTINCT segment->>'discoveryOrigin') AS acquisition_sources
FROM eligible;

ROLLBACK;
```

Also export grouped counts by `segment->>'country'`, `language`, and
`discoveryOrigin`, plus minimum/maximum observation timestamps. Do not export
channel names or evidence payloads into an operator report.

Proceed only if exact-version evidence eligibility is at least 90%. Raw counts do
not prove effective sample size; the POC will calculate it from the recorded
inclusion probabilities and requires at least 30 genuine creators and at least 30
baseline false-positive non-trading creators for its central assessment.

## 5. Phase C — preferred Railway backup restore

Provider-managed restoration is preferred because it minimizes load on the live
primary and preserves a database-wide point-in-time image.

1. Select a backup timestamp at or after the chosen dataset cutoff and dataset
   creation time. The backup must contain the sealed header and all referenced
   snapshots, not merely observations before the cutoff.
2. Restore the backup to a **new PostgreSQL service in the isolated evaluation
   project/environment**. Never restore over production or staging.
3. Do not attach application services or shared variables to the restored service.
4. Rotate/generated restore credentials; do not copy production application
   credentials into the evaluator.
5. Restrict network access and create the evaluator role described below.
6. Repeat Phases A and B against the restored database.
7. Compare migration ledger, dataset header, example counts, and stored dataset
   checksum with the source inventory. A backup from before dataset creation is
   unusable even if it contains underlying observations.

Railway dashboard labels and backup capabilities can vary by plan and current
product version. Before execution, the operator must follow the currently published
Railway backup/restore procedure and retain the provider's restore completion
record. The safety invariants above remain mandatory regardless of UI workflow.

## 6. Phase D — fallback consistent logical export

Use this only when no provider-managed isolated restore is available. Prefer a
read replica. A full database dump is safer than a hand-selected table dump because
the examples have foreign keys and the audit depends on policy, label, diagnostic,
and snapshot lineage.

### D1. Prepare secure local paths

```bash
umask 077
mkdir -p "$EVAL_EXPORT_DIR"
test -d "$EVAL_EXPORT_DIR"
```

Store `SOURCE_DATABASE_URL` only in a secret-injected environment or protected
password file. Ensure the export volume is encrypted and has enough free space.

### D2. Create a consistent read-only custom dump

```bash
pg_dump "$SOURCE_DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --serializable-deferrable \
  --file="$EVAL_EXPORT_DIR/admission-v2-source.dump"

sha256sum "$EVAL_EXPORT_DIR/admission-v2-source.dump" \
  > "$EVAL_EXPORT_DIR/admission-v2-source.dump.sha256"
pg_restore --list "$EVAL_EXPORT_DIR/admission-v2-source.dump" \
  > "$EVAL_EXPORT_DIR/admission-v2-source.contents"
```

`pg_dump` takes a consistent logical snapshot and does not modify source rows, but
it acquires read locks and consumes source I/O. Schedule it in a low-traffic window,
set operator-side connection/statement limits where supported, monitor database
load, and abort on production impact. Do not use `--clean`, `--create`, or any
command that targets the source for restore.

If policy forbids a full dump because unrelated personal data would be copied,
create a separately reviewed allow-listed dump that includes the required tables
and every referenced dependency. Do not improvise that list during the operation;
validate foreign-key closure on an isolated rehearsal first.

### D3. Transfer safely

- encrypt the dump before transfer with the organization's approved mechanism;
- use an access-controlled artifact location with expiration and audit logging;
- transmit the checksum through a separate trusted channel;
- never commit the dump, contents listing, credentials, or POC JSON to Git;
- delete temporary plaintext and revoke transfer access after verified restore.

## 7. Phase E — restore into the isolated evaluator

### E1. Restore as an isolated owner

Create an empty database owned by the restore administrator, then:

```bash
sha256sum --check "$EVAL_EXPORT_DIR/admission-v2-source.dump.sha256"

pg_restore \
  --dbname="$RESTORE_ADMIN_DATABASE_URL" \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  --single-transaction \
  "$EVAL_EXPORT_DIR/admission-v2-source.dump"
```

The destination must be empty. Do not run repository migrations, seeders,
application startup, queues, or workers after restoration.

### E2. Create a fail-closed evaluator role

Run this only on the isolated destination as its administrator, substituting a
secret-managed password:

```sql
CREATE ROLE admission_v2_evaluator LOGIN PASSWORD :'generated_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE admission_v2_evaluator SET default_transaction_read_only = on;
ALTER ROLE admission_v2_evaluator SET statement_timeout = '10min';
GRANT CONNECT ON DATABASE evaluation_restore TO admission_v2_evaluator;
GRANT USAGE ON SCHEMA public TO admission_v2_evaluator;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO admission_v2_evaluator;
REVOKE CREATE ON SCHEMA public FROM admission_v2_evaluator;
```

Do not grant default privileges unnecessarily; this database is frozen for one
evaluation. Verify that a read succeeds and a disposable write inside a rolled-back
transaction is rejected by privilege/read-only enforcement. Do not attempt that
negative check on production.

## 8. Phase F — integrity and privacy validation

Before running Admission V2:

1. repeat the Phase A migration/table inventory on the restore;
2. repeat the exact Phase B dataset-eligibility query;
3. compare source and restore counts for every required table;
4. compare each dataset UUID, cutoff, definition, checksum, and example count;
5. verify every example's diagnostic, assignment, and label foreign key resolves;
6. verify focus/coverage observations selected by the loader are no later than the
   sealed cutoff and match the checked-out constants;
7. verify the evaluator session reports `transaction_read_only = on`;
8. scan the evaluation host for production API/provider credentials and remove any;
9. record retention deadline, authorized analysts, output location, and destruction
   procedure for creator evidence and channel identifiers.

Any mismatch blocks execution. Do not “repair” immutable rows or rewrite stored
checksums.

## 9. Phase G — execute the existing POC only

Pin the repository commit and dependencies used for the run. Set `DATABASE_URL` to
the isolated evaluator role, never the source:

```bash
export DATABASE_URL="$ISOLATED_EVALUATOR_DATABASE_URL"
npm run admission:v2-poc -- "$SEALED_DATASET_UUID" \
  > "$CONTROLLED_OUTPUT_DIR/admission-v2-$SEALED_DATASET_UUID.json"
sha256sum "$CONTROLLED_OUTPUT_DIR/admission-v2-$SEALED_DATASET_UUID.json"
```

Retain:

- source environment and backup/restore identity;
- source backup timestamp and logical export checksum, if used;
- Git commit and dependency-lock checksum;
- dataset UUID/key/version/cutoff/checksum;
- imported classifier, focus-policy, coverage-policy, POC-policy, and report versions;
- restored row-count reconciliation;
- evaluator output checksum and access-controlled report.

Run the same dataset twice and require identical report input/output checksums.
Never enable provider access, application serving, jobs, dashboard routes, review
materialization, or promotion from this environment.

## 10. Teardown and rollback

Because production is never modified, rollback is containment and destruction:

1. stop evaluator sessions;
2. revoke the evaluator login and transfer access;
3. retain only approved aggregate/checksummed outputs under the evaluation policy;
4. securely delete local plaintext dumps and temporary password files;
5. expire encrypted transfer artifacts;
6. destroy the isolated database/project at the approved retention deadline;
7. retain an audit record of source, restore, checksums, operators, commands,
   results, and destruction confirmation—without credentials or raw evidence.

If source load rises during logical export, cancel `pg_dump`; its read-only
transaction leaves no data rollback to perform. If restore or integrity validation
fails, destroy the destination and repeat from a newly checksummed source artifact.

## 11. Decision outcomes

- **Qualified corpus found and reconciled:** run the unchanged POC on the isolated
  database and proceed only to semantic evaluation reporting.
- **Tables exist but no eligible sealed dataset:** inspect another backup. Do not
  seal or backfill production as part of this access task.
- **No backup contains the later immutable history:** stop. Prospective Phase B
  shadow accumulation is required and must be separately authorized.
- **Corpus exists but is underpowered or unrepresentative:** the POC may run, but
  its conclusion must be `INSUFFICIENT_EVIDENCE`; do not promote it.

This plan provides data access only. It grants Admission V2 no production
authority and makes no production system change.
