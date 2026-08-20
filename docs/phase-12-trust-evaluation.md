# Phase 12 — Trust and evaluation layer

## Authority and lineage audit

Phase 12 is an observation-only projection. Evidence generators own evidence;
`frontier_discovery_proposals` owns proposal identity/lifecycle; Phase 8 owns
`frontier_allocation_decisions`, Pacific quota-day reservations and capacity;
Phase 9 owns `query_runs`, continuation and provider execution. `channels` and
`channel_sightings` own creator identity/outcomes and the existing quality policy
remains authoritative. Country-Native and External OSINT own their existing
performance attribution tables. The autonomous scheduler remains the sole
scheduler. Phase 12 is allowed to insert only evaluation observations/snapshots.

Allocation decisions and `proposal_evidence_snapshot` are immutable historical
state. Proposal lifecycle and creator classification are mutable operational
state. A run observation records both the allocation snapshot and a separately
timestamped, checksummed classification observation. Late classification creates
an immutable per-run observation revision; it never updates an earlier revision.
Later evidence/proposal/classification changes therefore cannot rewrite history.

Completion commits before best-effort evaluation capture. Completion replay invokes
capture again, and terminal failures use the same best-effort path; identical
outcome checksums deduplicate while genuinely late outcomes create a revision.
Snapshot identity is
`cohort + half-open UTC window + evaluator version + revision`; an identical retry
is idempotent and a changed source checksum requires a new revision. Reads are
bounded to 10,000 ordered runs and diagnostics to 500 snapshots. Evaluation has
no quota, allocation, classification, proposal, retrieval, or scheduling writes.

## Model, cohorts, and denominators

Every observation carries persisted allocation origin/family/evidence, country,
language/locale/script/concept, source families, provider/cohort, quota, requests,
latency, results and creator outcomes. Provenance is never parsed from query text.
Deterministic cohorts cover overall, legacy/frontier allocation origin, proposal
family, country, language, independent source family and concept over `[start,end)`.

Per-query yield divides each new/relevant/quality/confirmed count by terminal run
count. Precision divides those useful-new outcomes by new creators. Novelty is new
over distinct creators; redundancy is known over distinct creators. Efficiency is
quota over relevant-new creators (null when none), plus request/allocation counts
and latency. Failure rates use terminal runs; wrong-country and irrelevant rates use
distinct creators because those funnel outcomes are creator-level. Provider request count is the greater of observed
page depth and authoritative quota cost divided by the 100-unit search cost.
Coverage counts distinct persisted countries, languages, concepts and source
families; expansion requires no earlier persisted observation of that identity.
Totals and explicit denominator fields are presented beside normalized
rates, so legacy/frontier traffic differences cannot masquerade as performance.

“Incremental” is limited to directly observed novelty (`was_known=false`) at the
authoritative sighting boundary. It is not a causal counterfactual. Legacy/frontier
overlap and comparative yields are descriptive; what legacy *would* have found is
unknown without a randomized compatible trial. Rediscovery is redundancy.

## Trust and uncertainty

The explainable status exposes all components and a 95% Wilson interval for
relevance precision. Fewer than 20 completed queries is always
`INSUFFICIENT_EVIDENCE`; otherwise explicit failure-rate, precision and yield
thresholds produce `HEALTHY`, `WATCH`, or `DEGRADED`. Status never disables work.
Provider failures affect operational degradation, not semantic evidence.

Country-Native grouping uses its frozen canonical-term identity, locale/language,
native status and provenance. New proposals persist these fields at allocation;
older snapshots retain their canonical term ID without reconstruction. OSINT grouping
uses the frozen canonical concept and deduplicated `sourceFamilies` snapshot;
corroboration quality remains separate from retrieval outcome quality. Stale and
expired proposals remain lifecycle metrics in their existing authorities and must
be reported alongside, not rewritten as retrieval failures.

## Operational interpretation and remaining risk

The engine can admit governed legacy, learned/creator/playlist/coverage/temporal,
Country-Native and External OSINT concepts; Phase 8 allocates and Phase 9 retrieves.
Phase 12 now makes outcome value, cost, coverage, redundancy and degradation
auditable without becoming a control plane. It does **not** prove production
effectiveness: sufficient real observations and, for causal incrementality,
randomized trials are still required. Current risks are sparse country-language
cohorts, delayed reclassification, imperfect wrong-country labels, correlated
sources upstream of the frozen family list, and the intentional 10,000-run report
bound. Rollouts/canaries remain controlled by their existing default-off settings.
