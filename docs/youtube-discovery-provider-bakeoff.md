# YouTube discovery provider bake-off

## Decision to make
Choose a quota-independent secondary YouTube discovery provider without changing production discovery behavior until measured results justify it.

## Candidates
1. YouTube.js (`youtubei.js`) / InnerTube — preferred candidate. Native Node/TypeScript fit, no official Data API key, search + continuation support.
2. `youtube-search-api` — lightweight no-key comparator with explicit `nextPage` continuation support, but smaller/less active project.
3. `yt-dlp` — resilience comparator and possible tertiary fallback; strong maintenance/community but adds a subprocess/runtime boundary.
4. Existing YouTube Data API — control/baseline, not a quota-independent candidate.

## Bake-off corpus
Use 30 representative queries sampled from the engine's existing autonomous query vocabulary, spanning countries/languages, instruments, generic trading terms, and recent-content terms. Do not hand-pick queries to favor one provider.

For each provider/query, fetch up to 3 pages/continuations or stop earlier on exhaustion/failure. Preserve provider-native ordering and record raw identifiers before dedupe.

## Metrics
- request success/failure and failure class
- latency per page and per query
- pages/continuations successfully consumed
- raw results
- unique video IDs
- unique channel IDs
- overlap with the official Data API baseline
- incremental unique channels not seen in baseline
- duplicate rate
- apparent upload freshness where exposed
- downstream candidate-firewall acceptance
- eventual `TRADING_CONFIRMED` yield
- eventual active Discord/community yield
- malformed/missing channel identity rate

The last three metrics matter more than raw result count. A provider that returns many irrelevant channels is not better discovery.

## Guardrails
- Shadow mode only: bake-off results must not nominate/enrich production candidates.
- No provider may become classification authority. Existing identity/relevance/vitality/community stages remain authoritative.
- Bound each provider to the same query/page budget.
- Keep official API enrichment/verification available even if discovery comes from an unofficial provider.
- Treat unofficial-provider rate limiting/schema changes as expected operational failures, not evidence that a query has no results.
- Do not call unofficial providers "unlimited"; they avoid Data API quota but remain subject to YouTube anti-abuse and protocol changes.

## Decision rule
Prefer YouTube.js if it demonstrates acceptable stability and continuation depth while producing equal or better downstream `TRADING_CONFIRMED` and active-community yield per unit of latency/failure than `youtube-search-api`.

Use `youtube-search-api` only if its measured yield/reliability materially beats YouTube.js despite its maintenance risk. Keep `yt-dlp` as a tertiary resilience path if its subprocess overhead is justified by materially different incremental discovery.

## Production architecture if YouTube.js wins
`autonomous query planner -> provider router -> YouTube.js discovery -> dedupe/root firewall -> official/cheap enrichment as needed -> existing classifier -> community acquisition`

The official YouTube Data API remains a provider and verification source rather than being removed. Provider health/rotation should be observable independently so one rate-limited source does not halt autonomous discovery.
