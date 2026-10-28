# Invite navigation-coverage telemetry and control recovery (P0.2/P1.1/P1.2/P1.7)

**Status:** P0.2 instrumentation, P1.1/P1.2 control recovery, and P1.7 outcome
truthfulness. No selection, queue, or schema behavior changes.
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
`POLICY_EXCLUDED`, not `COMPLETE`. P1.7 maps that reason to outcome
truthfulness and retry ownership (see below).

## Persisted fields

All fields are optional/sparse and rendered-only. They are counts or booleans;
none contains a URL, selector, element text, or payload.

| Field | Meaning |
| --- | --- |
| `controlsEnumeratedTotal` | Selector-matched controls before the community-hint filter. |
| `controlsHintRejected` | Controls the original community-hint filter would have excluded (`total - baseMatched`). |
| `controlsStructuralNavigation` | Menu/nav/hamburger/tab/summary/`aria-haspopup`/collapsed-`aria-expanded`/`role=menuitem` controls. |
| `controlsStructuralHintRejected` | Structural controls the original hint filter would hide. |
| `controlsStructuralDisclosure` | Structural controls included in the click set because they can reveal content in place. An already-open `<details>` summary is excluded: its content is already in the DOM and clicking would close it. |
| `controlsStructuralUnrecovered` | Structural navigable anchors that are outside the click set and that the enqueue path will not follow: explicit menu-semantic or hint-recovered anchors, same-origin, admissible, not already visited, rejected by the community-hint filter. Ordinary “Learn more”/“Resources”/“Support” page links are not counted. If the enqueue path does not follow one, its destination was not examined; this forces `POLICY_EXCLUDED` (unless a stronger reason applies). |
| `controlsIconLabelRecovered` | Controls recovered by a label the original filter ignored: `title`, `aria-labelledby`, child `alt`, `data-label`, `data-tooltip`, SVG `<title>`, or capped hidden text. |
| `popupTargets` | Popup/dialog controls that require capture rather than navigation: `aria-haspopup="dialog|menu"` and href-less `target="_blank"` controls. A `_blank` anchor with a real href is reachable by navigation and is not counted. Presence only; no popup capture. |
| `frameCount` | `iframe`/`frame`/`object`/`embed` elements observed on processed pages. |
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
2. `BOUNDED` when a named ceiling, interaction gap, or scroll-cap-still-growing
   was observed.
3. `CONTEXT_UNREACHABLE` when frames, open shadow roots, or popup targets were
   observed.
4. `POLICY_EXCLUDED` when `cross-origin-disallowed` or `destination-budget`
   exclusions occurred, or when `unrecoveredNavigation` recorded an unfollowed
   structural navigation.
5. `COMPLETE` otherwise.

`invalid-protocol` and `admission-rejected` are format/security rejections
(mailto links, assets, private addresses), not unexamined navigation, so they do
not make an ordinary page a policy gap.

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
`navigationPolicyExcluded` but are not policy exclusions for this reason:
`hint-rejected` is already represented by `controlsHintRejected`, and
`control-slice` already forces the interaction gap. The narrower
`structuralUnrecovered` signal is different: it counts only explicit or
hint-recovered structural navigation anchors whose destination was neither
clicked nor enqueued, not every URL the hint filter rejected. A stronger
reason wins over a weaker one (for example, a timeout is `BOUNDED` even when
frames are present).

## Outcome truthfulness (P1.7)

A non-`COMPLETE` coverage reason is never a clean absence:

- `resolveRenderedCompletionState` sets `complete=false` and carries the
  fallback's retry ownership. `BOUNDED` (budget, interaction, scroll) is
  retryable; `POLICY_EXCLUDED` and `CONTEXT_UNREACHABLE` are visible partials
  without retry ownership.
- `renderedAcquisitionOutcome` maps the gap to `PARTIALLY_INSPECTED` (or
  `FOUND` when an invite was retained) with `RENDERED_POLICY_EXCLUDED`,
  `RENDERED_CONTEXT_UNREACHABLE`, or `RENDERED_PARTIAL_COVERAGE`.
- Required-link coverage cannot resolve clean while a coverage gap exists.
- `isSufficientRenderedCoverage` requires `coverageReason` to be absent or
  `COMPLETE`, so a gapped run never satisfies the site cache. Legacy rows
  without the field keep their previous behavior.
- `FOUND_GAP_RETRYABLE_FAILURE_CLASSES` includes
  `RENDERED_PARTIAL_COVERAGE` and `RENDERED_BUDGET_EXPIRED`; policy/context
  classes are intentionally absent, so deterministic gaps stay visible without
  spending retries.
- Retry ownership for a coverage gap is derived from the coverage reason, not
  the fallback's aggregate `retryable` flag. A permanently blocked required
  child can set that flag without making a deterministic context or policy gap
  recoverable; only `BOUNDED` owns retry from the gap itself. A separate
  transient required-child failure still keeps retry ownership, because that
  page can succeed on refetch even when the traversal limit cannot be cleared.

## Safety and bounds

- `enumerateRenderedControlNodes` remains self-contained for Playwright
  serialization and still returns the complete matched set (never a 64-item
  prefix).
- Structural detection is attribute- and label-based and bounded to the control
  itself. A non-base-matched structural anchor that navigates to another
  document is not added to the click set, so a disclosure click cannot replace
  the document or spend the click budget on navigation. Navigation compares
  the resolved target against the current `document.URL`, not the effective
  `<base href>`, so an anchor resolving exactly to the base URI is still
  treated as navigation.
- An already-open `<details>` summary is not clicked: its content is already
  enumerated, and clicking would close it and hide controls.
- Label recovery scans only the control's own `title`, `aria-labelledby`
  references, first child `img[alt]`, `data-label`, `data-tooltip`, SVG
  `<title>`, and a descendant-text walk capped at 200 collected characters
  (500 text nodes). It does not scan page text.
- A click that changes the document URL stops the click loop and counts the
  remaining queued controls as skipped. A menu handler or `javascript:` link
  cannot silently replace the page and leave later controls looking examined.
  The loop distinguishes a real document replacement from a same-document
  `pushState`/`replaceState` update by comparing `performance.timeOrigin`;
  history-only query changes continue to re-enumeration so newly revealed
  controls are still clicked. The same identity check governs the post-click
  required-link re-snapshot: a history-only query change still merges newly
  revealed same-host community links into the seed's required set, while a
  replaced document never contributes required obligations to the seed.
- `collectRenderedPageContext` uses a bounded `TreeWalker` (2,000 elements,
  100 shadow roots) and a bounded frame count (1,000). It never traverses
  frames or shadow roots.
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
SELECT
  count(*) AS rendered_observations,
  sum((provenance->'crawlerTelemetry'->>'controlsEnumeratedTotal')::int) AS enumerated,
  sum((provenance->'crawlerTelemetry'->>'controlsHintRejected')::int) AS hint_rejected,
  sum((provenance->'crawlerTelemetry'->>'controlsStructuralHintRejected')::int) AS structural_hint_rejected,
  sum((provenance->'crawlerTelemetry'->>'controlsStructuralDisclosure')::int) AS structural_disclosure,
  sum((provenance->'crawlerTelemetry'->>'controlsStructuralUnrecovered')::int) AS structural_unrecovered,
  sum((provenance->'crawlerTelemetry'->>'controlsIconLabelRecovered')::int) AS icon_label_recovered
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

`(absent)` rows predate P0.2/P1.1/P1.2 or are static rows; it is not a
clean-coverage claim.

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
