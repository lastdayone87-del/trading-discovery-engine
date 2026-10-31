# Navigation follow-up security review

**Status:** review package prepared; **security approval not yet obtained**.
**Scope:** P1.3 popups, P1.4 frames/shadow roots, P1.6 cross-origin rendered
enqueue, P1.8 response wrappers, and the P2 retry/host levers in
`docs/invite-navigation-p2-p4-readiness.md`.
**Rule:** none of these surfaces may be enabled in production until the exit
criteria in §8 are met.

## 1. Why this review is separate

P1.1/P1.2/P1.5/P1.7/P1.9 stay within the existing single-document static or
rendered path. The follow-ups change one or more trust boundaries:

- they read content from additional document contexts (popups, frames, shadow
  roots);
- they admit additional navigation targets (cross-origin enqueue);
- they parse additional response formats (XHTML/XML/feed/error bodies/charsets);
- they change retry pressure on external hosts.

Each is a bounded recall improvement, but each also adds a way for hostile or
malformed content to consume resources or influence what the crawler retains.

## 2. Assets and threat model

**Assets**

- production worker availability, browser/CPU/memory, queue capacity;
- the crawler's network position: it must never reach private, loopback,
  link-local, metadata, or internal service addresses;
- candidate evidence integrity: a third-party or error-page candidate must not
  be presented as a creator-owned validated invite;
- credentials, cookies, session state, and any operator-only data;
- user/creator data retained in observations and candidates.

**Threat sources**

- hostile creator pages and user-generated content;
- compromised third-party embeds, frames, feeds, or link hubs;
- redirect chains and DNS rebinding;
- malformed HTML/XML/charset/error bodies designed to exhaust CPU or memory;
- pages that open many popups/frames or keep them alive;
- pages that try to make the crawler interact with authentication, payment, or
  account flows.

**Out of scope / explicitly forbidden**

- CAPTCHA/WAF evasion, credential replay, auth or paywall bypass;
- private-content crawling, account creation, form submission, purchases;
- blanket cross-origin crawling or removal of the destination policy;
- executing untrusted JavaScript outside the existing browser sandbox;
- production enablement or canary execution as part of this review.

## 3. Existing controls the new surfaces must preserve

These are present in the current rendered path and are prerequisites, not
substitutes for review:

- shared `assessCrawlAdmission` / `shouldFollowDestination` destination policy;
- `assessPublicDestination` checks at fetch time, including redirect targets;
- a context-wide Playwright route guard for every browser request;
- a loopback egress proxy that resolves once, rejects non-public answers, and
  pins the selected address (closes the browser DNS-rebinding gap);
- service workers blocked, one request at a time, isolated request queue,
  page/click/scroll/time budgets, and a browser runtime lease;
- no storage-state import or authenticated session injection;
- bounded response bodies and sanitized telemetry (closed taxonomies, no page
  text or URLs in counters).

The review must confirm that popups, frames, and new parsers stay behind these
controls rather than creating a parallel path around them.

## 4. Surface-specific risks and required controls

### 4.1 P1.3 popups

| Risk | Required control | Evidence required |
| --- | --- | --- |
| Popup opens a private/metadata address | Context route + egress proxy + explicit `assessCrawlAdmission`/`assessPublicDestination` before reading | Fixture for `window.open('http://169.254.169.254/...')` and redirect-to-private |
| Popup opens an auth/payment/OAuth flow | Never interact; extract-only; reject non-HTTP(S); no form fill | Fixture with a login form and an OAuth-like popup |
| Popup never closes / leaks listeners | Hard lifetime ceiling; close in `finally`; remove listeners; capture cap | Repeated-request test asserting page/listener counts |
| Popup chain / popup bomb | No recursive capture; per-page and per-crawl caps | Cap fixture; assert third popup is uninspected |
| Blank popup navigates later | Bounded readiness wait; re-check final URL before read | Blank-then-navigate fixture |
| Popup body is binary/huge | Content-type gate; 256 KiB cap; no download handling | PDF/large-body fixture |

### 4.2 P1.4 frames and shadow roots

| Risk | Required control | Evidence required |
| --- | --- | --- |
| Cross-origin frame reads data the page did not intend to expose | Stage 4c only after approval; extraction-only; no injection/click | Explicit approval note and negative fixture |
| Frame bomb / nested frames | Per-page/per-crawl frame caps, depth 1, bounded bytes | 11-frame and nested-frame fixtures |
| Frame points at private address | Shared admission + route/proxy; reject before read | Private-IP iframe fixture |
| Shadow-root traversal is unbounded | Element/root/depth caps; no closed-root access | Large-DOM fixture and closed-root fixture |
| Closed-root blind spot becomes a false clean | Count closed roots (observer) or document the blind spot; force context-unreachable | Fixture proving clean is not claimed |
| Clicking inside a frame causes side effects | No clicks in frames in stages 4b/4c | Source/behavior test |
| Detached frame breaks the run | Bounded try/catch; partial reason; no listener leak | Detach fixture |

### 4.3 P1.6 cross-origin rendered enqueue

| Risk | Required control | Evidence required |
| --- | --- | --- |
| Weak generic link opens an arbitrary host | Shared destination policy; strong-label requirement; admission | Unit tests already present |
| One page consumes the page budget | Crawl-wide cap of 3; `destination-budget` telemetry | Planner cap tests |
| Discord invite page is fetched unnecessarily | Discord host exclusion; invite extraction path owns it | Host exclusion test |
| Cross-origin target is private/rebinding | Route/proxy and admission apply to the enqueued request | External destination safety test |
| Optional cross-origin failure inflates retries | Canary must separate optional failures from required coverage; stop rule | Canary plan in P2–P4 package |
| Anchor-text mismatch (Crawlee label) | Bounded href+text collection before enqueue; planner tests | Regression for generic path with strong label |

### 4.4 P1.8 response wrappers

| Risk | Required control | Evidence required |
| --- | --- | --- |
| XML entity expansion / billion laughs | No DTD/entity expansion; truncate/reject internal subset; bounded text extraction | Entity fixture with a hard time bound |
| Parser CPU/memory blowup | 1 MiB decoded cap, 1,000 link cap, linear scans, no recursive feed parsing | Large/truncated fixtures |
| Charset confusion hides or invents links | Whitelist + BOM + explicit unknown/unsupported outcome; no heuristic guessing without a declared charset | UTF-16/unsupported/invalid fixtures |
| Error-page invite is presented as validated | New `HTTP_ERROR_WRAPPER` provenance; candidate only; never serving authority | Projection/display test |
| 403 challenge page is mined | Block-marker check runs first; no candidate extraction from challenges | Challenge fixture |
| Reading 429/5xx bodies breaks retry budget | Status policy keeps those bodies unread | Retry-after regression |

### 4.5 P2 retry/host levers

| Risk | Required control | Evidence required |
| --- | --- | --- |
| Retry amplification / hostile load on a host | Host caps, jitter, `Retry-After`, no increase for zero-recovery hosts | Canary host metrics |
| Starvation of recoverable hosts | Priority classes and queue-age guard | Canary conversion/backlog metrics |
| 403 escalation becomes access-control bypass | No credentials/CAPTCHA; bounded rendered attempt; block markers respected | Security sign-off + fixture |
| Long-attempt re-dating distorts fairness | Investigate claim starvation first; no purge; canary | Queue metrics |

## 5. Data retention and privacy

- Popup/frame extraction stores only candidate locators, source surface, and
  bounded provenance; it does not store page text, titles, form values, or
  screenshots.
- Error-wrapper candidates carry status/provenance and remain non-serving
  until validated.
- No credentials, cookies, auth headers, or session state may appear in logs,
  telemetry, observations, or PR evidence.
- A popup/frame that requires authentication is not a candidate source; it is
  counted as inaccessible/partial.
- The existing `muse_readonly` production access is unrelated to this review.
  If production evidence is needed, it must use `BEGIN TRANSACTION READ ONLY`
  and the Coolify production-access path (PR #564;
  `docs/production-infrastructure.md` once merged).

## 6. Abuse and resource-exhaustion checklist

- [ ] Every new context has a per-page and per-crawl cap.
- [ ] Every wait has a deadline; no network-idle dependency.
- [ ] Every listener/route/page is removed or closed on success, timeout, and
      exception paths.
- [ ] Every parser is linear in input size and bounded before allocation.
- [ ] No new unbounded recursion (popup-of-popup, frame-of-frame, feed-of-feed).
- [ ] No new DNS/HTTP path bypasses the shared admission or egress proxy.
- [ ] No new secret, token, or credential is introduced.
- [ ] Telemetry remains closed-taxonomy and content-free.
- [ ] Cross-origin enablement remains default OFF and capped.
- [ ] A kill switch/flag exists for each surface and is documented.

## 7. Validation required before approval

1. Unit tests for all policy/planner/parser decisions.
2. CI Chromium fixtures for:
   - popup capture and cleanup;
   - private-IP popup/iframe rejection;
   - open/closed shadow root behavior;
   - same-origin and cross-origin frame handling;
   - error-body provenance and challenge rejection;
   - charset/feed/entity bounds.
3. External-destination safety regression suite remains green.
4. A resource test proving repeated popup/frame requests do not grow pages,
   listeners, or memory without bound.
5. A dry-run report showing which existing production candidates would have
   been sourced from each new surface (counts only, no production enablement).

## 8. Exit criteria and approvals

The security review is complete only when all of the following are recorded:

- [ ] written threat-model acceptance of §4 controls;
- [ ] test evidence for every row marked "required";
- [ ] confirmation that no production flag/setting/budget changed;
- [ ] explicit approval for popup content, same-origin frame content, and (if
      requested) cross-origin frame content;
- [ ] explicit approval for error-wrapper candidate provenance and display;
- [ ] canary/stop-rule approval for P1.6 and each P2 lever;
- [ ] rollback owner and procedure.

**Approvals are external.** This document prepares the review; it does not
grant it. Until approval is recorded, the safe state is: all new surfaces
default OFF, existing single-document behavior unchanged, and no production
canary.

## 9. Open questions for the reviewer

1. Is extraction-only reading of a cross-origin frame the page already loaded
   acceptable, or should frames be restricted to same-origin permanently?
2. May a closed-shadow-root observer patch `attachShadow`, or is the documented
   blind spot preferable?
3. May candidates from 403/404 bodies be retained as evidence, and with what
   UI label, given they are not validated invites?
4. What is the maximum acceptable browser-time increase per seed for popup and
   frame inspection?
5. Should optional cross-origin page failures be excluded from the seed's
   retry ownership entirely, or only from clean-completion claims?
