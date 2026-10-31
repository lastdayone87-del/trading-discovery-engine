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
2. It is not already visited or already queued by this pass.
3. The crawl-wide cross-origin cap
   (`MAX_RENDERED_CROSS_ORIGIN_ENQUEUES = 3`) has room. A skip is counted as
   `destination-budget`.
4. `shouldFollowDestination` admits the target: the shared policy must return
   `eligible`. Unrelated outbound links are counted as `hint-rejected` and
   admission/security rejections as `admission-rejected`; neither is a coverage
   exclusion. Only an eligible community destination the pursuit policy leaves
   unvisited is counted as `cross-origin-disallowed`.
5. It is not a Discord destination. Discord links are terminal invite
   candidates extracted from the page; enqueueing them would spend page budget
   on a surface the crawler does not need to inspect.

The pass runs after the same-host pass and again after interactions, so
required same-host links are queued first and JS-revealed link-hub targets are
still captured.

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
   rendered acquisition.

Until those approvals exist, only tests may enable the option.

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
