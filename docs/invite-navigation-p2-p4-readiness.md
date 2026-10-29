# P2–P4 readiness, canary, and product-decision package

**Status:** preparation only. No P2/P3/P4 behavior, setting, flag, queue,
schema, concurrency, or production change is implemented or authorized.
**Evidence base:** `docs/evidence/p0_3_acquisition_classification_20261027.md`
(Coolify production, trailing 7 days; reproducible SQL and raw output in the
same directory) and the navigation/acquisition investigation report
[`docs/evidence/invite-navigation-acquisition-recall-investigation-20261027.md`](evidence/invite-navigation-acquisition-recall-investigation-20261027.md)
(read-only; no credentials, connection details, or raw page content).

## 1. Status summary

| Item | State | Blocker |
| --- | --- | --- |
| P1.1/P1.2 structural recovery | PR #560, default behavior, CI green | merge #559/#560 |
| P1.5 `<base>` | PR #562, independent; verify after latest review fix | merge |
| P1.6 cross-origin enqueue | PR #565, default OFF | security review + canary + product decision |
| P1.7 coverage truthfulness | PR #563, stacked on #560 | merge #559/#560/#563 |
| P1.8 wrappers | design prepared | security review + implementation |
| P1.9 redirect limit | PR #561, independent, CI green | merge |
| P1.3/P1.4 popups/frames | design prepared | security review + implementation |
| P2.1–P2.4 | readiness only | explicit approval, canary |
| P2.5 concurrency | **not proposed** | separate capacity approval |
| P3 exploration | design outline only | P1/P2 evidence + separate proposal |
| P4 dashboard/reporting | findings + proposed wording | product approval |
| P0.1 labeled sample | not started | sample approval + adjudication rules |

## 2. P2.1 — host-aware retry policy

### 2.1 Evidence

P0.3 shows recovery is host-dependent, not uniform:

| Host | Failed channels | Recovered | Recovery |
| --- | ---: | ---: | ---: |
| bitunix.com | 23 | 22 | 95.7% |
| fundednext.com | 30 | 28 | 93.3% |
| tradeify.co | 69 | 57 | 82.6% |
| lucidtrading.com | 49 | 21 | 42.9% |
| linktr.ee | 194 | 77 | 39.7% |
| apextraderfunding.com | 85 | 28 | 32.9% |
| whop.com | 146 | 12 | 8.2% |
| skool.com | 30 | 1 | 3.3% |
| patreon.com | 50 | 0 | 0% |
| linkedin.com | 83 | 0 | 0% |
| instagram.com | 35 | 0 | 0% |
| twitter.com | 27 | 0 | 0% |
| img-v2-prod.whop.com | 146 | 0 | 0% |

This is association, not a controlled experiment. It supports prioritizing
recoverable hosts and stopping low-yield retries, but a canary must prove the
causal yield benefit.

### 2.2 Proposed policy

1. Compute a host class from the trailing 30-day observation window:
   `RECOVERABLE` (>= 30% channel recovery and >= 10 failed channels),
   `MIXED` (5–30%), `LOW` (< 5% with >= 10 failed channels), and
   `NO_EVIDENCE` (insufficient sample).
2. Classify `no_class`/`NO_EVIDENCE` first; never infer a host class from a
   single failure or a single success.
3. Prioritize `RECOVERABLE` retry jobs within the existing due-order and
   fairness rules.
4. Cap `LOW` hosts at the current attempt budget or lower; do not increase
   attempts. `NO_EVIDENCE` keeps the current policy until the sample is
   sufficient.
5. Keep deterministic-terminal classes terminal. Host class may never
   override `REDIRECT_LOOP`, `SSRF_BLOCKED`, `UNSUPPORTED_CONTENT_TYPE`, or a
   confirmed terminal 404/410 barrier.
6. Store `hostClass`, `hostPolicyVersion`, and the evaluation window in retry
   job metadata for attribution. No URL or page content is added.
7. Default OFF behind a setting; one environment/cohort at a time.

### 2.3 Canary

- 10% of eligible retry jobs for 14 days, then 50% if guardrails hold.
- Metrics: recovered invites per worker-hour, retry conversion by host class,
  attempts per successful recovery, queue age, 429/403 rate, and failure-class
  mix.
- Guardrails: no increase in host 429/403/5xx rate attributable to the policy,
  no starvation of `RECOVERABLE` jobs, no increase in p95 queue age, no change
  to terminal classes.
- Stop rules: any SSRF/admission violation, any host error-rate increase above
  the pre-registered threshold, or zero conversion improvement after the
  minimum sample.

### 2.4 Acceptance tests

- A `LOW` host does not receive more attempts than the current policy.
- A `RECOVERABLE` host is scheduled ahead of an otherwise-equal `LOW` host.
- `NO_EVIDENCE` behavior is byte-for-byte the current policy.
- A deterministic terminal class stays terminal regardless of host class.
- Missing/invalid host metadata falls back safely.
- Retry metadata is content-free and schema-compatible.

## 3. P2.2 — 403 escalation and link-hub handling

### 3.1 403 rendered escalation

- Only for hosts with measured recovery and only for seeds where static access
  is blocked, not for every 403 child URL.
- One bounded rendered attempt; no credential, cookie, CAPTCHA, or alternate
  identity; block markers remain decisive.
- Respect `Retry-After`; keep the existing permanence rule.
- Metric: rendered recovery rate on the selected hosts vs static-only, and
  browser minutes per recovered invite.
- Approval: security + canary owner. This is not an access-control bypass; if
  the rendered attempt also returns a block/challenge page, it is terminal for
  that policy window.

### 3.2 linktr.ee 406 / image filter

- P0.3 shows linktr.ee has 39.7% channel recovery and 453 found observations,
  but 1,875 failed observations and a 406 class.
- Hypothesis: page-level retry plus rejecting image/asset subrequests reduces
  406s without changing invite extraction.
- Test in a canary only; do not hard-code a host exception without evidence.
- Metric: 406 rate, successful page inspections, found invites, browser time.

## 4. P2.3 — 404 root re-seed/sitemap probe experiment

- Observation: 283 404-only sites returned 200 at the root; 404 dominates
  status failures (34,833), but 404 recovery is only 1.9%. This is a
  hypothesis, not a recommendation to retry all 404s.
- Experiment: for a pre-registered sample of sites where the seed/deep URL is
  404 and the root is 200, probe the root and sitemap under a strict per-site
  cap; do not enqueue the whole site.
- Success metric: new found invites per extra fetch and per browser minute,
  with a confidence interval on the sampled cohort.
- Guardrails: no increase in 404 retry volume, no crawling of dead child URLs,
  no production cleanup.
- Approval: product (scope), canary owner, release owner. Not authorized now.

## 5. P2.4 — long-attempt cap and queue re-dating

### 5.1 Evidence

- 1,599 retry jobs pending; all 1,599 due; all unlocked; 1,223 (76.5%) have
  zero attempts.
- 812 are `COMMUNITY_REQUIRED_ACQUISITION_FAILURE`; 787 are
  `BROWSER_RUNTIME_UNAVAILABLE`.
- In the last 7 days, retry-job attempts were 2,743 failed and 405 completed
  (87.1% failure).
- 32% of attempts longer than 30 minutes eventually complete.

### 5.2 Interpretation

The queue is not short of due work; it is short of claims/worker capacity.
Raising a long-attempt cap or re-dating jobs before fixing claim starvation
would hide the bottleneck and distort fairness. P2.4 therefore starts as an
investigation, not a policy change:

1. Measure claim latency and worker availability by job class.
2. Compare `jobs.attempts` with `job_attempts` to separate "never claimed"
   from "attempted and failed".
3. Only after that evidence, propose a long-attempt cap or re-dating rule with
   a canary and a fairness guardrail.

No purge, deletion, or queue-setting change is authorized.

## 6. P2.5 — concurrency/capacity

Not proposed in this workstream. P0.3 shows 18,319
`RENDERED_FALLBACK_SATURATED` observations, or 56.8% of the 32,232 rendered
observations; the earlier 7-day creator snapshot measured 1,550 of 2,265
rendered attempts saturated (68.4%). Changing concurrency/budget requires a
separate capacity approval, load model, canary, and rollback. It is listed here
only to keep it out of P2.1–P2.4 scope.

## 7. P3 — intelligent exploration design

P3 remains a separate architecture proposal. The deterministic P1 fixes should
land first; P3 should not be folded into #560 or a narrow navigation patch.

Required proposal sections:

1. **Observation model:** DOM, accessibility tree, frame tree, open shadow
   roots, network log, popup pages.
2. **Navigation graph:** document/state nodes; control/link edges annotated
   with semantic role, accessible name, href, expected destination, cost, and
   confidence.
3. **Policy:** bounded best-first search with an evidence score, structural
   navigation prior, dedupe, and a marginal-yield stop rule; no keyword-only
   gate for structural navigation.
4. **Execution:** same-tab, popup, frame, shadow; href/click/keyboard/force
   fallback; overlay dismissal; settle policy.
5. **Safety:** shared admission/SSRF on every context, no auth/paywall bypass,
   bounded per-seed cost, no blanket cross-origin crawl.
6. **Evaluation:** offline replay fixtures, labeled sample, canary; recall by
   placement, false-clean rate, cost per found invite, p50/p95 latency,
   saturation, retry conversion.
7. **Rollout:** default OFF, canary, rollback, no budget/concurrency increase
   without separate approval.

P3 cannot be evaluated without P0.1 (labeled sample) and P1/P2 outcome data.
No implementation is proposed now.

## 8. P4 — dashboard/reporting truthfulness

### 8.1 Current-state findings (verified in the repository)

1. The channel listing computes `candidate_count` as the total persisted
   `discord_candidates` rows, but the detail JSON `discord_candidates` only
   contains candidates that are `VALIDATED`, `COMPLETED`, and `ACTIVE`.
2. The UI renders `c.discord_candidates.length` as "N candidates" inside the
   Discord cell. That is therefore **N validated, active candidates**, not all
   discovered candidates, and `candidate_count` is not displayed.
3. `getDashboardOperationalSummary` counts `activeDiscords` only for
   `ACTIVE`/`ACTIVE_LOW_VOLUME`, which is correct for serving counts, but the
   UI must label that scope explicitly.
4. The "Recently confirmed" control sorts by first successful validation
   timestamp; its title says "confirmed, validated" and may imply current
   liveness. The existing last-known-good copy for a retained-but-uncertain
   invite is good and should be used consistently.
5. `UNCERTAIN` exists as a Discord status filter, but there is no explicit
   "non-validated candidate" count or filter, and no candidate provenance in
   the main row.
6. Partial inspections do not expose a coverage reason in the row; an operator
   cannot distinguish a bounded partial from a policy-excluded or
   context-unreachable partial without opening details.
7. The deployment summary still reads Railway environment variables as a
   fallback (`RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_SERVICE_NAME`,
   `RAILWAY_DEPLOYMENT_ID`). That is separate configuration debt; the
   canonical production host is Coolify (PR #564;
   `docs/production-infrastructure.md` once merged). It must not be presented
   as production evidence.

### 8.2 Proposed changes (product approval required)

1. **Separate counts:** show `validated active candidates` and `other
   discovered candidates` as distinct labels; never call the validated subset
   the total.
2. **Total candidate visibility:** expose `candidate_count` in the row or
   details with an explicit definition (persisted discoveries, including
   unvalidated/rejected).
3. **Candidate-lifecycle filter:** add a filter over candidate fields, not
   channel states. The predicate applies to `discord_candidates` rows via
   `candidate_status`, `validation_status`, and `liveness_status` (for example
   non-serving means `liveness_status <> 'ACTIVE'`, and
   `validation_status IN ('NOT_STARTED','RETRY_PENDING','FAILED_OPERATIONAL')`
   covers untouched/retrying/operationally failed candidates). Channel fields
   (`discord_status`, `discord_validation_status`,
   `discord_liveness_status`) remain the existing channel-level filter and
   must not be reused as candidate predicates. The candidate facet must not
   change serving counts.
4. **Validation wording:** rename "Recently confirmed" to "Recently
   validated" or keep the label but state that it means the first successful
   validation, not current liveness.
5. **Last-known-good:** use the existing "previously verified but currently
   uncertain" wording for every retained-uncertain case; never show it as
   freshly validated.
6. **Provenance:** show source surface and duplicate-owner evidence for a
   candidate; never imply creator ownership without evidence.
7. **Coverage reason:** surface `coverageReason`/partial reason in the row or
   tooltip so an operator can see why a scan is partial.
8. **Deployment label:** read Coolify/environment-neutral variables or display
   "unknown"; do not label a Railway fallback as production.

### 8.3 Product decisions needed

- Exact labels for total vs validated vs active vs uncertain.
- Whether unvalidated candidates appear in the main table or only in details.
- Whether "Recently confirmed" is renamed and how the KPI is defined.
- Whether a coverage reason is operator-visible by default.
- Whether error-wrapper candidates are displayed at all, and with what
  provenance label (ties to P1.8).
- Whether the deployment-label cleanup ships in the P4 PR or a separate
  configuration PR.

### 8.4 Acceptance tests

- Counts are internally consistent: total >= validated >= serving, and no
  label claims a larger scope than the query.
- A row with only unvalidated candidates does not display "N candidates" as
  if they were validated.
- A retained-uncertain invite displays last-known-good wording, not fresh
  validation.
- An ownership-uncertain candidate is not presented as creator-owned.
- Coverage reason is present for every partial row.
- The deployment label never claims Railway production when the app is on
  Coolify.
- UI contract tests/snapshots cover the labels; no production setting change.

## 9. P0 measurement prerequisites

- **P0.1 labeled sample:** 200–500 stratified creator sites, manual
  adjudication, disjoint strata, propensity-weighted recall with confidence
  intervals. The draft protocol is
  `docs/invite-navigation-labeled-sample-protocol.md`; execution still needs
  approval of sample size, strata, reviewers, and evidence storage. Without it,
  no universal recall claim is possible.
- **P0.2 telemetry:** implemented in PR #559; required before measuring P1.1,
  P1.3/P1.4, P1.6, and P1.7.
- **P0.3 classification:** completed (Coolify read-only, trailing 7 days).
  Report, SQL, and raw output:
  `docs/evidence/p0_3_acquisition_classification_20261027.{md,sql,out}`.
- **P0.4 baseline reconciliation:** the 54-failure full-suite baseline is
  reconciled in the PR #558 verification record; future PRs must report both
  full-suite and targeted counts.

## 10. Approval matrix and exact external needs

| Decision | Owner | What is needed |
| --- | --- | --- |
| Enable P1.6 cross-origin enqueue | security + product + canary | threat-model sign-off, cohort/stop rules, product scope |
| Enable P1.3 popup capture | security + product | data-visibility sign-off, popup cap/lifetime, canary |
| Enable P1.4 same-origin frames/shadow | security + product | traversal sign-off, frame/shadow caps, canary |
| Enable P1.4 cross-origin frames | security + product | separate explicit approval |
| Enable P1.8 wrapper classes | security + product | parser/entity review, provenance/display decision |
| P2.1 host-aware retry | canary + release | canary plan, host guardrails, rollback |
| P2.2 403 escalation / link-hub | security + canary | no-bypass confirmation, host cohort, stop rules |
| P2.3 404 re-seed | product + canary | sample definition, extra-fetch cap, success metric |
| P2.4 long-attempt/re-dating | release + queue owner | claim-latency evidence first; no purge |
| P2.5 concurrency | capacity owner | separate capacity approval (not requested here) |
| P3 exploration | architecture + security | separate design proposal and canary |
| P4 wording/visibility | product | label/filter/KPI decisions |
| Merge/deploy any PR | user | explicit per-PR approval |

## 11. Measurement and stop rules (all P2/P3 canaries)

- Primary: found invites per worker-hour and per browser-minute.
- Secondary: recall by placement/stage, false-clean rate, partial rate, retry
  conversion, p50/p95 latency, saturation, queue age.
- Safety: SSRF/admission violations (must remain zero), host error-rate
  increase, resource/listener leaks, cross-origin request volume.
- Stop immediately on any safety violation, unexplained host error increase,
  or material latency regression. Roll back the flag, not the data.
- No canary may increase queue concurrency or page/click budgets without a
  separate approval.

## 12. Sequence

1. Merge/land P1 deterministic PRs in dependency order (#559 → #560 → #563,
   plus independent #561/#562/#564/#565 docs/code as approved).
2. Complete P1.3/P1.4/P1.8 security review and implementation behind flags.
3. Run P2.1/P2.2/P2.3 canaries one lever at a time; investigate P2.4 claim
   starvation before changing scheduling.
4. Start P0.1 labeled sample when approved; use it to evaluate P1/P2.
5. Design P3 only after P1/P2 data; keep it a separate proposal.
6. Ship P4 truthfulness with product-approved wording; no production data
   change.

No merge, deployment, production flag, schema, migration, queue, concurrency,
or cleanup action is authorized by this package.
