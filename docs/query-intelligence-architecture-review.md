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
After those foundations, this is a strong *discovery-quality* investment because it
addresses vocabulary coverage rather than merely optimizing a fixed search space. If
the product objective is maximum ecosystem coverage, however, the higher-order
investment is the persistent topic-exploration controller described below: it can use
learned vocabulary while also pursuing graph, website, playlist, relationship, and
other acquisition paths.

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

It is one of the strongest improvements **after operational readiness**, but it is not
the strongest if the goal is total discovery coverage. Adaptive pagination, ordering,
and bandit selection can only search more efficiently within known concepts. A concept
learning layer expands the reachable search space and can reveal regional language,
emerging instruments, new platforms, and creator-native content formats. A persistent
topic-exploration controller goes further by deciding which search and non-search
branches remain worth pursuing until topic-level marginal coverage is genuinely low.

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

## Orthogonal review: from search executor to persistent researcher

### Does the current engine already explore a strong concept deeply?

**No.** It is persistent at executing and resuming individual jobs, but it is not
persistent about pursuing a research objective.

Today the durable unit of intent is effectively a query run. Adaptive pagination can
follow that query's provider continuation token while the next page remains productive,
but it stops at page, creator, or consecutive-low-yield ceilings. Once the run ends,
its aggregate performance updates the query and terminology records. The scheduler
then selects another cooldown-eligible query, deliberately rotating countries, intents,
and primary terms. That is useful portfolio diversification, but it means no durable
owner asks, “What remains unknown about price action trading, and what is the best next
way to reduce that uncertainty?”

The engine does preserve discovered channels and some evidence, but a successful
channel, phrase, website, playlist, or community does not become a typed frontier node
whose unexplored relationships generate follow-up work. Enrichment exists to classify
a channel, not to recursively expand the discovery graph. Terminology observations can
eventually produce another search atom, but that is an indirect vocabulary feedback
loop rather than a coherent continuation of the originating research path.

The distinction is important:

- **Job durability** answers whether a known action survives a restart.
- **Pagination** answers whether another page of the same result set is worthwhile.
- **Query intelligence** answers which search string to execute next.
- **Persistent research** answers which unresolved hypothesis, relationship, source,
  or acquisition action has the highest expected marginal coverage for a long-lived
  topic.

Only the first three exist today.

### The architectural bottleneck

The primary bottleneck is not the query planner or the page ceiling. It is the absence
of a durable **exploration state above queries**.

There is no first-class object representing a topic/research program with:

- a stable objective and explicit scope;
- a graph of concepts, creators, content, websites, communities, markets, countries,
  and the evidence connecting them;
- a frontier of untried actions and unresolved hypotheses;
- coverage and saturation estimates by region, language, source, and creator cluster;
- a topic budget, action costs, and opportunity cost against other topics;
- a history of attempted strategies, negative results, and cooldowns;
- stopping, sleeping, and reactivation criteria.

Consequently, useful evidence terminates in a record instead of creating a bounded set
of new research opportunities. The query is both the planning unit and the attribution
unit, so paths discovered *inside* a query cannot compete independently for future
budget. Global cooldown and diversity policies then move the scheduler away even when
one branch remains highly promising. The current system optimizes the next search run;
it does not optimize completeness of a topic.

Several secondary bottlenecks reinforce this behavior:

1. Acquisition is predominantly keyword-to-YouTube-search. Related-channel,
   collaboration, playlist, website, backlink, community, and cross-platform edges are
   not modeled as interchangeable actions.
2. Channel identity and query sightings are stored, but there is no general evidence
   graph or path provenance suitable for recursive expansion and cycle detection.
3. Immediate page yield dominates continuation. Some valuable actions have delayed or
   indirect payoff—for example, reading an authoritative website may reveal three new
   regional terms but no creator immediately.
4. “Known channel” is treated mainly as duplicate suppression. A known high-quality
   creator should also be a high-value research seed whose still-unexplored edges can
   produce new coverage.
5. Query-level averages hide branch saturation. One language or creator cluster may be
   exhausted while another regional branch of the same topic is untouched.

### Should the architecture become topic-centric?

**Yes, but not topic-exclusive.** Make a durable `research_program` (or exploration
campaign) the unit of objective, coverage, and budget. Keep queries as one type of
action selected within that program. Replacing the query library with a topic table
would merely move the same problem up one level; the essential addition is a
stateful frontier and a common action/outcome model.

A topic such as “price action trading” should resolve to a concept, desired countries
and languages, quality constraints, acquisition sources, and a coverage objective. It
then owns many hypotheses and actions:

- search global and local surface forms;
- combine the concept with instruments, formats, sessions, and regional anchors;
- inspect recent and historical playlists from authoritative creators;
- traverse featured/related channels and repeated guest/collaboration relationships;
- crawl approved creator websites for linked educators and communities;
- follow community and social identities under explicit policy;
- mine discovered content for source-bound terminology and regional variants;
- test translations and aliases locally;
- revisit previously productive branches after freshness or ecosystem-change signals.

Queries remain important because they are cheap to propose, auditable, and often the
only provider-supported discovery primitive. They should become leaf actions in a
larger research plan rather than the container for the plan.

### Recommended architecture: a persistent exploration controller

Add a control plane above the existing durable job queue. It should plan and score
research actions but delegate execution to the current workers and ingestion gates.
The minimum domain model is:

#### 1. Research program

`research_program` stores the root concept, scope, countries/locales, inclusion and
quality objectives, priority, lifecycle (`ACTIVE`, `SLEEPING`, `SATURATED`, `PAUSED`,
`COMPLETE`), policy version, total/daily budgets, and owner/audit metadata. Programs
may be permanent; “complete” should mean complete relative to an explicit scope and
freshness horizon, not that the ecosystem can never change.

#### 2. Evidence graph

Use typed relational nodes and edges initially:

- nodes: concept, term surface, creator identity, channel/account, video/content,
  playlist, website/domain, community, organization, instrument, market, locale;
- edges: mentions, authors, links-to, member-of, collaborates-with, features,
  translated-as, related-to, discovered-by, and same-entity-as;
- every edge carries source, confidence, observed time, extractor version, and the
  research path that produced it.

Canonical global entities can be shared by programs. Program-specific discovery state
must remain separate so one campaign's visit does not falsely imply another campaign
covered the edge. PostgreSQL edge tables are sufficient initially; a graph database is
not required to implement best-first traversal.

#### 3. Hypothesis and frontier

`research_hypothesis` represents an unresolved, falsifiable opportunity such as
“French price-action educators use *lecture du prix*” or “creator A's recurring guests
lead to an independent futures cluster.” `frontier_action` represents one bounded way
to test it. Each action records:

- action type and normalized target;
- parent node/action and full lineage;
- expected new coverage, verified-creator yield, and information gain;
- estimated YouTube, web, AI, compute, and human-review costs;
- uncertainty, risk, novelty, depth, and cluster-diversity features;
- eligibility time, deduplication key, lease, attempt history, and policy version.

Actions should be idempotently materialized before execution. A unique semantic action
key prevents graph cycles and repeated spend, while a new validity window allows a
time-sensitive action to be revisited later.

#### 4. Common action adapters

Define a small action interface independent of source:

`propose -> estimate -> reserve -> execute -> observe -> attribute -> expand`

Initial action types could include `SEARCH_TERM`, `SEARCH_COMBINATION`,
`CONTINUE_RESULT_PAGE`, `INSPECT_CHANNEL_RELATIONS`, `INSPECT_PLAYLIST`,
`INSPECT_WEBSITE`, `FOLLOW_CREATOR_LINK`, `TEST_LOCAL_SURFACE`, and
`REVISIT_STALE_BRANCH`. Each adapter declares cost, policy restrictions, provider
quota class, expected outcome schema, and how observations can safely expand the
frontier.

This common contract lets a website inspection compete with another YouTube page on
expected marginal value rather than living in an unrelated pipeline.

#### 5. Coverage model

Raw counts are not coverage. Maintain a topic coverage matrix over dimensions that
matter to the product, for example:

- country and language;
- strategy sub-concept and terminology cluster;
- instrument and market;
- creator/community cluster;
- content format and acquisition source;
- activity/freshness band and quality tier.

The system cannot know absolute ecosystem recall because no complete denominator
exists. It can estimate saturation from diminishing capture rate, overlap among
independent acquisition methods, unseen-species estimators, repeated rediscovery, and
frontier exhaustion. Report coverage as an estimate with uncertainty, never as a
literal percentage of all creators.

#### 6. Exploration policy

Use budgeted best-first search before attempting sophisticated reinforcement learning.
Rank eligible actions approximately by:

`(expected incremental coverage value + information gain + freshness value) / expected total cost`

Then apply constraints for country/trading precision, source policy, maximum graph
depth, per-domain and per-cluster caps, daily provider quotas, review capacity, and a
minimum portfolio allocation to other topics. Bayesian posteriors can update expected
yield by action type and context. Contextual bandits become appropriate only after
randomized exposure data is available.

Critically, do not greedily maximize immediate new-channel yield. Reserve explicit
budgets for:

- exploitation of productive branches;
- breadth across uncovered coverage cells;
- uncertain high-information actions;
- new acquisition strategies;
- periodic freshness probes.

That mixture maximizes durable coverage and reduces the rich-get-richer behavior of a
pure yield policy.

#### 7. Attribution and expansion

Every result must be attributed to its exact action and path, including duplicate and
negative outcomes. Successful observations may propose child actions, but expansion
must be bounded by policy: maximum children per event, entity-cluster contribution
caps, confidence gates, and deduplication. A proposal is not an execution; it enters
the frontier and competes for budget.

Delayed enrichment and human-review decisions should update the originating action,
ancestors, and relevant policy posterior. They must not rewrite immutable raw outcomes.
This separates evidence collection from later judgment while letting verified quality,
not initial appearance, drive future allocation.

### Quota-efficient deep exploration

Persistent does not mean infinite or continuously busy. A quota-efficient controller
needs three scheduling levels:

1. **Portfolio allocator:** distributes daily budgets across research programs based on
   priority, recent marginal coverage, uncertainty, freshness, and fairness floors.
2. **Program controller:** selects the best eligible frontier action within a topic and
   can reserve a small multi-step budget for a coherent branch.
3. **Provider allocator:** enforces YouTube, web, AI, and review capacity independently,
   using actual cost reservations and releasing them idempotently.

Use cheap actions to qualify expensive ones. For example, mine already-fetched titles
and links before issuing another 100-unit search; inspect cached channel metadata before
calling AI; batch provider lookups; and traverse a website only after domain and policy
checks. Reuse a fetched artifact globally while attributing its evidentiary value to
each program that consumes it.

Continuation should occur at two levels:

- **Local continuation:** fetch another page or child edge while that branch has strong
  marginal utility.
- **Strategic continuation:** keep the topic active because other branches or coverage
  cells remain promising even after one query saturates.

The present page policy can remain as the local rule. It should no longer be mistaken
for the topic stopping rule.

### Stopping, sleeping, and reactivation

A topic should sleep—not be permanently discarded—when all of these are true across a
minimum evidence window:

- the upper confidence bound on the best frontier action is below its cost-aware
  threshold;
- independent acquisition methods mostly rediscover known entity clusters;
- target coverage cells have either adequate evidence or documented unreachable gaps;
- no high-information hypotheses remain within the current budget and policy;
- delayed review/enrichment backlog is small enough that the conclusion is stable.

Hard ceilings remain necessary as circuit breakers, but they should cause a checkpoint
and rescheduling decision rather than imply semantic exhaustion. Reactivate a sleeping
program on terminology bursts, new creator/content events, stale coverage, provider
capability changes, human nomination, or a scheduled freshness probe.

This turns “marginal value is low” into a versioned, auditable decision with uncertainty
instead of an accidental consequence of cooldown or a page limit.

### Failure modes specific to persistent research

| Risk | Consequence | Control |
| --- | --- | --- |
| Runaway graph expansion | Quota exhaustion and noisy evidence | bounded fan-out/depth, semantic dedupe, per-branch budgets |
| Hub domination | Famous creators absorb all exploration | cluster caps and uncovered-cell reward |
| Cycles and rediscovery | Repeated work without new coverage | canonical entities, action keys, path-aware visit state |
| Topic drift | “Price action” expands into generic finance | root-concept relevance checks and drift budgets |
| Premature saturation | Valuable sparse branches are abandoned | uncertainty-aware upper bounds and breadth floor |
| Endless low-value persistence | Zombie campaigns consume quota | sleeping criteria, opportunity-cost hurdle, freshness-only probes |
| Cross-topic double charging | Shared artifacts waste provider calls | global artifact cache with per-program evidence attribution |
| Deep-path trust decay | Weak edges compound into false branches | confidence propagation, depth penalties, human gates |
| Delayed-outcome bias | Fast but low-quality actions win budget | provisional rewards and verified delayed attribution |
| Unbounded research storage | Ledgers and snapshots grow indefinitely | artifact retention, compact sufficient statistics, cold archival |

### Migration from the current architecture

Do not rewrite the durable queue or stop query-level measurement. Introduce the new
control plane incrementally:

1. Add research programs, frontier actions, action outcomes, and lineage while mapping
   every existing autonomous query run to a `SEARCH_TERM` action.
2. Build one pilot program—“price action trading”—using current search and pagination
   adapters only. Prove restart safety, deduplication, budgets, and sleeping behavior.
3. Add coverage cells and delayed verified attribution before adding recursive edges.
4. Add terminology and playlist/channel-relation proposals in shadow mode; inspect
   proposed fan-out and drift without executing it.
5. Enable one new acquisition adapter at a time behind a separate budget and policy.
6. Compare topic-level incremental coverage against the current rotating scheduler
   using randomized country/time blocks and identical quota budgets.
7. Once superior, let the portfolio allocator own autonomous work while retaining the
   current query selector as a fallback action proposer.

The go/no-go metric should be **verified incremental coverage per total constrained
cost at equal country/trading precision**, not searches per day or raw channels found.
Also report coverage distribution: an approach that finds more creators from the same
affiliate cluster has not performed deeper research.

### Decision

Adopt a topic-centric exploration layer with a graph-backed, cost-aware frontier. Do
not replace query-centric execution; subordinate it. The durable research program owns
the objective and saturation decision, frontier actions own acquisition choices, and
existing jobs remain the reliable execution mechanism.

This is a higher-order architectural change than vocabulary intelligence. Vocabulary
and concept learning improve which branches can be proposed; persistent exploration
decides whether and how long the engine follows them. If maximizing ecosystem coverage
is the primary product goal, the exploration controller should be designed before
further optimizing query selection, and it should become the organizing architecture
into which terminology intelligence and future graph/source adapters plug.

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

## Is vocabulary intelligence the final major evolution?

No. It is probably the final major evolution of **query vocabulary**, but not of the
discovery engine.

The next major architectural frontier is the **persistent topic-exploration control
plane** described above, with source and graph expansion as its action portfolio:
discovering creators through collaboration graphs, website/community links,
playlist/channel relationships, and additional platforms rather than relying
predominantly on keyword search. Vocabulary learning still cannot find a creator who
uses no searchable trading language, is poorly indexed, or lives outside YouTube.

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
3. **Exploration control-plane pilot:** map existing searches and page continuations
   into one durable topic program with a frontier, budget, coverage cells, and sleeping
   decision. **Gate:** restart-safe execution reproduces current behavior at equal cost.
4. **Candidate pipeline:** source-bound statistical mining and bounded AI labels in
   shadow mode. **Gate:** high precision on a multilingual human-labeled set and zero
   untraceable terms.
5. **Concept/locale model:** migrate Phase F records into concepts, surfaces, and
   overlays; keep compatibility views. **Gate:** reversible merge/split and catalog
   rollback are proven.
6. **Controlled trials:** randomized, capped exploration with curated controls.
   **Gate:** sufficient samples and no country/trading precision regression.
7. **Graph/source action adapters:** enable playlist, relationship, website, and other
   acquisition paths one at a time. **Gate:** each adds verified coverage at acceptable
   cost and drift.
8. **Adaptive policy:** cost-aware contextual bandit with safety constraints.
   **Gate:** offline policy evaluation and guarded canary outperform the fixed policy.

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
value. It is the best long-term vocabulary architecture—but operational integrity and
measurement validity must precede it. For the larger engine, make persistent topic
exploration the organizing control plane and make vocabulary search, graph traversal,
and external acquisition competing actions within it.
