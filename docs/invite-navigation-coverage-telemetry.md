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
  they can reveal content in place.
- **P1.2 icon labels.** A control whose only useful label is `title`,
  `aria-labelledby`, a child `img[alt]`, `data-label`, `data-tooltip`, an SVG
  `<title>`, or capped hidden `textContent` is now matched.

Recovered controls are **not** a coverage gap: they are clicked. The remaining
structural gap is `structuralUnrecovered` (structural anchors that navigate to
a real document and are owned by the enqueue path). P1.7 still owns the mapping
from coverage reason to `PARTIALLY_INSPECTED`/retry.

## Persisted fields

All fields are optional/sparse and rendered-only. They are counts or booleans;
none contains a URL, selector, element text, or payload.

| Field | Meaning |
| --- | --- |
| `controlsEnumeratedTotal` | Selector-matched controls before the community-hint filter. |
| `controlsHintRejected` | Controls the original community-hint filter would have excluded (`total - baseMatched`). |
| `controlsStructuralNavigation` | Menu/nav/hamburger/tab/summary/`aria-haspopup`/collapsed-`aria-expanded`/`role=menuitem` controls. |
| `controlsStructuralHintRejected` | Structural controls the original hint filter would hide. |
| `controlsStructuralDisclosure` | Structural controls included in the click set because they can reveal content in place. |
| `controlsStructuralUnrecovered` | Structural controls still outside the click set: anchors that navigate to a real document and are owned by the enqueue path. |
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
2. `BOUNDED` when a named ceiling, interaction gap, scroll-cap-still-growing, or
   `structuralUnrecovered` control was observed.
3. `CONTEXT_UNREACHABLE` when frames, open shadow roots, or popup targets were
   observed.
4. `POLICY_EXCLUDED` when `invalid-protocol`, `admission-rejected`,
   `cross-origin-disallowed`, or `destination-budget` exclusions occurred.
5. `COMPLETE` otherwise.

P1.1/P1.2 changed what counts as bounded. Recovered icon-label and structural
disclosure controls are clicked, so they no longer trigger `BOUNDED`. The
remaining structural gap is `structuralUnrecovered`: a structural anchor that
resolves to a different document is owned by the enqueue path, not the click
set.

`hint-rejected` and `control-slice` are measured in
`navigationPolicyExcluded` but are not policy exclusions for this reason:
`hint-rejected` is already represented by `controlsHintRejected`, and
`control-slice` already forces the interaction gap. A stronger reason wins over
a weaker one (for example, a timeout is `BOUNDED` even when frames are present).

The reason remains diagnostic. It does not change `complete`, `retryable`,
`failureClass`, or the acquisition outcome. P1.7 owns that mapping.

## Safety and bounds

- `enumerateRenderedControlNodes` remains self-contained for Playwright
  serialization and still returns the complete matched set (never a 64-item
  prefix).
- Structural detection is attribute- and label-based and bounded to the control
  itself. A structural anchor that navigates to another document is not added
  to the click set, so a disclosure click cannot replace the document or spend
  the click budget on navigation.
- Label recovery scans only the control's own `title`, `aria-labelledby`
  references, first child `img[alt]`, `data-label`, `data-tooltip`, SVG
  `<title>`, and `textContent` capped at 200 characters. It does not scan page
  text.
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
- Recovered controls are added after hint-matched controls in DOM order. The
  64-control evaluation window and the per-page click budget still apply, so a
  large recovered set can leave controls unexamined; that is reported through
  the existing overflow/skip counters, not hidden.
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
