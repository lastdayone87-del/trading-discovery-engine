# Admission V2 sealed-dataset readiness report

**Review date:** 2026-08-09  
**Scope:** data readiness only; no production behavior or schema change  
**Finding:** the repository has the machinery to seal and read an evaluation
dataset, but this checkout does not contain one and the configured historical
PostgreSQL service was not reachable from this environment. Whether qualifying
rows already exist in that service or one of its external backups therefore
remains an operationally verifiable unknown, not an established absence.

## 1. Exact expected location and contract

The authoritative dataset is not a file. It is expected in the PostgreSQL
database selected by `DATABASE_URL`, in these migration-037 tables:

- `decision_evaluation_datasets`: the sealed dataset header, cutoff, definition,
  checksum, count, and creator;
- `decision_evaluation_examples`: immutable membership, time split, segment,
  production decision, label, inclusion probability, and diagnostic lineage;
- `evaluation_cohort_assignments` and `evaluation_ground_truth_labels`: the
  propensity and label records referenced by each example;
- `production_classification_diagnostics`: the exact historical production
  observation referenced by each example;
- `creator_focus_classification_snapshots` and
  `evidence_coverage_snapshots`: the immutable counterfactual inputs required by
  the Admission V2 loader.

The database migration makes evaluation rows immutable with `BEFORE UPDATE OR
DELETE` triggers. The dataset comment explicitly says production serving never
reads it. The offline loader accepts a dataset UUID, opens `BEGIN TRANSACTION
READ ONLY`, reads only `TEST` examples, and requires diagnostic-linked focus and
coverage snapshots observed no later than the dataset cutoff. Missing snapshots
are reported as excluded examples rather than silently manufactured.

There is no repository-defined object-store path, filesystem dataset directory,
or backup naming convention for these datasets. `scripts/phaseBSealBenchmark.ts`
is the only checked-in operational entry point that seals them, and it writes to
the same `DATABASE_URL` through the normal PostgreSQL store.

## 2. What currently exists

### Verified in this checkout

- No sealed dataset export, PostgreSQL dump, JSONL corpus, or benchmark payload is
  tracked in Git or present under the repository data paths.
- The three local `.db` files are legacy stores. String inspection found none of
  the evaluation, creator-focus, or coverage table names. They cannot satisfy the
  immutable lineage contract and must not be treated as evaluation data.
- The previous evaluation attempt reached no database: the configured Railway
  proxy hostname failed DNS resolution with `EAI_AGAIN`. Thus it inventoried zero
  datasets, but did **not** establish that the remote database has zero datasets.
- Repository configuration identifies one database connection contract
  (`DATABASE_URL`). It contains no second environment endpoint, replica, dump
  location, backup credentials, or automated dataset export. Existing repository
  documentation also characterizes Railway backups as externally configured
  infrastructure, not repository-managed artifacts.

### Not verifiable from the repository

The following remain unknown until an authorized operator queries deployment
state:

1. whether production or staging contains rows in
   `decision_evaluation_datasets`;
2. whether unsealed prerequisite history exists in production;
3. whether Railway has a usable point-in-time backup or restored clone containing
   those rows;
4. whether the Phase B controls were active long enough to create representative
   assignments, labels, assertions, focus snapshots, and coverage snapshots.

It would be incorrect to infer either existence or nonexistence in another
environment from source code. Migrations create tables and defaults; they do not
prove that operational observations accumulated.

## 3. Minimum read-only inventory

An operator with deployment access should first run the following against a
read-only replica or an isolated restore. If neither exists, use a dedicated
PostgreSQL role with `CONNECT` and `SELECT` only and force read-only transactions.
Do not use the application role merely because the loader itself is read-only.

```sql
BEGIN TRANSACTION READ ONLY;

SELECT id, dataset_key, version, status, cutoff_at, example_count,
       checksum, created_at
FROM decision_evaluation_datasets
ORDER BY cutoff_at, id;

SELECT d.id,
       count(*) FILTER (WHERE e.split = 'TEST') AS test_examples,
       count(DISTINCT e.segment->>'country') AS countries,
       count(DISTINCT e.segment->>'language') AS languages,
       count(DISTINCT e.segment->>'discoveryOrigin') AS acquisition_sources,
       min(e.observed_at) AS first_observation,
       max(e.observed_at) AS last_observation
FROM decision_evaluation_datasets d
LEFT JOIN decision_evaluation_examples e ON e.dataset_id = d.id
GROUP BY d.id
ORDER BY d.id;

SELECT e.dataset_id,
       count(*) FILTER (WHERE e.split = 'TEST') AS test_examples,
       count(*) FILTER (WHERE e.split = 'TEST' AND f.id IS NOT NULL
                        AND c.id IS NOT NULL) AS admission_v2_eligible
FROM decision_evaluation_examples e
LEFT JOIN LATERAL (
  SELECT id FROM creator_focus_classification_snapshots f
  WHERE f.classification_diagnostic_id = e.decision_diagnostic_id
  ORDER BY f.observed_at DESC, f.id DESC LIMIT 1
) f ON true
LEFT JOIN LATERAL (
  SELECT id FROM evidence_coverage_snapshots c
  WHERE c.classification_diagnostic_id = e.decision_diagnostic_id
  ORDER BY c.observed_at DESC, c.id DESC LIMIT 1
) c ON true
GROUP BY e.dataset_id
ORDER BY e.dataset_id;

ROLLBACK;
```

This establishes existence and rough coverage only. Before evaluation, repeat the
loader's exact version and cutoff predicates and calculate label counts,
propensity-weighted effective sample size, and the country/language/source cells
needed by the evaluation protocol.

### Safest access when a dataset exists

The preferred order is:

1. restore the relevant Railway/PostgreSQL backup into a new, network-restricted
   evaluator database;
2. grant the evaluator a dedicated `SELECT`-only role and set
   `default_transaction_read_only = on` for that role/database;
3. compare dataset and example counts and stored checksums with the source;
4. point only the offline CLI process at the isolated database and run
   `npm run admission:v2-poc -- <dataset-uuid>`;
5. retain the dataset UUID, cutoff, checksums, command version, and JSON output.

A hot standby or private-network read replica is the next-best option. Direct
access to the primary is acceptable only with the dedicated read-only role,
statement timeout, and the loader's existing read-only transaction. Copying only
CSV results is not sufficient: it loses constraints, referenced lineage, and the
snapshot/version selection behavior being evaluated.

## 4. If no sealed dataset exists

### First determine whether valid prerequisite history exists

The sealer does not turn arbitrary channel history into valid evaluation data. An
example exists only where all of the following predate the chosen cutoff:

1. a non-disputed immutable ground-truth label;
2. the latest production diagnostic at or before that label;
3. a selected retrieval-boundary cohort assignment with known, nonzero inclusion
   propensity;
4. a creator-focus snapshot tied to that exact diagnostic and policy version;
5. an evidence-coverage snapshot tied to that exact diagnostic and policy version.

Ground truth is appended after a human approve/reject transaction commits. Cohort
assignment occurs at ingestion only while evaluation sampling is enabled. This is
important: missing historical assignments cannot be reconstructed truthfully from
today's channels because their inclusion probability was never observed. Likewise,
rerunning current creator evidence against old channels would create a new
counterfactual corpus, not the immutable historical evidence required by this POC.

Phase B initially enables sampling, document dual-write, and creator-focus shadow,
but deliberately leaves assertion dual-write off. Assertions can be enabled only
after a passing projection-validation run. Therefore a database may contain
assignments and labels yet still lack usable creator-focus evidence for the same
diagnostics. The inventory must measure the join, not merely table row counts.

### Minimum valid creation process

If the prerequisite join has adequate historical rows, no backfill or runtime
change is needed:

1. restore or clone the source database into an isolated evaluation database;
2. choose chronological `calibrationFrom < testFrom <= cutoffAt` boundaries that
   exclude post-label leakage and retain representative TEST cells;
3. use a new, unique dataset key and run the existing Phase B sealer once against
   the isolated database;
4. record the returned dataset UUID and verify its stored example count/checksum;
5. run Admission V2 read-only against that UUID.

The unique key matters: the schema makes `dataset_key` globally unique even though
the sealing code calculates a next version for a key. Reusing the default key for
a second seal will conflict; use a distinct immutable key per seal rather than
changing the schema as part of this readiness work.

If the prerequisite join is empty or too sparse, the minimum honest process is to
wait for naturally produced, immutable history after all existing Phase B
observers are correctly enabled and validated, and for ordinary human reviews to
produce labels. No labels, identities, snapshots, assignments, or benchmarks
should be invented or retrospectively inferred. Activation of already-built
shadow observers is an operational prerequisite and is outside this report; it
must remain non-authoritative and follow the existing Phase B validation gate.

Once enough elapsed history exists, create the sealed dataset with the existing
sealer. A broad dataset can cover multiple countries, languages, sources, and time
periods through its stored segments; additional seals are needed only when the
evaluation protocol requires independent temporal cohorts. Every seal must use a
new key under the current schema.

## 5. Readiness gates

Admission V2 evaluation is executable only after all gates below pass:

| Gate | Required evidence | Current status |
| --- | --- | --- |
| Database visibility | Read-only inventory output from production replica or isolated restore | Unknown; endpoint unreachable here |
| Sealed dataset | At least one UUID, cutoff, definition, checksum, and nonzero TEST count | Not present locally; remote unknown |
| Sampling validity | Selected assignments with recorded nonzero inclusion propensity | Remote unknown |
| Label validity | Non-disputed, provenance-linked labels preceding cutoff | Remote unknown |
| Diagnostic lineage | Each example pins a diagnostic no later than its label | Enforced by sealer; population unknown |
| Admission evidence | Exact-version focus and coverage snapshots for TEST diagnostics, no later than cutoff | Remote unknown |
| Representativeness | Adequate genuine/non-trading labels and effective sample size in required country/language/source/time cells | Unknown |
| Replay safety | Isolated/read-only database, source counts/checksums verified, CLI output retained | Procedure available; not executed |

## 6. Minimum work remaining

The smallest next action is **not code**: obtain a read-only restore or replica and
run the inventory queries. There are then only two branches:

- **Qualifying sealed dataset found:** verify exact snapshot eligibility and
  checksums, then run the existing offline CLI. No creation work is required.
- **No qualifying seal, but qualifying history found:** clone the database, choose
  defensible time boundaries, seal once with the existing Phase B script and a new
  key, then run the CLI.
- **Qualifying history absent:** accumulate real prospective shadow observations
  and human labels. The evaluation remains blocked until enough immutable,
  propensity-aware history exists; synthetic or retrospective substitutes would
  disprove neither the policy nor its production suitability.

Accordingly, the missing artifact is not another evaluator feature. It is a
reachable, lineage-complete, representative historical population (or a seal of
such a population) plus retained operational evidence that its snapshot coverage
and sampling assumptions hold.
