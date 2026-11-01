# Enterprise OSINT Evolution Plan: toward a global trading-intelligence engine

Date: 2026-09-12 · Status: **Proposed for review. No phase is approved by this document. No code merges or deploys.**
Base evidence: read-only production investigation (role `oom_investigator_ro`) + current repo at `origin/main` 714909a (#476).
Open related PRs (unmerged): **#477** language normalization · **#478** Discord canonical-domain wiring.

Rule: do not confuse proposed with proven, implemented with validated, detected with country-proven,
Discord-found with creator-owned, or more channels with better intelligence.

---

## 1. End-state architecture

```
L1 DISCOVERY                L9 FEEDBACK / LEARNING
query planner · country     terminology lifecycle · native projections
packs · frontier proposals  decay · yield attribution · governed exploration
     │                               ▲               │
     ▼                               │               ▼
L2 ACQUISITION ──► L3 EVIDENCE/PROVENANCE ──► L8 EVIDENCE GRAPH / IDENTITY
crawl · rendered ·       immutable ledgers ·         language→country→trading→
InnerTube · retry        acquisition outcomes ·      creator→website→Discord→
economics (#476)         inspection trails           social resolution
     │                               │
     ▼                               ▼
L4 LANGUAGE→COUNTRY         L5 TRADING CLASSIFICATION    L6 CREATOR IDENTITY
detection · voters ·        multilingual packs ·         canonical domains ·
mapping · scoring ·         semantic providers ·         social identity ·
exclusion gate              relevance doctrine           name/brand binding
     │                               │                         │
     └────────► L7 ASSOCIATION ◄─────┴─────────────────────────┘
                website/Discord/social ownership scoring,
                validator + projection dual gates
                                   │
                                   ▼
              L10 SERVING / REVIEW OPS        L0 GOVERNANCE / EVALUATION
              review workflow · dashboards    version/commit endpoint ·
                                              skip/retry metrics · eval sets ·
                                              per-phase go/no-go gates
```

- **L1 Discovery** (exists; extend by measured gaps): `server/queryPlanner.ts`, `server/queryIntelligence.ts`,
  `server/terminologyIntelligence.ts`, `server/countryNativeIntelligence.ts`,
  `server/discoveryProposalGenerators.ts`, `server/countrySearchHints.ts`, `src/data/initial_countries.ts`.
  Deterministic combinatorics + DB-backed learning; no autocomplete/Trends/LLM-query-gen (verified absent).
- **L2 Acquisition** (exists; verify then extend): `server/inspector.ts`, `server/crawlUrlSkipPolicy.ts`,
  `server/browserCommunityFallback.ts`, `server/youtubeInnertubeProvider.ts`, `server/communityRetryPolicy.ts`.
- **L3 Evidence/provenance** (strong; preserve): immutable `external_acquisition_observations`,
  `evidence_acquisition_outcomes/decisions`, `channels.inspection_trail`, fail-open semantics.
- **L4 Language→country** (narrow fixes open; gate changes experimental): `server/countryInference.ts`,
  `server/countryValidator.ts`, `server/globalLanguageModel.ts`, `server/terminologyLanguageContext.ts`.
- **L5 Trading classification** (working; extend only on measured recall loss):
  `server/tradingRelevanceClassifier.ts`, `server/stagedClassification.ts`,
  `server/evidenceEngine/multilingualTerminology.ts`, Gemini/Groq providers.
- **L6 Creator identity** (partial; extend carefully): `creatorIdentityParts`, brand-domain/social-identity
  signals in `server/discordCandidates.ts`.
- **L7 Association** (provenance-strong, identity-weak): `server/discordCandidates.ts`,
  `server/discordOwnershipSelection.ts`, `server/discordValidator.ts`, `server/discordProjection.ts`,
  `server/queueManager.ts:1110-1139`.
- **L8 Evidence graph** (foundation exists: per-channel merge/rank/select; cross-channel identity graph is new work).
- **L9 Feedback/learning** (exists governed: halfLife 90d, trial/proven thresholds, caps 25/5; harden, don't rebuild).
- **L0 Governance** (missing pieces are Phase 0): no version/commit endpoint, skip events log-only.
- **L10 Serving/review** (exists; untouched by this plan).

---

## 2. Phase-by-phase architecture

### Phase 0 — Observability & evaluation foundation (FIRST; everything else depends on it)
- **Objective:** make every later phase measurable from day one.
- **Problem:** no version/commit endpoint (`/api/health` = status/readiness/database only; Dockerfile has no
  GIT_SHA); #476 skip events are log lines only (skipped URLs emit zero observations by design, so success is
  invisible in the DB); no labeled eval sets for country/trading/Discord-ownership.
- **Changes:** (a) build-stamped version endpoint (commit SHA + deploy time, read-only);
  (b) skip/retry counters persisted per run (counts only, no behavior change);
  (c) representative eval sets: excluded-country trail sample, multilingual trading sample, Discord-ownership sample.
- **Components:** `server.ts` health/routes, `server/startupLifecycle.ts`, `server/crawlUrlSkipPolicy.ts` counters,
  `server/inspector.ts` log lines, docs/eval-set definitions.
- **Connects:** instruments L2/L4/L5/L7 without touching their decisions.
- **New capabilities:** deploy-SHA proof; skip-frequency measurement; before/after benchmarking harness.
- **Dependencies:** none. Blocks: Phase 2 verdict, Phase 3/5/6/7/8 measurements.
- **Unchanged:** all scoring, gates, thresholds, crawl behavior.
- **Class:** proven gap (verified by grep + prod queries) / high-confidence instrumentation.
- **Scoped PRs:** 0a version endpoint; 0b skip/retry counters; 0c eval-set definitions (docs + fixtures).
- **Metrics:** endpoint returns SHA; skip counts queryable per run; eval-set coverage counts.
- **Risks/safeguards:** near-zero; read-only additions, no decision-path changes; rollback = revert.

### Phase 1 — Land proven wiring fixes (#477, #478)
- **Objective:** activate two dead-but-designed signals.
- **Problem:** (a) full language names (Vietnamese/Tagalog/Urdu/Bengali/…) normalized to `''` and were silently
  dropped from declared-language routing; (b) `CREATOR_CANONICAL_DOMAIN` (+55) unreachable — no caller passed
  `creatorWebsiteHosts`.
- **Changes:** already implemented in open PRs; this phase = review, benchmark, merge.
- **Components:** `server/countrySearchHints.ts`, `server/globalLanguageModel.ts`, `server/inspector.ts`,
  `server/discordCandidates.ts` (unchanged callee), tests.
- **Connects:** L4 routing (no weight changes); L6→L7 ownership corroboration. Partner −80 and non-trading veto untouched.
- **New capabilities:** declared-language survival for 8+ excluded-country languages; domain-linked invite ownership.
- **Dependencies:** none (both branch off origin/main cleanly).
- **Unchanged:** scorer tiers/weights, 75 ownership gate, all thresholds.
- **Class:** proven bug/fix, unit-tested (9+67 suites; 18+41 suites; tsc clean).
- **Scoped PRs:** #477, #478 (already open, unmerged).
- **Metrics:** normalization matrix green; canonical-reason rate + rendered-escalation delta post-deploy.
- **Risks/safeguards:** #478 flips some UNCERTAIN→OWNED (intended; guarded); rollback = single-commit revert each.

### Phase 2 — Retry-economics verification & coverage decision (#476)
- **Objective:** prove or delimit #476's production effect; do not touch it blindly.
- **Problem:** 7h post-merge window (3683 obs) shows 15 consecutive identical capped failures still logged
  (e.g. vectorvest `/feed/` UNSUPPORTED 07:46→08:29). Two hypotheses: (H1) Railway hasn't deployed #476
  (no SHA proof possible — Phase 0 gap); (H2) child-asset URLs fall outside the top-level website/social skip set
  (`inspector.ts:560-566` builds history keys from top-level candidates only).
- **Changes:** none until verdict. Work = deploy-SHA confirmation + 48h trailing-run analysis + code trace of
  asset-URL observation keys (`crawlExternalLinks` emission) to test H2.
- **Components:** `server/crawlUrlSkipPolicy.ts`, `server/inspector.ts:553-614`, prod `external_acquisition_observations`.
- **Connects:** L2 economics; outcome decides a scoped follow-up (asset-key normalization) or a docs-only scoping note.
- **New capabilities:** none yet — measurement first.
- **Dependencies:** Phase 0 (SHA proof + counters + 48h window). Blocks: any further retry work.
- **Unchanged:** #476 code and thresholds.
- **Class:** high-confidence investigation; any follow-up code = high-confidence only if H2 proven.
- **Scoped PRs:** 2a verification report (no code) → conditional 2b asset-key coverage (only if H2 proven).
- **Metrics:** per-URL trailing-run flattening; capped-class volume/day; enrichment p50/p99; backlog; utilization.
- **Risks/safeguards:** no behavior change during verification; asset-key change (if any) keeps allowlist exemptions
  and fail-open, with H1/H2 evidence attached.

### Phase 3 — Excluded-country validation strategy (global, not Vietnam-specific)
- **Objective:** close the leakage/uncertainty loop without raising false exclusions.
- **Problem:** rejection works (IN 38 / PK 13 / VN 13 REJECTED) but excluded attributions persist as
  CONFIRMED/LIKELY (IN 10+11, PK 21 LIKELY, VN 18 LIKELY); 1979 null-country UNCERTAIN (1781
  AVAILABLE_NOT_DECLARED). Ngoc Anh (UC-01RZMFTwDINElIjPs32gw, EN query → UK target → 0/100 correct fail-open)
  proves the failure mode is thin-evidence + query bleed, not a Vietnam mapping bug (mapping exists and is correct).
- **Changes:** (a) trail-level audit of every excluded CONFIRMED/LIKELY (which evidence tier fired, pre- vs
  post-exclusion-list timing); (b) global uncertain-escalation: null-country UNCERTAIN triggers one bounded
  targeted re-acquisition (video-description top-up) before acceptance — never a threshold cut;
  (c) leakage dashboard from (a). No gate/weight/threshold changes in this phase.
- **Components:** `server/countryInference.ts` (read), `server/countryValidator.ts`, `server/queueManager.ts`
  enrichment scheduling, `server/youtube.ts:784-805` authoritative sampling.
- **Connects:** L4 gate + L2 acquisition budget; feeds L8 (provenance for re-acquired evidence).
- **New capabilities:** bounded evidence escalation; leakage visibility.
- **Dependencies:** Phase 0 eval set; Phase 2 untouched. Blocks: any future gate/weight proposal (which needs this audit).
- **Unchanged:** priority tiers, P9 cap 58, 85/60 thresholds, voter definitions, P10 exclusion, Hindi India-only scope.
- **Class:** (a) high-confidence audit; (b) high-confidence improvement with budget caps; gate changes = experimental, excluded.
- **Scoped PRs:** 3a leakage audit report; 3b bounded re-acquisition (caps + tests); 3c leakage monitor.
- **Metrics:** excluded CONFIRMED/LIKELY count; null-UNCERTAIN conversion rate; false-exclusion spot-audit = 0 regressions;
  enrichment cost per escalation.
- **Risks/safeguards:** budget-bounded (per-channel cap, no loop); fail-open preserved; rollback = flag/cap revert.

### Phase 4 — Language-intelligence completion (coverage where recall loss is proven)
- **Objective:** fix the actual weakest link among {normalization, coverage, acquisition, voting, mapping, stage-loss}.
- **Problem:** current state after #477: normalization fixed; voter covers 5/30 exclusions with exact gates
  (≥8 usable of ≤10 sliced, ≥80% share, authoritative `===true`, second-language veto ≥2, confidence 90/86);
  packs cover 12 codes with `ms≠id` exact-match (Indonesian gets no pack); scorer P9 caps at 58 and can never
  authorize exclusion (`priority<=3` required).
- **Changes:** (a) stage-loss audit: trace LLM `detectedLanguages` + YouTube language hints into scorer inputs —
  wire through only where a drop is proven; (b) targeted voter/pack additions ONLY for languages with measured
  recall loss + false-exclusion testing (Hindi stays India-only; representative sorting preserved);
  (c) shared-language doctrine (EN/FR/ES/PT/AR/Bahasa never vote alone — preserved, documented).
- **Components:** `server/countryInference.ts:381-535,697-742`, `server/evidenceEngine/multilingualTerminology.ts`,
  `server/terminologyLanguageContext.ts`, Gemini/Groq provider language outputs.
- **Connects:** L4; consumes L9 confidence calibration if available.
- **New capabilities:** fewer evidence drops; documented coverage per excluded language.
- **Dependencies:** Phase 3 audit (which languages actually leak). Blocks: nothing downstream except L8 consumption.
- **Unchanged:** gate math, confidence numbers, P10 doctrine, corroboration rules.
- **Class:** (a) high-confidence audit; (b) experimental until per-language precision/recall proven.
- **Scoped PRs:** 4a stage-loss audit; 4b per-language addition(s) each with eval proof (one PR per language max).
- **Metrics:** per-language vote-fire rate, precision on eval set, false-exclusion count, 0/100 conversion with provenance.
- **Risks/safeguards:** each addition ships with veto/corroboration intact + dedicated false-exclusion tests; revert per language.

### Phase 5 — Country-discovery recall (measured gaps only)
- **Objective:** raise non-English recall without quota waste or threshold gaming.
- **Problem:** quantified gap — 7d automated uniq: FR 382 / US 374 / UK 327 / DE 211 vs CH 71 / LU 6 / IE 1 / SG 0 / BE 0;
  avg uniq/run FR 2.0 / DE 1.77 / UK 0.95 / US 0.89 / CH 0.10 / LU 0.01 / JP 0.0. Causes: 19-country static atoms,
  15-country prod scope, sequential pagination (prod max 10, default 3), low-yield early-stop
  (`marginalUtility<0.2`, duplicate≥0.8) that can stop with `hasNextPage` true. Live stack exists
  (terminology lifecycle halfLife 90d, native projections, Gemini vocab extraction, Brave CANARY, External OSINT off)
  — prior "no live intelligence" claim corrected; the gap is scope + depth, not absence of learning.
- **Changes:** (a) scope/pack expansion ordered by measured uniq/run deficit; (b) pagination tuning from
  hasNextPage-true-but-stopped measurement + quota economics (later-page marginal yield);
  (c) governed live-term mining LAST (autocomplete/Trends candidates through existing lifecycle caps 25/5 + yield gates).
- **Components:** `server/queryPlanner.ts`, `src/data/initial_countries.ts`, `server/continuationPolicy.ts`,
  `server/queueManager.ts:658-708`, `server/autonomousDiscovery.ts`, terminology/native stack (unchanged logic).
- **Connects:** L1 depth; consumes L9 yield attribution; feeds L2 quota accounting.
- **New capabilities:** deficit-ordered country coverage; depth where marginal yield justifies quota.
- **Dependencies:** Phase 0 metrics; Phase 2 quota-baseline. Blocks: live-mining (needs lifecycle proof first).
- **Unchanged:** UCB1/exploration mechanics, dedup ledger, quota reservation, intent rotation.
- **Class:** (a)(b) high-confidence once measured; (c) experimental until yield-gated proof.
- **Scoped PRs:** 5a per-country-batch expansion (deficit-ordered, one PR per batch); 5b pagination tuning with
  marginal-yield evidence; 5c live-term mining proposal (design + shadow metrics first, no serving change).
- **Metrics:** uniq/run + precision per country; pages explored vs marginal yield; quota/run; hasNextPage-stop rate.
- **Risks/safeguards:** quota caps and cooldowns untouched; expansion batches independently revertible; no threshold cuts.

### Phase 6 — Trading-classification multilingual (recall loss per language, not pack count)
- **Objective:** close proven non-English trading-recall gaps without lowering the bar.
- **Problem:** packs lack vi/hi/ur/bn/tl (12 packs only); prod split TRADING_CONFIRMED 5020 / UNCERTAIN 5134 /
  NON_TRADING 58 suggests uncertainty reservoir, but per-language loss unmeasured. Entertainment bleed
  (Ngoc Anh-class) must not be solved by threshold cuts.
- **Changes:** per-language benchmark first; packs/vocab only where loss is proven; instrument/methodology lexicons
  (forex, gold, indices, futures, crypto, TA/price-action/liquidity/order-flow) per proven language.
- **Components:** `server/evidenceEngine/multilingualTerminology.ts`, `server/tradingRelevanceClassifier.ts`,
  `server/stagedClassification.ts`, semantic providers.
- **Connects:** L5; consumes L4 language signals; feeds L7 relevance gates.
- **New capabilities:** measured-language recall with precision held.
- **Dependencies:** Phase 4 language signals; Phase 0 eval set.
- **Unchanged:** confidence thresholds, relevance doctrine, non-trading veto, semantic-provider contracts.
- **Class:** benchmarks high-confidence; each pack experimental until precision/recall proven.
- **Scoped PRs:** 6a per-language benchmark; 6b pack(s) per proven language (one PR each).
- **Metrics:** per-language trading precision/recall; UNCERTAIN→resolved rate; false-inclusion spot audits.
- **Risks/safeguards:** no threshold lowering; each pack revertible; entertainment-bleed regression tests required.

### Phase 7 — Association & identity graph (the Discord-found ≠ creator-owned program)
- **Objective:** bind identity with independent evidence families; kill false associations.
- **Problem:** ownership is provenance-strong (surface weights, 75 gate, partner −80, corroboration, dual
  validator/projection gates) but identity-weak: no guild-name↔creator match, `creatorWebsiteHosts` now wired
  (#478) but website↔YouTube linkage unchecked, no cross-channel shared-server detection, sparse-metadata
  relevance leap exists (ownership substituting for server-content evidence under strong-parent guard).
- **Changes:** (a) guild-name/description fuzzy match as corroboration (never sole proof);
  (b) shared-server detection across channels (exclusivity flag); (c) website↔creator linkage check;
  (d) sparse-metadata doctrine tightened with independent-evidence counting.
- **Components:** `server/discordCandidates.ts`, `server/discordValidator.ts:219-266`,
  `server/discordProjection.ts:18-44`, `server/discordOwnershipSelection.ts`, new cross-channel resolution store.
- **Connects:** L6+L7→L8 identity resolution; provenance preserved per inference.
- **New capabilities:** identity-bound ownership confidence; shared/third-party community labeling.
- **Dependencies:** Phase 1 #478 landed (canonical signal live); Phase 0 ownership eval set.
- **Unchanged:** surface weights, 75 gate, partner guard, non-trading veto, selection precedence.
- **Class:** experimental — every item needs false-association measurement first.
- **Scoped PRs:** 7a guild-match corroboration; 7b shared-server detection; 7c linkage check; 7d sparse-metadata doctrine.
- **Metrics:** false-association rate on eval set; shared-server flag precision; projection promotion precision.
- **Risks/safeguards:** corroboration-only (no single-signal ownership); per-PR revert; audit trail per decision.

### Phase 8 — InnerTube controlled rollout (benchmark, then decide)
- **Objective:** recover evidence the official API misses, at acceptable cost.
- **Problem:** merged (#475) but prod-disabled (`youtube_inner_tube_autonomous_enabled=false`,
  `youtube_js_hybrid_enrichment_enabled=false`); value vs cost unmeasured.
- **Changes:** shadow/canary A/B first (recovery rate, useful descriptions, latency, error/throttle, quota,
  browser/runtime load vs official API vs static scrape); enablement only on material net win.
- **Components:** `server/youtubeInnertubeProvider.ts`, retrieval rotation (`dbCore.ts:1171-1189`), enrichment paths.
- **Connects:** L2 acquisition surfaces; feeds L4 authoritative descriptions.
- **New capabilities:** quota-free description recovery (if proven).
- **Dependencies:** Phase 0 metrics; Phase 2 quota baseline.
- **Unchanged:** provider rotation integrity, cooldowns, fail-closed canary behavior.
- **Class:** experimental until A/B proves net win.
- **Scoped PRs:** 8a shadow measurement; 8b conditional canary enablement with kill-switch + rollback plan.
- **Metrics:** recovery rate, description yield, p50/p99 latency, 429 rate, quota delta, browser cost.
- **Risks/safeguards:** kill-switch, quota caps, fail-closed; revert = flag flip.

### Phase 9 — Learning-governance hardening + continuous evaluation (capstone, not a rebuild)
- **Objective:** make the engine learn safely forever.
- **Problem:** lifecycle exists (trial/proven thresholds, 90d half-life, 25/5 caps, demotion 5/0.08) but needs
  anti-pollution (low-quality term quarantine), feedback-loop guards (self-reinforcing bad discoveries),
  and scheduled eval reporting.
- **Changes:** quarantine + loop-detection + eval dashboards; no new stores/schedulers (program rule: evolve in place).
- **Components:** `server/terminologyIntelligence.ts`, `server/countryNativeIntelligence.ts`, L0 dashboards.
- **Connects:** L9↔L1 loop with governors; L0 reporting.
- **New capabilities:** self-cleaning vocabulary; continuous quality visibility.
- **Dependencies:** all measurement phases (consumes their eval sets).
- **Unchanged:** lifecycle thresholds unless eval-proven; store schemas.
- **Class:** hardening high-confidence; new governors experimental until shadow-proven.
- **Scoped PRs:** 9a quarantine; 9b loop guards; 9c continuous-eval reporting.
- **Metrics:** term churn quality, demotion precision, eval trend lines.
- **Risks/safeguards:** shadow-first; caps preserved; revert per governor.

---

## 3. Execution order (why)

0 → 1 → 2 → 3 → (4, 5, 6 in deficit order) → 7 → 8 → 9.
- **0 first:** nothing later is provable without SHA proof, counters, and eval sets.
- **1 next:** #477/#478 are proven, tested, independent — bank them before adjacent code moves.
- **2 before any retry/acquisition change:** the 15-consecutive post-merge repeats must resolve to
  undeployed-vs-asset-gap; otherwise we optimize blind.
- **3 before 4/6:** the excluded-CONFIRMED/LIKELY audit decides which languages/countries actually leak, so
  voter/pack work targets measured loss instead of pack count.
- **4/5/6 ordered by measured deficit** (uniq/run, per-language recall), not by roadmap aesthetics.
- **7 after 1:** builds on the now-live canonical signal; needs the ownership eval set from 0.
- **8 after 2:** quota baseline required to judge InnerTube's net win.
- **9 last:** hardens the loop all prior phases feed.

## 4. Evidence mapping (every change → its proof)

| Change | Evidence | Status |
|---|---|---|
| #477 normalization | allowlist lacked 14 names; full names → `''`; 1979 null-UNCERTAIN | proven |
| #478 host wiring | param exists, 0 callers pass it, 0 tests reference it | proven |
| Version endpoint | grep empty for SHA/commit/version route; Dockerfile no ARG | proven gap |
| Skip counters | skips emit zero observations by design; logs only | proven gap |
| #476 effect | 15 consecutive post-merge capped repeats; no SHA proof | unproven — verify |
| Asset-key gap (H2) | skip keys = top-level URLs; repeats = asset requested_urls | hypothesis — trace first |
| Excluded CONFIRMED/LIKELY | IN 10+11, PK 21, VN 18 LIKELY, KE 2 CONF | measured — audit next |
| Ngoc Anh 0/100 | single P10-only trail; EN query → UK target; <8 descs | correct behavior, no fix |
| Discovery gap | uniq/run table (EN ~1–2 vs small ~0–0.1) | measured — expand by deficit |
| Live stack exists | lifecycle/projections/Gemini-extract/Brave-CANARY verified | corrected prior claim |
| Discord identity gaps | no guild match; unwired hosts (fixed); no shared-server flag | proven gaps; fixes experimental |
| InnerTube value | disabled in prod; zero A/B data | unproven — benchmark |
| `ms`≈`id`, Hindi→Nepal, UK default, P9-can-exclude | all disproved by code read | no action, documented |

## 5. Deliberately not changed (working correctly — preserve)

Fail-open UNCERTAIN/CONTINUE_CRAWLING; P10 discovery-context exclusion (weight 0 for decisions);
priority tiers + confidences (P1 100 … P9 58/52, gate 85/60, conflict→49/NEEDS_REVIEW);
Hindi India-only + Nepali veto; representative sorting; authoritative `===true` + ≥8/≥80% + veto rules;
partner −80; non-trading veto over ownership; ownership-first selection precedence;
quota reservation/rotation/cooldowns; immutable ledgers + inspection-trail provenance;
UCB1/exploration mechanics; lifecycle thresholds/caps; retrieval fail-closed canary behavior.
