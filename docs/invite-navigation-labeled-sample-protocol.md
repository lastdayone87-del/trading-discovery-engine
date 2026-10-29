# Invite recall labeled-sample protocol (P0.1)

**Status:** draft protocol only. The sample has not been drawn, no site has been
adjudicated, and no recall claim exists. Execution requires the approvals in
§9.
**Purpose:** produce the first defensible estimate of invite recall by
navigation placement, including a false-clean rate, without changing production
behavior.

## 1. Why a labeled sample is required

Crawler telemetry can say what the crawler did. It cannot say what the crawler
missed. P0.3 is observation-level failure classification; it has no ground
truth. Any claim such as "we now find 95% of invites" requires an independent
manual determination of whether an invite existed and where it was reachable.

The plan's target is 200–500 stratified creator sites. This protocol defines
the sampling frame, adjudication rules, estimator, and acceptance criteria so
the sample can start as soon as it is approved.

## 2. Unit, frame, and window

- **Unit:** one creator site, identified with the crawler's
  `canonicalSiteIdentity` (`site-identity-v1`), not one URL observation. The
  identity keeps path-tenant creators distinct (`linktr.ee/trader1` versus
  `linktr.ee/trader2`), subdomain tenants distinct (`tenant.skool.com`), and
  private-suffix tenants distinct (`tenant.github.io`); otherwise it collapses
  to the registrable domain. Multiple channel rows that resolve to the same
  identity collapse to one site; the site inherits the channel with the most
  recent creator-website observation.
- **Frame:** production channels with at least one `CREATOR_WEBSITES`
  observation in the window, using the latest site-level outcome per site.
  Only public creator sites are eligible.
- **Window:** the 14 days ending at sample draw. The draw timestamp and frame
  query are hashed and recorded before adjudication.
- **Exclusions:** private, authenticated, paywalled, adult, or illegal
  surfaces; sites whose only invite evidence is a direct message or a
  non-public channel; duplicate domains already selected; sites the operator
  cannot legally access. Exclusions are counted by reason, never silently
  dropped.

## 3. Strata and sample size

Strata are disjoint and assigned from the site-level outcome before manual
review:

| Stratum | Definition | Target n |
| --- | --- | ---: |
| S1 | Latest outcome `FOUND` | 80 |
| S2 | Latest outcome `INSPECTED_NO_MATCH` with `COMPLETE` coverage | 80 |
| S3 | Latest outcome `PARTIALLY_INSPECTED` (any coverage gap) | 80 |
| S4 | Latest outcome `ACQUISITION_FAILED` (static/rendered/network) | 160 |

Total target: **400 sites**. S4 is oversampled because failure is the largest
production bucket and the main recall opportunity. If a stratum is smaller than
its target, take the whole stratum and redistribute the remainder to S4, with
the final counts and weights recorded before adjudication.

**Redirect aliases:** resolve the latest site-level outcome through the
redirect chain before assigning a stratum. Use
`canonicalSiteIdentity(requestedUrl, finalUrl)` so a `REDIRECTED` alias joins
the destination site's identity instead of falling outside S1–S4. If the chain
is unresolved, leaves the public frame, or ends at a non-HTTP(S)/unparsable
destination, exclude the alias and count it under `REDIRECT_UNRESOLVED`; it is
never silently dropped. Any resolved outcome outside the four definitions is
likewise excluded and counted by reason. After resolution, S1–S4 are disjoint
and exhaustive for the included frame, and the exclusion counts are recorded
before adjudication.

**Precision check:** for a recall estimate near 0.70 and n=400, the unweighted
95% interval is roughly ±4.5 percentage points. Stratification and the
domain-cluster design effect will widen it; report the design-based interval,
not the naive one.

## 4. Manual adjudication procedure

Each site is reviewed by one adjudicator with a second independent review of a
20% random subsample; disagreements go to a third adjudicator.

1. Open the seed site in a clean browser profile. Do not use crawler output,
   cached crawler screenshots, or the outcome label.
2. Spend at most **12 minutes** on the site. Budget: 3 minutes on the seed,
   6 minutes on visible navigation/community links, 3 minutes on one level of
   linked community surfaces.
3. Record every usable Discord invite reachable within that budget:
   - invite code/locator;
   - placement: seed HTML, same-site child page, rendered disclosure/scroll,
     popup/new tab, iframe/shadow root, external link hub, or other;
   - whether the invite is creator-owned, ambiguous, or third-party;
   - the shortest visible control path.
4. An invite counts as ground truth only if a normal visitor could reach it
   without credentials, payment, CAPTCHA solving, or guessing a URL. A dead
   invite still counts as present if it is presented as the community link;
   liveness is recorded separately.
5. Record "no invite found" only after the full budget and at least one
   navigation path beyond the seed. Record access blocks (login, paywall,
   CAPTCHA, hard 403) as `INACCESSIBLE`, not as absence.
6. Store the raw notes and invite locators in an access-controlled evidence
   directory. Do not put credentials, cookies, private messages, or page dumps
   in the repository.

**Adjudication rule for ambiguous evidence:** a link whose label or destination
is a generic community host but whose ownership is unclear counts as
`AMBIGUOUS`, reported separately. It is not counted as a true positive or a
false negative in the primary recall estimate; a sensitivity analysis assigns
it both ways.

## 5. Blinding and order

- The adjudication sheet shows a random sample ID, the seed URL, and the time
  budget. It does not show the crawler outcome, failure class, or whether the
  site was selected from S1–S4.
- Sites are presented in random order; S1–S4 membership is joined only after
  all sheets are complete.
- The 20% second review is drawn after the first review, with the first
  reviewer's notes hidden.

## 6. Estimator

For each stratum `h`, let `N_h` be the frame count, `n_h` the sampled count,
and `y_i` the ground-truth invite indicator. The design-weighted invite
prevalence is:

```
P_h = sum_{i in sample_h} y_i / n_h
P   = sum_h (N_h / N) * P_h
```

Recall uses the crawler's site-level result for the same site and window.
Weight by the inverse sampling probability within each stratum, not by all
sites, so recall cannot track the share the crawler marked `FOUND`:

```
w_h    = N_h / n_h
TP_h   = sampled sites with ground truth invite AND crawler FOUND
FN_h   = sampled sites with ground truth invite AND crawler did not find it
Recall = sum_h (w_h * TP_h) / sum_h (w_h * (TP_h + FN_h))
```

A stratum with no ground-truth positives contributes zero to both the
numerator and the denominator and is reported separately as "no ground-truth
positives"; it does not define `Recall_h` as 0/0. If the weighted denominator
is zero, no recall estimate is published. Bootstrap the same weighted ratio
(10,000 resamples, resampling sites within strata) so the reported interval
measures the same quantity as the point estimate.

Report:

- weighted recall with a stratified bootstrap 95% interval (10,000 resamples,
  resampling sites within strata);
- a domain-cluster sensitivity interval when multiple channels share a domain;
- false-clean rate: ground truth invite present and crawler returned a clean
  `INSPECTED_NO_MATCH`/`COMPLETE`;
- recall by placement and by acquisition mode (static/rendered);
- per-stratum TP/FN counts and the `INACCESSIBLE`/`AMBIGUOUS` shares;
- a list of false-negative patterns (generic menu, icon-only control, iframe,
  popup, link hub, wrapper, access block, other) with counts, never raw page
  content.

No estimate is published if the effective sample in a stratum is below 20 or
the second-review agreement is below 80%; the report says "insufficient
sample" instead.

## 7. Acceptance criteria

1. The frame query, draw timestamp, exclusions, and final weights reproduce
   the sample exactly from a recorded manifest hash.
2. At least 90% of sampled sites have a completed adjudication sheet; missing
   sheets are reported and bounded.
3. Inter-reviewer agreement on invite presence is at least 80% on the 20%
   overlap; disagreements are adjudicated and counted.
4. Recall is reported with a design-based interval and a separate false-clean
   rate. No single-number recall claim is made without the interval.
5. Every false negative has a placement label and a reproducible path note.
6. No credentials, private content, or non-public URLs appear in the report.
7. The report distinguishes "crawler did not find", "crawler could not
   inspect", and "adjudicator could not access"; these are not merged.

## 8. What this sample can and cannot answer

**Can answer:** recall on the sampled frame and window, false-clean rate,
placement mix of misses, and whether P1 changes improve recall on comparable
strata.

**Cannot answer:** recall on unmeasured sites, private/authenticated
communities, non-English sites outside the frame, or future crawler behavior.
It is not a production experiment and does not authorize any crawler change.

## 9. Approvals and execution prerequisites

| Decision | Owner | Needed before draw |
| --- | --- | --- |
| Sample size, strata, and window | product/research owner | written approval |
| Adjudication budget and reviewers | operations owner | named reviewers, hours |
| Access to an isolated manual-review environment | security owner | clean profile, no production credentials |
| Evidence storage and retention | security/privacy owner | approved location and retention period |
| Publication of aggregate results | product owner | approved wording and scope |

Execution is manual and read-only with respect to production. It does not
require a deployment, flag, queue, schema, or concurrency change, and it must
not use the production database role for writes. If a production query is
needed to draw the frame, it uses the Coolify read-only path and
`BEGIN TRANSACTION READ ONLY` (PR #564;
`docs/production-infrastructure.md` once merged).

## 10. Deliverables

1. `sample_manifest.json` — frame query hash, draw timestamp, strata counts,
   inclusion probabilities, exclusions by reason.
2. `adjudication_sheets/` — one record per site, sample-ID keyed.
3. `adjudication_agreement.md` — overlap sample, agreement rate, resolved
   disagreements.
4. `recall_report.md` — estimator, intervals, false-clean rate, placement mix,
   false-negative patterns, limitations.
5. A short decision note: which P1/P2 levers the evidence supports, and which
   require a canary rather than a sample.
