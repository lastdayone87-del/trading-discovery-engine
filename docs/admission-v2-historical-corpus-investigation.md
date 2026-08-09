# Admission V2 historical-corpus investigation

**Investigation date:** 2026-08-09  
**Mode:** read-only  
**Production changes:** none  
**Outcome:** no executable Admission V2 corpus was located

## Executive result

The required creator-level historical corpus could not be found in any database
or backup accessible from this workspace:

- The only configured database target is the Railway PostgreSQL URL in
  `DATABASE_URL`. A direct read-only connection attempt did not reach PostgreSQL
  because `trolley.proxy.rlwy.net` failed DNS resolution with `EAI_AGAIN`.
- The live Railway inventory supplied for this investigation reports the
  migration-026 query-candidate tables but not
  `decision_evaluation_datasets`, `decision_evaluation_examples`, or their later
  creator-evidence dependencies. On that evidence, the reported Railway database
  does not contain an Admission V2 corpus.
- No staging connection, read replica, backup connection, Railway CLI/session, or
  database dump is configured or present in this environment.
- The checked-in legacy `.db` files contain none of the required table names and
  predate the PostgreSQL creator-decision evaluation plane.

Therefore the existing Admission V2 CLI cannot currently be executed against a
real sealed dataset from this environment. This is a **corpus-not-located** result,
not proof that every externally administered Railway backup is empty. Staging and
backup contents remain unverified because no endpoint, restored database, or
backup artifact was made available. Source code cannot establish their contents.

## 1. Stores actually investigated

| Store | Access available | Read-only result | Admission V2 readiness |
| --- | --- | --- | --- |
| Configured Railway PostgreSQL (`DATABASE_URL`) | Connection string present | DNS failed before authentication or SQL; no query reached the server | Independently unverified; supplied live table inventory lacks required schema |
| Other production database/replica | No endpoint or credentials | No target to query | Unknown |
| Staging database | No endpoint or credentials | No target to query | Unknown |
| Railway/database backup | No backup API/session, restore endpoint, or dump | No artifact to inspect | Unknown |
| Repository/workspace files | Full read access | No PostgreSQL dump, sealed dataset export, JSONL corpus, or compatible local database | Not ready |
| Legacy `data/*.db` files | Full read access | Required table-name signatures absent | Not compatible |

The environment exposes only one database-related variable, `DATABASE_URL`.
Neither a Railway command-line client nor an authenticated Railway project context
is installed. A filesystem search found no `.dump`, `.sql.gz`, backup archive, or
restored database. The only repository environment file is `.env.example`.

## 2. Exact read-only probe and boundary of the evidence

The configured target resolves to database `railway` on
`trolley.proxy.rlwy.net:11337`. The attempted client used a short connection
timeout and, had it connected, would have issued `BEGIN TRANSACTION READ ONLY`
before inspecting `schema_migrations`, `information_schema.tables`, and row counts.
The failure was:

```text
getaddrinfo EAI_AGAIN trolley.proxy.rlwy.net
```

This occurred at name resolution. It proves that this execution environment did
not inspect the remote rows; it does not prove that the server or a Railway backup
does not contain them. The externally observed list of
`candidate_evaluation_runs`, `candidate_evaluation_results`,
`evaluation_policy_versions`, and `offline_evaluation_controls` is consistent with
migration 026, but those tables are not creator-level equivalents.

## 3. Required schema and whether it was located

| Required historical object | Purpose in Admission V2 | Located? |
| --- | --- | --- |
| `evaluation_cohort_assignments` | Retrieval-time sampling cohort and known inclusion propensity | No |
| `evaluation_ground_truth_labels` | Immutable genuine/non-trading human or adjudicated label | No |
| `production_classification_diagnostics` | Exact historical production decision and input before label | Not established by supplied inventory |
| `decision_evaluation_datasets` | Sealed definition, cutoff, checksum, and example count | No |
| `decision_evaluation_examples` | Pinned creator/diagnostic/label/assignment TEST membership | No |
| `evidence_coverage_snapshots` | Diagnostic-linked completeness and evidence-capability envelope | No |
| `creator_focus_classification_snapshots` | Diagnostic-linked Creator Intelligence distribution and staged decision | No |
| `creator_type_adjudications` | Optional creator-type error-analysis label | Not located |
| `decision_benchmark_runs` / calibration artifacts | Earlier creator-focus comparison and calibration lineage | No |

The migration-026 tables cannot fill these rows. They record aggregate query
candidate counts and catalog-policy outcomes, not channels, human labels,
diagnostic-linked creator classifications, or evidence completeness. No safe join,
view, or column mapping can recover the missing experimental units.

## 4. Data sufficiency test that could not pass

The POC loader requires a sealed dataset UUID and then reads only examples where:

1. `split = 'TEST'`;
2. the example has an immutable ground-truth label and nonzero sampling
   probability;
3. a creator-focus snapshot exists for the exact production diagnostic, classifier
   version, and policy version at or before the dataset cutoff;
4. an evidence-coverage snapshot exists for that diagnostic and the exact coverage
   policy version at or before the cutoff.

The evaluator additionally needs enough eligible genuine and non-trading examples
to calculate effective sample size and country/language/acquisition-source/time
segments. A database with only empty post-migration tables would still fail this
test. Since no sealed dataset header or examples were located, the eligible count
is currently zero for every dataset available to this workspace.

## 5. Historical facts that are missing

If the reported Railway database is the authoritative production store and no
later backup contains unreported tables, the missing facts are not merely a
dataset seal. They are:

### Sampling history

- immutable channel assignments made at the retrieval boundary;
- assignment timestamp, country, language, script, discovery origin, and context;
- selected cohort, randomization value, and nonzero inclusion basis points;
- the sampling policy key/version and stable salt period.

These facts cannot be reconstructed after discovery. Retrospectively selecting
reviewed channels would introduce selection bias and would not supply a truthful
inclusion propensity.

### Label history

- immutable approve/reject or adjudicated creator labels;
- label time, provenance, review decision, evidence snapshot, disagreement, and
  label-policy version;
- creator-type adjudications and reason codes where available.

The query evaluator's `ACCEPT` or `REJECT` result is a policy output and cannot be
used as creator ground truth.

### Paired production-decision history

- the immutable production diagnostic that existed before each label;
- normalized input, production decision/score, provider execution, query run, and
  acquisition lineage;
- timestamps that permit leakage-safe chronological TRAIN/CALIBRATION/TEST splits.

### Creator Intelligence and coverage history

- Creator Intelligence snapshots bound to those exact diagnostics, including
  hypothesis distribution, proposed status, probability, lower confidence bound,
  staged language/temporal dispositions, reason codes, and pinned versions;
- coverage snapshots bound to the same diagnostics, including document and source
  counts, independent families, language and temporal coverage, provider
  availability/failure, completeness disposition, checksum, and policy version;
- all observations recorded no later than the eventual dataset cutoff.

Running today's classifier over today's channel state would not recreate these
historical observations and could leak post-decision evidence.

## 6. Shadow history required before evaluation

If no external restore contains the missing facts, the minimum evidence-valid
history must be accumulated prospectively through the repository's existing,
non-authoritative observers:

1. **Retrieval sampling:** create propensity-bearing evaluation assignments before
   classification for real discoveries across every required country, language,
   acquisition source, and time period.
2. **Production diagnostics:** retain the exact immutable classification diagnostic
   evaluated for each sampled creator.
3. **Evidence dual-write:** retain diagnostic-linked immutable creator documents,
   assertions, and coverage snapshots. Assertion collection must pass the existing
   Phase B projection-validation gate; missing assertions must remain missing, not
   be interpreted as negative evidence.
4. **Creator-focus shadow:** produce version-pinned, non-serving Creator
   Intelligence snapshots from the same diagnostic-linked evidence.
5. **Ground truth:** allow ordinary human review/adjudication to append genuine or
   non-trading labels after the diagnostic. Do not create proxy or synthetic
   labels.
6. **Elapsed windows:** accumulate enough history for a chronological calibration
   period followed by a genuinely held-out TEST period, including multilingual and
   low-volume slices.
7. **Coverage gate:** verify that at least 90% of sealed TEST examples have both
   exact-version focus and coverage snapshots, as required by the POC's central
   assessment.
8. **Sample-size gate:** obtain propensity-weighted effective sample size of at
   least 30 genuine creators and at least 30 baseline-missed non-trading creators,
   then assess required segments rather than relying only on pooled totals.
9. **Seal:** choose leakage-safe boundaries, create one immutable checksummed
   dataset with a unique key using the existing sealer, and run the existing POC
   read-only by its returned UUID.

This describes the evidence that must exist; it does not authorize enabling any
observer, migration, setting, or production runtime path.

## 7. What would close the remaining infrastructure unknown

An authorized operator must provide one of the following read-only artifacts:

- a dedicated `SELECT`-only connection to production and staging;
- a Railway backup restored into an isolated evaluator database; or
- a checksummed PostgreSQL dump of the migration ledger and required immutable
  tables, restored into an isolated database.

For every target, inspect the `schema_migrations` ledger, required table catalog,
row counts and timestamp ranges, then measure the exact loader join at prospective
cutoffs. A mere list of table names is insufficient. If any target contains a
sealed UUID with adequate exact-version snapshot coverage and effective sample
size, the existing CLI is executable without modification. If none does, the
prospective shadow-history process above is the only valid path.

## Final determination

No creator-level Admission V2 historical evaluation corpus is available to the
current workspace, and the live production table inventory provided does not show
one. Staging and externally managed backups could not be verified because no
read-only access or restored artifact exists here. On the evidence currently
available, the POC is **not executable**. Its missing prerequisite is real,
propensity-sampled, human-labeled, diagnostic-linked Creator Intelligence and
coverage history—not another loader implementation and not a translation of the
older query-candidate evaluation tables.
