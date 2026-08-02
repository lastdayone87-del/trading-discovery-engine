# Persistent research implementation — final repository verification

## Verification result

The repository does **not** yet satisfy every recommendation from the original
architectural review. It is therefore not accurate to confirm that Phases 1–6
are fully implemented or that only operational rollout remains.

Migrations 043–044 and the persistent-research controller provide substantial,
fail-closed foundations. They preserve the existing scheduler, classifier,
terminology governance, entity resolution, graph limits, and adapter controls.
All six phases are implemented in repository code. Phase 5's real-provider
onboarding correctly remains external/operational, while Phase 6 now uses immutable
logged behavior assignments and propensities for support-aware, time-split offline
policy evaluation.

## Correctly implemented and retained

The following work is real and should be preserved:

- typed discovery actions, hypotheses, provider registry, assignments, outcomes,
  execution links, and cycle records;
- disabled, shadow, pause, kill-switch, policy-pin, and optimistic-version gates;
- immutable observation, assignment, outcome, nomination, and evaluation rows;
- controller and action leases, durable query scheduling, and playlist canary
  reuse;
- exact-span corpus input, existing terminology lifecycle, governed concept
  surfaces, entity-resolution controls, and temporal graph caps;
- server-owned action loading instead of accepting an allocation result from a
  client;
- global cost accounting, cluster/action constraints, deterministic allocation,
  and legacy query fallback;
- source-bound structured nomination ingestion without arbitrary crawling; and
- isolation of research-cycle failure from the authoritative query scheduler.

These make the current code safe to keep disabled or shadowed while completion
work continues.

## Phase-by-phase status

### Phase 1 — Integrated measurement foundation: **complete**

Phase 1 now includes:

- immutable aggregate observations plus entity-level channel/canonical-entity captures;
- deterministic earliest-research-sighting attribution for delayed review decisions;
- entity-level playlist capture with known/new comparison against prior captures;
- immutable equal-path multi-action credit snapshots whose basis points conserve
  exactly 10,000 per entity;
- immutable treatment-versus-legacy-control incrementality snapshots based on
  entity overlap rather than aggregate result counts;
- assignment, cost, rank, coordinates, source family, cutoff, and source-capture
  lineage; and
- leased, checkpointed cycle projection over the existing immutable query/review
  ledgers.

The aggregate outcome rows remain for backward-compatible dashboards, but the
entity capture and credit ledgers are now the authoritative substrate for new
research evaluation. No remaining Phase 1 recommendation requires repository
code.

**Conclusion:** Phase 1 is fully complete in repository code.

### Phase 2 — Operational creator-network discovery: **complete**

Implemented and independently verified:

- a bounded, deterministic, source-span relationship extractor for exact YouTube
  channel IDs and handles, with typed featured, collaboration/guest, mention, and
  linked-creator candidates, stable deduplication, confidence, and fan-out caps;
- durable relationship candidates backed by corpus artifacts and source families,
  plus exact-provider-native entity resolution for channel IDs and governed
  resolver/search actions for ambiguous handles;
- common-action producers and the existing durable query executor for
  `INSPECT_FEATURED_CHANNELS`, `INSPECT_COLLABORATOR`,
  `RESOLVE_EXTERNAL_ENTITY`, and `REFRESH_STALE_FRONTIER`;
- temporal relationship recording only from source-bound evidence and approved or
  exact-native canonical identities, retaining the existing graph depth, hub,
  component, freshness, and source-independence safety controls;
- deterministic graph-versus-search-control assignment with immutable propensity
  and entity-level outcome ledgers, so incremental graph yield and provider cost
  can be compared without aggregate-count attribution;
- bounded stale-frontier reactivation and post-execution relationship resolution;
  and
- parent action and execution-link chaining from the creator capture that caused
  the network expansion through the resulting durable query run.

Playlist discovery remains on its existing bounded adapter rather than being
replaced. Ambiguous account handles deliberately pass through the normal YouTube
search, classifier, and entity-resolution governance path; they are never
silently promoted to approved bindings. All new serving remains behind the
existing provider registry, allocator budgets, canary mode, pause, and kill
switch. No remaining Phase 2 recommendation requires repository code.

**Conclusion:** Phase 2 is fully complete in repository code. Production
migration, canary enablement, monitoring, and experiment-duration decisions are
operational rollout activities and are not repository-code gaps.

### Phase 3 — Exogenous terminology and multilingual semantics: **complete**

Implemented and independently verified:

- persistent-research corpus producers for transcript text, playlist titles,
  website text, uncertain-channel evidence, reviewed false negatives, and channel
  metadata, with bounded retained excerpts, immutable artifacts, lineage checks,
  cluster identities, existing compute controls, and deterministic Unicode spans;
- typed `MINE_TRANSCRIPT_KEYPHRASES` and `MINE_CHANNEL_CORPUS` common actions,
  explicit portfolio caps, a provider-registry gate, a bounded local materializer,
  execution links, and idempotent corpus persistence;
- multilingual surface admission through the existing global organic-query and
  language-capability gate rather than a parallel policy;
- corroboration from distinct observed corpus artifacts instead of treating a
  concept sense and its moderation record as independent usage evidence;
- an immutable emerging-terminology burst ledger that conservatively reactivates
  matching sleeping programs and coverage cells only after a multi-source burst;
- deterministic terminology-versus-baseline trials with recorded propensity,
  assignment and quota caps, entity-level outcome evaluation, and source-bound
  concept-resolution jobs; and
- a complete governed handoff from approved concept sense and positive trial to a
  catalog publication request. The handoff explicitly requires the existing
  approved catalog-version and atomic pointer-CAS controls and never enables
  automatic publication.

Existing corpus retention, concept moderation, organic-query admission, language
model, terminology lifecycle, catalog publication, and rollback mechanisms were
reused rather than replaced. Provider and program modes remain fail-closed; local
corpus execution occurs only under an evaluated canary with an enabled provider.
No remaining Phase 3 recommendation requires repository code.

**Conclusion:** Phase 3 is fully complete in repository code. Applying the
migration, enabling bounded providers/programs, completing human concept and
catalog approvals, and observing a statistically sufficient live trial window
are operational rollout activities, not repository-code gaps.

### Phase 4 — Coverage-driven research portfolio: **complete**

Implemented and independently verified:

- a sparse six-level opportunity surface spanning country, language, market,
  concept, content style, and provider, with deterministic cell and parent keys;
- entity-level coverage projection from immutable captures into every hierarchy
  level, rather than country-only aggregate query counters;
- independent-lane capture–recapture unseen-mass estimation with explicit
  abstention when fewer than two lanes or no cross-lane overlap are available;
- probe generation from actionable concept-level cells, with deterministic targets,
  scheduled-probe priority, program scope, and the existing quota allocator;
- immutable coverage projection snapshots containing the exact lane entity sets,
  cutoff, estimate, uncertainty, and reason codes needed for replay;
- ecosystem overlap based on result-set Jaccard, normalized semantic terms,
  creator components, and source-family overlap, with component explanations
  persisted on actions and immutable completed-action signatures;
- cutoff-pinned sleep/reactivation decisions with immutable cell lifecycle events;
- terminology-burst, new-content, provider-capability, human-nomination, and
  scheduled-probe triggers wired into the same event-before-mutation transition;
  and
- research-program sleep and reactivation derived from scoped coverage cells, with
  immutable program lifecycle events and affected-cell lineage.

The existing coverage table, gap-action helper, allocator, sleep predicates,
capture ledger, provider governance, and lifecycle event table were extended and
retained. Estimation fails closed rather than fabricating unseen mass from one
provider. No remaining Phase 4 recommendation requires repository code.

**Conclusion:** Phase 4 is fully complete in repository code. Applying the
migration, selecting canary budgets, monitoring live lane independence, and
waiting for scheduled probes are operational rollout activities, not
repository-code gaps.

### Phase 5 — Structured external providers: **repository-complete; activation operationally blocked**

Implemented and independently verified:

- a provider-neutral, code-registered structured adapter interface with typed
  requests, typed nominations, opaque continuations, and abort signals;
- durable provider jobs on the existing queue, worker dispatch, heartbeat/stale
  recovery, exponential retry, timeout, page-size, page-count, daily-request, and
  continuation caps;
- fail-closed adapter controls separate from the provider registry, including
  shadow mode, pause, kill switch, configuration version, and zero default quota;
- autonomous polling for explicitly configured and registered allowlisted adapters;
- immutable provider run/page ledgers with cursor hashes and payload checksums;
- dedicated materialization for `RESOLVE_EXTERNAL_ENTITY`,
  `INSPECT_WEBSITE_AUTHOR`, and `HUMAN_NOMINATION` actions;
- conservative provider-native identity resolution: an exact YouTube channel ID
  can create an exact-native binding, while handles, names, and ambiguous locators
  remain search-required and pass through the existing classifier/entity pipeline;
- immutable native-identity resolution observations retaining provider namespace,
  native ID, source family, confidence, locator evidence, and decision; and
- fixture adapters covering output bounds, continuation, cooperative timeout, and
  exact-versus-ambiguous identity behavior.

Adapters cannot accept arbitrary URLs and the generic layer contains no web
crawler. Existing nomination normalization, duplicate prevention, source-family
lineage, allocator budgets, durable job failure semantics, provider registry,
classifier, and entity governance are reused. No remaining Phase 5 recommendation
requires repository code.

**Conclusion:** Phase 5 is fully complete in repository code. Selecting real
providers, adding credentials through production secret infrastructure,
contract/legal approval, provider-specific adapter packages, setting real quotas,
applying migrations, and canary outcome collection are genuine operational or
external-infrastructure dependencies. Until those occur, controls remain paused
and killed with zero request capacity. This operational block does not prevent the
repository-only Phase 6 audit below.

### Phase 6 — Governed contextual allocation: **complete**

Implemented and independently verified:

- replay uses an explicit evaluation-window start and cutoff and rejects invalid
  windows, rather than evaluating an undifferentiated history;
- every observed reward is joined through its immutable selected behavior-policy
  assignment, retaining the assignment identity and actual logged propensity;
- inverse-propensity weights use the target-policy probability as numerator and the
  logged behavior-policy probability as denominator;
- candidate or baseline selections without logged support are recorded explicitly and
  force `ABSTAIN` instead of being converted into zero-reward observations;
- effective sample size, confidence intervals, and country/language segment guardrails
  are calculated only from supported observations;
- the caller's positive integer `minimumAssignments` gate is validated, persisted in
  the evaluation artifact, and applied to both policy arms;
- sealed replay datasets and immutable action decisions retain evaluation windows,
  behavior assignments, behavior and target propensities, and support status;
- regression tests cover unequal logged propensities, support mismatch, sample-floor
  enforcement, time-window wiring, and assignment/outcome joins; and
- the previously verified allocation constraints, protected exploration, mandatory
  baseline, atomic activation audit, pause, kill switch, budgets, and policy pin remain
  intact.

**Conclusion:** Phase 6 is fully complete in repository code. Applying migrations,
collecting a representative time-split dataset, obtaining policy approval, and running
a monitored canary are operational rollout activities rather than repository-code
gaps.

## Recommendation accounting

| Original recommendation | Final repository status |
|---|---|
| Unified typed actions | Complete: common actions, provider capabilities, dedicated or durable materializers, execution links, and outcome projection are implemented. |
| Persistent research programs | Complete: leased cycles, checkpoints, hypotheses, actions, coverage-derived sleeping/reactivation, and immutable lifecycle events are implemented. |
| Multi-source generation | Complete: query, corpus, transcript, playlist, website, false-negative, graph, multilingual, coverage, nomination, and structured-provider inputs are supported under governance. |
| Creator-network expansion | Complete: bounded extraction, exact/ambiguous identity handling, temporal edges, stale refresh, graph/search experiments, and attribution chains are implemented. |
| Corpus terminology exploration | Complete: multi-corpus ingestion, exact spans, independent usage, burst detection, concepts, randomized trials, evaluation, and governed publication handoff are implemented. |
| Multilingual discovery | Complete: global capability admission, scripts/locales, independent evidence, controlled trials, and existing catalog governance are retained. |
| Hierarchical coverage and gap generation | Complete: six-level sparse cells, capture–recapture estimates, probes, replay snapshots, triggers, and program lifecycle are implemented. |
| Provider-neutral and structured providers | Complete in generic repository code: registry, typed adapter contract, durable jobs, bounds, immutable ledgers, and identity workflow exist; real provider onboarding is operational/external. |
| Contextual portfolio and exploration/exploitation | Complete: allocation constraints, protected exploration, sealed artifacts, atomic activation, logged-behavior IPS, explicit support, time-split evaluation, and sample gates are implemented. |
| Incremental/delayed attribution | Complete: entity captures, delayed review projection, multi-path credits, incrementality snapshots, and provider/review costs are implemented. |
| Semantic/ecosystem diversity | Complete: result, semantic, creator-component, and source-family overlap affect allocation with replayable explanations. |
| Diminishing returns | Complete: cutoff-pinned cell/program sleeping, scheduled probes, immutable transitions, and all specified reactivation triggers are implemented. |
| Representative evaluation/active learning | Complete: existing production evaluation is retained; research-policy replay uses logged behavior assignments/propensities, abstains without support, enforces explicit evaluation windows and sample gates, and reports segmented uncertainty. |
| Production classification and rollout safety | Complete and retained: classifier authority is unchanged; flags, provider modes, evaluated policies, budgets, pause, kill switches, leases, idempotency, and audit events remain fail-closed. |

## Final confirmation

All repository-code recommendations from the six-phase architectural roadmap are now
accounted for and implemented. **Phases 1 through 6 are fully complete in repository
code.** No repository-code gap from the authoritative audit remains.

Remaining work is limited to migration application, real provider/credential/legal
onboarding, human approvals, representative time-split data collection, canary
monitoring, and staged rollout. Those activities require production infrastructure,
external agreements, elapsed observation windows, or human governance and cannot be
completed solely by changing this repository.
