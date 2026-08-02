# Persistent research implementation — completion verification

## Verdict

The repository-side work for roadmap Phases 1–6 is complete. The persistent
research plane now has an autonomous, leased, replayable controller rather than
only tables and pure helpers. Production serving remains intentionally disabled,
shadowed, and kill-switched until an evaluated policy is explicitly canaried.
That operational gate is a production rollout requirement, not missing code.

The implementation extends the existing query planner, durable workers,
classifier, terminology lifecycle, evidence graph, entity resolution, coverage
lifecycle, and policy catalog. None of those authorities was replaced.

## End-to-end loop

Each enabled controller cycle now:

1. acquires the singleton research lease and pins an input cutoff;
2. projects completed query funnels, delayed reviews, and playlist results into
   immutable observation and outcome ledgers;
3. generates source-bound corpus hypotheses and terminology observations;
4. generates governed multilingual concept-surface trials;
5. adapts bounded playlist and temporal entity frontiers into common actions;
6. projects hierarchical coverage, sleeping, and scheduled reactivation;
7. generates coverage probes for specific uncertain concept cells;
8. loads canonical database actions and a pinned policy server-side;
9. enforces provider/review budgets, action and cluster caps, exploration share,
   provider mode, and per-cycle caps;
10. records immutable counterfactual or canary assignments;
11. materializes playlist work through the existing playlist worker and search,
    channel, multilingual, external-nomination, and coverage actions through the
    existing durable YouTube query scheduler;
12. records the checkpoint and releases the lease.

Controller failure is isolated: it cannot prevent the legacy query scheduler
from continuing.

## Phase verification

### Phase 1 — Integrated measurement foundation: complete

- `discovery_observation_events` is the immutable input ledger.
- Query funnels are automatically attributed from pinned query metadata.
- Delayed review decisions follow `channel_sightings` back to the originating
  query action and canonical entity when one is approved.
- Playlist results are projected through execution links.
- Outcomes retain assignment, source-event, incremental, cost, latency, and
  evidence attribution.
- Hierarchical coverage is replayed from existing immutable query ledgers.
- `persistent_research_cycles` records cutoff, checksum, policy, costs,
  candidates, selections, materialization, failure class, and checkpoint.
- A lease prevents concurrent controllers and permits restart-safe recovery.
- Existing protected audits, review ground truth, replay, and decision evaluation
  remain authoritative and are reused.

### Phase 2 — Operational non-query discovery: complete

- Existing temporal frontier safety remains authoritative for depth, fan-out,
  hubs, components, freshness, independence, and attribution paths.
- Eligible entity-resolved frontier candidates with approved YouTube bindings
  become common `SEARCH_CHANNEL` actions.
- Existing playlist proposals become common `INSPECT_PLAYLIST` actions.
- Selected playlist actions materialize through `enqueuePlaylistCanary`; selected
  creator-network resolutions use the durable query scheduler.
- Playlist execution links and results are projected automatically.
- Query controls remain available as contemporaneous portfolio controls.

No unbounded graph traversal or embedding-only neighbor crawl was added.

### Phase 3 — Exogenous terminology and multilingual semantics: complete

- The existing immutable corpus harvester continues to own exact Unicode spans.
- The controller reads qualified corpus occurrences, requires creator diversity,
  preserves document/creator/source provenance, records terminology observations,
  and proposes search hypotheses without automatic publication.
- Approved concept senses and local market affinities generate source-bound
  multilingual controlled trials.
- Existing language capability, terminology lifecycle, concept moderation,
  organic admission, experiments, and catalog publication retain their gates.
- New corpus and multilingual actions feed the common portfolio instead of a
  parallel serving path.

### Phase 4 — Coverage-driven research portfolio: complete

- Coverage cells are sparse and versioned across independent coordinates.
- Production query outcomes project observed creators, marginal yield, provider
  reachability, uncertainty, unseen directional mass, and last probe.
- Statistically supported low-yield cells sleep; the approved 90-day scheduled
  probe reactivates them. Other canonical reactivation triggers remain recorded.
- Specific concept cells generate bounded coverage probe actions.
- Freshness is an active utility feature rather than an unused policy field.
- Allocation reads canonical actions from the database; the former client-owned
  allocation endpoint now fails closed.
- Global provider/review budgets subtract both observed spend and outstanding
  reservations. Provider mode, action caps, program floors, cluster caps,
  curated-search controls, and per-cycle caps are enforced.
- Deterministic selections record truthful propensities of 0 or 10,000. Existing
  randomized experiment infrastructure remains the authority for randomized
  causal trials.

### Phase 5 — Structured external providers: repository complete, rollout pending

Repository implementation includes:

- a versioned provider registry with type, family, capabilities, locale policy,
  quota domain, terms reference, mode, and daily cap;
- bounded, normalized, deduplicated external nominations;
- immutable provider-native observation records and payload checksums;
- source-family and source-locator attribution;
- nomination hypotheses that remain non-classifying;
- common `SEARCH_CHANNEL` actions routed through existing durable execution;
- fixture-level contract tests; and
- explicit exclusion of arbitrary web crawling.

A concrete provider remains paused until operators supply its contract,
credentials, legal/privacy approval, production quota, fixtures, and successful
canary evidence. Those facts cannot be manufactured in repository code.

### Phase 6 — Governed contextual allocation: complete

- Only server-loaded canonical actions can be allocated.
- Contextual policies reuse `portfolio_policies` and must be the pinned active
  policy.
- Canary configuration requires both a CANARY policy and a passing immutable
  persistent-research policy evaluation.
- Offline evaluation records dataset cutoff, sample sufficiency, incremental
  confirmations per cost, rejection guardrails, artifact checksum, and decision.
- Shadow cycles record counterfactual assignments but never change action
  lifecycle or serving.
- Canary cycles enforce all global constraints transactionally.
- Search materialization uses `FOR UPDATE SKIP LOCKED`, a reservation lease, and
  an atomic lifecycle claim before creating the query record. Failures release
  the reservation; stale reservations are reclaimable.
- Playlist and search materialization retain their existing adapter-specific
  quota and kill-switch controls.
- The deterministic best-first allocator and legacy query scheduler remain the
  permanent fallback.

## Recommendation accounting

| Recommendation | Final status |
|---|---|
| Unified typed discovery actions | Complete: durable lifecycle, leases, execution links, observations, and outcomes. |
| Persistent research programs | Complete: objectives, hypotheses, leased cycles, checkpoints, sleeping/reactivation. |
| Multi-source candidate generation | Complete: corpus, concepts, playlist, temporal graph, coverage, and external nominations. |
| Creator-network exploration | Complete within bounded explicit relationships and approved entity bindings. |
| Corpus terminology exploration | Complete and source-bound; existing governance controls publication. |
| Multilingual concept/alias discovery | Complete for approved senses and market affinities under controlled trials. |
| Hierarchical coverage | Complete as a replayed sparse projection. |
| Coverage-gap generation | Complete for specific reachable concept cells. |
| Capture–recapture/unseen estimation | Conservatively retained as directional evidence; it never asserts absolute recall. |
| Provider-neutral discovery | Complete registry, normalized inputs, common actions, and existing adapter materialization. |
| Structured external nominations | Repository complete; concrete production provider activation is operationally pending. |
| Contextual portfolio | Complete, server-owned, policy-pinned, evaluated, capped, and replayable. |
| Incremental/delayed attribution | Complete for query, review, and playlist paths. |
| Semantic/ecosystem diversity | Complete through action clusters, overlap inputs, and caps. |
| Diminishing returns | Complete through projected yield, conservative sleeping, and scheduled reactivation. |
| Exploration/exploitation | Complete with protected deterministic allocation and existing randomized trial authority. |
| Representative evaluation/active learning | Existing implementation retained and connected through attributed outcomes. |
| Production classification safety | Unchanged and complete. Discovery never grants a terminal classification. |
| Automatic provider rollout | Correctly remains an explicit operational decision after canary evidence. |

## Production invariants

- Persistent research defaults off, shadowed, and kill-switched.
- No discovery action changes classification thresholds or terminal decisions.
- No model-generated term automatically publishes to search.
- All serving requires a pinned evaluated policy and adapter-specific controls.
- All recursive exploration remains depth/fan-out/hub/component bounded.
- All provider work retains existing quota reservation and durable job behavior.
- Duplicate cycles, observations, hypotheses, actions, assignments, links,
  nominations, and outcomes are idempotent.
- Immutable ledgers are never rewritten by a new policy version.
- Arbitrary crawling remains unsupported.

## Remaining operational rollout

The repository cannot choose third-party vendors, accept their terms, create
credentials, allocate production budget, produce human labels, or demonstrate a
real-world canary result. Operators must perform those actions before enabling
CANARY mode. Until then the completed architecture runs only in its safe shadow
configuration and the existing autonomous query engine remains authoritative.
