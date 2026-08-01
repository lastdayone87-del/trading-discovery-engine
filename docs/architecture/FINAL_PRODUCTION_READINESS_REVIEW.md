# Final production-readiness review

**Review date:** 2026-08-01  
**Scope:** current repository head, production server/UI, migrations 001–042, and all approved architecture records.

## Decision

The checked-in architecture is implementation-complete for the approved dependency-ordered program and is suitable for a governed production rollout. “Complete” does not mean every default-off research control should be activated: publication, adaptation, experiments, playlist acquisition, and learned-model paths intentionally remain behind approval, sampling, budget, canary, and rollback gates. Representative calibration, provider observations, deployment rehearsal, backup/restore proof, and policy tuning are operational/data-driven release activities rather than missing application architecture.

This review supersedes the 2026-07-29 readiness snapshot where later migrations and controls conflict with its historical findings. In particular, `/api` now has a fail-closed operator authorization boundary, PostgreSQL filtering/pagination and readiness were corrected, provider deadlines and metrics exist, and phases 16–21 implement the post-roadmap control planes.

## End-to-end implementation map

| Program | Production implementation | Durable schema / verification |
| --- | --- | --- |
| Core discovery and recovery | PostgreSQL jobs, quota reservation, scheduler, manual sessions, enrichment, retries and cooldown | 001–017; queue, quota, scheduler, provider-resilience tests |
| Classification and replay | staged evidence, explicit abstention, immutable decisions, validation and replay | 018–019, 036–037; multilingual, false-negative, decision-evaluation tests |
| Research and coverage | passive ledger, restart-safe pilot, uncertainty-aware coverage, immutable corpus and scoring | 020–024; pilot, coverage, corpus and scoring tests |
| Governed knowledge | concept graph, offline catalogs, randomized trials, publication and rollback | 025–028, 035; graph, catalog, trial and knowledge-plane tests |
| Evidence acquisition and allocation | source-independent evidence graph, playlist canary and best-first portfolio | 029–031; evidence graph and portfolio tests |
| Adaptive and operational control | shadow classifier, dashboards, execution traces, diagnostics and authorization | 032–034, 036; shadow, dashboard, trace and auth tests |
| Post-roadmap evolution | evaluation, VOI, resumable investigations, entity resolution, temporal frontier and governed adaptation | 037–042; dedicated tests for every phase |

All migrations are forward-only and additive by design. Default-off or proposal-only states are safety properties, not orphaned features: mutable observations cannot directly alter terminal classification or serving publications. Promotion requires immutable evidence, explicit authorization, replay/evaluation gates, bounded rollout, and rollback.

## Country architecture

`SUPPORTED_PRODUCTION_COUNTRIES`, derived from the persisted vocabulary seed, is the authoritative registry. A production startup invariant compares that registry with query atoms, deterministic classification, country knowledge, language packs, and ISO canonicalization and fails startup on missing, extra, duplicate, or incomplete registration. The nineteen countries therefore enter the generic country-keyed query performance, benchmark, coverage, evaluation, terminology, portfolio, adaptation, rollout, and replay systems without per-country duplicate pipelines.

Multilingual countries load all deterministic language packs rather than only a primary-language fallback. Arabic is supported for the United Arab Emirates; English, Mandarin Chinese, and Malay are supported for Singapore; German/French/Italian for Switzerland; Dutch/French/German for Belgium; French/German for Luxembourg; and English/French for Canada. Script policy admits Arabic and Singapore Han queries but rejects cross-market Japanese kana.

## YouTube provider pool

`YOUTUBE_API_KEY_POOL_SIZE` is the sole pool-size control. The default is 30 for backward-compatible production configuration; any positive configured size generates the ordered base key plus indexed key names. Rotation, deduplication, quota capacity, cooldown, request scheduling, circuit breaking, health, and failover consume the resolved key array and contain no production cardinality assumption. Numeric tens in calibration bins or bounded test fixtures are unrelated to provider capacity.

## Architectural recommendation disposition

The Principal Architecture Review and Final Evolution Review recommendations are implemented through phases 16–21 in dependency order. Recommendations explicitly marked “implement later” were subsequently implemented as governed control planes, while recommendations marked “do not build” or “no-go” remain intentionally absent. Compatibility stores and fallback paths remain only where the approved reviews require rollback and historical replay; removing them before production evidence and migration acceptance would violate those recommendations.

Priority 2 calibration remains deliberately conservative until representative time-split reviewed data exists. This is an intentional non-probabilistic/abstaining safety boundary. Fitting or activating a model without that external evidence would contradict the roadmap acceptance criteria. The remaining work is consequently operational rehearsal, representative data collection, calibration fitting, policy approval, and measured rollout—not unfinished repository architecture.

## Verification boundary

Repository verification consists of the complete deterministic test suite, TypeScript lint/type checking, production bundling, migration manifest tests, static diff checks, registration invariants, and clean Git state. A live migration, provider call, restart exercise, and backup restore require deployment credentials and infrastructure and must remain deployment release gates; they cannot be truthfully certified by an offline repository run.
