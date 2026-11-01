# Invite navigation-coverage telemetry and control recovery (P0.2/P1.1/P1.2)

**Status:** P0.2 instrumentation plus P1.1/P1.2 control recovery. No outcome,
retry, selection, queue, or schema behavior changes.
**Scope:** Rendered creator-website acquisition (`mode = RENDERED`).
**Related evidence:** `INVITE_NAVIGATION_ACQUISITION_RECALL_INVESTIGATION_20261027.md`
and the 2026-10-27 P0.3 production classification report (read-only Coolify
snapshot; aggregate metrics, not committed to this repository).

## Why

Production telemetry could say how many community-hint controls were clicked,
but not how many controls existed before the hint filter. It also could not
distinguish a page that stopped growing from one that hit the scroll cap while
still growing, and it did not record menu-like controls, icon-only labels,
popup targets, frames, open shadow roots, `<base href>`, or navigation policy
exclusions. That made “not fully inspected” unmeasurable and made a clean
`INSPECTED_NO_MATCH` impossible to audit against unexamined navigation surfaces.

P0.2 adds bounded counters and a diagnostic coverage reason. P1.1/P1.2 then use
the measured surfaces to **recover** controls that were previously excluded:

- **P1.1 structural disclosures.** Menu, nav, hamburger, tab, `summary`,
  `role=menu|menubar|menuitem|navigation|tab`, `aria-haspopup`, collapsed
  `aria-expanded="false"`, and menu-like labels are added to the click set when
  they can reveal content in place. The shared selector also matches
  non-button `role="menuitem"` and `aria-haspopup` controls, so they reach the
  classification logic at all.
- **P1.2 icon labels.** A control whose only useful label is `title`,
  `aria-labelledby`, a child `img[alt]`, `data-label`, `data-tooltip`, an SVG
  `<title>`, or bounded hidden descendant text is now matched.

Recovered controls that reveal content in place are **not** a coverage gap:
they are clicked. A non-base-matched structural anchor that navigates to a real
document is different: clicking it would replace the document and strand the
remaining menu controls, so the click set excludes it and the enqueue path owns
it. `structuralUnrecovered` counts only the subset that represents a real
unexamined structural destination:

- the anchor has explicit menu semantics (`role=menu|menubar|menuitem|navigation|tab`,
  `aria-haspopup`, collapsed `aria-expanded="false"`, `summary`, or `nav`), or
- the anchor was recovered by a hint-bearing label (P1.2).

An ordinary “Learn more”, “Resources”, or “Support” page link is a navigation
candidate the hint policy deliberately did not pursue, not a structural
disclosure; it does not mark the crawl policy-excluded. The request handler
then re-checks each candidate against the enqueue rule: a same-origin,
admissible, not-already-visited destination that the community-hint filter
would follow is inspected separately and is not a gap. When the enqueue path
does not follow one, the destination was never examined and coverage is
`POLICY_EXCLUDED`, not `COMPLETE`. P1.7 still owns the mapping from coverage
reason to `PARTIALLY_INSPECTED`/retry.

## Persisted fields

All fields are optional/sparse and rendered-only. They are counts or booleans;
none contains a URL, selector, element text, or payload.

| Field | Meaning |
| --- | --- |
| `controlsEnumeratedTotal` | Selector-matched controls before the community-hint filter. |
| `controlsHintRejected` | Controls the original community-hint filter would have excluded (`total - baseMatched`). |
| `controlsStructuralNavigation` | Menu/nav/hamburger/tab/summary/`aria-haspopup`/collapsed-`aria-expanded`/`role=menuitem` controls, including controls inside `<nav>`/`role=navigation|menu|menubar` containers. Classification uses the control's own label/naming text, not its resolved href. |
| `controlsStructuralHintRejected` | Structural controls the original hint filter would hide. |
| `controlsStructuralDisclosure` | Structural controls included in the click set because they can reveal content in place (a collapsed disclosure or a menu trigger that does not navigate). An already-open `<details>` summary is excluded: its content is already in the DOM and clicking would close it. |
| `controlsStructuralUnrecovered` | Structural navigable anchors that are outside the click set and that the enqueue path will not follow: explicit menu-semantic or hint-recovered anchors, same-origin, admissible, not already visited, rejected by the community-hint filter. Ordinary “Learn more”/“Resources”/“Support” page links are not counted. If the enqueue path does not follow one, its destination was not examined; this forces `POLICY_EXCLUDED` (unless a stronger reason applies). |
| `controlsIconLabelRecovered` | Controls recovered by a label the original filter ignored: `title`, `aria-labelledby`, child `alt`, `data-label`, `data-tooltip`, SVG `<title>`, or capped hidden text. These are included in the click set. |
| `popupTargets` | Popup/dialog controls that remain unexamined by the click loop and require capture rather than navigation: any non-false `aria-haspopup` value and `target="_blank"` controls without an HTTP(S) href. A `_blank` anchor with a followable HTTP(S) href is reachable by navigation and is not counted; a popup the click loop successfully examined is subtracted. Presence only; no popup capture. |
| `frameCount` | `iframe`/`frame`/`object`/`embed` elements observed on processed pages (bounded live-collection scan). |
| `shadowRootCount` | Open shadow roots observed on processed pages. Presence only; no traversal. |
| `baseHrefPresent` | A document `<base href>` was observed. |
| `scrollCapReachedStillGrowing` | The last permitted scroll iteration still found a growing document. |
| `navigationPolicyExcluded` | Counts by `invalid-protocol`, `admission-rejected`, `cross-origin-disallowed`, `destination-budget`, `control-slice`, `hint-rejected`. |
| `coverageReason` | `COMPLETE`, `BOUNDED`, `POLICY_EXCLUDED`, `CONTEXT_UNREACHABLE`, or `UNKNOWN`. |

Existing fields keep their meanings:

- `evidenceControlsTotal` remains the evidence-bearing click set. Before
  P1.1/P1.2 it was exactly the hint-matched set; it now also includes recovered
  structural disclosures and icon-label controls. It is not the pre-filter
  denominator; `controlsEnumeratedTotal` is.
- `evidenceControlsSkipped` remains the interaction-budget skip count.
- `dropReasons` remains the canonical enqueue/selection ledger.
- `zeroPageReason` already records `GATE_SATURATED`, `BROWSER_LAUNCH_FAILED`,
  and the other zero-page reasons, so P0.2 does not duplicate them in a
  `renderedGateRejected` map.

## Coverage-reason precedence

`resolveRenderedCoverageReason` is intentionally conservative:

1. `UNKNOWN` when no page was processed.
2. `BOUNDED` when a named ceiling, interaction gap, scroll-cap-still-growing,
   or unresolved terminal request failure was observed. A failed child request
   can hide a destination, so it is never reported as `COMPLETE`. Icon-label
   recoveries and structural disclosures are clicked, so they no longer imply
   an unexamined destination on their own.
3. `CONTEXT_UNREACHABLE` when frames, open shadow roots, or unexamined popup
   targets were observed. Popups the click loop successfully examined are not
   context gaps.
4. `POLICY_EXCLUDED` when `invalid-protocol`, `admission-rejected`,
   `cross-origin-disallowed`, or `destination-budget` exclusions occurred, or
   when `structuralUnrecovered` recorded an unfollowed structural navigation.
5. `COMPLETE` otherwise.

P1.1/P1.2 changed what counts as bounded. Recovered icon-label and structural
disclosure controls are clicked, so they no longer trigger `BOUNDED`. A
non-base-matched structural anchor that resolves to a different document is
owned by the enqueue path, not the click set. If the enqueue path rejects a
real structural destination, the destination remains unexamined and the run is
`POLICY_EXCLUDED`; it must not be reported as clean coverage. Base-matched
anchors keep their original click behavior. Ordinary page links that the
community-hint policy rejects are not structural gaps: they are the same
out-of-scope navigation the hint filter has always applied, and counting them
would mark nearly every crawl policy-excluded.

`hint-rejected` and `control-slice` are measured in
`navigationPolicyExcluded` but are not policy exclusions for this reason.
`hint-rejected` is an intended filter decision: a link that does not match the
community surface is not unexamined navigation, and `controlsHintRejected` is a
separate click-control count, not a substitute for it. `control-slice` is
origin-gated: only an unexamined hint/icon control forces the interaction gap,
while an over-budget generic disclosure stays opportunistic. The narrower
`structuralUnrecovered` signal is different: it counts only explicit-menu or
hint-recovered structural navigation anchors whose destination was neither
clicked, enqueued, nor already inspected, not every URL the hint filter
rejected. Its href evidence is a bounded sample; if candidates remain beyond the
sample the signal fails closed rather than reporting clean coverage.
Cross-origin structural anchors cannot be followed by the same-hostname enqueue
path, so they are recorded as `cross-origin-disallowed` in the rendered policy
ledger. A stronger reason wins over a weaker one (for example, a timeout is
`BOUNDED` even when frames are present).

The reason remains diagnostic. It does not change `complete`, `retryable`,
`failureClass`, or the acquisition outcome. P1.7 owns that mapping.

## Safety and bounds

- `enumerateRenderedControlNodes` remains self-contained for Playwright
  serialization and still returns the complete matched set (never a 64-item
  prefix).
- Structural detection is attribute- and label-based and bounded to the control
  itself. `structuralKind` is measured from explicit semantics (`nav`,
  `summary`, menu roles, `aria-haspopup`, collapsed `aria-expanded`), a
  menu-like label, or membership in a `<nav>`/menu container. Container
  membership is measurement only: only explicit semantics or a menu-like label
  make a control a clickable disclosure, so ordinary section/TOC fragment
  links cannot exhaust the click budget ahead of the invite menu. Structural
  classification never reads the resolved href; hint/icon matching may still
  use it as destination evidence. A non-base-matched structural anchor that
  navigates to another document is not added to the click set, so a disclosure
  click cannot replace the document or spend the click budget on navigation.
  Navigation compares the resolved target against the current `document.URL`,
  not the effective `<base href>`, so an anchor resolving exactly to the base
  URI is still treated as navigation.
- An already-open `<details>` summary is not clicked: its content is already
  enumerated, and clicking would close it and hide controls.
- Label recovery scans only the control's own `title`, `aria-labelledby`
  references, any descendant `img[alt]`, `data-label`, `data-tooltip`, SVG
  `<title>`, and a bounded descendant-text walk capped at 200 collected
  characters (500 text nodes); each appended value is sliced to the remaining
  budget before concatenation. It does not scan page text. At most 16
  `aria-labelledby` id tokens are extracted without splitting the full
  attribute, and referenced labels are walked as text nodes (512 nodes, 200
  characters) rather than materializing a subtree.- A click that changes the document URL stops the click loop and counts the
  remaining queued controls as skipped. Only remaining hint/icon controls make
  that outcome an interaction gap; disclosure-only leftovers stay
  opportunistic. A menu handler or `javascript:` link cannot silently replace
  the page and leave later controls looking examined. Inspected pages are
  added to the crawl's visited set, so a structural link back to a completed
  page is not counted as an unexamined destination.
  The loop distinguishes a real document replacement from a same-document
  `pushState`/`replaceState` update by comparing `performance.timeOrigin`;
  history-only query changes continue to re-enumeration so newly revealed
  controls are still clicked. The same identity check governs the post-click
  required-link re-snapshot: a history-only query change still merges newly
  revealed same-host community links into the seed's required set, while a
  replaced document never contributes required obligations to the seed. The
  identity and initial link snapshot are refreshed for each seed attempt, so a
  Crawlee retry compares its own document rather than the failed attempt's.
- `collectRenderedPageContext` uses a bounded `TreeWalker` (2,000 elements,
  100 shadow roots) and a bounded frame scan over live `getElementsByTagName`
  collections (1,000). It never traverses frames or shadow roots. Context
  counters are refreshed after scrolling and after each click so transient
  interaction-revealed frames/shadows are counted. The baseline identity and
  counts are captured together in one evaluation before any counter sample, so
  a URL update during a probe is not mistaken for a replacement; a sample
  counts when either the document identity or the URL still matches this page.
  A same-document path/query update and a same-URL reload are both recorded,
  while a real navigation to another URL is left to its own request. A
  per-click probe is queued without awaiting it, so telemetry never delays the
  next click; pending probes are flushed at page end under a 250 ms cap that
  never exceeds the remaining crawl budget, and unfinished samples are
  dropped. A retry that throws before its first enumeration keeps the earlier
  control observation and merges context counts per field rather than
  replacing them with zeros. If a page cannot be measured because no
  trustworthy document identity was available, the internal resolver input
  `contextUnknown` forces `coverageReason: BOUNDED`, never `COMPLETE`. It is
  not persisted as a separate field, so consumers see the reason rather than
  the cause. Counters are aggregated on the page
  error path so an enumerated page is never published as zero.
- The published denominator and hint-rejected count come from one coherent
  enumeration snapshot (largest total; first wins ties). Structural and  icon-label counters are merged observations: a later, smaller snapshot can
  contribute a control that a click revealed, so they are combined per count
  rather than constrained to the denominator snapshot. A successfully clicked
  popup is excluded from the unexamined-context count. Each Crawlee retry
  replaces its request's previous-attempt observation instead of adding the
  same request to the crawl totals twice.
- The persistence boundary (`safeCrawlerTelemetry`) re-sanitizes every field:
  closed taxonomies, positive integers, fixed caps, rendered-only placement.
- No migration is required; the fields live in the existing
  `provenance.crawlerTelemetry` JSON document.

## Production query examples

Use the existing Coolify read-only path (SSH tunnel + `muse_readonly`), never
the historical Railway workflow. Verify `transaction_read_only=on` and
`default_transaction_read_only=on` before querying.

```sql
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- How much navigation was hidden by the hint filter in the last day?
-- Guard every JSON counter: a legacy or malformed row must not abort the
-- whole aggregate, and no matching rows must read as zero rather than NULL.
SELECT
  count(*) AS rendered_observations,
  coalesce(sum(CASE WHEN (provenance->'crawlerTelemetry'->>'controlsEnumeratedTotal') ~ '^[0-9]+$'
    THEN (provenance->'crawlerTelemetry'->>'controlsEnumeratedTotal')::bigint ELSE 0 END), 0) AS enumerated,
  coalesce(sum(CASE WHEN (provenance->'crawlerTelemetry'->>'controlsHintRejected') ~ '^[0-9]+$'
    THEN (provenance->'crawlerTelemetry'->>'controlsHintRejected')::bigint ELSE 0 END), 0) AS hint_rejected,
  coalesce(sum(CASE WHEN (provenance->'crawlerTelemetry'->>'controlsStructuralHintRejected') ~ '^[0-9]+$'
    THEN (provenance->'crawlerTelemetry'->>'controlsStructuralHintRejected')::bigint ELSE 0 END), 0) AS structural_hint_rejected,
  coalesce(sum(CASE WHEN (provenance->'crawlerTelemetry'->>'controlsStructuralDisclosure') ~ '^[0-9]+$'
    THEN (provenance->'crawlerTelemetry'->>'controlsStructuralDisclosure')::bigint ELSE 0 END), 0) AS structural_disclosure,
  coalesce(sum(CASE WHEN (provenance->'crawlerTelemetry'->>'controlsStructuralUnrecovered') ~ '^[0-9]+$'
    THEN (provenance->'crawlerTelemetry'->>'controlsStructuralUnrecovered')::bigint ELSE 0 END), 0) AS structural_unrecovered,
  coalesce(sum(CASE WHEN (provenance->'crawlerTelemetry'->>'controlsIconLabelRecovered') ~ '^[0-9]+$'
    THEN (provenance->'crawlerTelemetry'->>'controlsIconLabelRecovered')::bigint ELSE 0 END), 0) AS icon_label_recovered
FROM external_acquisition_observations
WHERE observed_at > now() - interval '1 day'
  AND provenance->>'surface' = 'CREATOR_WEBSITES'
  AND provenance->'crawlerTelemetry'->>'mode' = 'RENDERED';

-- Coverage-reason distribution for rendered creator observations.
SELECT
  coalesce(provenance->'crawlerTelemetry'->>'coverageReason', '(absent)') AS coverage_reason,
  count(*) AS observations
FROM external_acquisition_observations
WHERE observed_at > now() - interval '1 day'
  AND provenance->>'surface' = 'CREATOR_WEBSITES'
  AND provenance->'crawlerTelemetry'->>'mode' = 'RENDERED'
GROUP BY 1
ORDER BY 2 DESC;

COMMIT;
```

`(absent)` rows are rendered rows that predate P0.2/P1.1/P1.2 or lack a
stored `coverageReason` (for example, malformed direct telemetry). Static rows
are excluded by the `mode = RENDERED` filter, so they cannot appear as
`(absent)`. It is not a clean-coverage claim.

## Limits

- Structural detection is a heuristic. A label such as “more” or “support” can
  mark a control as structural; the click planner still bounds clicks per page
  and the enqueue path still decides navigation, so a false positive can spend
  click budget but cannot bypass admission.
- Original hint matches are clicked first, then icon-label recoveries, then
  structural disclosures; each group preserves DOM order. The 64-control
  evaluation window and the per-page click budget still apply, so a large
  recovered set can leave controls unexamined; that is reported through the
  existing overflow/skip counters, not hidden.
- `frameCount` includes advertising/analytics iframes. It is a presence
  counter, not proof that a frame contains navigation or invite evidence.
- `popupTargets` counts popup/dialog controls that need capture (ARIA
  haspopup, or a `_blank` control with no href). It does not capture or inspect
  the popup (P1.3). A normal external link that opens a new tab is still
  reachable through its href and is not counted.
- `shadowRootCount` counts open roots only. Closed roots remain unreachable and
  are a documented limit.
- `scrollCapReachedStillGrowing` is a post-hoc observation; content that grew
  after the final height read is not counted.
- `controlsEnumeratedTotal` counts selector-matched controls, not every
  clickable element in the DOM. The selector is the same one used for clicking.
- The coverage reason is not a recall estimate. It says a navigation surface
  was observed, not whether an invite existed behind it.

## Validation

- `npx tsc --noEmit` passes.
- Unit tests cover the coverage-reason precedence, exclusion sanitizer,
  rendered-only persistence, static-row rejection, and the P1.1/P1.2
  enumeration contract.
- Real-DOM browser fixtures (CI-only; local Android cannot run Playwright)
  cover mixed hint/structural/icon/popup controls, a generic hamburger that
  reveals an invite, and the bounded page-context collector.
- Source-contract tests keep the 64-control rotation, stable markers, overflow
  accounting, and both certificate-publish paths intact.
