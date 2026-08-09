# Phase B History Collection Readiness Report

**Review date:** 2026-08-09  
**Scope:** prospective Admission V2 evaluation history only  
**Serving authority:** unchanged; all proposed activity is observational  
**Excluded:** Dashboard, Review, Discord, Investigation, Enrichment, and Intake
authority

## Executive conclusion

The repository contains the semantic producers for every Admission V2 prerequisite,
but it is **not yet operationally safe to declare prospective history collection
ready**.

The happy path is substantially complete: ingestion can record propensity-bearing
assignments; production classification can persist an immutable diagnostic; the
evidence dual-write can persist documents, assertions, coverage, and a diagnostic-
linked Creator Focus snapshot; human review can append ground truth; and the Phase B
benchmark command can later seal chronological examples. Migration 063 enables only
sampling, document observation, and Creator Focus shadow while preserving production
decision authority.

The blocking issue is observational completeness. Assignment, diagnostic, evidence,
Creator Focus, and label failures are deliberately contained so they cannot alter
production. Several of those failures have no durable retry or reconciliation path.
A missing assignment cannot be truthfully reconstructed after retrieval, and the
current sealer writes an immutable dataset before it discovers some snapshot gaps.
In addition, assertion dual-write starts disabled; unmatched documents remain
semantically ambiguous until the existing projection gate passes and assertions are
activated.

The smallest safe program is therefore not a new architecture. It is to harden the
existing Phase B observers with preflight, durable observational completion, and
coverage monitoring; validate and activate existing assertion dual-write; then begin
the evaluation clock. No serving consumer or production decision needs to change.

**Readiness verdict: Additional observational work required before history
collection can begin.**

## 1. Required prospective record graph

A creator can enter a future sealed Admission V2 TEST set only when the following
immutable graph exists:

```text
retrieval observation
  -> evaluation_cohort_assignment (known inclusion propensity)
  -> production_classification_diagnostic
       -> evidence_documents
       -> classification_evidence_assertions
       -> evidence_coverage_snapshot
       -> creator_focus_classification_snapshot
  -> later human/adjudicated evaluation_ground_truth_label
  -> decision_evaluation_example (chronological TEST split)
  -> decision_evaluation_dataset (sealed header/checksum/cutoff)
```

The diagnostic, focus snapshot, and coverage snapshot must all refer to the same
classification event. The label must occur after that diagnostic. All POC evidence
must be observed no later than the sealed cutoff and match the POC's pinned policy
versions.

## 2. Capability review by prerequisite

### 2.1 Retrieval sampling assignments

**Implemented capability.** `processChannelThroughPipeline` checks
`decision_evaluation_sampling_enabled` before normal channel processing and awaits
`recordRetrievalEvaluationAssignment`. The assignment records channel, country,
origin, language, observation time, and manual/enrichment context. The protected
audit policy uses deterministic randomization and a known nonzero inclusion basis
for selected creators.

**Preserved authority.** Assignment does not select a production classification or
change the channel lifecycle.

**Readiness gap.** The insertion error is caught and reduced to a warning. Production
correctly proceeds, but no durable completion record or retry is created. Because
sampling occurs at the retrieval boundary, a lost assignment cannot later be
reconstructed from the set of reviewed creators without bias. A stable sampling
salt is also operationally required for the entire declared sampling policy period;
the code accepts an empty environment value, which is deterministic but does not
prove that deployments share a governed salt.

**Minimum correction.** Add a fail-closed *observer readiness* check before enabling
sampling (schema, approved policy, stable salt, insert/read probe in a disposable
transaction), plus a durable, non-serving completion/outbox record at the same
retrieval boundary. Retry must preserve the original assignment key, observation
time, stratum, policy version, and propensity. Production must never wait for retry
success or consume the result.

### 2.2 Ground-truth labels

**Implemented capability.** Human APPROVE/REJECT commits first, then invokes
`recordEvaluationGroundTruth` with the immutable review decision, evidence snapshot,
optional creator type, and reasons. The label writer validates provenance and
creator-type consistency and uses an idempotent label key.

**Preserved authority.** The observer runs only after the authoritative review
transaction commits and cannot roll it back.

**Readiness gap.** The call is intentionally fire-and-forget; a failure is logged and
discarded. There is no durable retry or reconciler from `channel_review_decisions` to
`evaluation_ground_truth_labels`. This can silently remove both genuine and
non-trading examples and distort recall and false-positive estimates.

**Minimum correction.** Add an observational label reconciliation job keyed by the
immutable review decision ID. It must only append a missing label through the
existing `recordEvaluationGroundTruth` validation path, never modify the review or
channel, and expose lag/error counts. This avoids coupling review availability to
the evaluator while making eventual label completeness measurable.

### 2.3 Production diagnostics

**Implemented capability.** The production classifier input and decision are
captured in `production_classification_diagnostics`, including input checksum,
provider execution, evidence, staged report, policies, catalogs, job/query lineage,
and enrichment stage. The ingestion pipeline calls this once after the unchanged
production classifier returns.

**Preserved authority.** The stored diagnostic observes the already-computed
production decision. It does not replace or modify that decision.

**Readiness gap.** A diagnostic write failure is caught and the pipeline continues
with an undefined diagnostic ID. That is correct for production stability but makes
all downstream Phase B evidence unusable for Admission V2. There is no durable retry
containing the exact normalized input and decision envelope.

**Minimum correction.** Persist a bounded, immutable observational completion
envelope or transactional outbox containing the exact diagnostic payload and
original event time. Retry through the existing idempotent diagnostic identity (an
idempotency key must be added if one is not already available), then run only the
evidence observers bound to the resulting diagnostic. The retry worker must have no
classification, channel, review, or serving mutation capability.

### 2.4 Evidence documents and assertions

**Implemented capability.** When document dual-write is enabled, the canonical
evidence corpus is projected into immutable, subject-bound documents. Projection is
compared with legacy evidence before persistence. Assertions are persisted through
the same bundle only when their separate control is enabled.

**Preserved authority.** Documents and assertions are observational. Search-match
context is explicitly separated, and no production classifier reads the Phase B
tables for authority.

**Readiness gaps.** Migration 063 intentionally starts assertions disabled. Creator
Focus can still emit a snapshot, but repository tests demonstrate that an unmatched
creator document remains `AMBIGUOUS`; alternative-focus semantics require an
attributed assertion. Consequently, collecting the final evaluation window before
assertion validation would generate high snapshot volume without the semantic
evidence needed to test Admission V2. Projection mismatch also aborts the bundle,
and no durable retry exists after correction of an observational failure.

**Minimum correction.** Use the existing document-only validation window first.
Require complete diagnostic lineage, persisted coverage, exact projection
equivalence, and acceptable p95 duration. Then activate assertion dual-write only
through the existing PASS-gated command. Define the start of the Admission V2
collection epoch after assertion activation; earlier document-only observations may
be used for safety validation but not assumed to be a representative semantic TEST
period.

### 2.5 Evidence coverage snapshots

**Implemented capability.** Every successful evidence bundle constructs and
idempotently persists a policy-versioned coverage snapshot with diagnostic lineage,
document counts, temporal/language coverage, independent families, provider state,
failures, completeness, checksum, and observation time.

**Preserved authority.** Production decisions do not read this snapshot.

**Readiness gap.** Coverage persistence happens after documents and assertions but
outside a single atomic bundle. A partial failure can leave documents without
coverage. The projection observation exposes `coverage_persisted`, but no worker
repairs a diagnostic-incomplete bundle. The returned coverage insert result is not
resolved to an ID and therefore is not passed into the Creator Focus snapshot even
though the schema supports that foreign key.

**Minimum correction.** Add idempotent completion/reconciliation by diagnostic ID:
verify documents/assertions, persist or locate the exact coverage snapshot, and
record a terminal observational bundle outcome. Pass the resolved coverage snapshot
ID into Creator Focus where supported so lineage can be checked directly as well as
through the common diagnostic. Do not update immutable partial rows.

### 2.6 Creator Focus snapshots

**Implemented capability.** `runCreatorFocusShadow` reads the mode, classifies
documents/assertions, aggregates creator-level hypotheses, evaluates classifier v4,
and inserts an immutable snapshot keyed by diagnostic, classifier version, and
policy version. `effective_status` is forced to `UNCERTAIN`; returned metadata states
`servingAuthority:false` and `terminalAuthority:false`.

**Preserved authority.** The snapshot cannot change production classification. Any
later advisory call is separately gated and failure-contained.

**Readiness gaps.** Creator Focus errors are caught inside the evidence bundle and
converted to an in-memory error result. There is no durable retry or completeness
projection. The snapshot call currently receives no resolved coverage snapshot ID,
so `evidence_coverage_snapshot_id` remains null even though diagnostic lineage is
present. A mode of `OFF` silently produces no snapshot.

**Minimum correction.** Add diagnostic-keyed idempotent retry and a completeness
ledger/metric for exact classifier and policy versions. Require mode `SHADOW`, never
`CANARY`, for the initial collection epoch; assert effective status is always
`UNCERTAIN` and serving/terminal authority is false. Treat missing exact-version
snapshots as an observational incident, not as negative creator evidence.

### 2.7 Sealed evaluation datasets

**Implemented capability.** `phaseb:seal-benchmark` accepts calibration, TEST, and
cutoff timestamps; `sealEvaluationDataset` joins the latest non-disputed label,
pre-label diagnostic, selected assignment, optional creator-type adjudication, and
query lineage. It creates chronological TRAIN/CALIBRATION/TEST examples with stored
propensity, segments, checksum, and immutable dataset header.

**Preserved authority.** Benchmark output is no-network, non-serving, and cannot
activate production.

**Readiness gaps.** The command seals first, then checks only whether *some* Creator
Focus snapshot joined calibration/TEST examples. It does not preflight exact
classifier/policy versions, cutoff-bounded focus selection, or evidence-coverage
snapshots. If validation fails, the immutable dataset has already been inserted.
The join can also return more than one snapshot for a diagnostic. The schema makes
`dataset_key` globally unique although the code computes a next version for the same
key.

**Minimum correction.** Before the first seal, add a read-only deterministic
preflight using the Admission V2 loader's exact lateral joins and versions. It must
report example counts, missing lineage, evidence eligibility, propensity-weighted
ESS, and required segments and must refuse sealing on gaps. After a passing
preflight, seal with a new unique key, then verify that the stored membership and
checksum match the preflight population. This work is needed before sealing, not
before the first prospective observation is collected.

## 3. Cross-cutting readiness gaps

### 3.1 No end-to-end completeness projection

The repository can inspect individual tables, but there is no single prospective
metric keyed by retrieval assignment that proves progression through diagnostic,
documents, assertions, coverage, focus, and eventual label. Without it, a 90%
historical-evidence eligibility failure may be discovered only months later.

Add a read-only/rebuildable projection or query—not a second evidence store—that
reports, by day/country/language/source:

- selected assignments;
- diagnostics and assignment-to-diagnostic match rate;
- successful document bundles;
- assertion coverage;
- coverage snapshots and completeness disposition;
- exact-version Creator Focus snapshots;
- eventual labels and label lag;
- fully joinable examples;
- inclusion-propensity distribution and estimated ESS.

Alerting must never feed production decisions.

### 3.2 Failure containment currently means silent sample loss

Failure containment is correct for authority isolation, but warnings alone are not
adequate for evaluation validity. Every observer needs an immutable/idempotent
completion state: pending, completed, retryable failure, or permanently excluded
with a reason. The completion mechanism should reuse existing jobs/outbox and
immutable diagnostic/review identities rather than introduce parallel assignment,
label, or evidence systems.

### 3.3 Collection epoch and version pinning are not operational artifacts

A valid future evaluation needs a declared start time, sampling policy/salt version,
classifier version, focus policy, coverage policy, assertion policy, and supported
segment set. Record these in the existing control/policy plane before the epoch.
Do not silently pool observations across a control or version transition.

### 3.4 Sample allocation may be too slow

The initial protected audit allocation is 100 basis points. That is statistically
valid because propensity is known, but it may take a long time to obtain ESS 30 in
both genuine and baseline-false-positive classes and in multilingual/source slices.
Do not raise allocation merely to accelerate the project without a separately
approved observational sampling policy and capacity review. First forecast yield
from actual prospective counts.

## 4. Smallest implementation sequence

The sequence deliberately grants one observational side effect at a time.

### Milestone 0 — authority invariant and schema readiness

**Objective:** Make it impossible for Phase B collection to affect serving.

**Change:** Add/startup and CI assertions that Phase B tables are absent from all
production-decision reads; Creator Focus effective status remains `UNCERTAIN`;
sampling/evidence/focus controls are independently killable; and the required
migrations/policies exist before any collection control is enabled.

**Unchanged:** Classifier, channel state, queue routing, enrichment, review,
Dashboard, Discord, investigation, and intake.

**Advance gate:** Schema/policy preflight passes and all four controls are OFF.

### Milestone 1 — reliable assignment and diagnostic observation

**Objective:** Never lose the two non-reconstructable roots: propensity assignment
and exact production diagnostic.

**Change:** Add idempotent, durable observational completion/retry using existing
queue/outbox infrastructure. Pin original time, context, policy, propensity, and
diagnostic payload. Add lag/failure metrics.

**Unchanged:** Production classification and all operational outcomes proceed even
when the observer is pending or failed.

**Advance gate:** Fault injection demonstrates eventual completion without changing
the production result; duplicate/reordered retries produce one immutable assignment
and diagnostic.

### Milestone 2 — reliable label observation

**Objective:** Make committed human decisions eventually complete as evaluation
labels.

**Change:** Add a post-commit reconciler keyed by review decision ID, using the
existing ground-truth writer and provenance validation. Add label-lag and mismatch
metrics.

**Unchanged:** Review commit/response and channel mutation semantics.

**Advance gate:** Dropped observer calls reconcile idempotently; disputed or invalid
provenance remains excluded; review is never rolled back.

### Milestone 3 — document-only shadow validation

**Objective:** Prove document and coverage projection safety before semantic
assertions.

**Change:** Enable only evaluation sampling, document dual-write, and Creator Focus
SHADOW using the existing Phase B controls. Keep assertions false. Run the existing
validation command over a declared window and monitor diagnostic coverage,
equivalence, coverage persistence, lineage, and p95 duration.

**Unchanged:** All serving and terminal authority; assertions; downstream canaries.

**Advance gate:** An immutable validation run is `PASS`, no material production
latency/error regression occurs, and kill-switch rehearsal succeeds.

### Milestone 4 — assertion shadow activation and collection epoch

**Objective:** Begin semantically useful Creator Focus history.

**Change:** Activate assertions only through the existing PASS-gated command. Start
a version-pinned collection epoch and require diagnostic-keyed bundle completion for
documents, assertions, coverage, and focus.

**Unchanged:** Creator Focus stays SHADOW with effective status `UNCERTAIN`; no
Dashboard, review, enrichment, investigation, Discord, or intake consumer is added.

**Advance gate:** Exact-version focus/coverage availability is at least 90% overall
and meets predeclared segment floors for a sustained window; failures reconcile or
are explicitly excluded.

### Milestone 5 — accumulate labels and held-out time

**Objective:** Build a representative, leakage-safe population.

**Change:** No serving implementation. Continue normal discovery and human review;
monitor propensity, join completeness, label lag, class balance, countries,
languages, sources, and projected ESS. Predeclare chronological calibration and TEST
boundaries only after enough elapsed time exists.

**Unchanged:** Every production decision and workflow.

**Advance gate:** Both required classes reach ESS 30, evidence eligibility is at
least 90%, required slices are adequate or explicitly insufficient, and the TEST
period has closed.

### Milestone 6 — preflight and seal offline

**Objective:** Materialize exactly one valid immutable dataset.

**Change:** Add/use the exact-version read-only preflight, then invoke the existing
sealer with a unique dataset key only after it passes. Verify membership/checksum and
run Admission V2 offline.

**Unchanged:** Production authority and all runtime consumers.

**Advance gate:** Deterministic replay, checksum equality, no missing snapshots, and
the evaluation report is generated from the sealed TEST population.

## 5. Components to reuse unchanged

- closed creator hypothesis taxonomy and classifier-v4 decision logic;
- immutable diagnostic, evidence document/assertion, coverage, focus, assignment,
  label, dataset, example, benchmark, and calibration schemas;
- deterministic sampling and propensity weighting;
- production classifier and channel lifecycle;
- human review authority and post-commit observer boundary;
- evidence projection validation and assertion activation gate;
- Phase B kill switches and immutable control events;
- offline Admission V2 policy/report and read-only loader.

The new work should add reliability, reconciliation, and preflight around these
components, not duplicate them.

## 6. Explicit non-goals

This readiness sequence must not:

- admit, reject, enrich, review, investigate, or materialize a creator;
- change production classification status or score;
- expose Creator Focus on the Dashboard as authority;
- alter Discord acquisition or status;
- schedule new evidence acquisition for Admission V2;
- change intake or Query Intelligence nomination;
- enable Release 5 advisory/canary authority;
- automatically promote a benchmark or calibration artifact;
- backfill or relabel historical creators.

## 7. Start criteria for prospective collection

History collection may be declared started only when:

1. required schemas and immutable triggers are installed;
2. all Phase B controls and policy versions are inspectable and rollback-tested;
3. assignment and diagnostic observation are durable/idempotently retryable;
4. human-review labels are reconcilable without touching review authority;
5. document projection has a passing validation run;
6. assertion dual-write is activated through that run;
7. coverage and Creator Focus bundle completion is monitored by exact diagnostic;
8. Creator Focus is SHADOW, effective status is always `UNCERTAIN`, and no serving
   consumer exists;
9. a collection epoch pins time, salt, sampling, classifier, focus, assertion, and
   coverage versions;
10. segment-level completeness and latency/error guardrails are live.

Until those conditions hold, accumulating rows would create observational volume
but not a reliably sealable Admission V2 corpus.

## Final verdict

The repository does not need a replacement Phase B architecture. It already has
all semantic record types and a non-authoritative happy path. It does need a small,
focused observational hardening layer: durable completion for assignments,
diagnostics, labels, coverage, and focus; a prospective completeness projection;
PASS-gated assertion activation; a pinned collection epoch; and an exact-version
sealing preflight.

**Additional observational work required before history collection can begin.**
