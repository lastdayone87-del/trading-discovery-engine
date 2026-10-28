# Popup and frame/shadow navigation design (P1.3 / P1.4)

**Status:** design only. Not implemented, not enabled, and not authorized for
production.
**Depends on:** P1.1/P1.2 structural control recovery (PR #560) and the P0.2
coverage telemetry.
**Security review:** `docs/invite-navigation-security-review.md`.

## 1. Problem

The rendered tier currently inspects one document context: the main frame of
the page it navigated to.

- Popup/new-tab destinations are counted as `popupTargets`, but no popup is
  captured. A control that opens an invite wrapper in a new tab can therefore
  be counted as an unexamined navigation surface and still leave no invite
  evidence.
- Frame and shadow-root presence is counted (`frameCount`, `shadowRootCount`),
  but neither is traversed. An invite inside a same-origin child frame or an
  open shadow root is invisible to extraction and clicking.
- Closed shadow roots are not observable with the current counter and are not
  represented in coverage at all.

The plan's acceptance criteria require these contexts to be either inspected
or reported as a named coverage gap. A clean `INSPECTED_NO_MATCH` is not
acceptable when one of these surfaces could hold the invite.

## 2. Current behavior (verified in the P1.1/P1.6 tree)

- `enumerateRenderedControlNodes` counts `aria-haspopup=dialog|menu` and
  `target=_blank` controls without a navigable href as `popupTargets`.
- `collectRenderedPageContext` counts up to 1,000 frame elements and up to 100
  open shadow-root hosts, but does not read either.
- The rendered crawl runs one Playwright page per request. The browser context
  has a route guard for every URL, and a loopback egress proxy pins public DNS
  answers. The route guard also covers popups; this is a safety foundation, not
  popup inspection.
- `resolveRenderedCoverageReason` already treats observed frames/shadow roots
  and popup targets as incomplete context, so the system does not currently
  claim completeness when they are present. That is conservative by design.

## 3. P1.3 — popup/new-tab capture

### 3.1 Scope

Capture popup documents opened by a rendered click or by a `window.open` on
the seed document, extract invite candidates from them, and close them. Do not
interact with popup content, do not fill forms, and do not navigate popups
further.

### 3.2 Why popups are different from normal links

A `target=_blank` anchor with a real href is already reachable by enqueueing
that href; the existing counter excludes it. P1.3 targets controls that open a
document without a usable href, such as a JS handler that calls
`window.open(...)`, or a dialog that hosts a cross-origin wrapper. Those URLs
are otherwise never requested by the crawl.

`aria-haspopup=dialog` may open an in-page dialog rather than a browser popup.
P1.1's click loop already owns in-place disclosure. P1.3 must not count an
in-page dialog as a captured popup; the distinction is the appearance of a new
Playwright page, not the ARIA attribute.

### 3.3 Proposed execution

1. Register `page.on('popup')` before the click loop and `context.on('page')`
   as a backstop. Deduplicate by Playwright page identity.
2. When a popup appears, record it and wait only for a bounded readiness signal
   (`domcontentloaded` or `load`, 1,500 ms ceiling). Never wait indefinitely for
   network idle.
3. Resolve the final popup URL. `about:blank`, `data:`, `blob:`, `file:`, and
   other non-HTTP(S) documents are rejected. Apply the shared
   `assessCrawlAdmission` + `assessPublicDestination` checks before reading
   content; the context route/proxy remains the enforcement point for network
   traffic.
4. Read a bounded body (`<= 256 KiB`) and extract invite candidates only. Do
   not click, scroll, enqueue, or recursively open popups from a popup.
5. Add the popup URL to the page's observed contexts. If the URL was also
   enqueued by the normal same-host pass, deduplicate at the visit-key level.
6. Close the popup in a `finally` block and remove listeners. A popup that
   cannot be closed must not leak into the next request.

### 3.4 Bounds

| Bound | Proposed initial value | Behavior on hit |
| --- | ---: | --- |
| Popups captured per page | 2 | Remaining popup controls count as `popup-uninspected` |
| Popups captured per rendered crawl | 5 | Remaining popups count as `popup-uninspected` |
| Popup readiness wait | 1,500 ms | Capture the current DOM if readable; else count uninspected |
| Popup body read | 256 KiB | Mark truncated; extraction is text-only |
| Popup lifetime | 10 s hard ceiling | Force close; count uninspected |
| Recursive popups | 0 | Never followed |

All counters are closed taxonomies. No popup URL, title, or body text is
persisted in telemetry.

### 3.5 Outcome semantics

- Popup inspected and candidate found: candidate is retained with source
  surface `RENDERED_POPUP` (new closed enum value) and source URL.
- Popup inspected with no candidate: the popup is covered; the page can still
  be complete only if every other context is covered.
- Popup detected but not captured or not readable: coverage reason
  `CONTEXT_UNREACHABLE` (or a dedicated `popup-uninspected` reason), never
  `COMPLETE`.
- Popup rejected by admission: `POLICY_EXCLUDED` with the existing
  `admission-rejected`/`cross-origin-disallowed` reason; it is not a clean
  absence, but it is not retryable just because a policy rejected it.

### 3.6 Acceptance tests

1. A button with no href calls `window.open('/community')`, and that page
   contains `discord.gg/<code>`; the crawl returns `FOUND` with the code.
2. A popup control opens `about:blank` and then navigates to a private IP; the
   popup is rejected before content is read, the run is not clean, and no
   request reaches the private address.
3. Two popups are captured; a third is counted as uninspected and suppresses
   `COMPLETE`.
4. A popup that never becomes readable is closed within the lifetime ceiling;
   the next request still runs.
5. A `target=_blank` anchor with a real href is not double-captured; the
   enqueue path owns it.
6. A popup that opens a PDF/binary document is rejected as unsupported
   content, not parsed as HTML.
7. Popup listeners are removed and pages closed on success, timeout, and
   exception paths.

## 4. P1.4 — frames and shadow roots

### 4.1 Staged scope

P1.4 is split so safety review can advance without enabling every context.

| Stage | Context | Read/extract | Click | Default |
| --- | --- | --- | --- | --- |
| 4a | Open shadow roots | Yes | Same-document controls only | OFF |
| 4b | Same-origin child frames | Yes | No | OFF |
| 4c | Admitted cross-origin child frames | Extract only | No | OFF |

Closed shadow roots are out of scope for content extraction. They are covered
by a separate detection/telemetry rule (4.4).

### 4.2 Shadow roots

- Playwright CSS locators pierce open shadow roots, so verify rather than
  assume whether the existing enumeration already includes controls inside
  them. The fixture must assert the actual behavior before adding traversal.
- If locators do not include a control, use a bounded `TreeWalker` that enters
  open `shadowRoot` trees (depth-first, max 2,000 elements, 25 roots, and depth
  2) and returns the same descriptor shape as the main document.
- Store markers on the control element. Playwright's marker locator must
  resolve through the open root; if it cannot, do not invent an index-based
  fallback that can click the wrong element.
- Click only controls that disclose content in place. A shadow-root anchor
  with a real document destination stays enqueue-owned, exactly like a
  light-DOM anchor.
- Do not cross into a closed root; `element.shadowRoot` is null there.

### 4.3 Frames

- Enumerate `page.frames()` after load. Skip the main frame.
- Apply `assessCrawlAdmission` to each frame URL. The browser already fetched
  the frame as a subresource, but this policy decides whether its content is in
  scope and keeps a uniform admission boundary.
- Stage 4b reads same-origin frames only; extraction is text/link based and
  bounded. No form fills, no clicks, no scrolling inside frames.
- Stage 4c reads admitted cross-origin frames only after security review. It
  must not inject scripts or click. Reading a cross-origin frame that the page
  already loaded is a data-visibility question, not a new network request, but
  it still requires explicit approval because it changes what content the
  crawler retains.
- Nested frames: depth 1 only (seed document plus its direct children). Deeper
  frames count as uninspected.
- Frames whose URL is not admitted are counted as policy-excluded; frames that
  cannot be read are context-unreachable.

### 4.4 Closed shadow roots

A closed root cannot be read from page script. To avoid a silent clean claim,
propose an optional init script installed before page scripts that wraps
`Element.prototype.attachShadow` only to count closed-root creation. It must:

- not read, retain, or expose the root or its content;
- preserve the original `attachShadow` return value and errors;
- be best-effort: a page that replaces the API later may hide subsequent
  roots;
- set a `closedShadowRootObserved` counter that maps to
  `CONTEXT_UNREACHABLE`, with the limitation documented.

If the init script is rejected by security review, the fallback is an explicit
documented blind spot: closed roots cannot be detected, and the crawler must
not claim that closed-root content was examined. The report wording must say
so.

### 4.5 Bounds

| Bound | Proposed initial value |
| --- | ---: |
| Frame elements considered per page | 10 |
| Frame documents read per page | 5 |
| Frame documents read per crawl | 20 |
| Frame nesting depth | 1 |
| Bytes read per frame | 256 KiB |
| Open shadow roots traversed per page | 25 |
| Elements examined per shadow tree | 2,000 |
| Shadow tree depth | 2 |

Hitting a bound produces a named coverage gap; it never counts as complete.

### 4.6 Coverage integration

P1.7 currently uses observed frame/shadow counts to mark context unreachable.
P1.4 must split observation from outcome:

- `framesObserved`, `framesInspected`, `framesPolicyExcluded`,
  `framesUnreadable`
- `shadowRootsObserved`, `shadowRootsTraversed`, `closedShadowRootsObserved`
- `popupsObserved`, `popupsInspected`, `popupsUninspected`,
  `popupsPolicyExcluded`

Coverage is computed in this order:

1. **`COMPLETE`** requires every observed frame, shadow root, and popup to be
   inspected: `framesObserved == framesInspected`,
   `shadowRootsObserved == shadowRootsTraversed`, and
   `popupsObserved == popupsInspected` (plus the existing page/control/scroll
   certificates). A policy-excluded frame or popup is *not* inspected, so it
   can never satisfy these equalities.
2. **`CONTEXT_UNREACHABLE`** when at least one observed context is neither
   inspected nor policy-excluded (unreadable/detached frame, cap-hit, or
   uninspected popup). It keeps retry ownership only while the failure is
   transient.
3. **`POLICY_EXCLUDED`** when every observed context is either inspected or
   policy-excluded, and at least one was policy-excluded. This is a terminal
   partial: it suppresses `COMPLETE` and visible absence claims, but it does
   not own a retry.

If a page has both a policy-excluded frame and an unreadable frame, the
unreadable frame wins for retry ownership (`CONTEXT_UNREACHABLE`), while the
policy exclusion remains visible in the counters. "No retry needed" and
"fully inspected" are therefore separate decisions: policy exclusion can close
retry work without ever producing a clean `COMPLETE`.

### 4.7 Acceptance tests

1. An invite inside an open shadow root is found; the run is complete only if
   every observed root was traversed.
2. An invite inside a closed root is not found; the run is marked
   context-unreachable, not clean. If closed-root detection is unavailable,
   the documented blind spot is asserted in the report.
3. An invite inside a same-origin iframe is found; no click occurs inside the
   frame.
4. A cross-origin iframe containing an invite is either extracted after
   approval or reported policy-excluded/context-unreachable, never clean.
5. A page with 11 frames reads at most the bound and reports the remainder.
6. An iframe pointing at a private address is rejected by the shared admission
   and the browser route/proxy.
7. A frame that detaches during extraction is bounded and does not fail the
   whole seed or leak a listener.
8. No recursive popup/frame expansion and no unbounded listener growth across
   requests.

## 5. Rollout and approvals

1. Land P1.3/P1.4 code default OFF, behind separate budget flags.
2. Complete the security review in
   `docs/invite-navigation-security-review.md`.
3. Run fixture-only and CI Chromium validation.
4. Canary one stage at a time (popups, then shadow roots, then same-origin
   frames); cross-origin frames require a separate approval.
5. Measure candidate yield, context-read failures, page/browser time, and
   retry attribution. Stop on any SSRF/admission violation or material latency
   increase.

Exact approvals required before enablement:

- security owner: popup/frame data visibility, parser and listener bounds,
  closed-root observation;
- product owner: whether popup/frame content is in acquisition scope;
- canary owner: cohort, duration, stop thresholds;
- release owner: deployment window and rollback.

No production flag, budget, or concurrency change is part of this design.
