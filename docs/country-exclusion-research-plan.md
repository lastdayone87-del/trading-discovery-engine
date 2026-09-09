# Country Exclusion: Research Report & Implementation Plan

> **Status:** RESEARCH + PLAN ONLY. No production code, config, migration, or behavior was changed for this report.
> **Business rule:** false rejection is worse than missing excluded channels — uncertain/weak/conflicting evidence defaults to PROCESS. Genuinely strong, consistent evidence (including aggregated language) rejects.
> **Scope note:** language is used as *creator-origin* evidence only. Markets, assets, brokers, audience, viewers, external sites, Discord/Telegram, upload times, and market-based inference are never country evidence (existing allowlist already enforces this).

---

## 1. Repository / architecture mapping

### 1.1 Excluded-country configuration
- Seed list: `src/data/initial_countries.ts:191-221` (`INITIAL_EXCLUDED_COUNTRIES`, 29 rows: 21× African Region, IN/BD/PK/NP/LK South Asia, PH/VN/ID Southeast Asia non-target). Type: `src/types/index.ts:286-289`.
- Storage: Postgres `excluded_countries(country_name PK, reason)` (`server/db/migrations/001_postgres_core.sql:49-52`), NOT env/config. Accessors `server/dbCore.ts:590-592`, seed-once `server/dbCore.ts:215-217`. Operator API `server.ts:496-516`. Countries are full English names, matched NFKC/lowercased exact (`server/countryExclusionRules.ts:8-19`).
- Allowed production set: `SUPPORTED_PRODUCTION_COUNTRIES` (`src/data/initial_countries.ts:3-189`).

### 1.2 The decision engine (single function)
- `assessChannelCountry` in `server/countryInference.ts:228-413` is the sole decision engine. Inputs (`CountryInferenceInput`, `:47-68`): `officialCountry, channelName, aboutBio, socialBios[] (unpopulated in prod), officialWebsiteLinks[], verifiedSocialLinks[], videoTitles[] (zeroed before use), discoveryCountry, metadataStatus`.
- Evidence tiers: P1 OFFICIAL_YOUTUBE_METADATA (100) → P2 CHANNEL_ABOUT_BIO (92) → P3 WEBSITE_TLD (90) → P4 SOCIAL_LINK (82) → P5–P8 exchange/broker/phone/address (78–64) → P9 NATIVE_LANGUAGE (≤58) → P10 DISCOVERY_CONTEXT (25, can never attribute).
- Rejection rule (`:370-393`, verified): reject IFF detected country is excluded AND `decisiveEvidence` unanimous AND `decisivePriority <= 3` AND `topConfidence >= 85` AND no conflict. Otherwise CONFIRMED(≥85)/LIKELY(≥60)/UNCERTAIN; conflict (equal top scores) forces UNCERTAIN/NEEDS_REVIEW.
- Adapters: `mergeCountryValidationResults` (later/weaker evidence never overrides; equal-priority conflict stays UNCERTAIN, `server/countryValidator.ts:105-129`); `applyTargetCountryBoundary` (target mismatch can NEVER create REJECTED, `:131-151`).

### 1.3 Where the decision runs in the pipeline
1. Scheduling scope excludes listed countries (`server/autonomousDiscovery.ts:215-225`); job admission gates (`server/queueManager.ts:401-412,468-472`).
2. **Gate 1 (per candidate, pre-spend):** `processChannelThroughPipeline` → triage → `validateChannelCountry` → optional 1-unit hydration → optional no-key public-About fallback → REJECT (halt, unpersisted) / NEEDS_REVIEW / continue (`server/ingestionPipeline.ts:192-272,291-366`). Re-runs on every pass, including enrichment passes.
3. Accounting: `COUNTRY_REJECTED` funnel + `channel_sightings` (`server/queueManager.ts:585-611`); serving filter excludes REJECTED (`server/dbCore.ts:330-337`).
4. Defense in depth: country re-check inside Discord inspection (`server/queueManager.ts:900-941,963-979`); recovery replay (`server/countryBoundaryRecovery.ts`).

### 1.4 Bio / metadata provenance (verified)
- Authoritative bio + official country come from YouTube Data API `channels.list` (`part: snippet,brandingSettings,statistics`): bio = `snippet.description`, official country = `brandingSettings.channel.country` (`server/youtube.ts:704-767,785-812`). No-key HTML fallback parses `ytInitialData` (`server/youtubePublicAbout.ts:137-238`), gated to uncertain + short-bio cases (`:37-65`).
- Persisted on `channels` (country, country_status, confidence, `country_metadata_*`, `public_about_*`, inspection trail) and immutable `evidence_documents` (`server/db/migrations/001_postgres_core.sql:7-33`, `055_evidence_documents_and_assertions.sql:4-22`).

## 2. Current country-exclusion behavior

- **Bio-dependent by construction.** Gate 1 calls `validateChannelCountry` with `{channelName, description, videoTitles, locationTag, externalLinks, metadataStatus}` (`server/ingestionPipeline.ts:206-217`), and the validator then **zeroes `videoTitles`** (`server/countryValidator.ts:69-72`, deliberate anti-circularity: titles may echo the query). With empty bio + no official country → `creatorEvidence == []` → UNCERTAIN/CONTINUE (confidence 0). The empty-bio Vietnamese channel therefore passes — the exact gap in the task brief.
- **Language can never reject today.** P9 NATIVE_LANGUAGE caps at 58 and needs ≥2 keyword hits (`server/countryInference.ts:308-329`); the rejection gate needs priority ≤3 + confidence ≥85. Language is advisory only.
- **Structural consequence:** the three rejection-capable tiers (P1 official metadata, P2 bio, P3 website TLD) are all empty precisely when the bio is empty and no official country is declared.

## 3. Current data / signals available (no new acquisition needed)

Already fetched and persisted under current quota flow:
- Official `brandingSettings.channel.country` + About bio + subscriberCount + activity (`server/youtube.ts:677-767`).
- **≤10 recent video titles + full descriptions** (stage-1 enrichment, `maxResults:10`, `:707,756-757`) and **10 playlists + `videos.list` hydration at stage ≥2** (`:737-748`); 5 recent descriptions via `fetchRecentVideoDescriptionsFromAPI` (`:606-670`).
- Per-video `{id,title,description,published_at}` plumbed through `RawChannelInput.videos`, `video_titles`/`video_descriptions` (index-parallel), `evidence_documents` with per-doc `language/script` columns (columns exist, values mostly null).
- Script/code-switch detectors (`server/globalLanguageModel.ts:72-109`, `server/countryNativeIntelligence.ts:169-240`), multilingual keyword packs (`server/evidenceEngine/multilingualTerminology.ts`, `knowledgePacks.ts`), per-field LLM language output (post-classification), explicit-language single-winner gate (`server/terminologyLanguageContext.ts:27-45`).

## 4. Current gaps and limitations

1. **Gate-1 input has no descriptions/playlists/transcripts/languages** — validator signature accepts none, so ≤10 already-fetched descriptions never reach the decision.
2. **No per-video language assignment in production**: `detected_languages`, `videos[].language/script`, `transcript_excerpts` are typed but unwritten (zero producers outside tests); no captions API read; no `defaultLanguage`/`defaultAudioLanguage` read; no standalone language-ID library.
3. **P9 keyword lists are thin for excluded-region languages** (e.g., Vietnamese has exactly 2 entries while the rule needs ≥2 distinct matches) and substring matching is fragile.
4. `socialBios[]` is typed but unpopulated; channel creation date, topicDetails, captions are not collected.
5. P5–P8 broker/exchange/phone/address signals exist but are capped below the rejection gate (cannot reject alone — acceptable, and consistent with the "no broker/market inference" rule for automatic rejection).

## 5. Research findings

- **Language→country is safe only when every strongly-associated country is excluded.** Approved language map: Vietnamese→{Vietnam}, Tagalog→{Philippines}, Hindi→{India}, Bengali→{Bangladesh, India} (both excluded — ambiguity harmless), Urdu→{Pakistan, India} (both excluded). Hindi is fully eligible: India is excluded and strong consistent Hindi evidence rejects without any additional India signal; diaspora false positives are a documented residual risk (see §15), not a blocking guard. **Never language-reject** on English/French/Spanish/Portuguese/Arabic (worldwide) or Bahasa (ID/MY overlap); African excluded countries have no distinctive single-country language → explicit evidence only.
- **Per-video language without new libraries**: script detection (existing) + Vietnamese diacritic density (ăâđêôơư + tone marks — deterministic, cheap) + extended keyword lists per eligible language + existing vocab packs. Descriptions (creator-written long-form) only — **titles stay excluded** to preserve the anti-circularity guarantee.
- **Sample size: minimum 8 usable videos, no exceptions.** The rejection rule needs both an absolute floor and a share: usable descriptions ≥ 8 AND dominant-language share ≥ 80% (8/10 boundary inclusive; 8/8, 8/9, 9/9, 9/10, 10/10 all qualify). Any sample below 8 usable videos → PROCESS regardless of share — a 4/4 or 5/5 sample is never enough for automatic rejection. 10 recent videos are already fetched at stage 1 (zero new quota).
- **Tiers beat weights here**: the existing gate (priority ≤3, ≥85, unanimity, conflict→UNCERTAIN) already encodes the asymmetry. A new evidence source that meets the gate needs no threshold redesign and inherits conflict handling (e.g., US official metadata P1 automatically outranks language; equal-top conflict forces UNCERTAIN).

## 6. Recommended evidence hierarchy

New source **`AGGREGATED_CONTENT_LANGUAGE` at priority 3** (alongside website TLD, below bio): deterministic criteria — eligible language per the approved map (§5), usable videos ≥ 8, dominant share ≥ 80%, single winner, bio empty-or-noncommittal, and tier precedence satisfied (P1–P2 absent or inconclusive; P3 website interaction follows the multi-country agreement rule below) — confidence from a fixed 2-row table tied to the existing ≥85 gate (100% share → 90, 80–<100% share → 86, always with usable ≥ 8). It can then satisfy `exclusionAuthority` unchanged. Nothing else in the hierarchy moves; P9 stays advisory; forbidden signals (markets, brokers, audience, timezone, external sites, messaging links) remain outside the allowlist.

**Multi-country representation (Urdu, Bengali).** The evidence carries the language's full candidate-country SET — Urdu→{Pakistan, India}, Bengali→{Bangladesh, India} — never an invented single country. The approved map admits a language only when every set member is excluded, so the set as a whole is rejection-capable. Agreement with P3 website country W is set membership: agree iff W ∈ set (e.g., Urdu + `.pk` or `.in`; Bengali + `.bd` or `.in`); a website country outside the set is disagreement. With no website evidence, rejection requires the all-members-excluded property (true by map construction), recorded with the set named in reasoning rather than a forced single country.

## 7. Recommended language aggregation approach

1. Sample = up to 10 most recent video descriptions (+ stage≥2 playlist names/descriptions as corroboration, never decisive alone); skip empties; **fewer than 8 usable → insufficient-data → PROCESS, regardless of share**.
2. Per-video language: script/diacritic pass → keyword-list pass (extended lists) → semantic-model per-field language when classification already ran. Each video votes for at most one eligible language or abstains.
3. Dominance = **usable ≥ 8 AND `votes(L) / usable ≥ 0.8`** with a single winner; any second eligible language with ≥2 votes voids dominance → PROCESS. Tier precedence (§11): P1–P2 evidence that is present and conclusive is evaluated first and the language path is skipped; P3 website evidence must agree (unanimity) — disagreement voids a language-based REJECT.
4. Mixed-language, multilingual, and below-minimum-sample cases therefore PROCESS by construction.

## 8. Recommended confidence / decision thresholds

No invented weights: reuse the gate (`decisivePriority ≤ 3`, `topConfidence ≥ 85`, unanimity, conflict→UNCERTAIN). New source confidence is criterion-derived (100% share → 90, 80–<100% share → 86, always with usable ≥ 8), i.e., calibrated *by* the gate it must pass. HIGH CONFIDENCE (all required) → REJECT: approved-map language, usable ≥ 8, share ≥ 80%, single winner, P1–P2 absent/inconclusive, P3 website agrees or is absent, bio empty/non-committal. Everything else → PROCESS (including NEEDS_REVIEW/CONTINUE paths unchanged).

## 9. Exact decision flow

```
Collect available country signals (unchanged: P1–P10)
  ↓ Is there strong explicit excluded-country evidence (gate as today)?
YES → REJECT (unchanged)
NO ↓ Is P1–P2 country evidence present and conclusive?
YES → follow existing rules (language path skipped; conflict → PROCESS
      unless existing rules independently justify REJECT)
NO ↓ Thread already-fetched descriptions/playlists into validator input
Aggregate per-video language over ≤10 recent videos (titles excluded)
  ↓ Approved-map language AND usable ≥ 8 AND share ≥ 80% AND single winner
    AND bio empty/non-committal?
YES → Is there P3 website country evidence?
      YES → website country ∈ language set? YES → REJECT (agree) / NO → PROCESS
      NO → all set members excluded (map construction)? YES → REJECT / (cannot happen per map)
NO ↓ (mixed / multilingual / below-minimum sample / worldwide language /
      P3 website disagreement / conflicting evidence / no data)
PROCESS via existing UNCERTAIN / NEEDS_REVIEW / CONTINUE paths (unchanged)
```

## 10. Mixed-language and edge-case handling

- Mixed/multilingual → no single ≥80% winner (with usable ≥ 8) → PROCESS. Worldwide languages → ineligible, PROCESS. Below-minimum sample (<8 usable, e.g. 4/4 or 5/5) → PROCESS regardless of share.
- Expat/diaspora (e.g., Hindi speaker with US bio/location): present, conclusive higher-priority evidence takes precedence → PROCESS/UNCERTAIN by existing rules. Monolingual-diaspora with empty bio and no metadata is a known residual false-positive risk (see §15): documented, accepted, and reviewable — it does not block automatic rejection when the high-confidence rule is met.
- Hindi is fully eligible (India excluded): 10/10, 9/10, 8/10 Hindi → REJECT; 7/10 or lower, mixed, conflicting, or below-minimum samples → PROCESS. No additional India location signal is required once the language rule is met.

## 11. Conflicting-signal handling

Unchanged mechanics, extended input: official metadata (P1) and bio (P2) outrank language — when conclusive, the language path is skipped before it can compete. Website evidence shares tier P3 with the new language source, so the existing unanimity rule governs their interaction with no new logic: agreement → gate evaluates unanimously; disagreement → not unanimous → no language-based REJECT (the top-confidence country wins for CONFIRMED/LIKELY, ties stay UNCERTAIN, `countryInference.ts:362-372`). **Multi-country agreement:** the language evidence carries its candidate-country set, so “agreement” with P3 website country W means W ∈ set (Urdu + `.pk`/`.in`, Bengali + `.bd`/`.in`); a website country outside the set is disagreement. With no website evidence, the all-members-excluded property (§6) authorizes REJECT with the set named in reasoning — no single country is invented. Lower tiers (P4–P9) never block or outvote a decisive P3, exactly as today. `mergeCountryValidationResults` prevents weaker live evidence from overriding; target mismatch can never create REJECTED. Language evidence additionally self-voids on any second eligible language with ≥2 votes. **Non-override rule:** language-based rejection applies only when P1–P2 evidence is absent or inconclusive and P3 website evidence is absent or agrees per the set rule above. If strong country evidence conflicts with the aggregated language evidence, the result is PROCESS unless the existing country-validation rules independently justify REJECT.

## 12. Recommended location (safest, smallest change)

1. `assessChannelCountry` (`server/countryInference.ts:228-342`): add the one `AGGREGATED_CONTENT_LANGUAGE` source; gate formula, thresholds, and conflict logic untouched. Single decision function = single place to review/test.
2. `creatorLevelCountryEvidence` (`server/countryValidator.ts:46-74`): accept `videoDescriptions[]`/`playlists[]` (already on the candidate) into the input join. No new fetch, quota, crawl, or migration.
3. Coverage comes free: Gate 1 re-runs on every pass including enrichment passes (`server/ingestionPipeline.ts:206-272` runs inside `processChannelThroughPipeline`, which the ENRICH worker re-invokes), so pre-enrichment behavior is unchanged (insufficient data → UNCERTAIN as today) while enriched candidates (≤10 descriptions) become decidable.
4. Data-only follow-ups (no architecture): extend `COUNTRY_SIGNALS.language` lists for eligible languages; optionally populate `evidence_documents.language/script` at projection time for auditability.

## 13. Minimal implementation plan

1. Extend `CountryInferenceInput` + validator input with `videoDescriptions?: string[]`, `playlists?: {name,description}[]` (thread from candidate; titles stay excluded).
2. Add per-video language voter (script/diacritic + extended keyword lists + existing vocab packs; abstain on worldwide/unknown).
3. Add `AGGREGATED_CONTENT_LANGUAGE` evidence (priority 3, 100%→90 / 80–<100%→86 table with usable ≥ 8, approved language map Vietnamese/Tagalog/Hindi/Bengali/Urdu). Evidence carries the language's candidate-country set; website agreement = set membership; rejection without website requires the all-members-excluded property (see §§6, 11).
4. No gate/threshold/conflict changes; no new acquisition; no migration; no config format changes.
5. Estimated surface: ~120 lines in `countryInference.ts`, ~15 in `countryValidator.ts`, keyword-list data additions, tests below.

## 14. Proposed tests

- Empty bio + 10/10 and 8/10 Vietnamese descriptions → REJECT_EXCLUDED; 7/10 Vietnamese → PROCESS; <8 usable videos → PROCESS.
- 10/10 Hindi → REJECT; 9/10 Hindi → REJECT; 8/10 Hindi → REJECT; 7/10 Hindi → PROCESS.
- Mixed Hindi/other languages without ≥80% dominance → PROCESS; worldwide language dominance (English/French/Arabic) → PROCESS.
- Mixed VI/EN, multilingual, 4/4 or 5/5 samples → PROCESS (absolute minimum not met).
- 10/10 Vietnamese + `locationTag` US (or US bio line) → PROCESS/UNCERTAIN (higher-priority evidence takes precedence; no override).
- P3 website TLD US + 10/10 Vietnamese descriptions → PROCESS (equal-tier disagreement breaks unanimity, no language-based REJECT); P3 website `.vn` + 10/10 Vietnamese → REJECT (agreement, gate evaluates unanimously).
- Urdu 9/10 → REJECT (PK/IN both excluded); Bengali 8/10 → REJECT (BD/IN both excluded); Hindi + US bio → PROCESS.
- Multi-country website agreement: Urdu + `.pk` website → REJECT; Urdu + `.in` website → REJECT; Urdu + `.us` website → PROCESS (disagreement); Bengali + `.bd` → REJECT; Bengali + `.in` → REJECT; Bengali + `.de` → PROCESS; Urdu/Bengali alone (no website) → REJECT via the all-members-excluded rule with the set named in reasoning.
- Pre-enrichment candidate (0–1 descriptions) → behavior unchanged (UNCERTAIN path).
- Regression: existing 29-country attribution suite, threshold/conflict/merge/boundary tests all green unchanged.

## 15. Risks and limitations

- Language ≠ domicile (diaspora): mitigated by higher-priority precedence + empty-bio requirement; monolingual-diaspora residual false positives are documented, accepted per the asymmetry rule, and reviewable via NEEDS_REVIEW sampling — they do not block automatic rejection at the high-confidence threshold.
- Latin-script SE-Asian languages need keyword-list quality (Tagalog/Bahasa) — weaker than Vietnamese diacritics; start with Vietnamese, Hindi, and already-excluded-pair languages (Bengali, Urdu), then Tagalog once lists are validated.
- Description availability depends on enrichment stage; pre-enrichment recall unchanged by design.
- No transcripts/audio language — video-description text is the ceiling without new acquisition (deliberately out of scope).
