# Release 4: dashboard corpus separation and review eligibility v2

## Scope and authority

Release 4 implements roadmap Phase 6 and Phase 7 only. Phase 6 creates a replayable projection separating discovery candidates, active investigations, review candidates, confirmed channels, and withheld channels. Phase 7 records whether an unresolved case is appropriate for human judgment. Both planes are observational, default `OFF`, and database-constrained to `serving_authority=false`. The legacy dashboard predicate and durable `channel_reviews` queue remain authoritative.

## Phase 6 classification

The corpus projector consumes admission states rather than reinterpreting semantic evidence. Confirmed and review admission states map to distinct corpora; active investigations remain outside review; policy, operational, and terminal-negative states are withheld. Immutable decisions/events are the replay authority and the current projection is repairable. Read, verify, and governed repair APIs expose the projection without changing existing dashboard APIs.

## Phase 7 eligibility

Eligibility v2 requires all of the following: an uncertain classifier outcome, a plausible trading hypothesis, sufficient independent evidence, exhausted/unresolved investigation, supported language/provider capability, and no terminal policy, semantic, or operational outcome. Acquisition, provider, language, or active-investigation gaps defer rather than enter review. Country exclusions, terminal decisions, operational failures, and cases without a plausible trading hypothesis are not eligible. Release 4 never inserts or updates `channel_reviews` from the v2 projection.

## Rollout and rollback

1. Apply migrations 059 and 060 additively.
2. Enable `dashboard_corpus_mode=SHADOW`, inspect and replay-verify the corpus projection.
3. Enable `review_eligibility_v2_mode=SHADOW`, compare its eligible set with reviewed outcomes and review capacity.
4. Canary assignment is deterministic and requires explicit non-zero basis-point settings, but remains non-serving in Release 4.
5. Roll back either observer immediately by setting its mode to `OFF`; immutable history remains replayable.

## Independent audit classification

- **Implemented:** additive immutable event schemas, repairable projections, deterministic controls, default-OFF settings, conservative pure policies, observational ingestion/admission hooks, read/verify/repair APIs, replay gap/version checks, and focused/full-suite tests.
- **Retained:** legacy dashboard SQL, existing channel APIs, durable review queue and human decision state machine, nomination/admission provenance, Phase-3 evidence, and Phase-4/5 shadow behavior.
- **Intentionally excluded:** any Release 5 serving cutover, automatic review-queue admission, destructive migration, threshold reduction, or classifier terminal authority.
