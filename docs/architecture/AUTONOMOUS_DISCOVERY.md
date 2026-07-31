# Autonomous Discovery Architecture

**Status:** Current production architecture and audit findings
**Related:** [Architecture Overview](./ARCHITECTURE_OVERVIEW.md) · [Learning Pipeline](./LEARNING_PIPELINE.md) · [Roadmap](./ROADMAP.md)

## Purpose

Autonomous discovery selects, schedules, executes, and measures searches for trading creators across configured markets. It is not a single query loop: planning, durable execution, ingestion, and learning are separate responsibilities.

## Production flow

```text
Discovery scope + country vocabularies + exclusions
                       │
                       ▼
Capacity policy
  - queue target
  - daily YouTube quota
  - autonomous allocation
  - UTC pacing
                       │
                       ▼
Country rotation and query selection
  - active query library
  - cooldown eligibility
  - intent rotation
  - primary-term diversity
  - UCB-style exploitation/exploration
                       │
                       ▼
Durable query run and SEARCH_YOUTUBE job
                       │
                       ▼
YouTube retrieval lane / ordering / pagination
                       │
                       ▼
Unified ingestion and funnel measurement
                       │
                       ▼
Query statistics, collection promotion/demotion,
terminology performance, replay outcomes
```

The scheduler produces durable work; workers own provider execution. This avoids tying discovery correctness to a process-local timer or request lifecycle.

## Where autonomous queries originate

Every autonomous selection comes from the country-scoped query library. New library entries are generated from four sources.

### 1. Curated country search atoms

A hard-coded map supplies compact instruments, methods, markets, and formats for the ten supported discovery countries. These are stable cold-start controls.

### 2. Seeded country vocabularies

Database initialization persists country vocabularies containing native terminology, instruments, local market phrases, and common content formats. They provide additional Tier 1 anchors.

### 3. Legacy extracted vocabulary

Confirmed, sufficiently high-quality autonomous discoveries can contribute extracted vocabulary. Eligible legacy terms may be paired with a local anchor under trust-tier constraints.

### 4. Governed terminology

Canonical terminology in `SEARCH_TRIAL` or `PROVEN_SEARCH_TERM` state can enter candidate planning, with lifecycle and performance metadata retained in the query record.

### 5. Governed multisource concepts

Priority 7 adds a typed candidate boundary for validated concepts, multilingual surfaces, related and external entities, playlist or transcript topics, creator neighborhoods, cross-language concepts, and explicit coverage gaps. A generator cannot activate its own proposal. Admission requires exact source references, a stable concept identity, two independent source entities, all deterministic validation gates, and either a quota-capped controlled trial or a proven entry from the active immutable serving catalog.

Priority 8 replaces the legacy country-to-script allowlist for this governed
path with `global-language-capability-v1`. Literal surfaces are Unicode-observed
against canonical language, script, and query-locale metadata. New scripts need
the existing quota-capped trial contract; proven standalone surfaces need the
immutable catalog pin. An unknown language or declared/detected mismatch
abstains, while curated country atoms retain the legacy deterministic fallback.

Manual searches are an operator-directed measurement lane. Their discoveries are persisted, but they do not train autonomous terminology without explicit human approval and post-approval enrichment. This prevents an arbitrary operator query from silently steering production.

## Query generation

The planner emits short retrieval atoms rather than generative prose. Current templates include:

- one curated or country-vocabulary atom;
- one local instrument/market plus one compatible method;
- one Tier 1 local anchor plus one constrained learned modifier.
- one local control anchor plus one governed multisource trial surface;
- one compact standalone multisource surface after proven catalog publication.

Generated queries are normalized, deduplicated against existing country queries, checked for token and length bounds, attributed to their atoms, and inserted as `EXPERIMENTAL`.

Organic metadata additionally pins the candidate, concept, sources, language/script/locale, lifecycle, validation policy, controlled-trial limits or catalog pointer, and deterministic provenance checksum. Thus query-performance tracking and the existing exploration/exploitation selector operate unchanged, while outcomes remain attributable to the new origin.

This is safer and more measurable than allowing an LLM to author arbitrary searches, but it also constrains organic expansion.

## Query selection and adaptation

The selector filters out:

- rejected queries;
- active reservations;
- queries before their next eligibility time;
- queries inside the hard cooldown;
- recently overused primary terms;
- the most recently used intent when alternatives exist.

Eligible queries receive a UCB-style value:

```text
normalized historical performance
+ exploration constant × sqrt(log(total executions + 1) / (query executions + 1))
```

A configured exploration ratio selects under-tested `EXPERIMENTAL` entries; otherwise successful `PROVEN` queries are preferred. If no eligible entry remains, the generator creates new experimental candidates.

This means the engine genuinely changes future selection based on outcomes. It is not a static round-robin runner.

## Performance feedback

Each execution records a funnel rather than only raw result count:

- raw and distinct results;
- new and known channels;
- country-rejected channels;
- `NON_TRADING`, `UNCERTAIN`, and confirmed channels;
- quality channels;
- discovered communities;
- average quality;
- quota and retrieval attribution.

The query collection can be promoted, retained, or rejected based on performance. Learned-term queries also attribute yield back to terminology lifecycle records.

## Audit conclusion: how adaptive is it?

### Capabilities that are genuinely adaptive

- historical query performance changes selection;
- explicit exploration avoids permanent winner lock-in;
- cooldown and diversity rules alter future execution order;
- queries can be promoted or rejected;
- successful confirmed channels can contribute new terminology;
- terminology can progress into controlled search trials;
- poor repeated terminology yield can cause demotion;
- durable measurements support replay and portfolio analysis.

### Capabilities that remain constrained or static

- cold start depends on ten manually defined country environments;
- query shapes begin from curated anchors;
- learned terms generally cannot run independently;
- script compatibility rejects several major global scripts;
- intent inference and query templates are hard-coded;
- the learning supply is limited to channels already confirmed by the production classifier;
- newer candidate catalogs are not the planner's primary serving input;
- discovery remains centered on YouTube text search rather than a persistent multi-source frontier.

The correct characterization is:

> The engine is an adaptive query portfolio manager with governed but constrained vocabulary expansion. It has evolved beyond a static query library, but not beyond the seed ontology or country envelope.

## The endogenous feedback problem

Current learning can reinforce what the engine already understands:

```text
seed terms retrieve familiar creators
        ↓
familiar creators match static classification vocabulary
        ↓
only confirmed creators contribute learned terms
        ↓
learned vocabulary resembles the original reachable ecosystem
        ↓
unfamiliar communities remain under-observed
```

Priority 0 reduces the harm by preserving unrecognized channels as `UNCERTAIN`, but it does not itself make them terminology teachers. Human review and future semantic classification are needed to turn those cases into governed learning evidence.

## Country and language limitations

Country currently carries several meanings that should eventually be separated:

- creator residence;
- declared YouTube country;
- audience country;
- content language and script;
- market or instrument traded;
- query locale;
- platform region.

Creators frequently use English trading loanwords in non-English content or serve several countries. Static country-script compatibility rules are therefore not an adequate global language policy.

## Design rationale

### Why retain curated terms?

Curated atoms provide:

- deterministic cold start;
- stable control arms for experiments;
- recovery when learned catalogs are unavailable;
- known-safe quota usage;
- interpretable comparison baselines.

The goal is not to delete seeds; it is to stop seeds from defining the reachable universe.

### Why short, attributable queries?

Compact queries generally align with YouTube retrieval behavior and make causal attribution more tractable. Each atom can retain origin, intent, trust tier, and terminology identity. Arbitrary generated prose would be harder to evaluate, deduplicate, or govern.

### Why durable jobs and reservations?

Durability provides restart safety, idempotency, quota reservation, retries, cooldown-aware scheduling, and separation between planning and provider availability.

## Desired evolution

The next discovery architecture should generate candidates from:

- governed learned concepts and aliases;
- multilingual semantic neighbors;
- playlist and channel relationship graphs;
- external websites and community links;
- transcript and topic clusters;
- emerging instruments, venues, educators, and formats;
- explicit coverage gaps by country, language, market, and strategy.

Candidates should enter bounded randomized trials, be measured on quality-adjusted confirmed yield and cost, and transition through versioned lifecycle states. Details appear in the [Roadmap](./ROADMAP.md).

## Priority 10 knowledge-plane consumption

The planner may consume only the deterministic discovery projection of an immutable pinned knowledge publication. Every atom carries concept and surface identity, concept version, language/script/locale, policy version, publication checksum, and pointer version. Query outcomes return as append-only contributions and never mutate the active artifact. Existing proven catalogs and curated atoms remain compatibility controls until shadow replay, bounded canaries, and rollback proof permit migration.
