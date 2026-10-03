# Frozen Benchmark Specification / Preregistration

**Status: PREREGISTRATION ONLY — no benchmark has been executed under this specification.**
**Do not modify this document after benchmark execution begins. Any change requires a new spec version.**

- Benchmark specification version: `benchmark-preregistration-v1`
- Engine base commit (merged main after PR #492): `4b49e0c01ac53eebf0080fae29bd6aaabb803cfc`
  (`4b49e0c Merge pull request #492 from lastdayone87-del/feat/engine-completion`)
- Scope: describes what is actually implemented and executable at the base commit. No imagined future system.
- Prohibitions during preparation (observed): no benchmark run, no new mechanisms, no tuning, no threshold/prior/weight/horizon/cut/feed/provider/eligibility/assignment changes, no UCB1 changes, no production behavior changes, no global enablement of experimental mechanisms.

## 1. Frozen system under test

| Component | Frozen value | Source |
|---|---|---|
| Engine commit | `4b49e0c01ac53eebf0080fae29bd6aaabb803cfc` | `git rev-parse HEAD` on `origin/main` |
| Spec version | `benchmark-preregistration-v1` | this document |
| Selection experiment core | `query-selection-experiment-v1` | `server/querySelectionExperiments.ts:53` |
| Thompson observation map | `thompson-observation-map-v1` | `server/querySelectionExperiments.ts:54` |
| Query features map | `query-features-v1` | `server/querySelectionExperiments.ts:55` |
| Retrieval (P2 window/order) experiment | `retrieval-experiment-v1` | `server/retrievalExperiment.ts:13` |
| Allocation challenger (Thompson/Contextual scorers) | `allocation-challenger-v1` | `server/allocationChallengers.ts:13` |
| Trial funnel map | `trial-funnel-map-v1` | `server/discoveryFrontierTrials.ts:465` |
| Frontier allocator | `discovery-frontier-allocator-v1` | `server/discoveryFrontierAllocator.ts:14` |
| Site Profiler (P-A) | `site-profiler-v1` | `server/siteProfiler.ts:21` |
| Acquisition Ladder (P-B) | `acquisition-ladder-v1` | `server/acquisitionLadder.ts:24` |
| Frontier Manager (P-C) | `frontier-manager-v1` | `server/frontierManager.ts:20` |
| Domain Learner (P-D) | `domain-learner-v1` | `server/domainLearner.ts:25` |
| LLM Assist (P-E) | `llm-assist-v1` | `server/llmAssist.ts:25` |
| Graph expansion policy (P3) | `graph-expansion-v1`, `GRAPH_MAX_DEPTH=2`, `GRAPH_MAX_FANOUT=10` | `server/graphExpansionPolicy.ts:12-14` |
| Relationship canary | `relationship-canary-v1`, `MAX_SEEDS=10`, `MAX_DEPTH=2`, `MAX_FANOUT=10`, `MAX_DEPTH2_PARENTS=5`, `MAX_CHANNELS_PER_RUN=150`, `ESTIMATED_DOWNSTREAM_UNITS=305` | `server/relationshipCanary.ts:31-48` |
| Autonomous query authority | `autonomous-query-authority-v2` | `server/autonomousQueryAuthority.ts:5` |
| Candidate triage | `candidate-triage-v4-contextual-admission` | `server/candidateTriage.ts:6` |
| DB migrations | 137 files, latest `137_domain_memory.sql` | `server/db/migrations/` |
| Assignment/hash | sha256 hex slice `(0,8)` mod 10000; no separate salt field exists — assignment identity/version inputs = `policyVersion + experimentId + opportunityKey` (see §6) | `server/querySelectionExperiments.ts:137-139`, `server/retrievalExperiment.ts:114-117` |
| Feature-gate states | All benchmark-relevant experimental gates default OFF/false/0 (see §3 table); UCB1 control has no gate | §3 |
| Provider versions/config | YouTube official + Innertube-free + Brave direct/OSINT providers via registry; quota domains enforced at reservation; no provider version bump in this spec | `server/dbCore.ts:1829-1834`, `server/queueManager.ts:597-643`, `server/braveSearch.ts:22-25` |
| Acquisition/evidence pipeline | Existing crawl ceilings bind; P-A/P-B/P-C bounds are caps, never targets | `server/siteProfiler.ts`, `server/acquisitionLadder.ts`, `server/frontierManager.ts` |

Configuration hash method (record at execution, before first observation): `sha256(engineCommit + specVersion + SELECT setting_key,setting_value FROM app_settings ORDER BY 1 dump + SELECT max migration filename + provider registry snapshot)`. No run may silently use a later commit: the execution record must quote the engine commit above and the config hash.

PR lineage incorporated in base: #486 (frontier P0–P6 testability scaffolding), #488 (adaptive evidence acquisition), #491 (experiment wiring/measurement: pure selection-experiment core, scheduling→execution wiring, benchmark access routes, P-D experiment gate, observation attribution), #492 (engine completion: P3 depth-2 policy evaluation in canary loop shadow-only, P5 adapter registry + gated runner with stubs staying stubs and no fetch loop, P5/P-D/P-E execution-path completion shadow-only default-off, Greptile P1/P2 guards).

## 2. Control (UCB1, unchanged)

Implementation: `server/queryIntelligence.ts:selectNextQueryForCountry` (`304-475`); scoring block `359-379`.

Frozen control parameters (literals):

- Exploration constant: `explorationConst = 0.8`, hardcoded (`queryIntelligence.ts:368`); term `0.8 * sqrt(log(totalExecutions+1) / (times_executed+1))` (`:369`); score `max(0, normPerformance + ucbTerm)`, `normPerformance = performance_score/100` (`:365-370`); stored `ucb_score = round(ucbScore*100)/100` (`:374`); descending sort (`:379`).
- Stochastic exploration gate: `explorationRatio` default `'0.4'`, clamp `[0.1,0.9]` (`:330`); `isExploration = Math.random() < explorationRatio` (`:452`); exploration branch filters `collection==='EXPERIMENTAL'`, sorts `times_executed ASC, ucb_score DESC` (`:456-463`).
- Cold start: empty query set → `generateCandidateQueriesForCountry(country,4,'COLD_START')`, strategy `COLD_START_GENERATION` (`:333-342`); empty eligible set → 4 `EXPLORATION` candidates, strategy `UCB1_EXPLORATION` (`:348-357`); generator default `count=3`, upserts `collection:'EXPERIMENTAL'` (`:482-525`).
- Eligibility gates (pre-UCB): `collection!=='REJECTED'`, `reserved_until`/`next_eligible_at` null or past (`:321-327`); cooldown `query_intelligence_query_cooldown_minutes`, default `'360'`, `max(1,…)` (`:328`); primary-term cap `query_intelligence_primary_term_max_uses`, default `'2'` (`:329`); `queriesOutsideCooldown` + `limitRepeatedPrimaryTerms` + `rotateAwayFromMostRecentIntent` (`queryPlanner.ts:117-138`); authority reject → `REJECTED` + skip (`autonomousDiscovery.ts:601-620`, rules `autonomousQueryAuthority.ts:107-151`); batch diversity guard (`autonomousDiscovery.ts:622-632`); reservation `reserved_until=now()+20min`, zero-rows skip (`dbCore.ts:1852-1866`); provider must be `ACTIVE/ACTIVE_GLOBAL/CANARY` (+`SHADOW` only explicit Brave canary) (`dbCore.ts:1829-1834`).
- Quota/cost: per-key `YOUTUBE_DAILY_QUOTA_PER_KEY||'10000'` (`dbCore.ts:651`); autonomous share default `70`, range `[1,100]` (`autonomousDiscovery.ts:100-108`); capacity `min(batchSize, max(0,target-current))` (`discoverySchedulerPolicy.ts:29-37`); execution reserves 100 units `AUTONOMOUS_QUERY_PAGE` (`queueManager.ts:615-618`); `YOUTUBE_INNERTUBE_FREE` reserves nothing; Brave uses provider-request ledger (`:602-634`); `quotaConsumed = providerCostUsd>0 || INNERTUBE_FREE ? 0 : pageNumber*100` (`:824`); pagination caps `autonomous_pagination_max_pages='3'`, `autonomous_pagination_max_low_yield_pages='2'` (`:691-702`).
- Allocation semantics: control `allocationOrigin='LEGACY'`, no frontier decision id/dimensions (`autonomousDiscovery.ts:633-658`); provider rotation stable per `scheduled:${query.id}:${country}` (`dbCore.ts:1787-1822`); lane/ordering deficit allocator, video-lane target 70 (`retrievalLanes.ts:4-6`, default `discovery_video_lane_percent`), ordering `CHANNEL=>RELEVANCE`, video date target `max(configured '10', recency floor '60')` (`searchOrdering.ts:15-27`).
- Attribution semantics: `completeQueryRun` sets `COMPLETED/quota_used/provider_*/performance_details`, idempotent `query_run_accounting_attributions` (`attribution_version='query-run-accounting-v1'`), updates `query_library` + `query_execution_logs` + terminology attribution (`dbCore.ts:2841-2903`); funnel→score `100*(0.30 tradingPrecision + 0.25 noveltyRatio + 0.20 qualityYield + 0.15 countryPrecision + 0.10 communityYield)` (`queryPerformance.ts:90-96`); quality = `TRADING_CONFIRMED && score>=55` (`:6-10`); promotion `>=60=>PROVEN`, `<25 && runs>=2=>REJECTED` (`:135-141`).
- Neighborhood: dimensions/key/checksum/mapping (`discoveryNeighborhood.ts:6-67,99-150`); control targeted branch `NEIGHBORHOOD_TARGETED` with miss→generate→`planFrontierTargetedQuery` fallback (`queryIntelligence.ts:386-449`; `queryPlanner.ts:145-175`).

UCB1 was not modified while preparing this specification.

## 3. Experimental arms (as implemented at base)

Admission models differ per mechanism. The benchmark treatment for each category is explicit:

1. Request-level deterministic experiment assignment (benchmark-randomized): Thompson, Contextual, P2 ordering — assignment by frozen hash construction (§6) using the frozen experiment identity (§3A). Absent `experiment` in a request → legacy UCB1 byte-identical path (not a benchmark observation).
2. Feature-gated deterministic mechanisms (NOT benchmark-randomized; remain default-off): P-A, P-B, P-C — no benchmark treatment arm; benchmark runs with gates as frozen in §3A (off unless the frozen config says otherwise).
3. Approval + feature-gated mechanism (NOT benchmark-randomized): P-D serving influence — no serving arm until human-approved snapshot + flag admission exist (none exists at base); benchmark treatment is snapshot-production metrics only.
4. Shadow-only mechanisms (record-only by construction): P3 policy evaluation, P2 shadow recommendation, P5 registry/gates, P-E gateway/fallbacks, P-D snapshot production — benchmark treatment is eligibility/reason-code/fallback rates only, never efficacy claims.
5. Genuinely blocked mechanisms (no benchmark arm): P3 independent-family instrumentation, live P5 materialization/fetch, P6, live P-E provider, unapproved P-D serving — documented in §4, reported as blocked-rate where observable, never silently dropped for performance reasons.

For the randomized arms, `treatmentBasisPoints=0` or empty `enabledArms` forces CONTROL. Invalid request on routes → `400`, schedules nothing (`server.ts:463-477,702-718`).

### 3A. Frozen benchmark configuration (part of benchmark-preregistration-v1)

Chosen deterministically from the spec version and code defaults — not from expected performance. These values are frozen now; no operator selection at execution time.

- Selection experimentId: `benchmark-prereg-v1-selection` (derived from the spec version string).
- Ordering/P2 experimentId: `benchmark-prereg-v1-ordering` (derived from the spec version string).
- Enabled selection arms: `['THOMPSON', 'CONTEXTUAL']` (the complete set of executable selection treatments at base; equal split, no picking).
- Selection treatmentBasisPoints: `5000` (balanced 50% CONTROL / 50% treatment; treatment split `floor(5000/2)=2500` per arm; control propensity `5000`). Justification: balanced control/treatment with equal challenger coverage; no performance input.
- Ordering treatmentBasisPoints: `5000` (balanced 50% CONTROL / 50% TREATMENT windowed retrieval; propensities `5000`/`5000`). Independent of the selection dimension.
- Thompson priors: `alpha0=1, beta0=1` (implemented defaults; `allocationChallengers.ts:27,123-127`).
- Contextual weights: `value=0.5, exploration=0.35, cost=0.1` (implemented defaults; `allocationChallengers.ts:156-160`).
- P2 window definition (immutable rule, enforced in code — not operator-selected): for the frozen ordering experimentId with a TREATMENT arm, the executed window is derived from the run's scheduled_at at schedule time (`deriveBenchmarkOrderingWindow`: publishedBefore = scheduled_at, publishedAfter = scheduled_at − 90 days, RFC3339). Caller-supplied bounds (present, absent, or divergent) never reach execution or the persisted envelope on this path (`querySelectionExperiments.ts:evaluateOrderingDimension` frozen branch + `dbCore.ts` schedule-time derivation, which overwrites the envelope copy before metadata/job persistence so recorded and executed bounds agree). All other experiment identities use the legacy caller-window path byte-identically.
- Trial request defaults (no tuning): `maxQuota=100`, `pageDepth=1` (code defaults; `querySelectionExperiments.ts:237-244`); downstream caps per §7 still bind.
- Feature-gated mechanisms during benchmark: P-A OFF, P-B OFF, P-C OFF, P-D serving OFF (no approved snapshot), P-E gateway OFF (fallbacks only), `graph_depth2_experiment_enabled` OFF, `relationship_canary_enabled` OFF, `frontier_trials_enabled` as-coded (missing=false) with trial initiation permitted only through the frozen trial path and caps. No gate is enabled to create the benchmark.

| Arm / mechanism | Implementation / version | Eligibility | Assignment | Gates (default) | Caps / quota | Failure handling | Eligible observation |
|---|---|---|---|---|---|---|---|
| Thompson sampling (selection) | `querySelectionExperiments.ts:53-55,462`, `allocationChallengers.ts:27,123-127` (`allocation-challenger-v1`); prior defaults `alpha0=1,beta0=1` | Valid request: non-empty `experimentId`, arms ⊆ {THOMPSON,CONTEXTUAL}, basis `0..10000` int, finite priors/weights (`:158-182`); pool = reservable + cooldown/diversity/intent gates, id-asc (`:581-589,705-708`); observation map `successes=floor(quality_channels_found)`, `failures=max(0,floor(times_executed)-successes)` (`:24-33,407-432`) | `shaBucket(VERSION:experimentId:opportunityKey)`, `bucket>=basis→CONTROL`; else `enabledArms[shaBucket(…:arm) % n]`, propensity `floor(basis/n)`, control propensity `10000-basis` (`:305-330`); no `Math.random` | No app_settings gate; opt-in request only; `query_intelligence_paused` pauses all (`autonomousDiscovery.ts:110-111`) | basis `0..10000`; trial `maxQuota 1..100 default 100`, `pageDepth>=1 default 1` (`:237-244`); downstream trial pageDepthCap `min(1,…)` (`discoveryFrontierTrials.ts:335`); daily canary cap 500 (`:153,163`) | Invalid→400; empty pool→UCB1 fallback with reason `Requested treatment arm but the eligible pool was empty; served UCB1 fallback` (`:709-723`); `OPPORTUNITY_KEY_REQUIRED`; `NO_ARMS`/`INVALID_ARM_COUNTS`/`INVALID_PRIOR` throws | Served query record with persisted `selectionExperiment` envelope + `selectionStrategy=THOMPSON` |
| Contextual challenger (selection) | Same core; scorer `contextualArmScore` defaults `value 0.5, exploration 0.35, cost 0.1` (`allocationChallengers.ts:156-160`); features `expectedValue=(performance_score)/100`, `uncertainty=1/(times_executed+1)`, `coverageGap`, `cost=1` | Same as Thompson | Same bucket/arm-pick mechanism | Same as Thompson | Same as Thompson | `INVALID_ARM_FEATURES` throws; otherwise same as Thompson | Same with `selectionStrategy=CONTEXTUAL` |
| P2 windowed retrieval/order | `retrieval-experiment-v1` (`retrievalExperiment.ts:13`); bounds RFC3339 full-datetime (`:31`); treatment needs ≥1 valid bound + non-empty experimentId (`:44-72`) | Ordering request valid: basis int `0..10000`, non-empty id chain, window re-validated (`querySelectionExperiments.ts:184-233`); independent of selection dimension (`:623-636`) | Independent bucket `sha256(VERSION:opportunityKey)%10000`, `bucket<basis→TREATMENT`, propensity basis / `10000-basis` (`retrievalExperiment.ts:114-143`) | Opt-in `experiment.ordering` only; absent→legacy byte-identical (`:629-636,648`) | Date-range only; execution pagination/trial caps apply (`queueManager.ts:691-701`, `discoveryFrontierTrials.ts:553-558`) | Route-invalid→400; execution-time invalid→`null` → unwindowed fetch (`retrievalExperiment.ts:86-104` via `queueManager.ts:624`); only TREATMENT+valid window persists `searchWindow` (`dbCore.ts:2094-2095,2176`) | `SEARCH_YOUTUBE` job carrying `searchWindow{publishedAfter?,publishedBefore?,experimentId}` executed via `executeAllocatedRetrievalPage` |
| P3 graph-depth-2 | `graph-expansion-v1` (`graphExpansionPolicy.ts:12`), `RELATIONSHIP_CANARY_VERSION` (`relationshipCanary.ts:31`); wrapper `evaluateGraphDepth2ForCanaryTarget` (`:241-268`) | Fail-closed: canaryEnabled; numeric sanity; `parentDepth==1`; fanout int ≥1; `independentFamilies>=2`; not saturated (`overlap>=0.85 && known>=0.85`) (`graphExpansionPolicy.ts:43-73`); caller passes `independentFamilies:0` → always `GRAPH_INSUFFICIENT_INDEPENDENCE` until family signals exist (`relationshipCanary.ts:234-238`); payload `seeds 1..10, maxDepth 1..2, maxFanout 1..10, maxChannels 1..150` (`:73-109`) | No randomization; deterministic `proposalKey=sha256(VERSION:parent:edgeKind:2:i…)[0:32]` (`graphExpansionPolicy.ts:122-125`) | `graph_depth2_experiment_enabled` default `'false'` (`:917-918`); parent canary `relationship_canary_enabled` default `'false'`, kill switch default `'true'`, quota pct default `'1'` clamp `1..10` (`:140-148`); live = enabled && killSwitch!==true | Fanout cap 10; depth2 parents 5; channels/run 150; earmark 305 units | Ineligible→`{eligible:false,proposals:[]}` record-only (`:259-261`); builder throws `GRAPH_DEPTH2_NOT_ELIGIBLE/INVALID_PARENT/…` (`:108-113`); execution failures classified (`:305-312`), guards break/return without spend | Record-only `rawObservation.graphDepth2Policy{eligible,reasonCode,proposalCount,firstProposalKey,policyVersion}` (`:971`); fetches are existing canary `expandFeatured(depth:2)` under canary caps, never gated by P3 outcome (`:934-977`). **Shadow-only. The P3 graph-depth-2 policy decision is shadow-only. Existing relationship-canary depth-2 traversal is not a P3 treatment and its traversal outcomes must not be attributed to P3 efficacy.** |
| P-A Site Profiler | `site-profiler-v1`, key `site_profiler_enabled` (`siteProfiler.ts:21-22`) | Read-only profile per site identity; never decides acquisition; bounded inventory fetches only | N/A (deterministic profiler) | Default-off (`'false'` read pattern per ladder/frontier analogues; profiler never in hot path) | `MAX_SITEMAP_INDEX_FILES=10`, `MAX_SITEMAP_URLS_ADMITTED=500`, `MAX_FEEDS_PER_SITE=2`, `MAX_FEED_ENTRIES=100`, `MAX_JSONLD_BLOCKS=20`, `ROBOTS_MAX_BYTES=524288`, `PROFILER_FETCH_TIMEOUT_MS=10000` | Fetch states `FETCHED/UNAVAILABLE_4XX/UNREACHABLE/RATE_LIMITED`; unknown never negative | Deterministic site profile record; **executable only when explicitly enabled; default path unchanged** |
| P-B Acquisition Ladder | `acquisition-ladder-v1`, key `acquisition_ladder_enabled` (`acquisitionLadder.ts:24-25`) | Cheapest-sufficient escalation; structured extraction per-response; sitemap/RSS yield nominations not evidence; rendered escalation delegates to established predicate | N/A (policy order) | Default `'false'` (`isAcquisitionLadderEnabled`) | `MAX_LADDER_SITEMAP_SEEDS=5`, `MAX_LADDER_STRUCTURED_URLS=10`, `MAX_LADDER_PROFILE_RUNS_PER_INSPECTION=3`; cost ranks `STRUCTURED 0, HTTP/SITEMAP/NAV 1, RENDERED 10, ALTERNATIVE 100` | Insufficiency logged with justification; rendered/alternative gated (concurrency-1/60s budgets; blockage-gated alternatives) | Ladder decision log + acquired response; **executable only when enabled** |
| P-C Frontier Manager | `frontier-manager-v1`, key `frontier_manager_enabled` (`frontierManager.ts:20-21,104`) | Per-site ordered navigation; stops on coverage/marginal-yield/budget/inaccessibility, never counts alone; deterministic logged decisions | N/A (deterministic scorer) | Default `'false'` | `MAX_FRONTIER_QUEUE_PER_SITE=50`, `MAX_FRONTIER_PAGES_PER_SITE=12`, `MAX_FRONTIER_DEPTH=2`; base weights `hint 1, depthPenalty 0.25, attemptPenalty 0.5, sitemapPrior 0.1, structuredPrior 0.1` | Hard caps bind regardless of yield; learned weights arrive only as versioned data (P-D), default base scorer | Frontier decisions + stop reasons; **executable only when enabled** |
| P-D Domain Memory | `domain-learner-v1` (`domainLearner.ts:25`); experiment key `domain_weight_experiment_enabled` (`:279`); benchmark access routes + observation attribution wired in #491 (`e2596bd`) | OFFLINE/BATCH ONLY, never hot path; snapshots DRAFT→APPROVED via explicit human approval; serving additionally flag-admitted; quorum-gated; decayed; exploration floor | N/A (offline weights as versioned data; content-hash version) | Default-off; approval required | `ROUTE_QUORUM_MIN_OBSERVATIONS=3`, `ROUTE_HALF_LIFE_MS=2592000000` (30d), `ROUTE_EXPLORATION_FLOOR_BPS=500` | Single observation never flips verdict; stale data decays; unapproved snapshots unconsumable | Approved weight snapshot (content-hash version) + consuming decision records version used; **no auto-promotion** |
| P-E LLM Assistance | `llm-assist-v1`, key `llm_assist_enabled` (`llmAssist.ts:25-26`) | Assist-only: 4 tasks (`PAGE_TYPE_REVIEW, LINK_INTERPRETATION, AMBIGUOUS_NAVIGATION, EVIDENCE_INTERPRETATION`); machine-validated; deterministic fallback | N/A | Default-off (gateway disabled → fallback) | `MAX_LLM_CALLS_PER_INSPECTION=3`, `MAX_LLM_INPUT_CHARS=8000` | Validator rejects invented URLs/evidence, missing confidence/rationale; budgets/task-allowlist/fallback apply | Validated decision or deterministic fallback + audit; **no live provider wired — gateway/budgets/audit/fallbacks are the complete surface** |
| Frontier/canary lifecycle | Allocator `discovery-frontier-allocator-v1`; trials gate `frontier_trials_enabled` (missing = disabled, `discoveryFrontierTrials.ts:84-96`); trial identity `trial:${dedup_key||proposal_id}`, idempotent INITIATED/COMPLETED check (`:268-291`) | Proposal must be PENDING; neighborhood safety; no active trial; quota headroom | Trial reservation atomic under savepoint `frontier_trial_init`, rollback-safe (`:222-247`) | Kill switch explicit enable required | Daily canary cap 500 (`:153,163`); quota bounds `1..100` (`103_frontier_trials_quota_constraints.sql`); funnel map `trial-funnel-map-v1` (`:465-512`) | Gate failure → ineligible reason; initiation failure → `trialLink={NOT_INITIATED,reason}`, scheduling proceeds (`dbCore.ts:2084-2086`) | `frontier_canary_trials` row + `frontier_allocation_decisions` consumption (`quota_consumed`, `COMMITTED`) |

P2-window shadow recommendation (`evaluateShadowRetrievalRecommendation`, `dbCore.ts:2112-2119`) is record-only and independent of P2 treatment.

## 4. Blocked mechanisms (honest treatment)

- P3 independent-family/overlap instrumentation: genuinely blocked — caller hard-codes `independentFamilies:0` (`relationshipCanary.ts:234-238`), so policy path always yields `GRAPH_INSUFFICIENT_INDEPENDENCE`; P3 treatment cannot be benchmarked beyond recording the ineligibility reason. Treatment: include as shadow-only arm; metric = eligibility rate + reason-code distribution, never traversal outcomes.
- Real P5 OSINT fetching: genuinely blocked — P5 adapter registry + gated runner wired, but stubs stay stubs with no fetch loop (`c66ebf3`); `external_osint_materialization_enabled` default `'false'` (migration `108_external_osint_proposal_sources.sql:28`); Brave OSINT provider exists (`braveSearch.ts:22-25`) but materialization path off. Treatment: shadow/gated path measurable only (registry resolution, gate decisions); no live-fetch arm.
- P6 mechanisms: no executable implementation found at base — missing external/data/legal prerequisites. Treatment: excluded from arms; listed here as blocked, not silently dropped for performance reasons.
- P-E provider execution: blocked — no approved provider/credential wired; gateway/budgets/audit/fallbacks complete surface only. Treatment: fallback-path audit only.
- P-D serving influence: blocked until human-approved snapshot + flag admission exist. Treatment: snapshot-production metrics only, no serving arm.

Rule observed: implemented + executable = specified above; blocked = documented here with treatment. No providers, credentials, data, labels, feeds, or observations fabricated.

## 5. Data / opportunity pool (frozen at execution, rules frozen now)

No frozen corpus/snapshot exists at preregistration time. Pool construction is frozen as a deterministic procedure; the snapshot itself must be recorded before the first benchmark observation:

- Source: `query_library` (schema `001_postgres_core.sql:71`) opportunities joined to `query_runs` (`005_continuous_discovery.sql:7`).
- Pool version identity: `pool = sha256(specVersion + engineCommit + SELECT … FROM query_library snapshot ordered by id + inclusion/exclusion rules below)`. Record pool hash + row count + collection timestamp in execution record.
- Inclusion: rows passing reservable filter (`collection!=='REJECTED'`, `reserved_until`/`next_eligible_at` null-or-past), cooldown/diversity/intent gates at snapshot time, authority-eligible (`STANDALONE/ANCHOR_ONLY` or scope-promoted pair), retrieval-oriented shape (`queryPlanner.ts:107-115`).
- Exclusion: `REJECTED`, reserved, `next_eligible_at` future, in-cooldown, primary-term-capped, most-recent-intent-only remainder, non-retrieval-oriented, stale policy version, unsupported-country scope.
- Dedup: observations keyed by `channelId` within run (`calculateQueryFunnel` distinct map); opportunities keyed by `benchmarkOpportunityId` (`benchmark-prereg-v1:q<queryId>`, recorded on every benchmark envelope and run metadata) mapping frozen pool rows 1:1 to scheduled opportunities across retries. Each scheduled attempt keeps its own recorded assignment draw (`determinism.opportunityKey/bucket/propensity`) and resulting run id: retries are new draws under the same opportunity identity, distinguished by run id. Never double-counted in denominators.
- Time boundaries: snapshot timestamp + `observed_at` window recorded; no favorable-year/query/source/period selection after results; no post-hoc pool modification.
- Tracking ledger (durable): `query_runs` rows (`query_id` = pool row, `metadata.selectionExperiment` = assignment + `benchmarkOpportunityId` + snapshot context) joined to the external execution record (pool snapshot hash, spec version, config hash). Pool rows with zero attributed runs after scope completion are coded exclusions classified by the gate that stopped them (cooldown, authority, reservation, provider-registry — see candidate diagnostics reason codes); they are reported, never silently dropped.

## 6. Assignment (frozen)

- Unit: eligible opportunity as identified by `opportunityKey` passed to the assignment function (selection and ordering dimensions assigned independently).
- Algorithm: `shaBucket(s) = parseInt(sha256(s).hexdigest[0:8],16) % 10000` (selection `querySelectionExperiments.ts:137-139`; ordering `retrievalExperiment.ts:114-117`).
- Selection: `bucket = shaBucket(f"{QUERY_SELECTION_EXPERIMENT_VERSION}:{experimentId}:{opportunityKey}")`; with frozen `experimentId=benchmark-prereg-v1-selection`, `treatmentBasisPoints=5000`, `enabledArms=['THOMPSON','CONTEXTUAL']`: `bucket>=5000 → CONTROL p=5000`; else `enabledArms[shaBucket(f"{VERSION}:{experimentId}:{opportunityKey}:arm") % 2]`, `p=2500` (`:305-330`).
- Ordering: `bucket = shaBucket(f"{RETRIEVAL_EXPERIMENT_VERSION}:{opportunityKey}")`; note the ordering construction embeds no experimentId (implemented as `VERSION:opportunityKey`); the frozen `experimentId=benchmark-prereg-v1-ordering` travels as the window `experimentId` attribution field, not as a hash input. With frozen `treatmentBasisPoints=5000`: `bucket<5000 → TREATMENT p=5000` else `CONTROL p=5000` (`retrievalExperiment.ts:114-143`).
- Assignment identity/version inputs (no separate salt field exists in the implementation): the hash is constructed directly from the experiment policy/version string, the experimentId where applicable (selection only), and the opportunityKey, exactly as written above. Frozen versions: `query-selection-experiment-v1` + `benchmark-prereg-v1-selection`; `retrieval-experiment-v1` (+ window `experimentId=benchmark-prereg-v1-ordering` as attribution). Same eligible input + same frozen inputs → same assignment (no `Math.random` on assignment paths).
- Arm probabilities: frozen by §3A (`5000` control / `2500`+`2500` selection treatments; `5000`/`5000` ordering); recorded per observation as `propensityBasisPoints`.
- Stratification: none implemented — explicitly none. Eligibility checks precede assignment; retries are new assignment draws under the same `benchmarkOpportunityId` (reservation/authority gates re-evaluated, draw recorded per attempt); duplicate observations deduped by channel/run keys; failed assignments (invalid request) → 400 with nothing scheduled; unavailable treatment (empty pool) → documented UCB1 fallback, `servedArm=CONTROL`.

## 7. Parameter table (from code/config — nothing tuned)

| Parameter | Frozen value | Source |
|---|---|---|
| UCB1 exploration constant | `0.8` hardcoded | `queryIntelligence.ts:368` |
| Exploration ratio | default `'0.4'`, clamp `[0.1,0.9]` | `queryIntelligence.ts:330` |
| Query cooldown minutes | default `'360'`, `max(1,…)` | `queryIntelligence.ts:328` |
| Primary-term max uses | default `'2'`, `max(1,…)` | `queryIntelligence.ts:329` |
| Thompson priors | `alpha0=1, beta0=1` | `allocationChallengers.ts:27,123-127`; `querySelectionExperiments.ts:162-164` |
| Contextual weights | `value 0.5, exploration 0.35, cost 0.1` | `allocationChallengers.ts:156-160` |
| Selection/ordering basis points | frozen: selection `5000` with arms `['THOMPSON','CONTEXTUAL']`; ordering `5000` (see §3A) | `querySelectionExperiments.ts:158-197`; assignment `retrievalExperiment.ts:114-143` |
| Trial maxQuota | `1..100`, default `100` | `querySelectionExperiments.ts:237-244`; re-validated `discoveryFrontierTrials.ts:296-308` |
| Trial pageDepth | `>=1`, default `1`; effective cap `min(1,…)` | same + `discoveryFrontierTrials.ts:335` |
| Daily canary cap | `500` units | `discoveryFrontierTrials.ts:153,163` |
| Video lane target | `70` | `retrievalLanes.ts:4-6`; default `discovery_video_lane_percent` (`dbCore.ts:1767-1768`) |
| Date-ordering video pct / recency floor | `'10'` / `'60'` | `dbCore.ts:1769-1770`; `searchOrdering.ts:23-25` |
| Quality creator threshold | `55` (`TRADING_CONFIRMED` + score) | `queryPerformance.ts:6-10` |
| Funnel→score weights | `0.30/0.25/0.20/0.15/0.10` | `queryPerformance.ts:90-96` |
| Promotion/rejection | `>=60 PROVEN`; `<25 && runs>=2 REJECTED` | `queryPerformance.ts:135-141` |
| P2 window format | RFC3339 full-datetime, both-bounds-undefined = control, empty range invalid | `retrievalExperiment.ts:31,49-62` |
| P3 | depth ≤2, fanout ≤10, seeds ≤10, depth2-parents ≤5, channels/run ≤150, earmark 305 | `graphExpansionPolicy.ts`, `relationshipCanary.ts:31-48` |
| P-A | sitemap index 10, urls 500, feeds 2×100, jsonld 20, robots 524288 B, timeout 10000 ms | `siteProfiler.ts:27-36` |
| P-B | sitemap seeds 5, structured urls 10, profile runs 3; cost ranks 0/1/10/100 | `acquisitionLadder.ts:29-56` |
| P-C | queue 50/site, pages 12/site, depth 2; weights hint 1, depthPenalty 0.25, attemptPenalty 0.5, priors 0.1/0.1 | `frontierManager.ts:25-52` |
| P-D | quorum 3, half-life 30d (2592000000 ms), floor 500 bps | `domainLearner.ts:29-31` |
| P-E | 3 calls/inspection, 8000 input chars; 4 tasks allowlisted | `llmAssist.ts:32-45` |
| Reservation | `reserved_until = now()+20min` | `dbCore.ts:1852-1866` |
| Pagination | max pages `'3'`, low-yield pages `'2'` | `queueManager.ts:691-702` |
| Per-key daily quota / autonomous share | `'10000'` / default `70` (`[1,100]`) | `dbCore.ts:651`; `autonomousDiscovery.ts:100-108` |
| Retrieval quota units | 100 per autonomous page | `queueManager.ts:615-618` |

Anything not listed here and not defined in code/config is documented as not defined — no value invented.

## 8. Outcomes and metrics (frozen, from repo measurement)

- Primary outcome: per-observation quality yield — `qualityChannels / evaluated`, where quality = `isQualityCreator` (`TRADING_CONFIRMED` and score ≥ 55), evaluated = `nonTrading+uncertain+needsReview+tradingConfirmed` (`queryPerformance.ts`). Reported at query-run level via `calculateQueryFunnel`, mapped to trial metrics (`relevantNewCreators=tradingConfirmed`, `qualityNewCreators=qualityChannels`, `TRIAL_FUNNEL_MAP_VERSION`, `discoveryFrontierTrials.ts:465-512`).
- Secondary: `performanceScore` composite + components (tradingPrecision, noveltyRatio, qualityYield, countryPrecision, communityYield); `distinctResults/newChannels/inScopeNewChannels/communitiesDiscovered`; retrieval/order measures (lane/ordering attribution, window-applied rate); cost/quota (`quotaConsumed`, provider units, trial `quota_reserved/consumed`); resource (pagination depth, duration); terminology yield (`terminology_performance`, scope-weighted); P3/P5/P-D/P-E shadow metrics (eligibility + reason codes only — P3 measured over the attempt-log `graphDepth2Decisions` set covering every evaluated depth-2 target, including targets returning no channels or admitted nothing).
- Success/failure: run `COMPLETED` with persisted funnel vs `FAILED`/rejected/skipped per `completeQueryRun`/`completeCanaryTrial` states; quality per `QUALITY_CREATOR_SCORE_THRESHOLD`.
- Attribution: `query_run_accounting_attributions(query_run_id, 'query-run-accounting-v1')` — inserted for COMPLETED runs (`completeQueryRun`) and for terminally FAILED runs (`failQueryRun`: zero-funnel row with `failureKind`, quality 0, `ON CONFLICT DO NOTHING`); `query_library` aggregates; `query_execution_logs`; `terminology_performance` keyed by lane/ordering; frontier consumption on `COMMITTED` decisions; trial metrics via funnel map. Denominators: distinct channels per run for funnel ratios; eligible attributed observations (completed + terminal-failed rows) per arm for comparisons — a provider/network/quota failure is attributable to its assigned arm and counts as a failed (quality-0) observation, never silently dropped.
- Missing/failed/partial: missing outcomes excluded from numerators and denominators with reason recorded; failed runs counted in arm denominators as failures unless §11 exclusion applies; partial observations (e.g., capped pagination) measured as-is with caps recorded; no metric chosen after results.

## 9. Sample size / minimum observation rules

No benchmark-N power contract exists in the repository — this is stated explicitly rather than invented. Preregistered reporting guards (not statistical claims):

- Minimum 30 eligible attributed observations per reported arm; arms below minimum reported as `INSUFFICIENT_SAMPLE — no comparison`.
- Relevant strata (lane/video-channel, ordering) reported only with ≥10 observations; otherwise pooled only.
- Treatment/control balance reported (assigned counts + propensity sums); imbalance investigated as assignment/execution bug, not adjusted post hoc.
- Minimum valid-attribution count = observations with a persisted `query_run_accounting_attributions` row (completed or terminal-failed); unattributed observations invalid.
- Insufficient/incomplete runs: reported with denominators; no claim made from them.

## 10. Stopping rules (frozen scope — no later execution approval may change the boundary)

- Frozen benchmark scope: the first 300 eligible opportunities in pool-snapshot id-ascending order. Rationale (methodological, not performance-based): 10× the §9 minimum reporting guard per arm (30/arm × 3 selection arms = 90 minimum; 300 provides headroom for deterministic exclusions while keeping all arms above minimum). No favorable-duration or favorable-sample choice is possible after this point.
- Wall-clock ceiling: 14 days from the first benchmark observation. Quota ceiling: existing coded caps/quotas only (§7); no additional quota is allocated for the benchmark.
- Minimum completion: all 300 assigned opportunities either observed (attributed per §8) or deterministically excluded per §11.
- Maximum boundary: reaching 300 assigned opportunities, the 14-day ceiling, or any quota-cap exhaustion stops intake; already-assigned observations complete.
- Failure/abort: infra failure, kill-switch engagement, or mechanism unavailability → stop intake, record cause, already-completed observations stand, partial run marked `INCOMPLETE` and no claim made.
- No stopping on favorable/unfavorable interim results. No interim efficacy looks are defined.

## 11. Failure / exclusion handling (deterministic, pre-defined)

| Event | Frozen handling |
|---|---|
| Invalid experiment request | Route 400, nothing scheduled |
| Empty treatment pool | UCB1 fallback, `servedArm=CONTROL`, reason recorded |
| Invalid window | Execution unwindowed (`resolveExecutionSearchWindow→null`), control attribution |
| Trial initiation failure | `NOT_INITIATED`, scheduling proceeds |
| Provider failure/timeout/quota/network/malformed | Run `FAILED` with classified code; counts in arm denominator; quota settled (`finishQuotaReservation(false)`); no silent retry beyond coded policy |
| Missing evidence | Funnel zeros for that channel; run still attributed |
| Duplicate observations | Dedup by channel/run keys; counted once |
| Assignment failure | Nothing scheduled; not an observation |
| Partial crawl (caps) | Measured as-is with cap fields recorded |
| Unavailable experimental prerequisite | Corresponding arm observations excluded by rule with reason (e.g., `GRAPH_INSUFFICIENT_INDEPENDENCE`); reported as blocked-rate, not dropped silently |
| Infrastructure incident | §10 abort path |

No post-outcome discarding. Every exclusion carries its coded reason.

## 12. Provenance (traceability + gaps)

Required per observation: spec version (`benchmark-preregistration-v1`), engine commit (`4b49e0c…`), mechanism versions (§1 table), assignment identity (`experimentId`, `bucket`, `armPickBucket`, `propensityBasisPoints`, `policyVersion`), `benchmarkOpportunityId` (`benchmark-prereg-v1:q<queryId>`), arm identity (`CONTROL/THOMPSON/CONTEXTUAL`, ordering `CONTROL/TREATMENT`), propensity, opportunity identity (`opportunityKey`, query/country/run ids), source/evidence provenance (funnel observations, provider allocation snapshot), provider/version where applicable, configuration hash, run/query ids.

Persisted today: `query_runs` (+`provider_allocation_snapshot`, `performance_details`, quota fields), `query_run_accounting_attributions`, `query_library` aggregates, `query_execution_logs`, `terminology_performance`, `frontier_canary_trials`, `frontier_allocation_decisions`, `external_osint_observations`/`_attribution` (tables exist, materialization off), `creator_action_shadow_*`, corpus/rollout decision/event tables, job payloads (`selectionExperiment/trial/searchWindow`).

Gaps identified (not invented around): no dedicated `benchmark_spec_version` / `pool_snapshot_hash` columns — these must be recorded in the external execution record and joined by run ids; no separate assignment-salt column exists in the implementation (assignment identity/version inputs = policy version + experimentId where applicable + opportunityKey, recorded in the execution record); pool snapshot itself must be exported and hashed at execution. If a future audit needs first-class columns, that is a separate schema change — out of scope for this preregistration.

## 13. Analysis rules (frozen)

- Primary comparison: each executable treatment arm vs UCB1 control on primary outcome (quality yield), at query-run aggregation, with arm denominators = eligible attributed observations and propensities reported.
- Secondary comparisons: same structure for secondary metrics; P2 ordering arm compared on retrieval/window measures + funnel outcomes; shadow mechanisms summarized descriptively (rates + reason codes), never as efficacy claims.
- No post-hoc method selection: descriptive arm rates with denominators + propensity sums; any interval/statistical method must be the one contractually required by the repo — none is, so none is claimed here. A future approved analysis addendum may specify one before execution without touching this spec's outcomes.
- Repeated observations: same opportunity re-eligible only via gates; each attributed run is one observation; channel-level dedup within run.
- Missing/invalid: per §8/§11; multiple-arm comparisons reported arm-by-arm against control; no ranking claim without pre-committed multiplicity rule (none here). Interpretation boundary: benchmark can only support claims about arms, pool, and period actually run.

## 14. Production safety

- UCB1 remains the production control. Experimental mechanisms stay non-authoritative until benchmark completion + evaluation.
- No global feature gate enabled for this specification. All experimental defaults remain OFF/false/0. Kill switches (`frontier_trials_enabled` missing=false, `relationship_canary_kill_switch` default true, per-arm basis-0 CONTROL) and quotas/caps (§7) remain intact.
- Benchmark preparation changed no production allocation/scoring behavior (docs-only change; see §18).

## 15. Reproducibility contract

A result is reproducible from: engine commit `4b49e0c01ac53eebf0080fae29bd6aaabb803cfc` + spec `benchmark-preregistration-v1` + mechanism versions (§1) + frozen pool snapshot hash (record at execution) + assignment versions + frozen experimentIds and basis points (§3A) + configuration hash + provider versions + provenance records (§12).

Missing pieces today (filled deterministically at execution, not chosen then): pool snapshot export + hash; config-hash dump; provider registry snapshot. The experimentIds, basis points, arms, priors, weights, and window rule are already frozen in §3A — they are not execution-time choices. No result may be declared reproducible without the execution-record items.

## 16. Required file

This document: `docs/BENCHMARK_PREREGISTRATION.md` (new file). Historical benchmark documents were not modified to agree with it. Mechanism classes distinguished per §3: (1) request-level randomized (Thompson, Contextual, P2 ordering) with frozen identity in §3A; (2) feature-gated deterministic (P-A, P-B, P-C; off during benchmark); (3) approval + feature-gated (P-D serving; no arm); (4) shadow-only (P3 policy evaluation, P2 shadow recommendation, P5 registry/gates, P-E gateway/fallbacks, P-D snapshot production); (5) genuinely blocked (§4); plus control (§2 UCB1).

## 17. Validation before freezing (no benchmark run)

- Inspected merged main at base commit; verified every parameter/version/gate/assignment/attribution field against cited code lines.
- Verified no benchmark executed: no pool snapshot, no execution record, no observations collected under this spec. ExperimentIds/basis-points/arms/window/scope in §3A/§10 are spec-frozen values (part of `benchmark-preregistration-v1`), not execution-time choices.
- Specification-consistency checks run (unit/contract tests only, not the benchmark):
  - `node --import tsx --test server/querySelectionExperiments.test.ts`
  - `node --import tsx --test server/retrievalExperiment.test.ts`
  - `node --import tsx --test server/discoveryFrontierTrials.test.ts`
  - `node --import tsx --test server/relationshipCanary.test.ts`
  - `node --import tsx --test server/benchmarkPreregFindings.contract.test.ts`
  - `npx tsc --noEmit` (full-project typecheck)
- Confirmed no production mechanism enabled or tuned (docs-only diff; `git status` shows only this file).

## 18. Git workflow

- Branch: `docs/frozen-benchmark-preregistration` from `4b49e0c` (pushed, PR opened, NOT merged).
- Commit: this preregistration document only.
- No production code modified. No discovered defect blocking factual preregistration (if one appears in review, it will be reported as a blocker, not scope-expanded here).
