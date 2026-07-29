# Architecture Review: The Next Evolution of Query Intelligence

Date: 2026-07-29

## Executive decision

The proposed direction is strategically correct, but it should **not** be implemented
as an AI-managed vocabulary loop and it is **not** the highest immediate production
priority.

The engine should evolve from a vocabulary list into an **evidence-derived concept
graph plus a controlled experimentation system**. Deterministic/statistical extraction
should generate candidates, a versioned AI classifier should annotate only ambiguous
candidates, and randomized low-budget trials should estimate incremental discovery
value. Curated terms should remain immutable control arms and a cold-start fallback.

However, the production-readiness blockers already identified—operator authorization,
staging/restart proof, backups, provider timeouts, and trustworthy observability—come
first. A self-learning loop magnifies measurement, security, and operational defects.
After those foundations, this is the strongest remaining *discovery-quality*
investment because it addresses vocabulary coverage rather than merely optimizing a
fixed search space.

This is also not a wholly new subsystem. Phase F already has country-scoped canonical
terms, aliases, append-only observations, lifecycle events, controlled eligibility,
production attribution, decay, and demotion. The next phase should therefore replace
the weak parts of that implementation rather than create a parallel third vocabulary
store.

## What the current architecture already gets right

The current pipeline has several sound boundaries worth preserving:

- Query planning emits compact retrieval atoms instead of AI-authored prose and keeps
  curated country vocabularies as stable anchors.
- Search execution is a durable, quota-paced queue concern, separate from planning.
- Query results are measured as a funnel of distinct creators, country fit, trading
  relevance, quality, community presence, and novelty rather than raw result count.
- Manual-search observations are isolated from automatic learning unless human review
  supplies explicit provenance.
- Phase F separates canonical terms, aliases, observations, performance, lifecycle
  history, and score snapshots.
- Learned terms must pass creator/community-diversity gates before a search trial;
  branding is not automatically searchable.

Those are the correct primitives. The problem is that Phase F currently implements a
thresholded term list, not yet a robust learning system.

## Critical findings in the present Phase F design

### 1. Extraction is still partly generative and weakly constrained

The Gemini prompt asks the model to “identify” terminology and returns free-form JSON.
That allows invention, paraphrase, and taxonomy drift even if the intention is to use
AI only as a classifier. The deterministic path recognizes only a small hard-coded
instrument list. Neither path first constructs candidates from spans that demonstrably
occur in source text.

**Required correction:** candidate text must be traceable to exact source spans.
Extraction should begin with deterministic n-grams, named-entity recognition,
collocation statistics, and repeated phrase mining. AI may accept/reject and annotate
those spans but must not add unseen strings. Persist source document ID, offsets,
extractor version, and a content hash.

### 2. Identity is country-plus-normalized-string, not concept identity

The uniqueness key `(country, normalized_term)` creates separate records for the same
global concept while also collapsing homonyms within one country. Alias support exists,
but aliases are not used by planning or performance attribution and no durable concept
links represent synonymy, translation, broader/narrower relations, or ambiguity.

**Required correction:** introduce a country-neutral `concept` identity and separate
locale-specific `term_surface` records. Surface forms should carry language, script,
country affinity, validity interval, and an ambiguity flag. A surface may map to more
than one concept until context or review resolves it. Country policy belongs on a
concept-surface-market edge, not in the concept's primary key.

### 3. Evidence independence can be overstated

Distinct channel IDs are not necessarily independent creators. Reposted titles,
network-owned channels, common affiliate funnels, the same Discord, templated content,
and channels discovered by the same query can produce correlated observations.
Conversely, requiring two Discord/community fingerprints disadvantages excellent
creators without public communities and terms used by legitimate but private groups.

**Required correction:** estimate source independence using creator/entity resolution,
shared domains and community IDs, textual near-duplicate clusters, discovery-query
lineage, and ownership where available. Use diversity as a continuous feature and
never make Discord presence a universal promotion prerequisite.

### 4. Performance is confounded and the score is not actually time-decayed

Term performance currently uses `new creators / distinct results`, while the planner
combines a learned modifier with a curated anchor. The result cannot isolate which
atom caused retrieval, and it ignores confirmed relevance, country precision, creator
quality, community value, ordering, lane, saturation, and quota efficiency in the
promotion score. The field named `decayed_yield_score` records an instantaneous ratio,
and lifecycle aggregation weights all historical executions equally.

The resulting promotion threshold is especially unsafe at low sample sizes: three
successful runs can promote a term, while five weak runs can demote it, without
uncertainty bounds, a control query, or randomized assignment.

**Required correction:** treat a query template/atom combination as the experimental
unit. Randomize eligible trials within country, lane, ordering, time window, and anchor
strata. Estimate incremental utility against a curated/control arm and retain exposure
propensity. Use a posterior or confidence interval, minimum sample size, and cost-aware
reward. Decay raw sufficient statistics by event time or use a state-space model; do
not label an undecayed lifetime mean as decayed.

### 5. Lifecycle transitions are not a state machine

The decision function does not use its `current` input. A previously proven term may
fall directly to `SEARCH_TRIAL`, and a demoted term can immediately re-enter trial as
soon as the demotion condition no longer holds. There is no quarantine, hysteresis,
manual override, reactivation policy, or distinction between temporary fatigue and
semantic invalidity. Score snapshots are produced for every observation, which will
grow rapidly while duplicating nearly identical state.

**Required correction:** define allowed transitions, separate eligibility from status,
add cooldown and hysteresis, distinguish `STALE`, `SATURATED`, `HARMFUL`, and
`INVALID`, and schedule snapshots or emit them only on state/configuration changes.

### 6. Learning is vulnerable to endogenous feedback

The engine learns from creators found by its own existing vocabulary. It will amplify
the language of already well-covered communities, popular strategies, and the
platform's ranking algorithm. Promotion based on net-new channels still favors terms
used by sources the current search path can reach. Malicious creators could seed
phrases across channels to steer future searches.

**Required correction:** record complete discovery lineage and distinguish exogenous
evidence (approved corpus imports, direct/organic sightings, independent sources) from
query-induced evidence. Cap contributions per entity cluster, detect coordinated term
bursts, reserve traffic for frontier exploration, and evaluate country/strategy
coverage—not only creator yield.

### 7. Country and language are underspecified

Observed terms default to language `und`; script inference is coarse, and query script
policy is hard-coded. Country is being asked to represent language, jurisdiction,
creator residence, audience, market traded, and query locale, which are different
dimensions. English trading terminology is routinely used by French or Italian
creators, and one creator may target several countries.

**Required correction:** model `language`, `locale`, `creator_country`,
`audience_country`, `market_or_instrument`, and `platform_region` independently, each
with evidence and confidence. Country targeting should consume these facts rather than
overwrite them into one label.

## Is this the strongest remaining improvement?

### Strategic answer

Yes, **after operational readiness**, evidence-derived query expansion is the
strongest remaining improvement to discovery recall. Adaptive pagination, ordering,
and bandit selection can only search more efficiently within known concepts. A concept
learning layer expands the reachable ecosystem and can reveal regional language,
emerging instruments, new platforms, and creator-native content formats.

### Immediate answer

No. The following work has higher priority before a learning loop receives production
traffic:

1. Authenticate and authorize all mutation and quota-consuming APIs.
2. Complete PostgreSQL migration, restart, stale-job, quota-reset, provider, and backup
   restoration rehearsals in staging.
3. Add provider deadlines/cancellation, structured request/run IDs, metrics, alerts,
   and cost accounting.
4. Calibrate country and trading classifiers on the human-reviewed corpus, including
   per-country precision/recall and drift monitoring.
5. Establish a reproducible offline evaluation dataset and replay framework.

Without these, new terminology can increase throughput while making quality,
causality, and failures harder to understand.

## Better approaches to the same goal

The strongest architecture combines four methods rather than choosing one:

### A. Corpus mining for candidate generation

Use source-bound deterministic/statistical methods:

- Unicode-aware tokenization and language identification;
- 1–5 gram frequency with TF-IDF or log-likelihood against a non-trading background
  corpus;
- noun-phrase/keyphrase extraction;
- financial entity dictionaries for instruments, venues, platforms, and markets;
- temporal burst detection for emerging vocabulary;
- embeddings only for nearest-neighbor candidate grouping, never as identity truth;
- exact offsets and document hashes for every candidate occurrence.

This is cheaper, reproducible, complete over the observed corpus, and incapable of
inventing a term that was not present.

### B. AI for bounded semantic adjudication

Use AI when rules cannot reliably answer semantic questions. Give it the literal span,
local context, source facts, and a closed schema. It may classify:

- trading relevance and sense in context;
- concept class (`STRATEGY`, `MARKET`, `INSTRUMENT`, `EDUCATION`, `PSYCHOLOGY`,
  `PLATFORM`, `FORMAT`, or `OTHER`);
- language and probable locale;
- spam, brand, person, generic-word, or ambiguity flags;
- proposed synonym/translation links to an explicit shortlist of existing concepts.

Require abstention, calibrated confidence, schema validation, model/prompt version,
and evidence quotes/offsets. Validate language and known entities deterministically.
Never permit model output to become search eligible directly.

### C. A concept graph for knowledge representation

Store meanings separately from surface forms and store relations with provenance:

- `concept` — stable semantic identity and category;
- `term_surface` — literal string, language, script, locale, validity window;
- `concept_relation` — synonym, translation, abbreviation, broader/narrower,
  related-to, or commonly-combined-with;
- `term_observation` — immutable source span and discovery lineage;
- `market_affinity` — country/locale usefulness as a learned distribution;
- `classification_assertion` — deterministic, AI, and human claims side by side;
- `experiment`, `exposure`, and `outcome` — assignment propensity and delayed reward;
- `policy_version` and `decision` — reproducible eligibility decisions.

Do not make the graph itself an online query dependency. Publish versioned, compact
country/locale query catalogs from it so the search path stays predictable and can
roll back atomically.

### D. Causal, budgeted online experimentation

Use a constrained contextual bandit only after randomized trial data exists. Context
should include country/locale, retrieval lane, ordering, query template, time, term
category, maturity, and recent saturation. Optimize a multi-objective reward such as:

`verified net-new creator value + coverage gain + community value - quota cost - review cost - harm penalties`

Apply hard constraints for country precision, non-trading rate, unsafe/spam results,
daily exploration budget, and minimum curated fallback share. Begin with simple
Thompson sampling or Bayesian beta/binomial components where the metric permits it;
do not use opaque reinforcement learning.

## Risks, failure modes, and controls

| Risk | Likely consequence | Required control |
| --- | --- | --- |
| Model hallucination | Invented or mistranslated terms | Source-span constraint; closed schema; abstention |
| Homonyms/polysemy | Non-trading or wrong-country searches | Contextual senses; ambiguous many-to-many mapping; trial precision guardrail |
| Popularity feedback | Dominant communities crowd out niches | Cluster contribution caps; coverage reward; frontier budget |
| Search-ranking bias | “Successful” terms merely mirror platform ranking | Randomized strata; ordering/lane attribution; control arms |
| Duplicate/affiliate networks | Fake creator diversity | Entity and near-duplicate clustering |
| Adversarial term seeding | Search poisoning and quota waste | Burst/co-occurrence anomaly detection; trust caps; quarantine |
| Trend churn | Premature promotion of short-lived slang | temporal features; minimum duration; hysteresis |
| Slow-moving valid niches | Useful terms never meet volume gates | human nomination; category-specific priors; low-volume evaluation |
| Country leakage | Global English terms erase local discovery | country affinity distribution; local exploration floor |
| Metric gaming | Clickbait yields many results but poor creators | delayed verified-quality reward; negative/harm metrics |
| Attribution error | Modifier gets credit for anchor performance | factorial/paired trials; per-combination attribution |
| Corpus/licensing/privacy | Unnecessary retention of scraped text | store minimal excerpts/hashes; retention and deletion policy |
| AI/provider drift | Inconsistent classifications over time | versioned assertions; golden-set regression; shadow rollout |
| Operational runaway | Quota and inference cost spikes | separate budgets, queue types, rate limits, kill switch |

## Global versus country-specific intelligence

Neither a single global vocabulary with weights nor fully isolated country databases
is sufficient. Use a **federated global concept graph with country/locale overlays**.

### Global layer

Globally stable meanings—Bitcoin, DAX, order flow, options, risk management—have one
concept identity. Cross-language synonyms and translations link local surface forms to
that concept. Evidence can strengthen confidence that the concept exists without
automatically making every surface form searchable everywhere.

### Country/locale overlay

Each country learns its own:

- observed surface forms and languages;
- creator/audience affinity;
- search performance by lane, ordering, template, and time;
- eligibility, exploration budget, and local negative terms;
- local aliases, spelling, platforms, regulations, and content formats.

French evidence should dominate decisions for French traffic, Italian evidence for
Italian traffic, and so on. Global propagation should create a **candidate prior**, not
an eligible query. A propagated term must pass script/language checks and a small local
trial (or explicit human approval) before promotion. Hierarchical Bayesian priors are
well suited here: sparse countries borrow strength from global or language-family data
while sufficient local data overrides the prior.

This avoids two opposite errors: globally popular English terminology overwhelming
local language, and isolated country stores relearning the same universal concepts
without shared identity.

## Recommended subsystem design from the current architecture

### Stage 0 — prerequisites

Close production-readiness blockers, define the outcome taxonomy, label an evaluation
corpus from existing review decisions, and create offline replay reports segmented by
country and acquisition lane.

### Stage 1 — immutable corpus and source-bound candidates

Add an asynchronous `TERM_HARVEST` job after a channel reaches a qualifying state.
Harvest channel/About text, recent titles/descriptions, playlists, and approved website
text under explicit source and retention policies. Persist document metadata and
candidate spans idempotently. Do not call the AI provider in ingestion's critical
path.

Only qualified evidence should train:

- human-approved or high-confidence confirmed trading creators;
- completed enrichment rather than partial records;
- autonomous discovery lineage by default;
- manual lineage only after an explicit review decision;
- capped observations per creator/entity cluster and time window.

### Stage 2 — deterministic scoring and AI adjudication

Compute frequency, distinct independent clusters, source diversity, temporal
stability, trading-background lift, country/language affinity, and anomaly features.
Reject boilerplate, URLs, generic finance words, creator names, and unsupported spans
deterministically. Queue only ambiguous/high-value candidates for bounded AI
classification. Store all assertions rather than overwriting a single classification.

### Stage 3 — concept resolution and moderation

Resolve high-confidence candidates to existing concepts or create quarantined new
concepts. Automatic synonym merges require conservative lexical/contextual agreement;
irreversible or ambiguous merges require human review. Support splitting a mistaken
merge. Publish a versioned candidate catalog for operators.

### Stage 4 — offline evaluation

Before live search, replay candidates against historical corpus and, where provider
terms allow, cached search observations. Measure incremental country precision,
trading precision, verified-quality yield, coverage by category/community, quota per
accepted creator, and review burden. Reject candidates that merely duplicate curated
coverage.

### Stage 5 — randomized shadow and low-traffic trials

Allocate a separately capped exploration budget (for example, an initial 5% of
autonomous search quota, configurable rather than hard-coded). Randomize candidate and
control assignments within comparable strata. Persist eligibility and assignment
propensity before enqueueing so retries cannot change treatment. Use immutable outcome
events and delayed updates after review/enrichment completes.

### Stage 6 — policy-driven publication

Promote only when the lower confidence bound of cost-aware incremental value exceeds
the policy threshold and all precision/harm guardrails pass. Publish catalog versions
atomically. Demote with hysteresis after credible deterioration, but preserve the term,
observations, experiments, and prior catalog versions. Always retain a minimum curated
control share and instant rollback.

## Additional improvements before implementation

1. **Measurement definitions:** decide whether success means raw recall, confirmed
   trading creators, high-quality creators, country-correct creators, communities, or
   underserved coverage. The reward must not quietly substitute novelty for quality.
2. **Delayed outcomes:** reattribute trial outcomes after enrichment and human review;
   the immediate ingestion result is not always final.
3. **Corpus health:** deduplicate creators and documents, identify ownership/affiliate
   clusters, and separate creator-authored text from platform/UI boilerplate.
4. **Classifier calibration:** report reliability curves and per-country confusion
   matrices; use AI confidence only after empirical calibration.
5. **Experiment governance:** predeclare policies, exposure budgets, stopping rules,
   guardrails, and rollback. Avoid changing extraction, classifier, and promotion
   policies simultaneously.
6. **Observability:** expose candidate funnel, AI abstention/error rate, merge/split
   history, trial exposure, posterior uncertainty, quota efficiency, drift, poisoning
   alerts, and catalog version.
7. **Repository boundaries:** split the dense database compatibility layer into corpus,
   knowledge, experimentation, and catalog repositories before adding more lifecycle
   writes.

## Five-year target architecture

If designing from scratch today, the system would be an event-driven learning and
retrieval platform with six bounded planes:

1. **Acquisition plane:** pluggable sources emit immutable content and provenance
   events. YouTube search is one acquisition adapter, not the domain model.
2. **Entity/evidence plane:** creator, channel, website, community, content, country,
   language, and ownership identities are resolved probabilistically while retaining
   raw assertions.
3. **Knowledge plane:** a global concept graph stores semantic identities; locale
   overlays store surface forms and market affinity. Deterministic and AI assertions
   are versioned independently.
4. **Decision plane:** versioned policies publish compact query catalogs and enforce
   eligibility, safety, quota, diversity, and exploration constraints.
5. **Experiment plane:** contextual randomized assignments, propensity logs, delayed
   outcomes, causal/off-policy evaluation, and cost-aware bandits improve catalog
   choices without contaminating evidence.
6. **Serving/operations plane:** durable queues, idempotent workers, per-provider
   budgets, authentication, audit logs, metrics, kill switches, catalog rollback, and
   data-retention controls keep learning off the request path.

PostgreSQL remains appropriate for transactional state, policies, and moderate-scale
event ledgers. Object storage should hold versioned source documents and offline
datasets; a warehouse or columnar analytics store becomes useful only when event
volume makes PostgreSQL replay expensive. A dedicated graph database and vector
database are not initial requirements: relational edge tables and a PostgreSQL vector
extension are simpler until measured scale proves otherwise.

The interfaces—not a particular model or datastore—are the long-lived investment:
version every source assertion, feature set, model, policy, catalog, exposure, and
outcome so that the system can replay decisions and replace components over five
years.

## Is this the final major evolution?

No. It is probably the final major evolution of **query vocabulary**, but not of the
discovery engine.

After the evidence-derived concept/catalog layer, the next major architectural frontier
is **source and graph expansion**: discovering creators through collaboration graphs,
website/community links, playlist/channel relationships, and additional platforms
rather than relying predominantly on keyword search. Vocabulary learning still cannot
find a creator who uses no searchable trading language, is poorly indexed, or lives
outside YouTube.

The durable end state is therefore a portfolio of acquisition strategies—keyword
retrieval, graph traversal, related-content expansion, external web discovery, and
human nominations—managed by the same constrained experiment and quota allocator.
Query intelligence should be one arm of discovery intelligence, not the final center
of the architecture.

## Recommended roadmap and go/no-go gates

1. **Production foundation (now):** security, staging recovery, backups, timeouts,
   observability, and classifier calibration. **Gate:** production rehearsal and
   reviewed baseline metrics pass.
2. **Measurement/replay:** immutable delayed outcomes and an offline benchmark.
   **Gate:** current query policy can be reproduced from logged data.
3. **Candidate pipeline:** source-bound statistical mining and bounded AI labels in
   shadow mode. **Gate:** high precision on a multilingual human-labeled set and zero
   untraceable terms.
4. **Concept/locale model:** migrate Phase F records into concepts, surfaces, and
   overlays; keep compatibility views. **Gate:** reversible merge/split and catalog
   rollback are proven.
5. **Controlled trials:** randomized, capped exploration with curated controls.
   **Gate:** sufficient samples and no country/trading precision regression.
6. **Adaptive policy:** cost-aware contextual bandit with safety constraints.
   **Gate:** offline policy evaluation and guarded canary outperform the fixed policy.
7. **Multi-source discovery:** add graph and external acquisition arms under the same
   measurement framework.

## Final recommendation

Proceed with the idea, but rename and reframe it as **Evidence-Derived Concept and
Experiment Intelligence**. Do not build another AI vocabulary generator and do not
promote terms with fixed occurrence/yield thresholds. Evolve Phase F into:

- deterministic, source-bound candidate mining;
- AI-assisted, abstaining semantic annotation;
- a global concept graph with country/locale overlays;
- independent-source and anti-poisoning controls;
- causal, quota-aware experiments with uncertainty;
- versioned catalog publication, fallback, and rollback.

This provides the desired continuous learning without surrendering query control to a
model, fragmenting knowledge by country, or confusing correlation with discovery
value. It is the best long-term query architecture—but operational integrity and
measurement validity must precede it, and multi-source/graph discovery remains the
larger evolution beyond it.
