# Full-System Read-Only Investigation: what this system is, where it stops, and the single highest-leverage improvement

> REPORT / FORENSIC ONLY. No implementation. No behavior changes. No production/database/variable/infrastructure/job/worker/dashboard changes. Branch contains this document only.
> Investigation date: 2026-09-04. HEAD investigated: `origin/main` at PR #438 merge (`dabe894`). Method: first-principles code reading (no prior-issue scoping), assisted by four bounded read-only exploration passes; every load-bearing claim re-verified first-hand against cited files. Proven vs inferred is marked throughout.

## Executive summary

This is a **YouTube-first trading-creator OSINT pipeline**: it discovers candidate channels (mostly via keyword search), enriches them (metadata, video descriptions, About pages, rendered websites, Discord validation), classifies them (trading relevance, creator country, Discord community), persists verdicts, and retries failures — with human review as the authoritative gate. It is a well-instrumented, recall-cautious **verification machine** sitting on top of a **narrow discovery funnel**.

**Verdict: A — HIGH-IMPACT IMPROVEMENT FOUND** (bounded, measured activation; see §9).

The single highest-leverage improvement: **activate relationship-driven discovery using the evidence-graph machinery the repository already contains but leaves dormant** — featured-channel / playlist / cross-creator pivots with metadata hydration and provenance-aware admission — so the system can discover *unknown* creators who carry no obvious keywords, instead of only re-finding creators its keyword list already describes. Mechanism blockage is **proven** from code; yield magnitude needs one bounded production measurement (specified in §9.9).

## 1. System map (as built)

```
INPUT SURFACES                         RETRIEVAL                    ADMISSION
YouTube keyword search (autonomous,    query planner (≤3 tokens,    nomination ledger (dedupe)
 5-min cycle, batch 5, 70% quota)      ≤40 chars, ~19 countries) →  → keyword triage GATE
Brave external search (canary-gated)    → SEARCH_YOUTUBE jobs      (name+matched-doc only)
Playlists / featured channels           → extract channels         → ingestion gates:
Manual operator search                    (nomination records)        country → audience → trading → Discord
Research/frontier proposals (mostly off)
        │                                    │                            │
        ▼                                    ▼                            ▼
ENRICHMENT / INSPECTION              ATTRIBUTION / CLASSIFICATION     PERSISTENCE / OPS
YouTube metadata, video descs,         country P1–P10 + exclusion     channels row (flat verdicts)
live About scrape, static + rendered   trading evidence engine +      + diagnostics tables (rich)
website crawl, Discord invite lookup   Gemini semantic provider       jobs/retries/recovery workers
+ Discord validation (liveness/        Discord ownership/validation   human review (authoritative)
relevance)                             → CONFIRMED/LIKELY/UNCERTAIN
```

**Tempo:** autonomous cycle every 5 min (`autonomousDiscovery.ts:91-99,515-538`), batch 5, target queue depth 15; in-process worker pools (search/manual/enrich, default concurrency 1 each — `queueManager.ts:1436-1438`); one Playwright-backed monolith (`Dockerfile`, `browserCommunityFallback.ts:315` maxConcurrency 1). No separate worker tier; durability = Postgres jobs/query_runs + claim/lease.

**Where information goes (first-principles ledger):**
- *Created:* provider payloads (YouTube/Brave), page HTML, Discord API responses, LLM judgments.
- *Transformed:* raw → nominations → triage verdicts → evidence items → staged decisions → flat channel statuses.
- *Enriched:* About hydration, video descriptions, rendered DOM, public Discord evidence ladder.
- *Discarded (early):* triaged-out candidates (`persisted:false`, ledger only — `ingestionPipeline.ts:192`); alternate Discord locators without native codes; sub-threshold signals.
- *Persisted richly:* `production_classification_diagnostics`, `external_acquisition_observations`, inspection trails, review history.
- *Persisted lossily:* `channels` row keeps verdicts, not evidence (no `EvidenceItem[]`, random nondeterministic IDs — `evidenceEngine` providers).
- *Re-used:* learned vocabulary → future queries (governed, slow); nominations dedupe; recovery events (idempotent).
- *Retried:* community acquisition (attempt-free generous loop), provider-transient jobs (6h ceiling), Discord validation (RETRY_PENDING).
- *Lost:* per-URL evidence on collapse (by design, audited); shadow intelligence (never serving); autonomous query-performance updates (`persist:false` — `queueManager.ts:600`).
- *Contradicted:* hype/adjacent negatives withheld from terminal rejection by design; mixed-evidence conflicts → UNCERTAIN/NEEDS_REVIEW (safe direction).
- *Incorrectly trusted (fixed in PR #438):* trail-prose-as-bio, acronym substrings, single-failure-equals-unavailable. Not re-litigated here.

## 2. Everything inspected (inventory)

Entry/etcd: `package.json`, `server.ts` (routes), `Dockerfile`, `railway.json`, `nixpacks.toml`, `src/` (App, ResultsTable, review flows), `src/types/index.ts`, `src/data/initial_countries.ts`, `tests/`, `docs/`, 127 migrations, 67 CI workflows. Server (388 entries), first-hand: `autonomousDiscovery.ts`, `queryPlanner.ts`, `queryIntelligence.ts` (selection), `youtube.ts` (extract/nomination), `candidateTriage.ts`, `candidateAdmission/*`, `featuredChannelAdapterWorker.ts`, `playlistAdapterWorker.ts`, `featuredChannelAdapter.ts`, `ingestionPipeline.ts` (gates), `inspector.ts` (Step 4–6), `browserCommunityFallback.ts`, `crawlerTelemetry.ts`, `communitySurfacePolicy.ts`, `communityRetryPolicy.ts`, `queueManager.ts` (jobs/workers), `operationalMaintenanceWorkers.ts`, `communityRecovery.ts`, `countryBoundaryRecovery.ts`, `countryInference.ts`, `countryValidator.ts`, `evidenceEngine/` (providers, stagedClassification, scoringEngine, decisionPolicy, canonicalEvidencePlane, documentTypes), `discordCandidates.ts`, `discordProjection.ts`, `discordValidator.ts`, `discordOwnershipSelection.ts`, `db.ts`, `dbCore.ts`, `candidateCorpus.ts`, `conceptGraph.ts`, `terminologyIntelligence.ts`, `discoveryFrontierAllocator.ts`, `persistentResearch*.ts`, `organicQueryExpansion.ts`, `reviewStore.ts`, `operatorAuth.ts`, plus test-marker spot checks. Four read-only subagent passes covered discovery/autonomy/evidence/frontend-ops in parallel; load-bearing claims re-verified by hand (cited inline).

## 3. Proven bugs (demonstrated incorrect behavior)

**PB-1. Discovery triage structurally blinds unknown creators — PROVEN, high impact.** `triageAutonomousSearchCandidate` decides on `channelName + matchedDocument.title/description` only (`candidateTriage.ts:91-95`); without high-specificity signals or ≥2 market families, generic creators are withheld (`:155-159` `NO_EXPLICIT_TRADING_SIGNAL_IN_RETRIEVAL_DOCUMENT`). VIDEO-lane descriptions are deliberately blanked (`youtube.ts:438`), so nothing compensates. A creator with no keywords in name/titles is *unadmittable by construction*, regardless of downstream classifier quality.
**PB-2. Relationship adapters are neutered three times over — PROVEN, high impact.** Featured/playlist machinery exists with real graph writes (`evidence_nodes`, visits with depth + attribution path — `featuredChannelAdapterWorker.ts`), but: (a) canary-gated to near-zero by default (adapter controls, 1% quota, `autonomousDiscovery.ts:237` OSINT default-off, migration `079*` SHADOW/paused); (b) depth-one, explicitly no recursion/follow (`featuredChannelAdapter.ts:18,95`, worker docstring); (c) ingested raws carry empty description/titles/channelName=ID, so they re-hit the PB-1 keyword firewall (`featuredChannelAdapterWorker.ts:13`, `playlistAdapterWorker.ts:13` → `ingest(..., 'automated_query')`). Three independent kill points; fixing any one alone changes nothing.
**PB-3. No online learning — PROVEN, high impact.** Autonomous completions call `evaluateQueryPerformance(..., {persist:false})` (`queueManager.ts:600`); performance ordering (`dbCore.ts:653`) never updates from autonomous runs. All "intelligence" (terminology lifecycle, concept graph, corpus, dual-write, evaluation) is `servingAuthority:false` / shadow / dual-read. The system provably does not improve with experience; vocabulary promotion needs 3 creators + 2 communities + executions plus human-approved quality≥55 (`terminologyIntelligence.ts:50`, `ingestionPipeline.ts:702`, manual excluded).
**PB-4. Strict-priority starvation without aging — PROVEN, operational.** Claim order `priority DESC` (`dbCore.ts:741`): manual 200/100 and auto 20 starve recovery/country/investigation at 10 indefinitely. No aging/boost mechanism found.
**PB-5. Unbounded attempt-free defer loop — PROVEN, operational.** Attempt-free decrement (`dbCore.ts:797`, `db.ts:49`) + 5h `created_at` renewal dodging the 6h transient ceiling (`communityRecovery.ts:75,306-359`) + FAILED reopen = capacity-failure retries that can never terminate, by design.
**PB-6. Small proven defects:** duplicate `failJob` implementations diverging (`db.ts:25-59` vs `dbCore.ts:797`); dead reviewer-auth layer vs live UI tokens (`server.ts:145-150`, `ResultsTable.tsx:80-82`); `nixpacks.toml` duplicates an unexecuted Playwright install (Railway uses Dockerfile); dashboard rewrites queue JSON in-browser (`apiClient.ts:86-91`); root junk-drawer repair scripts; `requireReviewer` pass-through.

## 4. Proven weaknesses (works as designed, demonstrably limiting)

**PW-1. Query-shape straitjacket.** Retrieval queries capped at ≤3 tokens/≤40 chars (`queryPlanner.ts:90-100`), curated atoms for ~19 countries, `maxUses=2` + 360m cooldowns + diversity guards. Long-tail, multilingual-natural, and multi-hop information needs cannot be expressed; recall ceiling is structural, not budgetary.
**PW-2. Lossy persisted belief.** `channels` keeps verdicts; replay needs diagnostics tables + nondeterministic IDs. Explanations exist in trails but re-computation isn't reproducible.
**PW-3. Single-process browser bottleneck.** Playwright maxConcurrency 1, capability-gate claim exclusion (`queueManager.ts:207-208`), full browser image in the web process. Rendered coverage scales with wall-clock, not workers.
**PW-4. LLM-per-enrichment coupling.** Every `ENRICH_CHANNEL` includes Gemini with a global cooldown gate (`queueManager.ts:183-186`); provider pressure pauses enrichment fleet-wide.

## 5. Likely issues (strong signal, needs production evidence)

- **Negative-evidence starvation is deliberate** (`stagedClassification.ts:37-39,103-109`: hype/adjacent can never REJECT; short-bio unrelated stays UNCERTAIN). Whether this costs more in review-queue load than it saves in false negatives needs sampled review outcomes. NOT a bug finding.
- **Bare-token inflation is guarded, not open:** repeated-independence bypass needs confidence≥70 + weight≥18 + 3 independent families (`stagedClassification.ts:78-79,92-99`); card/game usages explicitly excluded (`VideoMetadataProvider.ts`). Downgraded from "bug" to watch-item; needs precision sampling, not a rewrite.
- **Legacy reconciler PARTIAL-blindness** (known residual from PR #438): pre-v2 jobs read `ACQUISITION_FAILED` only; live v2 path carries partial ownership. Needs a production case to justify touching.
- **Common-cause Step-4 failures** (saturation/session/egress vs 15 independent target outages): mechanism exists; per-trail proof needs `acquisitionOutcomes` rows (previously established as inaccessible here).

## 6. Speculative opportunities (explicitly not proven)

Cross-platform identity resolution, video-transcript evidence, podcast/article OSINT ingestion, embedding-based candidate similarity, LLM adjudication expansion, separate worker tier, quota-market scheduling. None recommended: each is either unproven against a real measured gap or subsumed by §9's bounded approach.

## 7. Discovery / unknown-creator OSINT findings (the brief's core)

Answering the brief's questions directly from code: a never-seen creator with no keywords, generic titles, and a Discord behind Linktree/a secondary profile is today **undiscoverable** — triage withholds pre-enrichment (PB-1), relationship paths are gated off (PB-2), queries can't express the need (PW-1), and nothing learns from near-misses (PB-3). Weak clues cannot accumulate: withheld candidates persist `persisted:false` in a ledger nobody reads for discovery; confidence never builds across runs. SEO/affiliate networks are handled only as keyword hard-domain blocks, not as graph structures — so the system also can't *distinguish* genuine independents from networks structurally. High-quality non-SEO creators are the exact class the funnel drops first. Conversely, anything the system *can* find, it verifies thoroughly — the imbalance is discovery:verification ≈ 1:10 in engineering investment.

## 8. Autonomous-system findings

It processes a queue; it does not get better. All improvement machinery is shadow or governed-to-immobility (PB-3). Error compounding exists in one place (PB-5 defer loop) and error *hiding* in others (ExcludedCountryError completes jobs silently — `queueManager.ts:637-643`; crash-mid-page replays). Recovery coverage has holes (orphan `ENRICHMENT_PENDING` without investigation enabled; `RECONCILIATION_REQUIRED` never claimed). These are real but secondary: fixing them makes the same narrow funnel run smoother without widening what it can find.

## 9. Ranked candidates (Impact | Confidence | Evidence | Scope)

| # | Candidate | I | C | Note |
|---|---|---|---|---|---|
| 1 | Activate relationship-driven discovery on existing graph machinery (§10) | H | H(mech)/M(yield) | Only capability-frontier expansion; no new tech |
| 2 | Close the online learning loop (persist performance, promote validated shadows) | H | M | High feedback-contamination risk; needs careful design |
| 3 | Priority aging + bounded deferral (starvation/loop fixes) | M | H | Operational, narrow |
| 4 | Lossless persisted evidence + deterministic replay IDs | M | H | Auditability, moderate work |
| 5 | Rendered concurrency/worker separation | M | M | Cost/scale, infra-adjacent |

## 10. The single highest-leverage recommendation

**Activate relationship-driven unknown-creator discovery on the dormant evidence graph — as a bounded, measured canary, not a rewrite.**

1. **What:** Enable featured-channel (depth-2, entity-bound) and playlist expansion behind the existing canary controls, hydrate relationship-sourced candidates with the *already-existing* channel-metadata path (the same `channels.list` hydration used for the country fallback — no new acquisition), and admit them on *relationship + one corroborating signal* (or a bounded enrichment pass) instead of pure keyword match. Every graph edge keeps its existing provenance (`evidence_nodes`, visits, attribution paths).
2. **Why it matters:** it is the only candidate that finds creators the system structurally cannot see today (PB-1×PB-2), converting the pipeline's best asset (verification depth) from overkill-on-known to discovery-of-unknown.
3. **Repository evidence:** `featuredChannelAdapterWorker.ts` (graph writes + canary wall + empty ingest), `featuredChannelAdapter.ts:18,95` (no recursion), `playlistAdapterWorker.ts:9-13`, `candidateTriage.ts:91-159` + `youtube.ts:438` (keyword firewall + blank VIDEO context), `autonomousDiscovery.ts:237` + `079*` (defaults off), `ingestionPipeline.ts:241` (existing metadata hydration to reuse), `terminologyIntelligence.ts:50`/`ingestionPipeline.ts:702` (learning latency proving keywords can't bootstrap themselves).
4. **Flow touched:** frontier action → adapter job → nomination with relationship provenance → hydrated ingest → provenance-aware triage → existing gates unchanged → existing review. Nothing downstream changes.
5. **Why it beats alternatives:** #2 risks feedback contamination and needs redesign; #3–#5 optimize the existing funnel without widening it; §6 items are cosmetic. Only #1 moves the recall frontier, reuses built machinery (no graph/embedding/LLM fashion — explicitly not recommended), and is kill-switchable via controls that already exist.
6. **Expected benefit:** a new, measurable stream of TRADING_CONFIRMED creators unreachable by keyword search; reduced unknown-creator false-negative rate; relationship context (featured-by-X) *improves* precision vs cold keyword hits.
7. **Risks/regressions:** graph drift into networks (mitigate: depth cap + entity binding + per-source fanout caps already in code); quota burn (mitigate: existing 1% canary quota + caps); triage bypass inflation (mitigate: relationship never suffices alone — require corroboration or enrichment pass); review-queue load (mitigate: bounded cohort + sampling).
8. **Measurement (objective):** canary cohort vs keyword cohort over fixed quota: TRADING_CONFIRMED per 100 candidates, quota units per confirm, review-sampled precision, % confirms with zero keyword signals (the target class). Pre-register thresholds; auto-pause on breach via existing kill switches.
9. **Production evidence required:** one bounded canary run as designed (no prior data needed to start); plus a one-time ledger sample: re-examine WITHHELD `NO_EXPLICIT_TRADING_SIGNAL` nominations against known-good creators to size the missed class.
10. **Implementation scope (if authorized):** adapter control defaults for a named canary cohort only; depth-2 featured traversal with existing bindings; playlist video-title context carried into `matchedDocument`; hydration reuse for graph-sourced raws; triage relationship-signal rule (bounded); cohort metrics + dashboard sampling (read-only additions). Estimated: small — wiring and gates, no new services, crawlers, models, or schema redesign.
11. **Explicitly NOT changed:** keyword path, P2/country logic, exclusion authority, Discord validation, dashboard behavior, recall-reducing filters, any Fashionable Tech (no new KG/embeddings/agents/LLMs), production defaults outside the named canary.

## 11. What should NOT be changed (regardless)

Keyword discovery, country exclusion authority, Discord validation strictness, retry-ownership model, `RETRY_PENDING` semantics, dashboard representation, human-review authority, idempotency/lease mechanics, the shadow-governance pattern itself.

## Verdict: A — HIGH-IMPACT IMPROVEMENT FOUND

Confidence: **high** that the blockage is real and the machinery exists; **medium** on exact yield magnitude (hence bounded canary with pre-registered metrics, not a full rollout). The fundamentally better version of this system is already 80% built inside it — it just isn't switched on or connected to admission.
