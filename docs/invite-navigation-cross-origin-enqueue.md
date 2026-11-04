# Rendered cross-origin enqueue (P1.6)

**Status:** implemented, default **OFF**, not enabled in production.  
**Depends on:** P1.1/P1.2 structural control recovery (#560).

## Problem

The rendered tier enqueues navigation with Crawlee's `same-hostname` strategy.
A community link inserted by JavaScript on a link hub or creator page can
therefore be visible in the DOM, pass the destination policy, and still never
be inspected because it points at another host. Static navigation already uses
`shouldFollowDestination`; rendered navigation did not.

## Behavior

`BrowserFallbackBudget.crossOriginEnqueue` is an opt-in boolean. When absent or
false, no cross-origin page is enqueued: the rendered crawl keeps its two
`same-hostname` passes. The collector still classifies discovered cross-origin
anchors so an eligible community destination that pursuit did not follow is a
visible policy exclusion (`cross-origin-disallowed`), not a silent absence;
unrelated and admission-rejected links only update diagnostic counters.

When enabled, a second `enqueueLinks` pass admits a candidate only if all of
the following hold:

1. It is not same-origin. Same-origin links keep the existing community-hint
   enqueue rule, so enabling P1.6 cannot broaden same-host navigation.
2. It is not already visited or already queued by an earlier cross-origin pass
   in this crawl.
3. The crawl-wide cross-origin cap
   (`MAX_RENDERED_CROSS_ORIGIN_ENQUEUES = 3`) has room. A skip is counted as
   `destination-budget`.
4. The shared `shouldFollowDestination` policy admits the target
   (`shouldEnqueueRenderedCrossOriginLink`). Unrelated and weak/generic
   destinations are counted as `hint-rejected`, admission/security rejections
   as `admission-rejected`, and only an eligible community destination left
   unvisited by the cap counts as `cross-origin-disallowed`.
5. It is not a native Discord invite URL (`discord.gg/code`,
   `discord.com|discordapp.com|discord.app/invite/code`). Those are terminal
   candidates already extracted from the page, so enqueueing them would spend
   page budget on a surface the crawler does not need to inspect. Redirect
   shorteners (`dsc.gg`, `discord.me`, `discord.io`) and directory pages
   (`disboard.org`) carry no native code, so they pass through the destination
   policy and remain navigable.

The pass captures cross-origin anchors before interactions, so a click that
replaces the document cannot hide them, but submits only after the post-click
same-host pass. Before the click loop, the same cap plan reserves the
destinations that would be admitted; the click plan treats reserved URLs as
enqueue-owned while leaving inspectable eligible hubs beyond the cap clickable.
Because no queue slot is committed until after interactions, optional
destinations never take queue positions ahead of JS-revealed required same-host
links. Each
candidate keeps the page URL where it was observed, so a click that navigates
elsewhere cannot retroactively make the pre-click snapshot's cross-origin links
look same-origin. The merged pre/post-click snapshots are deduplicated by
normalized visit URL before accounting (all labels sharing a normalized URL are
evaluated together, so a weak first anchor cannot hide a later community
label), so an anchor present in both states is never counted twice in drop
telemetry.

Admitted third-party pages are tagged (`userData.crossOrigin = true`) and skip
their own same-host hint passes when their handler runs. Their bounded
cross-origin pass still runs, so the crawl-wide cap bounds the whole optional
branch rather than only the first hop; an admitted link hub cannot enqueue an
uncapped set of its own hint links and consume `maxPages`. Interaction-revealed
same-origin destinations and popups opened by a tagged third-party page inherit
the same tag and consume the same cap; when it is exhausted they are recorded
as `destination-budget` instead of being enqueued.

## Policy and safety boundary

- `shouldFollowDestination` is the single destination policy: shared crawl
  admission (scheme/host/resource/SSRF checks), known link-hub/community hosts,
  strong community evidence, and the weak-label rejection stay in force.
- The cap is per rendered crawl, not per page, so a page with many external
  links cannot consume the full `maxPages` budget. Third-party pages do not
  fan out through the same-host hint pass, so their child pages cannot bypass
  the cap either.
- A clean required-covered negative is explicitly non-retryable only when the
  run actually admitted cross-origin work (`crossOriginEnqueued > 0`). With
  P1.6 off, an eligible cross-origin destination is still recorded as
  `cross-origin-disallowed` so the run is a visible policy-excluded partial
  rather than a clean absence; no cross-origin request or retry is created.
  Unrelated and admission-rejected links do not change the outcome. Partial
  rows keep the existing site-evidence TTL.
- Cross-origin destinations are optional evidence. They never become seed
  `required` obligations, which remain same-host community-hint links only.
- The browser route guard and loopback egress proxy still enforce public
  destination and DNS pinning on every navigation and subrequest.
- `destination-budget` and `cross-origin-disallowed` are already closed
  telemetry reasons; no schema or migration change.

## Why default OFF

Cross-origin navigation increases the set of hosts a rendered crawl can
contact and can spend page budget on optional destinations. Enabling it
requires:

1. a security review of cross-origin navigation/SSRF boundaries;
2. a canary with measured cross-origin yield, page-budget consumption, and
   failure/retry attribution;
3. a product decision that link-hub/community destinations are in scope for
   rendered acquisition.

Until those approvals exist, only tests may enable the option. Click-plan
ownership is already enforced: the pre-click reservation and the live
`crossOriginQueued` set are threaded into initial and post-click click planning,
so an admitted destination is never both enqueued and clicked, while inspectable
over-cap hubs remain clickable.

## Validation

- Pure policy tests cover same-origin rejection, known link hub, strong
  community evidence, weak-label rejection, native-invite-only Discord
  exclusion, redirect/directory Discord admission, per-snapshot origin
  retention, merged-snapshot deduplication, admission-rejected targets,
  malformed URLs, the cap constant, pre-click reservation, deferred
  submission, and the default-OFF budget.
- `npx tsc --noEmit`: pass.
- Targeted rendered/fallback suites: pass.

## Rollout

1. Land this PR with the option unset.
2. Run the canary with the option enabled only for an allowlisted experiment
   cohort, collecting `destination-budget`, `cross-origin-disallowed`, retained
   candidates, page count, and retry/failure attribution.
3. Keep the cap at 3 unless the canary shows unused page budget with positive
   marginal yield.
4. Disable immediately if cross-origin requests increase SSRF/admission
   violations, retries, or latency without candidate yield.
