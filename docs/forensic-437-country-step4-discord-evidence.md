# PR #437 — Forensic-only: country provenance / Step 4 / Discord validation

> Forensic-only. No implementation. No merge/deploy/production/DB/variable/infrastructure changes.
> Unapproved implementation commit `232cb70` was removed from this PR branch. It is preserved separately on `fix/rendered-zero-page-inspection` for post-approval handling. This PR diff is documentation only: no Czech-specific fix, no Step 4 behavior change, no Discord dashboard change.

## Scope
- Country attribution: Vietnam P2 92% + P5 hose 78% with clean English Bio; Czech/CZ rejected as South Africa 92%.
- Step 4 PARTIAL/unavailable website trails.
- Discord candidate validation robustness (dashboard representation preserved, not the problem).

## Data-access note
- `DATABASE_URL` absent in verification environment; local `data/*.db` files unreadable (`database disk image is malformed` under both python-sqlite and sql.js). No live production row dump was possible.
- Verification used reported audit/trail oracles plus deterministic reproduction through the same production functions (`inferChannelCountry`, `classifyRenderedCrawlerFailure`, `isPureTargetBlockOutcome`, `extractDiscordCandidates`, `validateDiscordInvite` with mocked fetch). Read-only; no files modified during verification.

## Evidence table

| Issue | Exact production evidence (oracle) | Confirmed root cause (code refs) | Confidence | Remaining uncertainty |
|---|---|---|---|---|
| Vietnam P2 REJECTED 92% (`P2 CHANNEL_ABOUT_BIO vietnam 92` + `P5 EXCHANGE_REFERENCE hose 78`) | Reported trail; reproduced: clean English bio → `UNCERTAIN, []`; trail text containing literal `vietnam` → `REJECTED [P0 EXCLUSION, P2 vietnam 92, P5 hose 78]`; `channelName='Vietnam Trading'` alone → same REJECTED P2; empty bio → `UNCERTAIN, null` | P2 requires literal `vietnam` in `bioText = channelName + aboutBio(description+socialBios)` (`server/countryValidator.ts:47`, `server/countryInference.ts:223-224`) via bio-phrase list or domicile regex (`:227-242`). `hose` lives only in `exchanges` list, so HOSE alone yields `LIKELY` P5/P8, never REJECT. False P2 therefore = upstream field contamination, not vocabulary. Prime vector unfixed: `server/queueManager.ts:757` `description: rawDetails?.description \|\| inspection_trail.map(details).join(' ') \|\| channel_name` feeds trail prose into the P2 matcher when description is missing. `channelName`/`socialBios[]` are the other P2 inputs a manual About-only check misses. `DISCOVERY_CONTEXT` (P10, excluded from creator evidence), `videoTitles` (forced `[]`), website/social/exchange/phone/address/language surfaces verified unable to emit P2. | High (mechanism + exact signature) | Which P2 input supplied `vietnam` for that channel — needs one SELECT of `channelName/description/socialBios/inspection_trail` for the affected `channel_id`. |
| Czech/SA (`CZ REJECTED`, `P2 south africa 92`, `P5 lse UK + jse SA 78`, `Discovery None`) | Reported audit; reproduced: `JSE`-only bio → `LIKELY SA` (no reject); Czech `jsem` bio post-token-boundary → `UNCERTAIN`; Czech + `Based in South Africa` literal → `REJECTED P2 SA` | Pre-`232cb70`: no `Czechia` entry, no `cz/czech` alias, substring acronym matching (`jsem→jse`, `false→lse`, `those→hose`, `smith→smi`). But `jsem→jse` is P5-only (`content=aboutBio+videoTitles`) and `exclusionAuthority` requires `decisivePriority≤3`, so P5 alone yields `LIKELY`, never `REJECTED`. REJECT required a P2 literal `south africa`. Root is evidence-conflict/provenance (single unverified P2 authoritative; no context; no conflict guard), not a missing-Czech rule. | High | SA P2 surrounding context (not persisted before `matchedContext`). |
| Step 4 (`6+7`, `5+4` PARTIAL; `g/ NO_PAGE`, `ERR_EMPTY`, timeouts, budget-expired) | Reported trails; zero-page fix from PR #436 preserved | `ERR_EMPTY_RESPONSE`/`ERR_HTTP2_*`/`ERR_CONNECTION_*` → `TRANSIENT` (`server/renderedCrawlerPolicy.ts:34`); nav timeout → `TRANSIENT`; cert/abort → `OTHER` fail-open retryable; 401/403/captcha → `BLOCKED`; 429 → `RATE_LIMITED`; 5xx/timeout → `TRANSIENT`; `NO_PAGE_PROCESSED` (`wasRenderedResultProcessed=false`) → incomplete/retryable; pure-target-block (all BLOCKED, no transient/rate/timeout, budget unexpired) → record & move on, else retryable. Continuation: `uniqueUrls` Map dedupe, ranked full lists, per-URL `for...of` with isolated fallback — trails prove all URLs attempted. Seeds only via `normalizeExternalUrl`; subresources aborted; no caps. | High | Server-side truth per URL without live re-crawl. |
| Discord validation robustness (dashboard preserved) | Validator paths + fixtures (no live row): normalization 5 formats → same code; reserved → `INVALID_LOCATOR/COMPLETED`; 404 first → `INVALID_OBSERVED/RETRY_PENDING`; timeout → `RETRY_PENDING` with retries | `server/discordValidator.ts:178-281`, `server/discordProjection.ts:50,121`. Unproven never `ACTIVE`; inconclusive never `DEAD` (only durable 2nd 404 → `DEAD`). Retryable preserved via serving-invite guard + reconcile-only-sets-never-clears. | High logic / Medium distribution | One live candidate end-to-end needs `discord_candidates/check_attempts` rows. |

## Corrected minimal fix principles (not implemented)

### 1. Country — global provenance/conflict boundary (not country-specific)
- **PROVEN excluded-country evidence → REJECT. Not proven → PROCESS. Ambiguous/conflicting/weak/contaminated → UNCERTAIN / PROCESS.**
- P2 creator-country evidence must carry `matchedValue + matchedContext + sourceField` identifying exactly which input field and matcher produced it.
- Exchange/market references, discovery context, video titles/descriptions, websites, trail text, and substring collisions must never become creator-country proof.
- No per-country vocabulary exception as the fix; no priority tuning as the fix; no exclusion weakening. Genuine declarations must still REJECT.

### 2. Step 4
- External/permanent failure → record it and move on. Recoverable/ambiguous/zero-page → retryable.
- Preserve the complete deduped candidate set. One failed URL must never prevent remaining candidates from being processed.
- No filters, URL caps, or discovery-recall reduction.

### 3. Discord validation (dashboard unchanged)
- Current dashboard representation is not the problem; preserve it.
- Harden `discovery → candidate creation → persistence → validation attempts → outcome classification → retry logic → final status` to distinguish definitely valid / definitely invalid / temporarily unavailable / inconclusive.
- Retry temporary failures; keep unresolved retryable candidates `RETRY_PENDING`; mark DEAD only on durable evidence; never mark unproven candidates `ACTIVE/VALIDATED`; never convert inconclusive failures into definitive invalid; keep canonical invite normalization correct.

## Status
Forensic-only. Awaiting explicit approval before any implementation PR/commit.
