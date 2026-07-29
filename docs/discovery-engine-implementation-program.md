# Discovery Engine Architecture Implementation Program

Date: 2026-07-29  
Status: **Proposed for review; no implementation phase is approved by this document**

## 1. Purpose and authority

This program converts the approved architecture in
`query-intelligence-architecture-review.md` into small, production-safe increments.
The two approved designs in that review are the source of truth:

1. **Evidence-Derived Concept and Experiment Intelligence**; and
2. **Persistent Topic-Centric Exploration**.

This document sequences their implementation. It does not replace or redesign them.
Where sequencing requires a choice, persistent topic exploration is the organizing
control plane, existing query execution remains an action adapter, and concept
intelligence supplies evidence-derived actions to that plane.

The current durable queue, query planner, ingestion gates, review workflow, and Phase F
terminology store evolve in place. No phase may introduce a competing scheduler,
vocabulary store, or execution pipeline.

## 2. Program rules

### 2.1 Delivery rules

- One phase, one independently mergeable pull request. A phase begins only after the
  preceding phase's evidence has been reviewed and its go/no-go gate is explicitly
  passed.
- Database changes are forward-compatible and expand-first. Destructive cleanup is a
  later, separately approved contraction after at least one release of compatibility.
- New decision paths start disabled, then observe in shadow mode, then receive a
  separately capped canary budget. Existing curated/query behavior remains the
  fallback until measured superiority is established.
- Queue work is durably materialized before execution, idempotent under retry, leased,
  bounded, and attributable to a policy/version and exact lineage.
- Raw evidence and outcome events are immutable. Corrections are new assertions or
  events, not rewrites. Derived projections must be reproducible by replay.
- AI never invents candidate text or directly publishes a query. It may adjudicate an
  exact source span against a closed schema, must support abstention, and is always
  versioned.
- Provider, AI, compute, storage, and review costs are measured separately. Quota is
  reserved before execution and released or charged idempotently.
- Each rollout records the baseline, canary cohort, policy/configuration version,
  operator, start/end time, alerts, and rollback decision.

### 2.2 Compatibility contract

- Existing endpoint paths and response fields remain available unless a later
  deprecation phase is separately approved. New fields are additive and nullable.
- Existing autonomous query runs remain valid and continue to update existing query
  measurements throughout the migration.
- Existing country-scoped terminology records remain readable until concept/surface
  backfill, dual-read comparison, compatibility views, and rollback have all passed.
- Existing jobs remain claimable across deployments. Workers use tolerant readers for
  old payloads and producers do not emit a new payload version until compatible
  workers are deployed.
- A rollback normally disables a feature flag or restores a prior versioned policy or
  catalog. Forward migrations are not destructively reversed in production.

### 2.3 Program-wide success measures

The primary comparison is **verified incremental coverage per total constrained cost
at equal or better country and trading precision**. Every applicable phase also
reports:

- verified net-new creators and communities, separated from raw and duplicate hits;
- coverage distribution by country, language, concept/category, creator/entity
  cluster, acquisition source, freshness, and quality tier;
- country precision, trading precision, unsafe/spam rate, and human-review burden;
- YouTube, web, AI, compute, and review cost per accepted creator and coverage gain;
- retry, stale recovery, duplicate suppression, queue latency, provider failure, and
  delayed-outcome lag;
- uncertainty, sample size, assignment propensity, and policy/catalog versions where
  experiments influence a decision.

Absolute ecosystem recall is never reported as known. Coverage is an estimate with
uncertainty derived from overlap, rediscovery, capture rate, frontier state, and
documented unreachable cells.

## 3. Phase dependency map

| Phase | Independently reviewable objective | Depends on | Production traffic |
| --- | --- | --- | --- |
| 1 | Operator authorization boundary | Current system | Existing only |
| 2 | Provider resilience and trustworthy telemetry | 1 | Existing only |
| 3 | Recovery proof and calibrated production baseline | 2 | Existing only |
| 4 | Immutable outcomes and reproducible replay | 3 | Existing only |
| 5 | Passive exploration-control-plane ledger | 4 | Existing; shadow writes |
| 6 | One restart-safe topic pilot using current search | 5 | Shadow, then capped canary |
| 7 | Coverage cells, sleeping, and reactivation | 6 | Capped pilot only |
| 8 | Immutable corpus and source-bound candidates | 4, 6 | Shadow only |
| 9 | Deterministic scoring and bounded AI assertions | 8 | Shadow only |
| 10 | Global concepts, locale surfaces, and moderation | 9 | Shadow/dual read |
| 11 | Offline candidate evaluation and catalog governance | 4, 10 | No new live queries |
| 12 | Randomized, capped terminology trials | 11 | Small exploration budget |
| 13 | Policy-driven catalog publication | 12 | Canary, then gradual |
| 14 | Evidence graph and new acquisition adapters | 7, 10, 13 | One adapter at a time |
| 15 | Portfolio allocation and adaptive policy | 14 | Guarded canary |

Phases 7 and 8 may be developed only after Phase 6 is merged. They must still merge
serially in the order above so that production evidence and rollback remain clear.

## 4. Implementation phases

### Phase 1 — Operator authorization boundary

**Objective.** Remove the highest-risk release blocker by ensuring every mutation,
quota-consuming operation, administrative read, stress operation, and worker/scheduler
control is authenticated and authorized, without changing discovery behavior.

**Architectural scope.** Serving/operations plane only: a single operator authorization
middleware, explicit route policy, audit identity, request ID, and denial behavior.
This extends the existing reviewer bearer-token pattern rather than creating a second
identity system. Public readiness/health responses expose no sensitive internals.

**Affected subsystems.** `server.ts` routes; reviewer credentials/middleware; manual and
automated search APIs; country, queue, scheduler, vocabulary, regression, backup, and
stress-test controls; environment documentation; audit logging; dashboard API client.

**Database migrations.** Add an append-only `operator_audit_events` table with actor
identifier/hash, role, action, target, request ID, outcome, timestamp, and safe
metadata; indexes by time, actor, and action. Do not store bearer secrets. Migration is
additive and the application tolerates audit-table unavailability only during a
controlled rollback to the prior image.

**Queue/worker changes.** No job semantics change. Enqueue routes attach authenticated
actor and request ID as provenance; workers treat both as optional so old jobs remain
valid. Background scheduler jobs retain a distinct system actor.

**API changes.** Require bearer authentication and an operator/admin role as
appropriate on all non-public routes. Preserve paths and successful response shapes;
add stable `401`, `403`, and request-ID error contracts. Limit the unauthenticated
surface to a redacted liveness/readiness contract.

**Compatibility considerations.** Support the existing review token during a
documented transition, with explicit role mapping. Provide a pre-deployment route
inventory and client configuration. Do not silently allow missing credentials in
production; a local-development bypass must be explicit and impossible when
`NODE_ENV=production`.

**Operational risks.** Locking out operators, leaking secrets in logs, health-check
failure, unprotected forgotten routes, and dashboard outage. Deny-by-default routing,
redaction tests, health-probe separation, and an emergency credential rotation runbook
control these risks.

**Testing strategy.** Route-policy unit tests enumerate every API route and verify
anonymous, wrong-role, valid-role, and rotated-token behavior. Test audit idempotency
and redaction, old queue payload handling, dashboard authentication, request IDs,
production fail-closed startup, and build/type checks. Stage tests exercise every
mutation and quota route with access logs retained.

**Rollout strategy.** Inventory routes; deploy middleware in audit-only mode to staging;
configure credentials and probes; run the complete route matrix; enable enforcement in
staging; deploy production with scheduler/workers initially paused; smoke-test; then
resume one worker and the scheduler.

**Rollback strategy.** Pause producers, roll back the application image, retain the
additive audit table, and rotate any credential suspected of exposure. If only a client
is incompatible, keep enforcement and fix the client rather than reopen the route.

**Completion criteria.** Every route has an explicit public/operator/admin policy;
unauthorized quota and mutation attempts cannot enqueue or mutate; audit events are
queryable without secrets; documented dashboard and probe flows work; deterministic
tests/build pass; staging evidence is attached to the phase PR/release record.

**Go/no-go gate.** **GO** only after security review signs the complete route inventory
and a staging test proves zero unauthenticated state or quota changes. Otherwise stop;
Phase 2 must not begin.

### Phase 2 — Provider resilience and trustworthy telemetry

**Objective.** Make failures and cost visible and bounded before adding autonomous
decision loops.

**Architectural scope.** Serving/operations and acquisition boundaries: structured
request/run/action IDs, deadlines and cancellation, typed provider outcomes, metrics,
alerts, and real cost accounting. Classification logic is unchanged.

**Affected subsystems.** YouTube client, Gemini/evidence providers, health checks,
queue workers, quota reservations, scheduler logging, ingestion, dashboard operational
status, and deployment configuration.

**Database migrations.** Add append-only `provider_call_events` (provider, operation,
request/run/job IDs, attempt, status, latency, reserved/actual cost, error class, policy
version, timestamps) with retention-friendly indexes. Add nullable correlation IDs to
execution logs only where needed; avoid copying provider payloads.

**Queue/worker changes.** Heartbeats continue during bounded provider calls. A deadline
produces a retryable typed error when safe; cancellation and stale recovery cannot
double-charge quota. Retry policies distinguish rate limits, transient errors,
permanent input errors, and exhausted credentials.

**API changes.** Additive operational metrics/readiness fields and redacted diagnostics;
no discovery response changes. Administrative detail remains authorized under Phase 1.

**Compatibility considerations.** Default deadlines initially exceed observed p99 and
can be disabled by rollback flag. Old jobs and provider adapters use default operation
metadata. Existing quota totals remain available while event totals are reconciled.

**Operational risks.** Deadlines that are too short, metric cardinality explosion,
duplicate cost charging, logs containing provider data, or alert fatigue. Use bounded
labels, payload redaction, reservation reconciliation, and staged threshold tuning.

**Testing strategy.** Fake-provider tests cover success, timeout, cancellation, rate
limit, malformed output, retry, stale lease, and process restart. Reconcile reservation
and provider-event costs; load-test event writes; test health timeouts and metric
cardinality; run unit/type/build suites.

**Rollout strategy.** Emit telemetry without alerts, establish baselines, enable alerts
in staging, canary deadlines by provider/operation, then expand. Keep AI degradation
additive and observable rather than silently changing classification confidence.

**Rollback strategy.** Disable deadline enforcement or event emission independently,
restore the prior image, retain events, and reconcile reservations. Never compensate
for a timeout by unbounded retries.

**Completion criteria.** All external calls have a deadline/cancellation path; costs
reconcile; retry classes are deterministic; dashboards expose queue/provider latency,
error, timeout, and cost; alerts have owners and runbooks.

**Go/no-go gate.** **GO** only after a staging fault-injection run proves bounded calls,
idempotent quota accounting, stale recovery, and useful alerts without discovery
behavior regression.

### Phase 3 — Recovery proof and calibrated production baseline

**Objective.** Establish the trusted operational and quality baseline required to
judge every later phase.

**Architectural scope.** Production-foundation validation: PostgreSQL migration and
restart proof, backup/restore proof, quota reset/expiry proof, classifier calibration,
and baseline measurement definitions. This phase changes policy only to correct a
demonstrated calibration defect through a separately versioned configuration.

**Affected subsystems.** Migration scripts, deployment/runbooks, queue and scheduler,
quota ledger, backup service, country/trading classifiers, review corpus, evaluation
scripts, and operational dashboards.

**Database migrations.** Prefer none. If needed, add version identifiers for classifier
or baseline dataset provenance and a `validation_runs` ledger storing checksums and
results—not raw secrets or full backup contents.

**Queue/worker changes.** No new job type. Rehearse queued-before-restart,
killed-during-processing, stale recovery, retry exhaustion, scheduler lease, and quota
reset with current jobs.

**API changes.** At most an authorized, read-only validation-status endpoint. No public
contract changes.

**Compatibility considerations.** Preserve the SQL.js archive until migration
acceptance. Baseline reports segment legacy/missing provenance rather than inventing
values. Calibration versions coexist and can be restored.

**Operational risks.** Destructive rehearsal against production, incomplete restore,
using an unrepresentative labeled corpus, and tuning to the test set. Use disposable
staging, checksums, held-out sets, country strata, and an approved runbook.

**Testing strategy.** Execute the production-readiness migration/Railway checklist;
compare durable table counts and samples; perform a restore into a new database;
exercise real YouTube/Gemini paths; produce per-country confusion matrices,
reliability curves, precision/recall, and baseline cost/coverage reports.

**Rollout strategy.** This is a staging/evidence phase. Apply any approved calibrated
policy as a versioned canary, compare it to the baseline, then promote independently.

**Rollback strategy.** Stop workers, snapshot state, restore the previous image/policy,
or switch `DATABASE_URL` atomically to the verified restored database. Preserve the
legacy archive and all validation artifacts.

**Completion criteria.** All current release blockers are closed; restore is proven;
restart and quota scenarios pass; baseline data and definitions are reviewed; per-
country classifier quality and drift thresholds are documented.

**Go/no-go gate.** **GO** only when the production-readiness status is formally changed
to GO with retained logs, reports, and restore evidence. No learning/control-plane
phase proceeds on an untrusted baseline.

### Phase 4 — Immutable outcomes and reproducible replay

**Objective.** Make current query decisions and delayed verified outcomes reproducible
before introducing new optimization.

**Architectural scope.** Experiment/measurement plane foundation: canonical outcome
taxonomy, immutable events, decision context, feature/policy versions, delayed
attribution, and an offline benchmark/replay report segmented by country and lane.

**Affected subsystems.** Query runs/performance, ingestion funnel, enrichment, review,
quota ledger, evaluation scripts, reporting, and database repositories.

**Database migrations.** Add `decision_events` and `outcome_events` with stable subject,
event type/version, source event, query/run/job lineage, event/recorded times, immutable
payload, and uniqueness keys. Add benchmark dataset/version metadata and replay-run
tables. Do not remove existing aggregates.

**Queue/worker changes.** Existing workers append provisional outcomes; enrichment and
review append later verified/corrective outcomes referencing the original subject.
Retries use deterministic event keys. A replay worker, if queued, is compute-only and
has a separate concurrency/budget class.

**API changes.** Add authorized read-only replay/baseline endpoints or offline reports.
Existing query/performance responses remain unchanged; optional event/version fields
are additive.

**Compatibility considerations.** Dual-write events and legacy aggregates, reconcile
them, and keep legacy reads authoritative until the gate passes. Backfill marks unknown
lineage explicitly and never fabricates assignment context.

**Operational risks.** Double events, event/processing-time confusion, storage growth,
PII retention, and a replay that accidentally spends provider quota. Enforce unique
keys, retention rules, minimal payloads, and a no-network replay boundary.

**Testing strategy.** Golden fixtures reproduce current planner eligibility and funnel
metrics; retry/reordering/late-review tests prove deterministic projections; property
tests verify event idempotency; benchmark checksums and code/config versions make runs
repeatable; compare event projections to current production aggregates.

**Rollout strategy.** Dual-write in shadow, reconcile daily by country/lane, repair
instrumentation rather than history, then freeze benchmark v1. Reads do not switch in
this phase.

**Rollback strategy.** Disable event dual-write/replay, retain append-only rows, and use
legacy aggregates. Drop no data.

**Completion criteria.** Current policy and metrics reproduce within predeclared
tolerance; all new outcomes carry exact lineage when available; delayed review changes
are replayable; benchmark v1 is reviewed and immutable.

**Go/no-go gate.** **GO** only when logged data reproduces the current query policy and
funnel/cost reports for the acceptance window with explained residuals.

### Phase 5 — Passive exploration-control-plane ledger

**Objective.** Introduce durable topic/action/lineage primitives without allowing them
to schedule or alter production work.

**Architectural scope.** Persistent exploration control plane: `research_program`,
`research_hypothesis`, `frontier_action`, attempts, outcomes, lineage, policy version,
and budget fields. Map every existing autonomous search and page continuation to a
`SEARCH_TERM` or `CONTINUE_RESULT_PAGE` action in shadow.

**Affected subsystems.** Autonomous scheduler, query planner, pagination, queue
producer/worker, quota attribution, outcome events, database repositories, and
operational reporting.

**Database migrations.** Add research programs, hypotheses, frontier actions, action
attempts/outcomes, program budgets, and lineage tables. Enforce immutable semantic
action key plus validity window, parent integrity, bounded lifecycle enums, and indexes
for eligible frontier claims. Seed a disabled `price-action-trading` pilot program.

**Queue/worker changes.** No new executor and no control-plane claiming. Existing jobs
dual-write passive action records and exact outcomes; pagination creates child action
records after the existing continuation decision. Idempotency derives from existing
run/page IDs.

**API changes.** Authorized read-only program/action/lineage inspection endpoints.
Program mutation and activation remain unavailable or hard-disabled.

**Compatibility considerations.** All new foreign keys from existing records are
nullable; old jobs need no new fields; a failed shadow write cannot cause duplicated
provider work and is surfaced for reconciliation.

**Operational risks.** Write amplification, incorrect lineage, semantic-key collision,
or implying that passive records controlled work. Reports label mode as `SHADOW` and
compare source run/job IDs exhaustively.

**Testing strategy.** Migration constraints; deterministic semantic keys; retries,
pagination, restart, stale recovery, and duplicate-run mapping; one-to-one reconciliation
of current autonomous runs/pages/cost/outcomes to passive actions; query-plan/load test.

**Rollout strategy.** Deploy schema, enable shadow writes for a sample, reconcile, then
all autonomous runs. Keep the pilot disabled.

**Rollback strategy.** Disable shadow writes and endpoints; existing scheduler remains
authoritative. Retain passive records for diagnosis.

**Completion criteria.** Every current autonomous search/page in the acceptance window
has exactly one attributable action/attempt/outcome path and equal cost/funnel totals;
no action can independently execute.

**Go/no-go gate.** **GO** only after lineage and accounting reconcile and shadow writes
have no material scheduler/worker latency impact.

### Phase 6 — Restart-safe topic pilot using current search

**Objective.** Let one topic program reproduce current price-action search and
pagination behavior at equal cost, while keeping the current scheduler as fallback.

**Architectural scope.** Minimal common action contract
`propose -> estimate -> reserve -> execute -> observe -> attribute -> expand`, limited
to existing search and continuation adapters; program lifecycle and hard budgets; no
new source or learned term.

**Affected subsystems.** Pilot controller, query proposer, current durable jobs,
pagination, quota reservations, action ledger, scheduler feature flags, and dashboard.

**Database migrations.** Add controller leases/checkpoints and, if not already present,
explicit reserved/actual provider cost columns and action payload schema version.
Strengthen unique eligible-action and attempt constraints based on Phase 5 evidence.

**Queue/worker changes.** A short-lived controller materializes actions before mapping
them to existing `SEARCH_YOUTUBE` jobs. Workers remain the sole executors. Reservation,
job, action attempt, and outcome transitions are transactional/idempotent. Only the
pilot's current query repertoire is eligible.

**API changes.** Authorized pilot pause/resume/status, budget, and kill-switch controls;
add mode and policy version to program reads. Existing scheduler APIs remain.

**Compatibility considerations.** Start shadow-only. In canary mode, country/time
blocks are exclusively assigned to pilot or existing scheduler to prevent double
spend. Disabling the pilot immediately restores the current scheduler.

**Operational risks.** Double scheduling, budget leakage, stuck leases, divergent
pagination, or controller restart loops. Use exclusive cohort ownership, DB leases,
hard daily/total caps, semantic dedupe, and circuit breakers.

**Testing strategy.** State-machine and action-contract tests; crash before/after every
transaction boundary; concurrent controller tests; quota exhaustion/reset; duplicate
proposal; stale attempt recovery; deterministic replay comparing selected queries,
pages, cost, and outcomes with current behavior.

**Rollout strategy.** Shadow score, then zero/very small quota in one pilot scope,
pause between increments, and compare matched country/time blocks. Do not add breadth
or AI behavior.

**Rollback strategy.** Trip the pilot kill switch, release only safe unspent
reservations, let already claimed jobs finish or cancel by existing policy, and return
cohort ownership to the current scheduler. Keep action history.

**Completion criteria.** Pilot is restart-safe, duplicate-free, budget-bounded, and
operationally observable; it reproduces current query/page decisions and verified
outcomes within declared tolerance at equal quota.

**Go/no-go gate.** **GO** only after restart/lease/budget drills pass and the pilot has
no precision, cost, or availability regression. This validates mechanics, not yet
superiority.

### Phase 7 — Coverage cells, sleeping, and reactivation

**Objective.** Make topic-level continuation a deterministic, uncertainty-aware
decision rather than a side effect of query cooldown or page ceilings.

**Architectural scope.** Coverage matrix, sufficient statistics, frontier scoring by
cost-aware expected coverage/information/freshness, program lifecycle
`ACTIVE/SLEEPING/SATURATED/PAUSED/COMPLETE`, checkpoints, and reactivation triggers.
Use only existing acquisition actions.

**Affected subsystems.** Pilot controller, delayed outcomes/replay, query/pagination
metrics, program dashboard, policy configuration, and scheduler fallback.

**Database migrations.** Add versioned coverage dimensions/cells, compact sufficient
statistics, lifecycle decisions/events, checkpoints, unreachable-gap reasons, and
reactivation events. Never store a false absolute-recall percentage.

**Queue/worker changes.** Workers only emit outcomes. Controller updates projections
idempotently, selects eligible existing actions, sleeps after all approved criteria,
and schedules capped freshness probes. Hard ceilings checkpoint instead of declaring
semantic exhaustion.

**API changes.** Read APIs expose estimates plus uncertainty, evidence window, gaps,
and decision version. Authorized pause/reactivate accepts reason and idempotency key.

**Compatibility considerations.** Existing page continuation stays the local rule.
The program lifecycle governs only the pilot. Current scheduler can retake ownership
on rollback.

**Operational risks.** Premature saturation, zombie programs, biased cell definitions,
projection races, or misleading coverage. Require upper-confidence stopping,
breadth/information floors, backlog checks, versioned decisions, and clear estimate
labels.

**Testing strategy.** Synthetic productive/sparse/saturated/delayed datasets; replay
order invariance; concurrent outcome updates; sleeping only when every predicate holds;
reactivation on burst, stale coverage, provider capability, nomination, and scheduled
probe; matched pilot comparison.

**Rollout strategy.** Compute coverage/lifecycle recommendations in shadow, human-review
decisions, then allow sleeping/reactivation for the capped pilot with instant override.

**Rollback strategy.** Disable lifecycle enforcement and use hard budgets/current
scheduler; preserve decisions and statistics.

**Completion criteria.** Coverage reports are reproducible; sleep/reactivation is
auditable; delayed backlog is respected; the pilot pursues distinct promising branches
without exceeding budget or losing precision.

**Go/no-go gate.** **GO** only after shadow recommendations meet reviewed false-sleep
and zombie-rate tolerances and live pilot decisions survive restart and delayed updates.

### Phase 8 — Immutable corpus and source-bound candidates

**Objective.** Replace generative terminology extraction with a traceable, asynchronous
candidate corpus while leaving Phase F search eligibility unchanged.

**Architectural scope.** Acquisition/evidence plane: approved source policy, immutable
document metadata, minimal retained excerpts/hashes, exact candidate spans, extractor
versions, discovery lineage, and entity-cluster contribution caps.

**Affected subsystems.** Post-enrichment/review flow, durable queue, cached channel and
video artifacts, website policy hooks (approved text only), terminology intelligence,
retention/deletion, and corpus monitoring.

**Database migrations.** Add source artifacts/documents, retention class, content hash,
document-source assertion, candidate occurrence/span, extraction run/version, and
qualification decision tables. Exact offsets use a declared Unicode indexing scheme.
Existing terminology observations are not overwritten.

**Queue/worker changes.** Add `TERM_HARVEST` after a creator reaches a qualifying,
fully enriched state. Enqueue idempotently by document hash/extractor version. No AI in
ingestion's critical path. Separate queue pause, concurrency, and compute budget;
manual lineage qualifies only after explicit approval.

**API changes.** Authorized corpus/candidate inspection, provenance, retention, and
deletion-status reads. No candidate can be activated through an API.

**Compatibility considerations.** Phase F continues serving queries. Existing cached
metadata may be imported only with known provenance and hash; unavailable offsets are
marked legacy and never satisfy the zero-untraceable-term gate.

**Operational risks.** Copyright/privacy over-retention, boilerplate pollution,
endogenous feedback, storage growth, poisoning, and ingestion latency. Use minimal
content, retention/deletion policy, autonomous/approved provenance, cluster/time caps,
burst flags, and async backpressure.

**Testing strategy.** Unicode offsets round-trip to exact spans; deterministic 1–5
gram/keyphrase fixtures; content-hash idempotency; eligibility matrices; duplicate and
affiliate cluster caps; deletion/retention; queue retry/restart; performance/storage
limits; prove no provider AI call occurs in ingestion.

**Rollout strategy.** Enable for a small approved creator cohort, inspect candidate and
storage funnels, expand by country, then freeze a multilingual labeled sample.

**Rollback strategy.** Pause `TERM_HARVEST`, stop new document retention, execute
policy-required deletion, and leave current Phase F behavior untouched.

**Completion criteria.** Every accepted candidate maps to exact retained/authorized
source coordinates and versions; qualification and caps work; ingestion latency is
unchanged; retention/deletion is proven.

**Go/no-go gate.** **GO** only with legal/policy approval, zero untraceable accepted
spans, passing multilingual offsets, and acceptable candidate precision/storage cost.

### Phase 9 — Deterministic scoring and bounded AI assertions

**Objective.** Score source-bound candidates reproducibly and use AI only for ambiguous,
high-value semantic adjudication with abstention.

**Architectural scope.** Knowledge evidence pipeline: frequency, independent-cluster
diversity, source diversity, temporal stability/burst, background lift, language/locale
affinity, anomaly features, deterministic rejection, and parallel versioned assertions.

**Affected subsystems.** Corpus workers, evidence engine/Gemini provider, language and
script classification, entity dictionaries, review tooling, evaluation, queues, and
cost telemetry.

**Database migrations.** Add feature-set versions and candidate feature snapshots;
`classification_assertions` for deterministic/AI/human claims, confidence,
abstention, closed labels, context offsets, model/prompt/schema versions; adjudication
jobs/results and anomaly flags. Assertions never overwrite one another.

**Queue/worker changes.** Add a separately budgeted candidate scoring job and bounded AI
adjudication job. Deterministic filters run first; only policy-eligible ambiguity enters
AI. Retry keys include candidate and classifier version; malformed/unsupported output
fails closed.

**API changes.** Authorized assertion comparison, AI abstention/error/cost, and human
adjudication views. No publication API.

**Compatibility considerations.** Phase F extraction/lifecycle remains production
authoritative but cannot feed the new assertion store without source spans. New and
old candidate funnels are reported separately.

**Operational risks.** Model drift, hallucination, language error, correlated-source
overstatement, prompt injection, cost runaway, or false confidence. Enforce closed
schema/shortlist, literal spans, deterministic validation, abstention, version pinning,
cluster caps, golden regression, and hard AI budgets.

**Testing strategy.** Multilingual golden set and per-country confusion/calibration;
schema fuzzing and prompt-injection fixtures; hallucinated/unseen output rejection;
model timeout/retry; deterministic replay; feature and cost snapshots; human agreement
analysis.

**Rollout strategy.** Shadow only, starting with deterministic scoring; add AI for a
small ambiguous cohort; review drift and spend before expanding.

**Rollback strategy.** Pause AI/scoring queues or restore an earlier classifier version;
retain assertions and keep Phase F serving unchanged.

**Completion criteria.** Candidate decisions replay exactly by version; AI adds measured
value over deterministic rules, abstains as designed, never creates unseen strings,
and stays within cost/quality thresholds.

**Go/no-go gate.** **GO** only after multilingual held-out precision/calibration and
zero-untraceable/zero-model-invented accepted term gates pass.

### Phase 10 — Global concepts, locale surfaces, and moderation

**Objective.** Separate stable semantic identity from literal localized surface forms
and safely evolve the existing Phase F store without a parallel production vocabulary.

**Architectural scope.** Federated concept graph: concepts, term surfaces, many-to-many
senses, relations with provenance, market/locale affinity, validity, ambiguity,
moderation, reversible merge/split, and country overlays.

**Affected subsystems.** Terminology repository, query planner reads, candidate
assertions, human review/moderation, migration/backfill, catalog tooling, and audit.

**Database migrations.** Add `concepts`, `term_surfaces`, concept-surface senses,
`concept_relations`, market affinities, moderation decisions, and merge/split event
ledger. Add nullable mappings from current canonical terms/aliases/observations.
Backfill idempotently; provide compatibility views/adapters matching existing Phase F
reads. Do not drop old tables.

**Queue/worker changes.** Add idempotent resolution proposals in shadow. Conservative
automatic links may be proposed; ambiguous or irreversible operations require review.
Merge/split changes projections through events, not destructive source updates.

**API changes.** Authorized concept/surface/provenance views and moderation commands
with optimistic version and idempotency key. Existing terminology endpoint remains
compatible.

**Compatibility considerations.** Dual-read comparison precedes any read switch.
Country remains an overlay, not concept identity. Global propagation creates only a
candidate prior; it never creates local eligibility. Preserve old identifiers through
stable mappings.

**Operational risks.** Bad merges, homonym collapse, translation errors, cyclic
relations, backfill loss, and dual-write divergence. Use ambiguity, conservative
thresholds, graph constraints, review, reversible events, checksums, and compatibility
reconciliation.

**Testing strategy.** Backfill counts/checksums; homonym, synonym, abbreviation, and
translation fixtures; concurrent moderation; merge then split round-trip; relation
cycle policy; legacy endpoint equivalence; catalog construction from both models.

**Rollout strategy.** Backfill shadow graph, reconcile, moderate a pilot concept set,
enable dual read for internal reports, then compatibility reads behind a flag. No live
planner switch in this phase.

**Rollback strategy.** Restore Phase F reads, stop resolution writes, retain new graph
and mappings, and replay corrective split events.

**Completion criteria.** Phase F data is mapped without loss; ambiguous surfaces remain
ambiguous; merge/split and dual-read rollback are proven; locale overlays do not leak
eligibility across countries.

**Go/no-go gate.** **GO** only after reversible merge/split, compatibility equivalence,
backfill reconciliation, and catalog rollback drills pass.

### Phase 11 — Offline candidate evaluation and catalog governance

**Objective.** Reject candidates that do not add verified coverage before spending
live search quota, and make catalog decisions reproducible and atomically reversible.

**Architectural scope.** Offline evaluation, versioned policy/decision records,
candidate catalogs, approval workflow, and historical/cached replay. This phase does
not execute candidate queries.

**Affected subsystems.** Benchmark/replay, concepts/surfaces, existing query library,
cached search observations where provider terms permit, reporting, operator review,
and planner catalog loader in shadow.

**Database migrations.** Add policy versions, evaluation runs/results, candidate
catalogs/entries, publication approvals, decision explanations, and immutable catalog
checksums/status. Store dataset and code versions and explicit non-comparability flags.

**Queue/worker changes.** Optional compute-only evaluation jobs cannot access provider
quota. Planner loads candidate catalogs only in shadow and records what it would have
selected.

**API changes.** Authorized create/evaluate/review catalog endpoints; atomic publish is
not enabled yet. Read APIs expose metrics, uncertainty, duplication against curated
coverage, and guardrail reasons.

**Compatibility considerations.** Curated terms and current Phase F catalog remain the
only production source. Cached replay obeys retention/provider terms and distinguishes
missing counterfactual evidence from a negative outcome.

**Operational risks.** Offline/online mismatch, leakage, benchmark overfitting,
invalid counterfactual claims, or non-reproducible catalogs. Use held-out/time-split
sets, checksums, uncertainty, predeclared metrics, and human approval.

**Testing strategy.** Golden replay and checksum reproducibility; no-network enforcement;
time/country/lane segmentation; duplicate curated-coverage rejection; corrupted or
stale catalog refusal; deterministic planner shadow load; benchmark leakage review.

**Rollout strategy.** Evaluate a small concept set, review errors by country, freeze
policy/catalog versions, and run planner shadow comparison for an acceptance window.

**Rollback strategy.** Disable catalog shadow loading and evaluation workers; current
catalog is untouched. Mark invalid evaluations superseded, never rewrite them.

**Completion criteria.** Evaluation reports cover precision, verified quality,
coverage distribution, quota/review cost proxies, and uncertainty; catalogs are
reproducible and rollback-ready; redundant candidates are excluded.

**Go/no-go gate.** **GO** only after a reviewed catalog meets offline guardrails and
shadow loading cannot alter production query selection.

### Phase 12 — Randomized, capped terminology trials

**Objective.** Estimate causal incremental value of candidate surfaces under hard
safety, precision, and quota constraints.

**Architectural scope.** Experiment plane: predeclared experiment, strata, curated
control, immutable eligibility, randomized assignment and propensity before enqueue,
exposure, delayed outcomes, posterior/confidence intervals, and stopping rules.

**Affected subsystems.** Research controller, query/action proposer, quota allocator,
jobs, outcome events, review/enrichment, experiment analysis, alerts, and kill switch.

**Database migrations.** Add experiments, arms, strata, eligibility snapshots,
assignments, propensities, exposures, delayed reward components, sufficient statistics,
guardrail events, and stop decisions. Unique assignment/action keys prevent retry from
changing treatment.

**Queue/worker changes.** Persist assignment and capped exploration reservation before
creating the existing search job. Workers execute unchanged search actions and append
all positive, duplicate, negative, harm, and delayed outcomes. Curated minimum share is
enforced transactionally.

**API changes.** Authorized experiment configure/pause/stop/status APIs with optimistic
versions and predeclared policies; no direct term promotion. Reads expose sample size,
propensity, uncertainty, reward components, and guardrails.

**Compatibility considerations.** Initial exploration allocation is configurable and
small, never borrowed from protected manual/review capacity, and can be zero. Existing
curated behavior is the control/fallback. Do not compare unrandomized historical Phase F
performance as causal evidence.

**Operational risks.** Precision harm, quota runaway, assignment corruption, peeking,
confounding, delayed-outcome bias, or low-volume false winners. Use hard caps, stratified
randomization, immutable propensities, minimum samples, predeclared stopping, provisional
rewards, and automatic guardrail shutdown.

**Testing strategy.** Randomization balance and deterministic retry; concurrency and
budget invariants; synthetic null/positive/harm experiments; delayed and reordered
outcomes; confidence/posterior validation; kill switch; country/lane/ordering/time
strata; end-to-end staging without and with provider calls.

**Rollout strategy.** A/A test first, then one-country/one-concept shadow assignment,
then a tiny live budget (maximum configured by reviewed policy), with frequent human
review and automatic stop thresholds. Expand only after adequate samples.

**Rollback strategy.** Stop assignment, cancel only safe pending trial actions, restore
all traffic to curated/current catalogs, and retain exposures/outcomes for analysis.

**Completion criteria.** Assignments and costs reconcile; A/A is unbiased; delayed
verified reward is complete enough; no guardrail regression; estimates include sample
size and uncertainty rather than thresholded lifetime means.

**Go/no-go gate.** **GO** only with sufficient predeclared samples, lower confidence
bound above the cost-aware threshold, and no country/trading/harm/review-capacity
regression.

### Phase 13 — Policy-driven catalog publication

**Objective.** Publish proven concept surfaces as versioned, compact query catalogs
without putting the knowledge graph or AI on the online search path.

**Architectural scope.** Decision/serving boundary: atomic catalog publication,
eligibility state machine, hysteresis/cooldown, `STALE/SATURATED/HARMFUL/INVALID`,
manual override, minimum curated control share, and instant rollback.

**Affected subsystems.** Catalog repository, query planner, research action proposer,
terminology lifecycle compatibility, operator API/dashboard, audit, metrics, and
experiments.

**Database migrations.** Add active catalog pointer per scope, publication/rollback
events, lifecycle transitions with allowed-state constraints, cooldown/manual override,
and scheduled/config-change score snapshots. Preserve all prior catalogs and evidence.

**Queue/worker changes.** Producers pin the catalog/policy version into each action/job;
workers tolerate old versions and never query the graph. Demotion affects new proposals,
not already claimed jobs.

**API changes.** Authorized approve/publish/rollback/override endpoints using optimistic
version and idempotency key; compatible read endpoints add catalog and lifecycle
versions.

**Compatibility considerations.** Start with a catalog identical to current curated
output. Planner fallback is the last known-good curated catalog. Existing Phase F
statuses map through compatibility views until a later contraction is approved.

**Operational risks.** Bad global rollout, partial publication, catalog drift, status
flapping, or missing fallback. Use atomic pointers/checksums, canary scopes, transition
rules, hysteresis, retained versions, and automated precision alerts.

**Testing strategy.** State-machine/property tests; atomic concurrent publish; corrupted
catalog rejection; rollback under load; pinned in-flight jobs; country/script/locale
policy; curated-floor invariant; deterministic catalog reconstruction.

**Rollout strategy.** Publish no-op equivalent catalog, canary one approved surface and
scope, expand country by country, and retain controls. Require operator approval at
each step.

**Rollback strategy.** Atomically repoint to the last known-good catalog, stop candidate
experiments if needed, and leave knowledge/evidence intact for diagnosis.

**Completion criteria.** Online planning is predictable and graph-independent;
publication/rollback is atomic and audited; eligibility transitions cannot flap;
proven terms improve constrained coverage without precision regression.

**Go/no-go gate.** **GO** only after catalog rollback is rehearsed and canary metrics
meet the same causal/guardrail criteria used for promotion.

### Phase 14 — Evidence graph and new acquisition adapters

**Objective.** Expand beyond keyword search through typed evidence and one independently
budgeted acquisition adapter at a time.

**Architectural scope.** Relational evidence graph and common action adapters. Initial
node/edge types follow the approved architecture; global artifacts are reusable while
program-specific visit/attribution state remains separate. PostgreSQL is used until
measured scale proves otherwise.

**Affected subsystems.** Corpus/entity resolution, research frontier, ingestion,
provider/web policy, artifact cache, quota allocator, coverage, lineage, review, and
new adapters.

**Database migrations.** First PR adds typed evidence nodes/edges/assertions with
source, confidence, observed time, extractor version, path, canonical entity mapping,
and program visit state. Each adapter subphase may add only its bounded target/outcome
schema and policy fields. Enforce semantic action keys, depth, and validity windows.

**Queue/worker changes.** Each adapter is a separate job type implementing the common
contract and declaring quota class, cost, policy, outcomes, and bounded expansion. The
merge order is: `INSPECT_PLAYLIST`, `INSPECT_CHANNEL_RELATIONS`, `INSPECT_WEBSITE`, then
approved link/community/cross-platform adapters. Every adapter first runs proposal-only
shadow, then one capped pilot; successful observations propose, never directly execute,
bounded children.

**API changes.** Authorized graph/path/evidence and per-adapter budget/status/kill-switch
views. No unrestricted crawl endpoint. Provider/source policy failures are explicit.

**Compatibility considerations.** Search remains the fallback adapter and current
ingestion gates classify every discovered channel. Global artifact reuse never implies
program coverage and never double-charges provider calls. Adapter absence leaves the
controller functional.

**Operational risks.** Runaway fan-out, cycles, hub domination, topic drift, deep-path
trust decay, unsafe crawling, duplicate identities, or storage growth. Apply bounded
fan-out/depth, semantic dedupe, cluster/domain caps, relevance and confidence decay,
robots/source policy, retention, and separate budgets.

**Testing strategy.** Graph constraints and canonicalization; cyclic fixtures; restart
and duplicate expansion; fan-out/depth/budget limits; cross-program cache attribution;
topic-drift and trust-decay tests; provider-policy contracts; adapter-specific golden
fixtures; matched equal-budget experiment for each adapter.

**Rollout strategy.** Treat each listed adapter as a separately mergeable subphase:
schema/reader compatibility, proposal-only shadow, tiny canary, then measured expansion.
Never enable two new adapters in the same evaluation window.

**Rollback strategy.** Disable only the adapter's proposer/worker and stop new actions;
retain evidence and revert the budget to search/fallback. Policy-violating retained
artifacts follow deletion rules.

**Completion criteria.** For each adapter: paths are fully attributable, execution is
idempotent and bounded, country/trading precision holds, and verified incremental
coverage per total cost improves with acceptable drift and review load.

**Go/no-go gate.** **GO separately for every adapter** only after its equal-budget trial
adds verified, cluster-diverse coverage at acceptable cost. A failed adapter does not
block safe evaluation of the next adapter, but its production traffic remains off.

### Phase 15 — Portfolio allocation and adaptive policy

**Objective.** Allocate constrained budgets across persistent programs and action types
using measured causal evidence, while retaining deterministic safety and fallback.

**Architectural scope.** Three scheduling levels: portfolio allocator, program
controller, and provider allocator. Begin with transparent budgeted best-first search;
introduce a simple contextual bandit only after randomized data and offline policy
evaluation prove it safe. No opaque reinforcement learning.

**Affected subsystems.** Research programs/frontiers, coverage, experiments, all action
adapters, provider/review quotas, policy service, replay/off-policy evaluation,
dashboard, alerts, and kill switches.

**Database migrations.** Add portfolio policies/allocations, fairness floors, contextual
feature snapshots, posterior/sufficient-statistic versions, policy evaluations,
selection propensities, opportunity-cost decisions, and approvals. Retain exact fixed
policy versions for rollback.

**Queue/worker changes.** Allocator reserves provider/review capacity independently and
materializes selected actions before execution. Enforce portfolio, program, branch,
provider, cluster, and daily caps transactionally. Workers remain adapter executors,
not policy decision makers.

**API changes.** Authorized policy simulate/approve/canary/pause/rollback endpoints and
read-only explanations showing context, score components, constraints, propensity, and
version. Direct unconstrained weight editing is prohibited.

**Compatibility considerations.** Fixed best-first and current rotating scheduler are
retained policy fallbacks. Minimum curated/search and per-topic fairness shares prevent
starvation. Old outcomes without propensities are excluded from causal/off-policy
claims.

**Operational risks.** Rich-get-richer bias, topic starvation, nonstationarity,
propensity bugs, reward gaming, quota/review overload, and inexplicable decisions.
Use explicit exploitation/breadth/information/new-strategy/freshness allocations,
hard guardrails, delayed verified reward, drift monitoring, and simple models.

**Testing strategy.** Deterministic policy replay; conservation of every budget;
fairness/starvation and adversarial reward fixtures; off-policy estimator validation;
simulation on held-out time windows; A/A then randomized canary; delayed reward,
restart, concurrent allocation, and kill-switch tests.

**Rollout strategy.** Fixed best-first policy first; collect randomized exposure;
offline-evaluate a simple candidate policy; shadow; A/A; tiny country/time-block canary;
then gradual expansion with automatic guardrail rollback.

**Rollback strategy.** Atomically select the last fixed policy, stop adaptive
assignments, keep in-flight jobs pinned to their decision version, and preserve all
propensities/outcomes.

**Completion criteria.** Guarded canary improves verified incremental coverage per
total constrained cost at equal precision, respects fairness and all provider/review
budgets, and every choice is replayable and explainable.

**Go/no-go gate.** **GO for broader adoption** only after offline policy evaluation and
a statistically adequate guarded canary outperform the fixed policy without any
safety, precision, fairness, reliability, or capacity regression.

## 5. Required evidence package for every phase

No phase is complete with tests alone. Its PR/release record must contain:

1. approved objective and explicit non-goals;
2. schema migration and forward-compatibility review;
3. API and job-payload compatibility matrix;
4. deterministic test/build results and migration idempotence result;
5. staging or shadow/canary evidence appropriate to the phase;
6. baseline and post-change metrics with uncertainty and cohort definition;
7. quota/cost reconciliation and capacity impact;
8. dashboards, alerts, ownership, and runbook links;
9. executed rollback drill and retained evidence location; and
10. an explicit signed GO or NO-GO decision for the next phase.

## 6. First implementation approval point

Review and approval of this program authorizes planning only. **Phase 1 is the first
candidate implementation phase, but it must not begin until this document is reviewed
and Phase 1 is explicitly approved.** After approval, Phase 1 must be implemented on a
dedicated branch and end in its own clean pull request. Phases 2–15 remain blocked by
their predecessor gates.

