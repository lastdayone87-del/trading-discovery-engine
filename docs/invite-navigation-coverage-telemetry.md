# Invite navigation-coverage telemetry (P0.2)

**Status:** Implemented instrumentation. Measurement only; no outcome, retry,
selection, click, budget, queue, or schema behavior changes.
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

P0.2 adds bounded counters and a diagnostic coverage reason. It does **not**
change what the crawler clicks, enqueues, retries, or reports as an outcome.
P1.1/P1.2 use the counters to recover navigation; P1.7 decides when a coverage
reason must become `PARTIALLY_INSPECTED`.

## Persisted fields

All fields are optional/sparse and rendered-only. They are counts or booleans;
none contains a URL, selector, element text, or payload.

| Field | Meaning |
| --- | --- |
| `controlsEnumeratedTotal` | Selector-matched controls before the community-hint filter. |
| `controlsHintRejected` | Controls excluded by the community-hint filter (`total - matched`). |
| `controlsStructuralNavigation` | Menu/nav/hamburger/`aria-haspopup`/`aria-expanded`/`role=menuitem` controls, including controls inside `<nav>`/`role=navigation|menu|menubar` containers. Classification uses the control's own label/naming text, not its resolved href. |
| `controlsStructuralHintRejected` | Structural controls the hint filter would hide today. |
| `controlsIconLabelRecovered` | Controls whose useful label is only `title`, `aria-labelledby`, child `alt`, or `data-label`. |
| `popupTargets` | Popup/dialog controls that remain unexamined by the click loop and require capture rather than navigation: any non-false `aria-haspopup` value and `target="_blank"` controls without an HTTP(S) href. A `_blank` anchor with a followable HTTP(S) href is reachable by navigation and is not counted; a popup the click loop successfully examined is subtracted. Presence only; no popup capture. |
| `frameCount` | `iframe`/`frame`/`object`/`embed` elements observed on processed pages (bounded live-collection scan). |
| `shadowRootCount` | Open shadow roots observed on processed pages. Presence only; no traversal. |
| `baseHrefPresent` | A document `<base href>` was observed. |
| `scrollCapReachedStillGrowing` | The last permitted scroll iteration still found a growing document. |
| `navigationPolicyExcluded` | Counts by `invalid-protocol`, `admission-rejected`, `cross-origin-disallowed`, `destination-budget`, `control-slice`, `hint-rejected`. |
| `coverageReason` | `COMPLETE`, `BOUNDED`, `POLICY_EXCLUDED`, `CONTEXT_UNREACHABLE`, or `UNKNOWN`. |

Existing fields keep their semantics:

- `evidenceControlsTotal` remains the hint-matched control count, not the
  pre-filter denominator. `controlsEnumeratedTotal` is the new denominator.
- `evidenceControlsSkipped` remains the interaction-budget skip count.
- `dropReasons` remains the canonical enqueue/selection ledger.
- `zeroPageReason` already records `GATE_SATURATED`, `BROWSER_LAUNCH_FAILED`,
  and the other zero-page reasons, so P0.2 does not duplicate them in a
  `renderedGateRejected` map.

## Coverage-reason precedence

`resolveRenderedCoverageReason` is intentionally conservative:

1. `UNKNOWN` when no page was processed.
2. `BOUNDED` when a named ceiling, interaction gap, scroll-cap-still-growing,
   structural hint rejection, icon-label recovery, or unresolved terminal
   request failure was observed. A failed child request can hide a destination,
   so it is never reported as `COMPLETE`.
3. `CONTEXT_UNREACHABLE` when frames, open shadow roots, or unexamined popup
   targets were observed. Popups the click loop successfully examined are not
   context gaps.
4. `POLICY_EXCLUDED` when `invalid-protocol`, `admission-rejected`,
   `cross-origin-disallowed`, or `destination-budget` exclusions occurred.
5. `COMPLETE` otherwise.

`hint-rejected` and `control-slice` are measured in
`navigationPolicyExcluded` but are not policy exclusions for this reason:
`hint-rejected` is already represented by `controlsHintRejected`, and
`control-slice` already forces the interaction gap. A stronger reason wins over
a weaker one (for example, a timeout is `BOUNDED` even when frames are present).

The reason is diagnostic in P0.2. It does not change `complete`, `retryable`,
`failureClass`, or the acquisition outcome. P1.7 owns that mapping.

## Safety and bounds

- `enumerateRenderedControlNodes` remains self-contained for Playwright
  serialization and still returns the complete matched set (never a 64-item
  prefix).
- Label recovery scans only the control's own `title`, `aria-labelledby`
  references, first child `img[alt]`, and `data-label`. It does not read page
  text or hidden content. At most 16 `aria-labelledby` id tokens are extracted
  without splitting the full attribute, and referenced labels are walked as
  text nodes (512 nodes, 200 characters) rather than materializing a subtree.
- `collectRenderedPageContext` uses a bounded `TreeWalker` (2,000 elements,
  100 shadow roots) and a bounded frame scan over live `getElementsByTagName`
  collections (1,000). It never traverses frames or shadow roots. Context
  counters are refreshed after scrolling and after same-document clicks so
  interaction-revealed frames/shadows are counted, and aggregated on the page
  error path so an enumerated page is never published as zero.
- The published denominator and hint-rejected count come from one coherent
  enumeration snapshot (largest total; first wins ties). Structural and
  icon-label counters are merged observations: a later, smaller snapshot can
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

`(absent)` rows are rendered rows that predate P0.2 or lack a stored
`coverageReason` (for example, malformed direct telemetry). Static rows are
excluded by the `mode = RENDERED` filter, so they cannot appear as `(absent)`.
It is not a clean-coverage claim.

## Limits

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
  rendered-only persistence, and static-row rejection.
- Real-DOM browser fixtures (CI-only; local Android cannot run Playwright)
  cover mixed hint/structural/icon/popup controls and the bounded page-context
  collector.
- Source-contract tests keep the 64-control rotation, stable markers, overflow
  accounting, and both certificate-publish paths intact.
