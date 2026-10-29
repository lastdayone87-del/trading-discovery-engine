# Query Quality and Recognition Programme (Q0–Q8 / C1–C6) — Implementation Notes

**Date:** 2026-10-29
**Branch:** `feat/query-quality-admission-q0-q8`
**Worktree:** `/root/.local/share/opencode/worktree/0cb9bd/query-quality-admission-q0-q8`
**Plan:** `/tmp/opencode/QUERY_QUALITY_FINAL_PLAN_20261029.md`
**Specification:** `/tmp/opencode/TRADING_DISCOVERY_RECOGNITION_REVISION_20261028.md`

**Status:** implemented and tested locally. Not merged, not deployed, no schema
change, no production data change, no live experiment. PR #557 was tested
read-only in an isolated worktree and remains unmodified; PR #567 was not
touched.

## 1. What changed

### Q0 — terminology searchability

- Added `server/terminologySearchability.ts`: one pure, versioned gate
  (`terminology-searchability-v1`). It rejects emoji-only/maths-alphanumeric,
  too-short, CTA-only, format-only, stopword-only, URL/handle/hashtag,
  episode-label and over-token surfaces, plus script incompatibility.
- Learned/extracted atoms must also carry governed trading semantics.
  Curated, country-vocabulary, organic, persistent-research, PR #557 and manual
  surfaces pass shape/script/CTA/term-type checks without repeating the lexicon;
  a governed country-native allocation is an explicit provenance override.
- Wired into `terminologyIntelligence.ts` (native lifecycle),
  `getPlannerTerminology`, both planner learned paths and query admission, so a
  previously promoted row cannot bypass Q0.
- Reviewed additions: `liquiditätszone`, `liquiditätszonen`,
  `liquidity zone`, `liquidity zones`, `charttechnik`, `chartanalyse`, `p2p`,
  `peer-to-peer`.
- The four trace fixtures (`Free Interviews`, `Subscribe and Like button`,
  `Épisode 6`, `🔴`) remain evidence-only and never become planner atoms.

### Q1/Q2 — retrieval firewall, admission and composition

- Added `server/queryQuality/` pure modules: `types`, `profiles`,
  `composition`, `lifecycle`, `posterior`, `selector`, `accounting`,
  `simulator`, `admission`, `dashboard`.
- `composition.ts` implements the tiered contract. Tier fields are derived, not
  trusted from producers:
  - all atoms exact-attested in the same country/language/market →
    `ATTESTED_EXACT`;
  - all atoms licensed in-profile (or explicitly `GLOBAL`) and Q0-eligible →
    `LICENSED_UNSEEN`;
  - otherwise `SPECULATIVE` (evidence-only; never selectable).
- Shape limits: ≤3 query tokens, ≤3 atoms, one anchor, no bare short ticker,
  no unlicensed relation, no ambiguous instrument pair, cross-country atom and
  language/script isolation.
- Duplicate suppression: normalized, reorder-insensitive, alias-aware and
  Jaccard ≥0.8 near-duplicate suppression, scoped per country.
- C1a retrieval firewall: `search_match_context` is excluded from creator text
  and from the canonical creator-owned corpus.
- C1b cheap triage: high-specificity Latin-market lexicon; a single broad
  market word remains ambiguous; covered non-Latin scripts take the
  conservative route; emoji/symbol surfaces cannot pass as covered script.

### Q2d — single admission authority

- `admission.ts` registers every query producer (`CURATED`,
  `COUNTRY_VOCABULARY`, `LEARNED_TERMINOLOGY`, `ORGANIC`, `MANUAL`,
  `PERSISTENT_RESEARCH`, `PR557`, `COLD_START`) with
  `directWriteAllowed: false`.
- `dbCore.upsertQueryRecord` is the only production query writer and derives
  and stores `generation_metadata.queryAdmission`.
- `autonomousQueryAuthority.ts` revalidates the stored admission at execution
  (`autonomous-query-authority-v3`) and fails closed with
  hash/tier/family/reasons.
- Policy/registry drift, a changed candidate hash or a newly ineligible
  candidate is re-admitted with `STALE_ADMISSION_REVALIDATED`; a missing stored
  admission is backfilled (`ADMISSION_BACKFILLED`).
- Legacy rows without atom metadata use
  `LEGACY_UNSCOPED_ADMISSION_COMPATIBILITY`, but still pass Q0/Q1/Q2 gates.
- The only other `INSERT INTO query_library` is the unimported SQLite shim
  `server/db.legacy.ts`; the static test proves it stays unreachable.

### Q3/Q4 — lifecycle, posterior and selector

- `lifecycle.ts` is the single selectability authority: `REJECTED` is never
  selectable; cooldown, same-tick re-execution, reservation, next-eligible,
  primary-term diversity, failure backoff and stale/speculative admission are
  hard gates.
- `posterior.ts`: 30-day decayed Gamma–Poisson hierarchy with empirical-Bayes
  log-rate partial pooling (global 0.20, family 0.35, country 0.20, market
  0.15, language 0.10), cap 4.0, minimum sample 2. Pooling rates rather than
  raw counts avoids a globally strong family crowding out every country.
- `selector.ts`: deterministic hierarchical UCB,
  `index = min(cap, mean + c × SD)`, `c = 2.0`, 15% bounded portfolio. No
  `Math.random`, no least-executed-first, no unscored fallback. Every decision
  logs posterior, `c`, index, candidate-set hash and reason.
- `queryIntelligence.selectNextQueryForCountry` now builds a candidate pool from
  admitted rows, excludes `SPECULATIVE`, re-admits generated candidates, keeps
  the deterministic intent rotation as a filter, applies family/source caps
  against `max(candidate spend, daily quota)`, and returns `NO_ELIGIBLE_QUERY`
  instead of an unscored fallback. The 16-country scheduler owns global country
  rotation, so the per-country cap is 1 per call.
- New truthful strategies are `UCB_EXPLOITATION`, `UCB_PORTFOLIO`,
  `COLD_START_GENERATION` and `NEIGHBORHOOD_TARGETED`; `selectionStrategy`
  remains string-compatible downstream.
- Promotion reads result-level sighting truth, adds the in-flight run, computes
  a posterior LCB and requires `PROVEN_MIN_COMPLETED_RUNS = 2` with
  `PROVEN_LCB_THRESHOLD = 0.5`. Zero-confirm can never become `PROVEN`.
- `canPromoteToProven` also rejects duplicate saturation and invalid queries.

### Q5 — reward accounting and attribution

- `completeQueryRun` derives `newConfirmedCreators`/`newQualityCreators` from
  distinct, persisted, globally-new, non-country-rejected
  `channel_sightings` rows with `funnel_outcome='TRADING_CONFIRMED'`.
  `query_library.unique_channels_found` is never a reward source.
- `buildQueryQualityVector` emits quota-normalized reward, duplicate ratio,
  semantic overlap, invalid/zero-result rates, target-market precision,
  language match, provider degradation and failed-run flags.
- Explicit zero market/language counts are preserved as measurements; only an
  absent input falls back to the conservative aggregate proxy.
- Attribution path: term sense → relation → composition family → surface,
  persisted into `query_run_accounting_attributions.metrics` as
  `qualityVector`/`attribution` (existing JSONB; no migration).
- `getQueryQualityRunRows` excludes provider-failed runs and
  `country_outcome='REJECTED'` sightings.
- `rewardRate` excludes failed runs, provider-degraded runs and zero-quota runs.

### Q6 — operator surface

- Pure `buildQueryQualityDashboard` projection plus DB read
  `getQueryQualityDashboardRows` and endpoint
  `/api/query-intelligence/quality-dashboard`.
- New **Quality & Admission** sub-tab in `QueryIntelligenceEngine.tsx`.
- Honesty rules: only completed runs with a valid persisted vector count;
  unaccounted runs are reported separately; missing stop reasons are not
  guessed; degraded/failed vectors stay visible but are excluded from reward
  totals and the zero-confirm share; portfolio over-budget is explicit.
- C3 display honesty: `confidence_basis` and `classification_method` in
  `ResultsTable`/`InspectionModal` distinguish calibrated, deterministic,
  degraded and neutral-prior values; no fabricated score floors.

### C1a/C1b/C2/C3/C4/C5/C6 recognition

- **C1a** retrieval firewall: `search_match_context` excluded from creator
  text, canonical creator-owned corpus and composition.
- **C1b** script-aware admission/triage: high-specificity market lexicon,
  covered non-Latin conservative route, ambiguous Latin context withheld.
- **C2** predicate correction: Tier A alone is sufficient; generic
  methodology/education needs a second dimension; bare `trading`/`trader`
  needs a financial qualifier; card/game/skin usage still needs explicit
  financial evidence. Video aggregation requires ≥3 videos and either two
  distinct Tier A signals or consistency plus distinct contextual signals.
- **C3** calibrated confidence and honest reporting fields; provider coverage
  or a long bio alone cannot make a collection sufficient; no status floors.
- **C4** bounded semantic chain: code-default stage-0 budget 2.5s aggregate /
  2s attempt and enrichment 15s / 10s, overridable with
  `SEMANTIC_CHAIN_DEADLINE_MS` / `SEMANTIC_ATTEMPT_TIMEOUT_MS`; distinct
  auth/permission/model/input error taxonomy; deterministic evidence runs
  first; decisive/query-only candidates skip semantic.
- **C5** `contextualComposition.ts`: creator-owned documents only, family
  collapse, title as name prior, non-title Tier A requirement, alternative
  dominance, thin-retrieval guard.
- **C6** `recognitionState.ts`: deterministic
  `DECISIVE_TRADING`/`DECISIVE_NON_TRADING`/`QUERY_ONLY`/`AMBIGUOUS_*`/
  `PROVIDER_DEGRADED`/`INSUFFICIENT`, semantic policy and gap list. Decisive
  and query-only states skip semantic; retrieval-only composition blocks
  terminal rejection; a sufficiently supported creator-owned terminal negative
  still rejects.

## 2. Acceptance matrix

### 2.1 Functional invariants

| Criterion | Target | Evidence | Result |
|---|---|---|---|
| Single admission authority | 100% producers registered; 0 direct writes outside admission | `Q2: source registry has no direct-write producer…`, `Q2: query_library writes go only through the admission chokepoint` | PASS |
| Composition contract | 0 invalid held-out admitted; ≥90% valid licensed-unseen admitted | `Q2: held-out licensed-unseen compositions are admitted; invalid held-out compositions fail closed` | PASS — 0/10 invalid admitted; 10/10 valid admitted |
| Tiered admission | `ATTESTED_EXACT`/`LICENSED_UNSEEN` may spend; `SPECULATIVE` evidence-only | tiered admission fixture (see test suite) | PASS |
| Quota safety | 0 provider calls/quota for rejected; no same-tick; hard cap unchanged | `Q3/Q4: rejected and admission-ineligible candidates never reach quota`, `Q3/Q4: lifecycle gates reject REJECTED, cooldown, same-tick and speculative candidates` | PASS — selector refuses; cap untouched |
| Duplicate/overlap | exact/reordered/alias/near-duplicate suppressed; cross-country false dedupe = 0 | `Q2: exact, reordered, alias and near-duplicate compositions are suppressed; cross-country is not deduped` | PASS |
| Country isolation | 16-country exact; no cross-country leakage unless licensed | `Q2: cross-country and cross-language atoms are rejected unless explicitly global`, 16-country matrix | PASS |
| Language isolation | no accidental homonym; licensed code-switch only | same isolation test; profile language matrix | PASS |
| Unseen valid | licensed-unseen admitted; no manual whitelist | held-out set + planner 123/123 | PASS |
| Revalidation | policy/term/registry change invalidates stale admission | `Q2d: stale admission policy/registry drift…`, autonomous authority tests | PASS |
| Manual/persistent/PR #557 | routed through admission; override audited | source registry + single-writer static test | PASS |
| Terminology lifecycle | ineligible terms never `SEARCH_TRIAL`/`PROVEN`; evidence retained | Q0 fixtures + `terminologyNativeDiscovery` / `autonomousRootFirewall` suites | PASS |
| Quality scorecard | every run emits vector; zero-confirm not `PROVEN`; `UNCERTAIN` not contamination | `Q5`, `Q4c`, `isContaminatedRun` contract tests | PASS |
| Verified/proxy separation | online provisional reward; no second authority | `queryFeedbackEvaluation` contract tests | PASS |
| Attribution | term/relation/family/surface credited | `Q5: quality vector is result-level and attribution carries the full path` | PASS |
| Portfolio | cold-start countries get candidates; exploration bounded; no infinite generation | `Q4: portfolio budget…`, planner matrix, `NO_ELIGIBLE_QUERY` contract | PASS |
| PR #557 | 50-page ceiling unchanged; cumulative metrics consumed; no page-sum | isolated worktree integration run | PASS — 275/275 tests; PR #557 head unchanged |
| Full suite | `npm test`, lint, type-check, build pass; no regressions | see §3 | PASS with baseline-only failures — 3675/3910 pass, 186 skipped, 49 baseline failures identical; type-check PASS; Vite build environment-blocked |

### 2.2 Q4 selector and quality targets

| Criterion | Target | Evidence | Result |
|---|---|---|---|
| Reward | per-run confirmed-new per 100 quota; sighting truth; provider failure excluded | `Q5` vector/attribution tests; `getQueryQualityRunRows` SQL | PASS |
| Selector | hierarchical UCB `c = 2.0`; deterministic; no random/least-executed/unscored fallback | `Q4: selector is deterministic…` | PASS |
| Index | `mean + 2.0 × SD`, capped, min sample, decayed | `Q4: posterior index…` | PASS |
| Calibration | `c` fixed at 2.0; c=1.0 reported as under-tuned | constants + simulator matrix | PASS |
| Non-inferiority | UCB c=2 vs corrected hierarchical TS, 100 seeds × 8 scenarios, ≤−1% relative, 16/16 coverage, no cap violation | simulator matrix (§3.3) | PASS — 8/8 scenarios within 1%; all differences positive (+0.09% to +8.45%); coverage 16/16; max family 15.00%, max country 6.27% |
| TS comparator | offline only; no serving authority/shadow arm | simulator source static assertion; no TS in serving selector | PASS |
| Promotion | LCB; min sample; zero-confirm never `PROVEN` | `Q4c` | PASS |
| Hierarchy | new surface inherits family prior; no cross-country leakage | posterior hierarchy tests + isolation tests | PASS |
| Cold start | all 16 countries get valid candidates; cold-start recorded | 123/123 planner matrix; `COLD_START_GENERATION` | PASS |
| Exploration | 10–20% (default 15%); per-country floor; family/query/source caps | `Q4: portfolio budget…`; selector cap fixtures | PASS |
| Non-domination | no family/query/source over cap | selector `capReason` hard filter + cap fixture | PASS |
| Non-stationarity | decayed counts; halved yield demoted | 30-day decay + non-stationary simulator | PASS |
| Duplicate | semantic duplicates suppressed before quota; duplicate-heavy demoted | duplicate tests + `DUPLICATE_SATURATED` promotion guard | PASS |
| Offline comparison | 100 seeds × 8 scenarios; report yield, coverage, zero-yield, distinct arms, top-10/HHI, max family/country share | §3.3 | PASS (structural, not causal) |

## 3. Validation results

### 3.1 Type-check, targeted suites, full suite

```
npx tsc --noEmit                                  PASS
node --import tsx --test server/queryQuality/queryQuality.test.ts
                                                  26/26 PASS
targeted: autonomousRootFirewall, countryNativeIntelligence,
terminologyNativeDiscovery, queryPlanner,
querySelectionNoCandidate.contract, queryFeedbackEvaluation
                                                  160/160 PASS
npm test                                          3910 tests: 3675 pass, 49 fail
                                                  (baseline-identical), 186 skipped
```

The full-suite failure-name set was compared with the pre-existing baseline:
identical (49 baseline failures across 39 unrelated files). No new failure was
introduced.

### 3.2 Build / lint

```
npm run lint (tsc --noEmit)                       PASS
npx esbuild server.ts --bundle --platform=node \
  --format=cjs --packages=external --sourcemap     PASS
npm run build (vite build && esbuild)             BLOCKED — Termux/Android Rollup
                                                  native addon ERR_DLOPEN_FAILED
                                                  (baseline identical); esbuild PASS
```

`vite build` fails in this Termux/Android arm64 environment because the Rollup
native addon cannot be dlopened (`@rollup/rollup-android-arm64`,
`ERR_DLOPEN_FAILED`). The same failure occurs on the untouched baseline
worktree at `526e37e`, so it is an environment precondition, not a regression
from this branch. The esbuild server bundle passes.

### 3.3 Offline selector comparison (100 seeds × 1500 pulls)

The harness uses 16 countries, 15 global composition families (24 in the
many-arm stress), 20 arms per country (30 in the many-arm stress) spread as one
or two surfaces per family, hierarchical true rates, finite shared creator
pools, 100/200/300 quota units, a common 15% portfolio and a common 15% family
share cap. The 15% family cap is a common stress-test constraint for every
selector, not the serving default; serving caps are configured separately and
measured against `max(candidate spend, daily quota units)`. The simulator is
deterministic and offline; it is not a serving path and not causal evidence.

| Scenario | Selector | Yield /100 | Coverage | Zero-yield | Distinct arms | Top-10 share | Max family | Max country |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| sparse | current_ucb1 | 0.586 | 16.00/16 | 52.08% | 319.6 | 9.54% | 13.12% | 6.27% |
| sparse | hierarchical_ucb_c1 | 0.645 | 16.00/16 | 49.47% | 289.0 | 22.48% | 14.98% | 6.27% |
| sparse | hierarchical_ucb_c2 | 0.661 | 16.00/16 | 48.05% | 307.3 | 19.96% | 14.93% | 6.27% |
| sparse | independent_ts | 0.622 | 16.00/16 | 50.89% | 281.3 | 21.13% | 14.96% | 6.27% |
| sparse | hierarchical_ts | 0.626 | 16.00/16 | 50.52% | 281.8 | 21.25% | 14.98% | 6.27% |
| medium | current_ucb1 | 1.271 | 16.00/16 | 26.01% | 295.5 | 12.46% | 14.37% | 6.27% |
| medium | hierarchical_ucb_c1 | 1.218 | 16.00/16 | 33.87% | 284.5 | 19.61% | 14.98% | 6.27% |
| medium | hierarchical_ucb_c2 | 1.249 | 16.00/16 | 31.80% | 307.6 | 17.50% | 14.98% | 6.27% |
| medium | independent_ts | 1.186 | 16.00/16 | 35.22% | 283.1 | 19.05% | 14.99% | 6.27% |
| medium | hierarchical_ts | 1.183 | 16.00/16 | 35.25% | 283.0 | 18.94% | 14.99% | 6.27% |
| rich | current_ucb1 | 2.441 | 16.00/16 | 9.47% | 229.8 | 13.92% | 14.86% | 6.27% |
| rich | hierarchical_ucb_c1 | 2.242 | 16.00/16 | 22.21% | 279.3 | 18.72% | 14.99% | 6.27% |
| rich | hierarchical_ucb_c2 | 2.285 | 16.00/16 | 19.48% | 305.7 | 17.04% | 14.94% | 6.27% |
| rich | independent_ts | 2.188 | 16.00/16 | 23.44% | 282.1 | 18.38% | 14.99% | 6.27% |
| rich | hierarchical_ts | 2.180 | 16.00/16 | 23.45% | 281.2 | 18.37% | 14.98% | 6.27% |
| cold_start | current_ucb1 | 1.304 | 16.00/16 | 26.59% | 290.9 | 12.31% | 14.36% | 6.27% |
| cold_start | hierarchical_ucb_c1 | 1.230 | 16.00/16 | 34.75% | 280.4 | 19.64% | 14.96% | 6.27% |
| cold_start | hierarchical_ucb_c2 | 1.273 | 16.00/16 | 32.40% | 302.0 | 17.36% | 14.93% | 6.27% |
| cold_start | independent_ts | 1.197 | 16.00/16 | 36.10% | 280.8 | 18.87% | 14.98% | 6.27% |
| cold_start | hierarchical_ts | 1.192 | 16.00/16 | 36.26% | 279.7 | 18.82% | 14.97% | 6.27% |
| cold_countries | current_ucb1 | 1.280 | 16.00/16 | 31.61% | 287.7 | 11.98% | 14.08% | 6.27% |
| cold_countries | hierarchical_ucb_c1 | 1.176 | 16.00/16 | 39.01% | 271.9 | 20.42% | 14.95% | 6.27% |
| cold_countries | hierarchical_ucb_c2 | 1.236 | 16.00/16 | 36.37% | 293.4 | 17.70% | 14.93% | 6.27% |
| cold_countries | independent_ts | 1.150 | 16.00/16 | 40.12% | 274.6 | 18.99% | 15.00% | 6.27% |
| cold_countries | hierarchical_ts | 1.140 | 16.00/16 | 40.38% | 274.5 | 19.07% | 14.96% | 6.27% |
| non_stationary | current_ucb1 | 1.399 | 16.00/16 | 24.10% | 286.8 | 14.07% | 14.49% | 6.27% |
| non_stationary | hierarchical_ucb_c1 | 1.355 | 16.00/16 | 31.20% | 285.4 | 21.81% | 14.98% | 6.27% |
| non_stationary | hierarchical_ucb_c2 | 1.382 | 16.00/16 | 29.46% | 305.7 | 19.62% | 14.96% | 6.27% |
| non_stationary | independent_ts | 1.313 | 16.00/16 | 32.74% | 283.8 | 20.96% | 14.98% | 6.27% |
| non_stationary | hierarchical_ts | 1.315 | 16.00/16 | 32.43% | 283.8 | 20.98% | 15.00% | 6.27% |
| depletion | current_ucb1 | 0.053 | 16.00/16 | 95.90% | 320.0 | 3.33% | 10.67% | 6.27% |
| depletion | hierarchical_ucb_c1 | 0.053 | 16.00/16 | 95.89% | 303.3 | 23.30% | 15.00% | 6.27% |
| depletion | hierarchical_ucb_c2 | 0.053 | 16.00/16 | 95.89% | 316.7 | 21.54% | 15.00% | 6.27% |
| depletion | independent_ts | 0.053 | 16.00/16 | 95.90% | 256.1 | 23.29% | 15.00% | 6.27% |
| depletion | hierarchical_ts | 0.053 | 16.00/16 | 95.85% | 256.0 | 23.16% | 15.00% | 6.27% |
| many_arms | current_ucb1 | 1.432 | 16.00/16 | 22.06% | 335.1 | 12.37% | 13.61% | 6.27% |
| many_arms | hierarchical_ucb_c1 | 1.350 | 16.00/16 | 33.19% | 349.6 | 17.58% | 14.85% | 6.27% |
| many_arms | hierarchical_ucb_c2 | 1.400 | 16.00/16 | 30.20% | 411.0 | 15.28% | 14.52% | 6.27% |
| many_arms | independent_ts | 1.303 | 16.00/16 | 34.51% | 350.2 | 17.41% | 14.84% | 6.27% |
| many_arms | hierarchical_ts | 1.305 | 16.00/16 | 34.64% | 347.1 | 17.43% | 14.91% | 6.27% |

**UCB c=2 vs corrected hierarchical TS**

| Scenario | UCB c=2 | Hier TS | Relative | UCB family | UCB country | Within 1% |
|---|---:|---:|---:|---:|---:|---|
| sparse | 0.661 | 0.626 | 5.65% | 14.93% | 6.27% | yes |
| medium | 1.249 | 1.183 | 5.59% | 14.98% | 6.27% | yes |
| rich | 2.285 | 2.180 | 4.80% | 14.94% | 6.27% | yes |
| cold_start | 1.273 | 1.192 | 6.82% | 14.93% | 6.27% | yes |
| cold_countries | 1.236 | 1.140 | 8.45% | 14.93% | 6.27% | yes |
| non_stationary | 1.382 | 1.315 | 5.10% | 14.96% | 6.27% | yes |
| depletion | 0.053 | 0.053 | 0.09% | 15.00% | 6.27% | yes |
| many_arms | 1.400 | 1.305 | 7.24% | 14.52% | 6.27% | yes |

**Relative yield vs corrected hierarchical TS**

| Scenario | current UCB1 | UCB c=1 | UCB c=2 | independent TS |
|---|---:|---:|---:|---:|
| sparse | -6.35% | 3.15% | 5.65% | -0.59% |
| medium | 7.44% | 2.93% | 5.59% | 0.25% |
| rich | 11.95% | 2.83% | 4.80% | 0.35% |
| cold_start | 9.42% | 3.25% | 6.82% | 0.44% |
| cold_countries | 12.28% | 3.15% | 8.45% | 0.88% |
| non_stationary | 6.37% | 2.98% | 5.10% | -0.20% |
| depletion | -0.01% | -0.04% | 0.09% | 0.01% |
| many_arms | 9.71% | 3.47% | 7.24% | -0.12% |

The serving choice, UCB c=2, is non-inferior in all 8 scenarios and positive in
all 8. The old last-run UCB1 proxy loses in sparse (−6.35%) and gains in rich
(+11.95%), which is the instability the hierarchy is meant to remove. Every
selector keeps 16/16 coverage; the tested caps hold (max family 15.00%, max
country 6.27%). These are structural simulator results, not causal production
evidence.

## 4. PR #557 compatibility

PR #557 head `cd25da8` was checked out read-only in an isolated worktree
(`/tmp/opencode/pr557-compat`) with the existing `node_modules` linked. The
programme commit `953d943` was cherry-picked onto that head (isolated
compatibility commit `3324783`); conflicts were resolved without changing
PR #557:

- `server/queryIntelligence.ts` and `server/queryPlanner.ts`: kept PR #557's
  free-signal imports and the Q0 searchability import together.
- `server/terminologyIntelligence.ts`: kept PR #557's v2 reconciliation,
  aggregate and lifecycle block, and applied the Q0 gate to both
  `decideLifecycle` and `decideLifecycleV2` by passing the canonical
  term/country/language. A v2 promotion therefore cannot bypass Q0.
- `server/dbCore.ts` auto-merged: PR #557's fresh-confirmed, continuation,
  requested page depth and AI budget ledger behavior remain alongside the Q5
  sighting truth, quality vector and attribution.

Result in the isolated worktree:

```text
npx tsc --noEmit                                  PASS
queryQuality + PR #557/targeted suites            275/275 PASS
```

The suites were `queryQuality.test.ts`, `countryDiscoveryLoop.test.ts`,
`autonomousPageStore.test.ts`, `countryNativeIntelligence.test.ts`,
`queryPerformance.test.ts`, `terminologyIntelligence.test.ts`,
`terminologyNativeDiscovery.test.ts`, `queryPlanner.test.ts` and
`autonomousRootFirewall.test.ts`. The 50-page ceiling, cumulative metric
consumption and PR #557's own tests remain intact. PR #557 was not modified.

## 5. Known gaps, blockers and boundaries

1. **Vite build environment.** `npm run build` cannot complete in this
   Termux/Android environment because the Rollup native addon cannot be
   dlopened; baseline fails identically. The server esbuild bundle and the
   TypeScript type-check pass. CI or a normal x64/arm64 Linux environment must
   run the Vite build before merge.
2. **Pre-existing test failures.** 49 full-suite failures exist on the
   untouched baseline; this branch neither fixes nor worsens them. They are
   outside this programme.
3. **No production validation.** Shadow/canary, production settings, provider
   keys, and live experiments remain behind separate approval. The 100-seed
   simulator is structural evidence, not a causal production forecast.
4. **No production replay/cleanup.** Historical query/run data were not
   migrated, replayed or cleaned. Schema and data changes remain separately
   gated; all persistence uses existing JSONB.
5. **SPECULATIVE research.** SPECULATIVE candidates are evidence-only and
   fail closed in serving. Bounded speculative research is not enabled without
   separate approval.
6. **PR #557 merge order.** Integration was tested in a throwaway worktree;
   the merge order between this branch and PR #557 remains a coordination
   decision. PR #557 was not modified.
7. **Held-out set size.** The held-out composition set is deliberately small
   and hand-built. It measures 0 invalid admissions and 100% valid admission in
   this sample; it is not a production-representative estimate.

## 6. Rollback

- Revert the single programme commit (or the merge commit) — no migration, no
  destructive data change, no production setting is part of it.
- All new state is additive JSONB:
  `query_library.generation_metadata.queryAdmission`,
  `query_run_accounting_attributions.metrics.qualityVector/attribution`.
  Old rows without these fields are handled as legacy/unaccounted, not as zero
  yield.
- Selection strategies are string-compatible; the selector can be reverted
  without a schema change. Environment overrides for C4 semantic budgets are
  optional and default to the documented bounded values.
- The dashboard endpoint and UI sub-tab are read-only projections; removing
  them does not affect scheduling or accounting.
- No production data cleanup is required to roll back.

## 7. Merge readiness

Code complete and locally verified. Merge is not performed. Before merge:

1. CI or a normal Linux environment must run `npm run build` (Vite + esbuild);
   the local Vite blocker is the Termux/Android Rollup native addon, and the
   untouched baseline fails identically.
2. Confirm the PR #557 merge order. The isolated compatibility run passes, but
   the Q0-on-v2 lifecycle edit and the shared import resolution must be kept in
   the merge result.
3. Treat the 49 pre-existing full-suite failures as baseline, not as new
   regressions, and keep the full-suite failure-name comparison with the merge.

No merge, deployment, schema migration, production data cleanup or live
experiment was performed.
