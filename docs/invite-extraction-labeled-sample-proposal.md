# Labeled real-world sample — proposal (200–500 creator sites)

**Date:** 2026-10-27
**Status:** Proposal prepared. **No data collection has started.** Read-only
production access and manual labeling require explicit approval.
**Purpose:** Estimate real-world invite-extraction recall by acquisition stage
and mode, and calibrate the remaining low-prevalence gaps, without relying on
synthetic matrices alone.

## 1. Why this is needed

The 50/50 format matrix and 74/74 crawl matrix validate documented behavior on
synthetic fixtures. They do not estimate production recall, and they contain no
live Chromium, acquisition failures, queue/retry behavior, `<base>`, charset,
popups, >64 controls, or labeled real-world pages. The consolidated audit
therefore cannot say whether the remaining gaps matter in practice.

A labeled sample answers:

- What share of creator sites with a discoverable invite does the pipeline find?
- How much recall is lost at each stage: static fetch, static extraction,
  rendered fallback, interaction, projection/persistence?
- Which failure classes (403/404/406/partial/rendered timeout) are recoverable,
  and at what cost?
- Do `<base>`, charset, popups, iframes, or wrappers account for a meaningful
  share of misses?
- Is D1 >64-control overflow associated with real missed invites?

## 2. Sampling frame

**Unit:** creator channel (YouTube channel id), not URL observation. A channel
can have many candidate URLs; recall is a channel-level property.

**Frame:** channels with at least one eligible creator website or community
surface observation in the last 90 days, stratified by acquisition outcome and
mode. Exclude channels with no external surface at all (nothing to inspect) and
channels whose only surface is a non-page asset already filtered as noise.

**Target size:** 300 channels (minimum 200, maximum 500). The sample is
allocated across strata, not drawn uniformly, so rare failure classes are
represented.

### Proposed strata

| Stratum | Definition | Target n |
|---|---|---:|
| A. Static found | Static inspection `FOUND` with a serving invite | 60 |
| B. Rendered found | Rendered fallback `FOUND` after static miss | 60 |
| C. Partial | `PARTIALLY_INSPECTED` with a required gap | 50 |
| D. 403-only | Latest 7d observations contain 403 and no `FOUND` | 40 |
| E. 404-only | Latest 7d observations contain 404 and no `FOUND` | 40 |
| F. 406-only | Latest 7d observations contain 406 and no `FOUND` | 20 |
| G. No observation | Eligible surface never successfully inspected | 30 |
| **Total** | | **300** |

If the frame cannot fill a stratum, reallocate proportionally and document the
shortfall. Do not silently substitute a different class.

## 3. Label definition

For each sampled channel, a human labeler answers:

1. Does the channel have a creator-controlled community surface (Discord invite
   or a page that leads to one)?
2. If yes, what is the canonical invite code or destination?
3. Where was it found: channel page, About, video description, linked website,
   link hub, social profile, rendered interaction, popup/iframe, other?
4. Is the surface currently reachable (200/403/404/406/other)?
5. Is the invite creator-owned, third-party/sponsor, or ambiguous?
6. Confidence: high / medium / low, with a short reason.

Labels must be recorded without seeing the pipeline's extracted result first
(blind labeling), then compared. A second labeler independently labels a
random 10% (30 channels); disagreements are adjudicated by a third reviewer.
Report Cohen's κ and the adjudication rate.

## 4. Procedure

1. **Freeze the sampling frame.** Export channel ids, strata, and the latest
   observed URL per channel from the read-only replica. Record the snapshot
   timestamp and query text.
2. **Select and de-duplicate.** Randomly select within each stratum; exclude
   channels already labeled in a prior sample; cap multiple channels per site
   host to reduce clustering (for example ≤5 per host).
3. **Capture evidence.** For each channel, record the URL(s) to inspect, the
   HTTP status, content type, whether the page is static/rendered, and the
   pipeline's stored outcome **after** the blind label is recorded.
4. **Manual inspection.** Use a normal browser and, where needed, a rendered
   capture. Do not bypass authentication, paywalls, or access controls. Do not
   interact with Discord servers beyond reading the public invite landing page.
5. **Compare.** Match the pipeline's candidate/invite to the label. Record
   exact match, same guild/different code, different guild, or no pipeline
   result.
6. **Attribute misses.** For each false negative, record the stage and the
   suspected cause (fetch failure, static extraction, interaction, rendering,
   projection, noise filter, other). Only mark a cause when evidence supports
   it; otherwise use “unknown”.

## 5. Metrics

Primary:

- **Channel-level recall** = channels with a labeled invite that the pipeline
  found / channels with a labeled invite, overall and by stratum.
- **Stage recall**: static-found / rendered-found / interaction-found.
- **False-negative rate by attributed cause**, with exact binomial 95%
  confidence intervals.

Secondary:

- Precision of extracted invites (creator-owned vs sponsor/third-party).
- Attempts and worker-seconds per successful find, by stratum.
- Recovery rate for 403/404/406 strata.
- Share of misses attributable to each low-prevalence gap (`<base>`, charset,
  popups, iframes, wrappers, >64 controls).

Report point estimates with confidence intervals; do not present a single
aggregate recall without the stratum breakdown. With n=300 and roughly 150
labeled positives, the 95% CI half-width around a 70% recall is about ±5
percentage points; rarer causes will have wide intervals and must be reported
as such.

## 6. Data handling and safety

- Read-only replica only (`muse_readonly`); no production writes.
- No credentials, tokens, private messages, or member data collected.
- Store only channel id, public URL, public invite code, status, and label.
- Do not retain full page bytes beyond the review session unless separately
  approved; if bytes are needed, retain a bounded sample with a defined
  deletion date.
- Do not contact creators or join servers.
- Respect robots/terms for manual review; a single human page view is not
  crawling at scale.

## 7. Deliverables

1. Sampling frame export and selection manifest (reproducible).
2. Labeled dataset (CSV/JSON) with blind labels, adjudications, and pipeline
   results separated.
3. Recall report by stratum and stage, with confidence intervals.
4. False-negative cause table with evidence links.
5. Recommendation: which gaps are worth fixing, which are not, and which need
   more data.
6. A short reproducibility appendix: queries, timestamps, tool versions, and
   labeling rules.

## 8. Approval gates

- **Before frame export:** approval for read-only production access and the
  sampling frame.
- **Before labeling:** approval for the target size and strata (or a revised
  allocation).
- **Before any page-byte retention:** separate approval with a retention and
  deletion plan.
- **Before acting on results:** a separate change proposal; the sample informs
  priorities but does not authorize code, queue, or production changes.

No data collection, export, or labeling has begun.
