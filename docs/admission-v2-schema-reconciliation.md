# Admission V2 evaluation-schema reconciliation

**Review date:** 2026-08-09  
**Scope:** schema and data compatibility only  
**Production changes:** none

## Executive conclusion

The Admission V2 POC is **not using renamed or outdated table names**. The
repository contains two separate, additive evaluation systems with different
subjects and purposes:

1. migration 026 evaluates **query/terminology candidate keys** from aggregate
   cached search observations and writes `candidate_evaluation_*` records;
2. migration 037 evaluates **creator classification decisions** from labeled,
   propensity-sampled, diagnostic-pinned examples and writes
   `decision_evaluation_*` records.

The tables reported in Railway are the older migration-026 query-catalog control
plane. They are not equivalents of the migration-037 creator decision-evaluation
tables and cannot supply Admission V2's creator identity, label, diagnostic,
Creator Intelligence, or evidence-coverage inputs. Their presence alongside the
absence of `decision_evaluation_datasets` is evidence of deployment-schema lag or
an environment running an earlier migration set, not evidence that the repository
renamed the newer schema.

Applying missing DDL alone would create empty tables and would not make the
evaluation executable. The minimum safe next step is to reconcile the deployed
`schema_migrations` ledger on an isolated database restore, then inventory whether
the later immutable observations exist anywhere. If they never accumulated, the
current Railway data is insufficient and real creator-level shadow history must
be collected before Admission V2 can be evaluated.

## 1. Repository chronology proves two schemas, not a rename

Migration filenames are ordered and the PostgreSQL runner applies each numbered
file once using `schema_migrations`. Migration 026 creates the tables observed in
Railway. Migration 037 later creates `decision_evaluation_datasets` and its
supporting creator-decision evaluation tables. Migration 036 first adds production
classification diagnostics; migrations 055–057 later add immutable evidence
documents/assertions, coverage snapshots, and creator-focus snapshots.

No migration drops, renames, or transforms the migration-026 tables into the
migration-037 tables. Both sets remain referenced by separate runtime modules:

- `server/offlineEvaluation.ts` owns the migration-026 query-candidate evaluator;
- `server/decisionEvaluation.ts` owns the migration-037 labeled decision evaluator;
- `server/candidateAdmission/offlineV2Store.ts` intentionally consumes the latter
  plus migration-056/057 snapshots.

Consequently, changing the POC's SQL to the older table names would not be schema
reconciliation. It would silently substitute a different experimental unit and
answer a different question.

## 2. Table-by-table mapping

| Admission V2 expected object | Railway-reported object that looks similar | Equivalent? | Reason |
| --- | --- | --- | --- |
| `decision_evaluation_datasets` | `candidate_evaluation_runs` | **No** | A run stores a caller-supplied dataset version/checksum and query-policy execution metadata. It does not materialize or identify creator examples, labels, splits, or diagnostics. |
| `decision_evaluation_examples` | `candidate_evaluation_results` | **No** | Results are aggregated per `candidate_key`, country, and lane with `ACCEPT`/`REJECT`/`INSUFFICIENT_EVIDENCE`. Admission V2 needs one labeled creator/diagnostic example with a TEST split and inclusion probability. |
| `evaluation_sampling_policies` | `evaluation_policy_versions` | **No** | The older policy contains thresholds for query-result volume, precision, verified quality, coverage gain, quota cost, and review cost. The newer policy defines retrieval-boundary probability sampling and strata. |
| `evaluation_cohort_assignments` | no migration-026 equivalent | **Missing** | Migration 026 has no channel assignment, randomized inclusion value, sampling cohort, or inclusion propensity. |
| `evaluation_ground_truth_labels` | `candidate_evaluation_results.decision` | **No; label data missing** | A policy output is not human/adjudicated ground truth. The older schema has no creator channel label, provenance, review decision, disagreement, or evidence snapshot. |
| `production_classification_diagnostics` | no migration-026 equivalent | **Missing unless migration 036 exists independently** | Cached candidate observations contain search aggregates, not an immutable production classification input/decision for a channel. |
| `creator_focus_classification_snapshots` | no migration-026 equivalent | **Missing unless migration 057 exists independently** | Query-candidate metrics contain no creator hypothesis distribution, lower confidence bound, staged language/temporal report, or classifier/policy version. |
| `evidence_coverage_snapshots` | `offline_cached_observations.coverage_keys` | **No** | Coverage keys measure incremental terminology/catalog coverage. Admission coverage pins document counts, languages, temporal envelope, independent source families, provider availability, acquisition failures, completeness, diagnostic lineage, and policy version. |
| `decision_benchmark_runs` | `candidate_evaluation_runs` + `candidate_evaluation_results` | **No** | Both record offline outcomes, but the metric populations and policies differ. Query catalog results cannot be used to calculate creator precision/recall or Admission V2 workload projections. |
| Admission V2 read-only control | `offline_evaluation_controls` | **Not an input equivalent** | This control disables provider access and publication for the query-catalog worker. It provides a useful safety pattern but contains no dataset or creator evidence. Admission V2 already enforces a read-only transaction directly. |

### What the migration-026 data actually contains

`offline_cached_observations` records `candidate_key`, country, lane, aggregate
counts (`results`, `relevant`, `verified`), terminology coverage keys, and cost
proxies. The evaluator partitions those observations by country/lane and decides
whether a query candidate meets catalog thresholds. It never reads a channel ID,
human creator label, production classification diagnostic, creator-focus snapshot,
or evidence-coverage snapshot.

That schema may help evaluate Query Intelligence search terms. It cannot determine
whether Admission V2 withholds non-trading creators while retaining genuine
trading creators.

## 3. Genuinely missing schema and data

### Schema absence to verify

The authoritative check is the deployed migration ledger, not a partial table
listing:

```sql
BEGIN TRANSACTION READ ONLY;

SELECT version, name, applied_at
FROM schema_migrations
WHERE version IN (26, 36, 37, 55, 56, 57, 63)
ORDER BY version;

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'evaluation_cohort_assignments',
    'evaluation_ground_truth_labels',
    'decision_evaluation_datasets',
    'decision_evaluation_examples',
    'production_classification_diagnostics',
    'evidence_documents',
    'evidence_assertions',
    'evidence_coverage_snapshots',
    'creator_focus_classification_snapshots'
  )
ORDER BY table_name;

ROLLBACK;
```

If ledger version 037 is recorded but its tables are absent, the database has a
broken migration invariant and must be investigated rather than repaired ad hoc.
If the ledger stops before 037, it confirms deployment-schema lag. If 037 exists
but 056/057 do not, datasets may be sealable for the older decision benchmark but
will still be unusable by Admission V2.

### Data Admission V2 genuinely requires

Even when all tables exist, the following joined historical facts must be nonzero:

1. selected evaluation cohort assignments with known inclusion probability;
2. non-disputed creator ground-truth labels with review/adjudication provenance;
3. production classification diagnostics created no later than their labels;
4. sealed TEST examples referencing those three facts;
5. creator-focus snapshots for the exact example diagnostics, matching the POC's
   classifier and policy versions and observed no later than the dataset cutoff;
6. evidence-coverage snapshots for those diagnostics, matching the POC's coverage
   policy and observed no later than the cutoff;
7. sufficient genuine and non-trading effective sample size across the required
   country, language, acquisition-source, and time cells.

The Railway-reported migration-026 tables supply none of items 1–6. A populated
query evaluation run does not reduce this gap.

## 4. Sufficiency determination

### Are the reported existing tables sufficient?

**No.** There is no lossless mapping or SQL view that can turn aggregate query
candidate results into creator-level counterfactual examples. Specifically:

- `candidate_key` is not a stable creator/channel identity;
- `ACCEPT`/`REJECT` is a catalog policy decision, not ground truth;
- aggregate counts cannot reconstruct per-creator errors;
- no inclusion propensity exists, so representative weighted metrics cannot be
  computed;
- no creator-focus distribution or staged classification exists;
- terminology coverage cannot stand in for evidence completeness;
- precision, genuine-creator recall, false-positive reduction, and projected
  enrichment/review reductions require creator-level paired decisions and labels.

An adapter that merely aliases columns would manufacture semantics and invalidate
the evaluation. The POC should continue to fail closed when the later tables or
snapshots are absent.

### Is the POC itself pointed at the correct repository schema?

**Yes.** Its table names match migration 037, its diagnostic dependency matches
migration 036, and its creator-focus/coverage dependencies match migrations 057
and 056. The mismatch is between the checked-in repository migration level and
the observed deployed database, not between the loader and current repository
source.

## 5. Minimum safe reconciliation

No production feature, serving path, feature flag, or runtime query should change
as part of schema discovery. Proceed in this order:

### Step 1 — prove the migration state read-only

Run the ledger/catalog query above using a dedicated `SELECT`-only role. Also
record the deployment commit/image version. This distinguishes an old deployment,
a database attached to the wrong service/environment, and a broken migration
ledger.

### Step 2 — use an isolated restore

Restore the Railway database into a separate, network-restricted evaluation
database. Do not start the application against production merely to “catch up”:
the repository migration runner applies every unapplied numbered migration, and
this checkout contains migrations through 080, far beyond the four tables under
investigation.

On the isolated restore, apply the repository migrations in order and verify the
ledger and constraints. This safely proves DDL compatibility, but it will not
create historical observations.

### Step 3 — inventory usable facts, not empty tables

Measure assignments, labels, diagnostics, sealed examples, exact-version focus
snapshots, and exact-version coverage snapshots at common cutoffs. If a backup or
another environment already contains these immutable rows, copy/restore that
database as a unit and verify stored checksums; then the existing Admission V2 CLI
can run unchanged and read-only.

### Step 4 — choose the only evidence-valid branch

- **Later immutable history exists elsewhere:** restore it into the isolated
  evaluator, verify lineage/checksums, and run the POC unchanged.
- **Prerequisites exist but no seal exists:** invoke the existing Phase B sealer
  once on the isolated database with chronological boundaries and a unique dataset
  key, then run the POC read-only.
- **Later history never existed:** do not translate migration-026 results, invent
  labels, or synthesize snapshots. Admission V2 remains blocked until the existing
  non-authoritative Phase B observers prospectively accumulate real assignments,
  reviews, diagnostics, focus snapshots, and coverage snapshots. Enabling that
  collection would require a separately controlled operational change; it is not
  performed or proposed as an implicit part of this reconciliation.

## 6. Minimum repository change recommendation

For the immediate reconciliation, **no POC code change is justified**. The minimum
work is operational inspection plus an isolated restore. After the database facts
are known:

- do not repoint `offlineV2Store.ts` at migration-026 tables;
- do not add compatibility views that misrepresent query candidates as creators;
- do not apply ad hoc table creation directly to production;
- do not modify the migration ledger manually;
- do not run the current application image against production solely to obtain
  missing tables.

If an isolated restore proves that valid creator-level facts exist in some other
historical shape, the smallest acceptable code change would be a separate,
read-only **offline export adapter** that emits the existing
`OfflineAdmissionExample` contract with explicit lineage and checksum validation.
No such equivalent is present in the reported migration-026 schema, so there is
currently no evidence supporting that change.

## Final finding

The database did not evolve *from* `decision_evaluation_*` *to*
`candidate_evaluation_*`. The repository evolved in the opposite chronological
direction and retained both systems for different purposes. The observed Railway
schema exposes the earlier query-catalog evaluator but apparently lacks the later
creator-decision evaluation plane required by Admission V2. Until the migration
ledger and other environments/backups are inventoried, the exact cause is not
fully proven; however, the reported tables are definitively not sufficient to run
the Admission V2 semantic evaluation.
