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
false, the rendered crawl is byte-for-byte the previous behavior: one
`same-hostname` enqueue pass before interactions and one after.

When enabled, a second `enqueueLinks` pass admits a candidate only if all of
the following hold:

1. It is not same-origin. Same-origin links keep the existing community-hint
   enqueue rule, so enabling P1.6 cannot broaden same-host navigation.
2. It is not already visited or already queued by an earlier cross-origin pass
   in this crawl.
3. The crawl-wide cross-origin cap
   (`MAX_RENDERED_CROSS_ORIGIN_ENQUEUES = 3`) has room. A skip is counted as
   `destination-budget`.
4. `shouldEnqueueRenderedCrossOriginLink` returns true: the shared
   `shouldFollowDestination` policy must admit the target. Admission-rejected
   and weak/generic destinations are counted as `cross-origin-disallowed`.
5. It is not a Discord destination. Discord links are terminal invite
   candidates extracted from the page; enqueueing them would spend page budget
   on a surface the crawler does not need to inspect.

The pass captures cross-origin anchors before interactions, so a click that
replaces the document cannot hide them, but submits only after the post-click
same-host pass. Optional destinations therefore never take queue positions
ahead of JS-revealed required same-host links.

## Policy and safety boundary

- `shouldFollowDestination` is the single destination policy: shared crawl
  admission (scheme/host/resource/SSRF checks), known link-hub/community hosts,
  strong community evidence, and the weak-label rejection stay in force.
- The cap is per rendered crawl, not per page, so a page with many external
  links cannot consume the full `maxPages` budget.
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
   rendered acquisition;
4. click-plan ownership: an admitted destination must not also be clicked
   (see “Known pre-enablement blocker” below).

Until those approvals exist, only tests may enable the option.

## Known pre-enablement blocker: click-plan ownership

`partitionRenderedClickTargets` still treats a cross-origin anchor as
click-only unless its href is same-origin. When the option is enabled, an
admitted cross-origin destination is enqueued and should be enqueue-owned, but
the click plan can also click it. A click that navigates the seed away marks
the remaining seed controls skipped and can make coverage incomplete.

This must be fixed before enablement: thread the crawl-wide
`crossOriginQueued` set, including destinations revealed after a click, into
initial and post-click click planning so an admitted destination is never both
enqueued and clicked. It is not changed here because the option is default OFF
and the fix changes interaction ordering; it is part of the enablement gate and
requires the canary/browser validation below.

## Validation

- Pure policy tests cover same-origin rejection, known link hub, strong
  community evidence, weak-label rejection, Discord exclusion,
  admission-rejected targets, malformed URLs, the cap constant, and the
  default-OFF budget.
- `npx tsc --noEmit`: pass.
- Targeted rendered/fallback suite: 67/67 pass.

## Rollout

1. Land this PR with the option unset.
2. Run the canary with the option enabled only for an allowlisted experiment
   cohort, collecting `destination-budget`, `cross-origin-disallowed`, retained
   candidates, page count, and retry/failure attribution.
3. Keep the cap at 3 unless the canary shows unused page budget with positive
   marginal yield.
4. Disable immediately if cross-origin requests increase SSRF/admission
   violations, retries, or latency without candidate yield.
