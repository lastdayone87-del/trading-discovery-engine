# Final architecture evolution review

**Status:** Decision record for selecting the next major evolution
**Review date:** 2026-08-01
**Scope:** Critical evaluation of twelve proposed capabilities against the assembled production, shadow, evaluation, coverage, experimentation, graph, portfolio, and governed-knowledge architecture

## Executive decision

The twelve proposals are not twelve independent architectural investments. They collapse into four coherent capabilities:

1. a trustworthy measurement and experimentation control plane (proposals 1, 7, 10, and 11);
2. a decision-conditioned evidence controller (proposals 2 and 12);
3. a governed failure-learning workflow (proposal 3, consuming the first two capabilities);
4. an adaptive discovery portfolio (proposals 4, 5, and 6).

Proposal 9 is already effectively covered by the governed knowledge plane. Proposal 8 is potentially useful later, but dynamically changing scoring weights is not a safe or high-priority substitute for calibration. Implementing every proposal separately would duplicate state, attribution, policy, and promotion mechanisms.

The strongest next major evolution remains **decision-grade continuous evaluation**, followed by **value-of-information evidence acquisition**. The engine should then activate a narrow graph frontier and close the false-negative diagnosis loop. Coverage and saturation should evolve together as one portfolio policy, not as separate systems.

## Existing architecture baseline

The review assumes the following current capabilities and boundaries:

- immutable production diagnostics preserve normalized classifier input, provider execution, evidence, stage reports, decisions, and policy versions;
- reviewed outcomes can label adaptive shadow runs, which report aggregate agreement and classification metrics;
- provider calls expose availability, failures, latency, and cost independently of semantic polarity;
- query execution records funnel outcomes, while terminology trials record randomized assignments and propensities;
- coverage cells accumulate distinct, new, duplicate, verified, cost, and backlog statistics and support governed sleeping/reactivation;
- the portfolio layer has deterministic constrained allocation and governed policy lifecycle foundations;
- evidence graph and playlist adapters exist as bounded foundations, but text search remains the dominant acquisition path;
- concepts, localized surfaces, contributions, publications, scoped pointers, checksums, and rollback already form a unified governed knowledge plane;
- multilingual semantics retain per-field citations and version pins, but production probability calibration still lacks a representative fitted corpus.

These are substantial partial implementations. Recommendations below distinguish a useful production completion from a duplicate subsystem.

## Decision summary

| # | Proposal | Existing coverage | Decision | Architectural value |
|---:|---|---|---|---|
| 1 | Continuous decision evaluation and self-calibration | Partial | **Implement now** | Highest; creates trustworthy feedback for all adaptive policies |
| 2 | Value-of-information evidence acquisition | Small partial | **Implement now** | Highest; changes the cost/recall frontier of classification |
| 3 | Automatic false-negative learning | Partial diagnostics and governed contribution path | **Implement later** | High if diagnosis is automatic but publication remains governed |
| 4 | Discovery graph and semantic neighborhood expansion | Foundation exists | **Implement later** | High incremental reach, but only after narrow causal trials |
| 5 | Coverage-gap exploration | Substantial shadow/control-plane coverage | **Implement later** | Medium-high as an input to the portfolio, not a new subsystem |
| 6 | Discovery saturation intelligence | Substantial partial coverage | **Already effectively covered by the current architecture** | Complete policy wiring rather than create a capability |
| 7 | Active learning | Small partial | **Implement later** | High review efficiency after unbiased baseline sampling exists |
| 8 | Adaptive provider weighting | Fixed reliability and provider telemetry exist | **Implement later** | Medium and risky; prefer calibrated policy selection to free-running weights |
| 9 | Living knowledge intelligence | Strong coverage | **Already effectively covered by the current architecture** | Operate the existing contribution/evaluation/publication lifecycle |
| 10 | Operational intelligence | Partial telemetry and inspection | **Implement later** | Medium-high when based on causal decomposition, not generated narrative |
| 11 | Autonomous experimentation | Strong domain-specific foundations | **Implement later** | High, but unify existing trial/policy machinery before generalizing it |
| 12 | Counterfactual reasoning | No distinct serving controller | **Not recommended as a separate capability** | It is the decision rule inside proposal 2 |

## Impact scale

Each proposal uses `High`, `Medium`, `Low`, or `Neutral` for expected long-term impact. A high score does not imply that the proposal should be built now; prerequisites and risk can dominate sequencing.

## Proposal evaluations

### 1. Continuous decision evaluation and self-calibration

**Decision: Implement now.**

**Exists today:** Partially. Immutable diagnostics, replay, reviewed labels, shadow comparisons, provider telemetry, query funnels, and offline evaluation exist. Multilingual semantic artifacts are versioned. However, reviewed labels arise from the serving workflow, aggregate shadow metrics are not representative calibration, and the current confidence score is explicitly a policy score rather than a fitted probability.

**Architectural improvement:** Meaningful and foundational. The missing component is not another metrics collector; it is a versioned evaluation population sampled before serving decisions create selection bias. Without known inclusion probabilities, the engine cannot estimate terminal false negatives, compare policies fairly, or distinguish model improvement from a changed review mix.

**Overlap:** Extends classification diagnostics, replay measurement, offline evaluation, adaptive shadow labeling, provider telemetry, query experiments, and publication gates. It should unify their evaluation contract rather than replace them.

**Required design:**

- assign immutable stratified audit cohorts at retrieval time across outcomes, evidence bands, provider states, origins, languages, scripts, and time;
- preserve sampling probability and a protected random sample alongside information-directed sampling;
- use adjudicated labels with disagreement, delayed outcomes, and hierarchical truth rather than only one terminal class;
- fit immutable time-split calibration artifacts and report precision, recall, abstention, review rate, and cost with confidence intervals and minimum effective sample size;
- detect data, provider, label, and calibration drift separately;
- recommend candidate changes, but require governed experiment and promotion policy for serving changes.

**Expected impact:** discovery `Medium`; classifier quality `High`; multilingual capability `High`; autonomy `High`; explainability `High`; scalability `High`; operational intelligence `High`.

**Costs and risks:** Implementation complexity is high. Provider quota is low unless audit cases acquire extra evidence. Review cost is persistent and must be budgeted. Online latency is negligible if cohort assignment is asynchronous. Storage and privacy cost rise because raw field snapshots and label provenance must be retained. Small language slices will often produce abstaining evaluation results; silently pooling them would invalidate the design.

**Governance:** The system may recommend recalibration or policy changes, but must never fit and publish from the same uncontrolled loop. Artifact versioning, approval, canary, rollback, and evaluation-population lineage are mandatory.

---

### 2. Value-of-information evidence acquisition

**Decision: Implement now, after the evaluation cohort contract is defined.**

**Exists today:** Only in coarse form. The system avoids some expensive work behind country and trading gates, hydrates uncertain country metadata, uses cost-tiered semantics, and gives uncertain cases one enrichment pass. It does not select the next provider/action from the case's unresolved decision state.

**Architectural improvement:** Very meaningful. Evidence acquisition becomes part of inference rather than a fixed prelude to inference. This can increase confirmation recall without retrieving transcripts, pages, playlists, or community evidence for every candidate.

**Overlap:** Extends staged classification, enrichment lifecycle, provider resilience, quota policy, portfolio allocation, and durable jobs. It must not become a second classifier or an unconstrained agent.

**Required design:**

- stages emit typed unresolved hypotheses and evidence sufficiency gaps;
- registered actions declare prerequisites, applicable languages/fields, expected latency, quota/cash cost, freshness, and possible decision effects;
- a deterministic baseline estimates expected decision utility and selects a bounded next action;
- every selection, propensity, result, cost, reclassification, and stop reason is durable;
- stop on terminal evidence, deadline, case budget, dominant contradiction, or negligible expected value;
- shadow against the fixed enrichment policy before a capped canary.

**Expected impact:** discovery `Medium`; classifier quality `High`; multilingual capability `High`; autonomy `High`; explainability `High`; scalability `High`; operational intelligence `High`.

**Costs and risks:** Complexity is high because action idempotency, sequential decisions, counterfactual evaluation, and budgets interact. Average provider quota should fall, but spend on promising sparse cases may rise. Tail latency rises if actions are sequential, so wall-clock deadlines are required. Transcript and external-page actions add material legal, privacy, egress, and retention concerns.

**Governance:** Only registered actions may be selected. The controller may allocate evidence budget; it may not relax terminal thresholds, invent providers, or treat acquisition failure as semantic evidence.

---

### 3. Automatic false-negative learning

**Decision: Implement later. Diagnose automatically; never publish automatically merely because a miss occurred.**

**Exists today:** Partially. Corrections and reviewed outcomes are durable, reviewed false negatives are regression inputs, shadow runs can be labeled, terminology can observe approved channels, and knowledge contributions have governed publication paths. There is no single workflow that joins the corrected channel to its original retrieval, provider execution, stage abstention/failure, policy versions, query lineage, and missing concept coverage and then assigns a causal miss taxonomy.

**Architectural improvement:** High, provided it is a failure-analysis pipeline rather than online self-training. False negatives are unusually valuable because they reveal blind spots in retrieval, evidence availability, semantics, corroboration, lifecycle routing, or policy. Treating every miss as a vocabulary problem would reinforce noise and duplicate the knowledge plane.

**Overlap:** Consumes proposal 1, classification diagnostics, review store, replay, regression suite, terminology/candidate corpus, knowledge contributions, provider telemetry, and query performance. It should emit contributions and experiments into those systems, not mutate them directly.

**Required design:**

1. Bind every correction or delayed confirmation to the exact original attempts and discovery lineage.
2. Replay the pinned decision and classify the earliest causal failure: not retrieved, country gate, missing field, unavailable/failed provider, unsupported language, semantic miss, insufficient independence, threshold/calibration, stale evidence, lifecycle loss, or human-label dispute.
3. Attribute uncertainty: multiple causes may remain plausible; do not force a single provider blame.
4. Emit a governed remediation proposal: acquire a missing evidence type, add a regression cohort, propose a source-bound concept/sense, adjust audit sampling, or start a query/provider policy experiment.
5. Verify on held-out and time-split cohorts before any promotion.

**Expected impact:** discovery `High`; classifier quality `High`; multilingual capability `High`; autonomy `High`; explainability `High`; scalability `Medium`; operational intelligence `High`.

**Costs and risks:** Complexity is high, provider quota is low for diagnosis but medium when replay reacquires expired evidence, and serving latency is neutral because work is asynchronous. Operational review cost is medium. The largest risk is endogenous feedback: learning only from discovered and corrected cases can improve familiar regions while leaving invisible misses untouched. Proposal 1's protected audit sample is therefore a prerequisite.

**Governance:** Automatic diagnosis and proposal creation are appropriate. Automatic semantic-feature, provider-weight, query, or catalog publication is not. Human review may be reduced for low-risk experiment routing, but serving promotion must keep policy gates and rollback.

---

### 4. Discovery graph and semantic neighborhood expansion

**Decision: Implement later, narrowly and adapter by adapter.**

**Exists today:** A meaningful foundation exists: evidence nodes/edges, source-bound candidates, concept identity, playlist adapter canary, frontier actions, organic relationship candidate types, and portfolio controls. The graph is mainly offline/corroborative, and production discovery remains primarily query-driven.

**Architectural improvement:** High. It creates reachability beyond creators who expose searchable known surfaces. Explicit collaborations, playlist ownership/membership, featured channels, and repeated resolved external entities can discover sparse or unfamiliar-language creators that query refinement cannot reach.

**Overlap:** Extends evidence graph adapters, passive exploration/frontier actions, portfolio allocation, candidate corpus, unified ingestion, and governed query expansion. It should not introduce a second mutable online graph.

**Required design:** Conservative entity resolution; temporal source-bound edges; correlated-source-family collapse; immutable online projections; parent-path attribution; depth, fan-out, hub, component, and anomaly caps; and randomized incremental-yield trials. Begin with playlist/channel neighborhoods and provider-explicit creator relationships. Do not begin with arbitrary-web crawling or embedding-only semantic neighbors.

**Expected impact:** discovery `High`; classifier quality `Medium`; multilingual capability `High`; autonomy `High`; explainability `High`; scalability `Medium`; operational intelligence `Medium`.

**Costs and risks:** Complexity and graph storage are high. Quota ranges from low for cached playlist relationships to high for web/transcript expansion. Work is asynchronous, so request latency is low, but discovery completion latency may rise. Spam rings, generic hubs, ambiguous identity, and stale ownership are major precision risks.

**Governance:** Every path must pin source observations, entity-resolution policy, graph projection, and portfolio assignment. Fuzzy mutable resolution stays offline. Promote an adapter only on incremental confirmed creators unavailable to the contemporaneous search control.

---

### 5. Coverage-gap exploration

**Decision: Implement later as a portfolio input, not as a new subsystem.**

**Exists today:** Substantially in foundation. Coverage dimension versions, cells, statistics, uncertainty labeling, sleeping/reactivation, explicit coverage-gap candidate types, program floors, and portfolio budgets exist. Absolute ecosystem recall is correctly described as unknown. Current cells and planners do not yet form a continuously estimated global opportunity surface backed by representative outcome data.

**Architectural improvement:** Medium-high. It changes the objective from maximizing local yield to balancing yield with measured information and ecosystem coverage. Its value depends on avoiding a false premise: low observed creator count can mean genuine scarcity, retrieval failure, provider limitation, or lack of sampling.

**Overlap:** Coverage lifecycle, organic query expansion, global language capability, research programs, and portfolio allocation already own the required state. A separate gap engine would duplicate them.

**Required design:** Treat a gap as a probability distribution with uncertainty, opportunity, last probe, provider reachability, and evidence quality—not a zero-filled matrix cell. Use hierarchical dimensions so sparse combinations do not explode. Allocate bounded probes with control traffic and update the portfolio on marginal coverage gain and posterior uncertainty.

**Expected impact:** discovery `High`; classifier quality `Low`; multilingual capability `High`; autonomy `High`; explainability `Medium`; scalability `Medium`; operational intelligence `High`.

**Costs and risks:** Analytical complexity is medium-high. Quota impact is intentionally medium because exploration spends on uncertain areas with lower immediate yield. Latency is asynchronous. Cardinality explosion and repeated probing of genuinely small ecosystems are the primary operational costs.

**Governance:** Coverage objectives, dimension versions, minimum country/control floors, probe caps, and reactivation policy must be published and replayable. Coverage pressure cannot lower classifier evidence requirements.

---

### 6. Discovery saturation intelligence

**Decision: Already effectively covered by the current architecture; complete integration rather than launch a project.**

**Exists today:** Query funnels track known/new/duplicate results and cost; queries and terminology can be retained, rejected, demoted, or marked stale/saturated; coverage statistics track duplicates and new/verified creators; coverage programs can sleep and reactivate; the portfolio supports costs, caps, floors, and expected reward.

**Architectural improvement:** The concept is useful, but it is not a new architecture. The remaining work is to feed a statistically stable marginal-yield/saturation estimate into the existing coverage lifecycle and portfolio while preserving occasional probes.

**Overlap:** Almost total overlap with query performance, coverage lifecycle, terminology lifecycle, and portfolio allocation. A standalone saturation service would create conflicting lifecycle authority.

**Expected impact:** discovery `Medium`; classifier quality `Neutral`; multilingual capability `Medium`; autonomy `Medium`; explainability `Medium`; scalability `High`; operational intelligence `Medium`.

**Costs and risks:** Implementation complexity is low-medium, quota impact should be beneficial, and latency is neutral. Over-aggressive sleeping can destroy recall when a region changes or a provider previously returned biased results. Use recency-weighted marginal unique yield, uncertainty bounds, scheduled probes, and explicit reactivation triggers—not a permanent `saturated` label.

**Governance:** Policy version, observation window, minimum sample size, reason, sleep duration, and probe budget must be recorded. This is normal completion of existing policy wiring.

---

### 7. Active learning

**Decision: Implement later, after representative evaluation sampling.**

**Exists today:** Review channels are durable and rescannable, shadow disagreements and uncertain cases are observable, and portfolio configuration can account for review cost. Review selection does not yet optimize expected model/decision improvement with recorded sampling propensities.

**Architectural improvement:** High for review efficiency, but only if separated from evaluation. Reviewing only the most uncertain or novel cases produces a biased ground-truth corpus and can starve stable terminal classes of audits.

**Overlap:** It is a review-budget policy within proposal 1 and the portfolio allocator, not a new learning store. Its labels feed the same immutable evaluation corpus and governed contribution pipeline.

**Required design:** Divide review capacity into protected random audit, operational adjudication, and active-learning allocations. Score expected information gain using model disagreement, calibration uncertainty, slice scarcity, concept novelty, and likely policy impact; cap near-duplicates and creator/source clusters. Persist selection probability and reason.

**Expected impact:** discovery `Medium`; classifier quality `High`; multilingual capability `High`; autonomy `Medium`; explainability `Medium`; scalability `High`; operational intelligence `Medium`.

**Costs and risks:** Complexity is medium-high, provider quota is low, serving latency is neutral, and human cost should fall per unit of learning. Poor uncertainty estimates can select noisy outliers. Reviewer disagreement and label difficulty must be part of utility, not treated as failure.

**Governance:** Active learning may prioritize review but cannot define truth, bypass adjudication, or consume the entire audit budget. Evaluation must use propensity-aware estimates.

---

### 8. Adaptive provider weighting

**Decision: Implement later, and only as governed segmented calibration or action policy—not continuously mutable free weights.**

**Exists today:** Evidence items carry confidence, reliability, and multipliers; providers report availability and execution outcomes; semantic output has calibration metadata; scoring weights are deterministic and staged terminal gates constrain them. Reliability is largely fixed rather than fitted per slice.

**Architectural improvement:** Medium. Providers can differ by language, field, evidence band, and time, but automatically increasing weights from production outcomes can confuse provider quality with selection, corroboration, and label availability. It also risks breaking the meaning of evidence independence.

**Overlap:** Strong overlap with proposal 1's calibration, proposal 2's provider/action selection, scoring policy, and staged classification. Often the safer response to a weak provider is to call it less often or require adjudication, not change its semantic weight.

**Required design:** First calibrate provider assertions out of sample by defined slice and model/provider version. Prefer monotone bounded reliability bands and policy snapshots over online weight updates. Preserve hard corroboration and contradiction rules. Compare weighting changes through replay and randomized canary; automatically revert on guardrail breach.

**Expected impact:** discovery `Low`; classifier quality `Medium`; multilingual capability `Medium`; autonomy `Medium`; explainability `Low-Medium`; scalability `Medium`; operational intelligence `Medium`.

**Costs and risks:** Analytical complexity is high, quota impact is neutral or beneficial through action selection, and latency is neutral. Sparse slices, correlated evidence, rapid oscillation, Simpson's paradox, and opaque scores are serious risks. This should not precede trustworthy evaluation data.

**Governance:** No per-request mutable weights and no provider self-rating. Publish immutable policy artifacts with training/evaluation cohorts, bounds, effective dates, confidence intervals, canary scope, and rollback.

---

### 9. Living knowledge intelligence

**Decision: Already effectively covered by the current architecture. Operate and validate it rather than build another layer.**

**Exists today:** Source-bound terminology observations, candidate corpus, concepts, localized surfaces and senses, moderation, diversity/decay/performance lifecycle, offline evaluation, randomized trials, immutable catalogs, governed contributions, lane-scoped publications, atomic pointers, pins, and rollback collectively implement this proposal's safe form.

**Architectural improvement:** The proposed outcome is valuable, but a new “living intelligence” subsystem would duplicate the unified governed knowledge plane. What remains is production evidence that its consumers and lifecycle policies improve outcomes, plus eventual retirement of legacy stores after rollback proof.

**Overlap:** Total overlap with terminology intelligence, concept graph, candidate scoring/evaluation, catalog publication, organic expansion, adaptive classifier, and Priority 10 knowledge publication.

**Expected impact:** discovery `High`; classifier quality `High`; multilingual capability `High`; autonomy `High`; explainability `High`; scalability `High`; operational intelligence `Medium`—but these gains come from operating the existing architecture, not redesigning it.

**Costs and risks:** Consumer canaries and evaluation have medium operational cost; serving quota and latency are low because publications are compact. The chief risk is lifecycle proliferation or letting observed yield directly grant serving authority.

**Governance:** Preserve the existing rule: mutable observations create contributions, not eligibility. Separate discovery and classification lane scopes, independent approval, immutable publication, pinned consumption, and rollback are already the right design.

---

### 10. Operational intelligence

**Decision: Implement later as a derived diagnosis and recommendation layer, not an autonomous operator.**

**Exists today:** Provider events, queue state, immutable outcomes, replay reports, classification diagnostics, review reasons, coverage statistics, experiment guards, portfolio decisions, publication history, and inspection endpoints provide much of the raw telemetry. They do not yet create a coherent causal explanation of changes across the whole funnel.

**Architectural improvement:** Medium-high. Joining versioned changes to funnel deltas can shorten incident diagnosis and reveal whether a decline comes from retrieval, provider availability, language capability, classifier stages, review backlog, catalog change, or saturation. A prose-generating model over logs would not provide this value.

**Overlap:** It is a projection over existing immutable ledgers plus proposal 1's baselines and proposal 11's experiment registry. It should not become another source of truth or a duplicate dashboard database.

**Required design:** Build a version/change registry, causal funnel decomposition, slice-aware anomaly detection, evidence-backed incident hypotheses, and ranked bounded actions with expected benefit, cost, confidence, and rollback. Every sentence or reason code must link to measurements and policy changes; unknown cause must remain `UNATTRIBUTED`.

**Expected impact:** discovery `Medium`; classifier quality `Medium`; multilingual capability `Medium`; autonomy `Medium`; explainability `High`; scalability `High`; operational intelligence `High`.

**Costs and risks:** Complexity is medium-high, provider quota and serving latency are low, and analytical storage/compute is medium. Confounded simultaneous releases and low-volume slices limit causal attribution. Recommendations can create automation bias if confidence and counterevidence are hidden.

**Governance:** The layer recommends pause, probe, replay, or investigation actions. Only pre-authorized reversible safety actions may execute automatically; policy/catalog/model promotion remains in the experiment and approval lifecycle.

---

### 11. Autonomous experimentation

**Decision: Implement later by generalizing existing experiment primitives; do not create unconstrained automatic promotion.**

**Exists today:** Randomized terminology trials include controls, assignments, propensities, caps, sufficient statistics, guardrails, pausing, and stopping. Offline candidate evaluation, shadow selection, adaptive classifier shadowing, portfolio policy states, canaries, and immutable publication already cover several experiment families. There is no single experiment contract spanning enrichment policies, provider combinations, graph actions, and classifier policies.

**Architectural improvement:** High if it standardizes causal evidence and safe rollout. Low or negative if “automatic” means letting each subsystem invent metrics and promote itself.

**Overlap:** Strong overlap with terminology trials, offline evaluation, adaptive shadow, portfolio policies, replay, provider resilience, and knowledge publication. Generalize their shared control-plane concepts while retaining domain-specific executors and guardrails.

**Required design:** A common experiment registry should define unit, eligibility, strata, randomization, propensity, control, primary objective, guardrails, interference assumptions, quota/review budget, minimum duration/sample, stop policy, version pins, and allowed lifecycle transitions. Promotion may be automatic only when a pre-approved policy has unambiguous thresholds, sufficient samples, no guardrail breach, and automatic rollback; high-impact terminal-classification changes still require explicit approval.

**Expected impact:** discovery `High`; classifier quality `High`; multilingual capability `High`; autonomy `High`; explainability `High`; scalability `High`; operational intelligence `High`.

**Costs and risks:** Complexity is high. Experiment traffic consumes provider quota and review capacity; request latency depends on the tested policy but control-plane latency is low. Cross-experiment interference, repeated peeking, novelty effects, and optimizing proxy rewards are major risks. A global concurrency and budget allocator is required.

**Governance:** Experiment creation, execution, evaluation, promotion, and rollback are separate authorities. Immutable assignments and predeclared outcomes are mandatory. The engine may stop a harmful experiment automatically; it should have a higher bar for automatic promotion.

---

### 12. Counterfactual reasoning

**Decision: Not recommended as a separate capability. It is already the core decision rule proposed for value-of-information acquisition.**

**Exists today:** Offline counterfactual evaluation and replay concepts exist, but the uncertain-case enrichment path does not estimate a per-action decision effect. That missing behavior belongs in proposal 2.

**Architectural improvement:** High as an internal method; negligible as an independent subsystem. A standalone counterfactual service would duplicate the case state, provider action registry, cost model, and outcome estimator needed by the evidence controller.

**Overlap:** Complete overlap with proposal 2 for online cases and proposal 1/11 for offline policy comparison.

**Expected impact:** discovery `Medium`; classifier quality `High`; multilingual capability `High`; autonomy `High`; explainability `High`; scalability `High`; operational intelligence `Medium`—all attributed to proposal 2.

**Costs and risks:** No separate quota or latency should be introduced. Exact counterfactuals are not observable because only the selected evidence action runs; estimates require randomized exploration, propensity logging, conservative uncertainty, and a fallback deterministic policy. An LLM assertion that “a transcript would help” is not a counterfactual estimate.

**Governance:** Counterfactual estimates guide bounded evidence allocation only. They cannot fabricate missing evidence or change a terminal decision without the evidence actually being acquired and passed through the staged classifier.

## Better architectural evolutions not expressed cleanly in the list

### A. Idempotent, resumable investigation workflows

This ranks above adaptive provider weighting and generic operational narrative. Search jobs are durable, but a channel investigation spans several side effects and best-effort observers. The evidence controller and graph frontier will add sequential actions and fan-out, making attempt identity, transactional outbox records, idempotent stages, leases, supersession, and projection repair prerequisites for safe scale. This is operational architecture, not a new discovery feature.

**Recommendation: Implement later, immediately before proposals 2 or 4 move beyond small canaries.**

### B. Conservative entity resolution and source-family independence

This is a prerequisite hidden inside proposal 4 and also improves classifier corroboration. The engine must distinguish five pages copying one source from five independent entities, and must retain uncertain entity links rather than merge them prematurely. Temporal assertions, source-family clustering, reversible identity decisions, and immutable serving projections are higher value than broad semantic-neighbor generation.

**Recommendation: Implement as the first milestone of proposal 4.**

### C. Explicit utility and constraint contract

Discovery yield, coverage gain, confirmation quality, provider quota, cash cost, review burden, latency, and false-positive harm currently appear across several policies. Before autonomous experiments or portfolio adaptation expand, define one versioned utility vocabulary and hard-constraint contract. This does not imply one scalar score: terminal precision, country exclusions, safety, audit allocation, and quota ceilings remain constraints; only feasible actions are ranked by utility.

**Recommendation: Implement now as a design prerequisite shared by proposals 1, 2, 5, 7, and 11.**

## Prioritized roadmap

Only genuinely compounding investments are included. “Already covered” proposals are operational completion work, not new roadmap phases.

### Phase 1 — Trustworthy measurement foundation

1. **Continuous decision evaluation and calibration (proposal 1).** Establish retrieval-boundary cohorts, protected audits, delayed/adjudicated labels, slice metrics, fitted artifacts, confidence intervals, and drift classification.
2. **Explicit utility and constraint contract (unlisted prerequisite C).** Standardize outcomes, costs, guardrails, and non-optimizable safety constraints.

**Gate:** No major adaptive policy proceeds until production and candidate policies can be compared on time-split, propensity-aware outcomes with uncertainty and review/provider cost.

### Phase 2 — Intelligent confirmation

3. **Value-of-information evidence acquisition, including counterfactual action selection (proposals 2 + 12).** Start deterministic and shadowed; add learned estimates only from controlled exploration.
4. **Resumable investigation workflow (unlisted prerequisite A).** Introduce attempt identity, idempotent actions, durable stop reasons, and repairable projections before broad rollout.

**Gate:** Higher resolved-confirmation yield per provider unit, non-inferior terminal-positive precision, bounded tail latency, and lower or controlled review cost versus fixed enrichment.

### Phase 3 — Governed corrective learning

5. **Automatic false-negative diagnosis and remediation proposals (proposal 3).** Automate causal taxonomy and replay; route source-bound remediations into existing governance rather than auto-publishing them.
6. **Active-learning review allocation (proposal 7).** Allocate only one protected portion of review capacity; retain random audits and operational adjudication.

**Gate:** Held-out false-negative reduction without terminal false-positive regression, feedback-loop contamination, or loss of evaluation representativeness.

### Phase 4 — Beyond-query autonomous discovery

7. **Conservative entity resolution/source independence (unlisted prerequisite B).** Establish safe temporal identity and independence semantics.
8. **Narrow graph-neighborhood expansion (proposal 4).** Trial playlist/channel and explicit creator relationships before broader sources.
9. **Coverage-gap portfolio integration (proposal 5).** Rank uncertain coverage probes alongside yield actions using the common utility/constraint contract.
10. **Complete saturation wiring (proposal 6).** Feed marginal unique yield and uncertainty into existing sleep/reactivation policy; this is not a separate build.

**Gate:** Incremental quality-adjusted confirmed creators not reachable by the contemporaneous query control, within quota, review, precision, hub, and diversity guardrails.

### Phase 5 — Generalized safe adaptation

11. **Unified autonomous experiment contract (proposal 11).** Generalize existing trials only after multiple action families need the same machinery.
12. **Operational causal intelligence (proposal 10).** Attribute changes and rank bounded actions from the common registry and evaluation baselines.
13. **Segmented provider calibration/policy (proposal 8).** Consider only where evaluation shows material, stable provider differences not handled by action selection.

**Gate:** Reproducible experiment conclusions, bounded concurrent exposure, safe automatic stopping, explicit promotion authority, and rollback drills.

## Final recommendation

Do not approve twelve projects. Approve one integrated evolution with a strict dependency order:

```text
unbiased evaluation + utility constraints
                  ↓
value-of-information acquisition + resumable attempts
                  ↓
false-negative diagnosis + active review allocation
                  ↓
entity-resolved graph and coverage portfolio
                  ↓
generalized experimentation and operational attribution
```

The living knowledge and saturation proposals are already substantially represented and should be completed through their existing owners. Counterfactual reasoning belongs inside evidence acquisition. Adaptive provider weights should wait until the engine can prove that a segmented reliability change is real, stable, causal, and safer than simply changing which evidence action is selected.

If the project undertakes only one major evolution, implement proposal 1. If it undertakes two, add proposals 2 and 12 as one capability. That pairing makes the engine more intelligent by improving what it can know, more autonomous by choosing how to resolve uncertainty, and more governable by measuring every subsequent adaptation against a representative baseline.
