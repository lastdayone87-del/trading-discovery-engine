# Community acquisition retry — implemented filter and prepared improvements

**Date:** 2026-10-27
**Scope:** Remediation of the approved retry/acquisition items from
`INVITE_EXTRACTION_CONSOLIDATED_REPORT_20261027.md` §3 and §5.
**Status:** Non-page/malformed URL filter implemented. Host-aware policy,
long-attempt cap, and queue re-dating are investigation/preparation only. No
concurrency, queue, budget, or setting change is included.

## 1. Implemented: non-page/malformed URL filter

`server/communitySurfacePolicy.ts` now rejects non-page and malformed URLs at
the shared `assessCrawlAdmission` boundary, before fetch or enqueue:

| Reason code | What it rejects | Examples |
|---|---|---|
| `MALFORMED_URL` | Template placeholders, script/quote artifacts, control characters, embedded JS | `/%7B%7Blink%7D%7D`, `${link}`, `d,a.onload=function()%7B...`, `/%22%22;` |
| `RESOURCE_EXTENSION` | Image, video, audio, font, script, archive, and executable suffixes, including encoded forms and transform parameters | `card.png&w=1920&q=75`, `app%2Ejs`, `hero.avif`, `clip.webm` |
| `NON_PAGE_PATH` | Segment-anchored image/thumbnail/avatar directories | `/images/join-community/...`, `/thumbnails/...` |
| `ASSET_HOST` | Hosts that can only serve page assets (YouTube/Meta/Twitter image CDNs, image proxies, code CDNs) | `fbcdn.net`, `cdninstagram.com`, `twimg.com`, `res.cloudinary.com`, `i0.wp.com`, `cdn.jsdelivr.net` |

Deliberate exclusions from the filter:

- social/profile and invite hosts stay eligible (`instagram.com`, `x.com`,
  `t.me`, `discord.gg`, `discord.com/invite`, `discordapp.com/invite`);
- link hubs and shorteners stay eligible (`linktr.ee`, `bit.ly`, `beacons.ai`);
- generic CDNs that can host entire sites (`cloudfront.net`, `amazonaws.com`)
  are not filtered;
- document and feed types (`pdf`, `rss`, `xml`) stay eligible;
- dots inside page slugs (`v1.2`, `app.js.html`, `using-.js-files`) do not
  match the resource-extension rule.

### Regression coverage

- `server/crawlAdmissionGate.test.ts`: noise is rejected before fetch or
  observation; legitimate HTML pages, query strings, apostrophes, documents,
  shorteners, social profiles, and invite hosts still crawl.
- `server/pageAssetFilter.test.ts`: asset/CDN hosts are filtered; profile and
  invite hosts are preserved.
- `server/communityRetryPolicy.test.ts`: non-page/malformed observations own no
  retry, while a legitimate page failure remains retryable.

**Expected effect (not yet measured in production):** up to 1,022
observations (12.9% of the 7d total) and 309 pending retry jobs are tied to
this noise class. The filter removes future work; it does not purge existing
records. A production cleanup/backfill of already-stored noise requires
separate approval and has not been performed.

## 2. Prepared: host-aware retry policy

### Evidence

7d same-URL recovery after the first bad status:

| First status | Bad URLs | Later `FOUND` | Recovery | p50 hours |
|---|---:|---:|---:|---:|
| 403 | 1,063 | 108 | 10.2% | 4.5 |
| 404 | 3,237 | 61 | 1.9% | 4.2 |
| 406 | 215 | 63 | 29.3% | 22.1 |

Host classes with ≥20 bad URLs:

| Class | Hosts | Bad URLs | Recovered | Recovery |
|---|---:|---:|---:|---:|
| Low <10% | 23 | 822 | 13 | 1.6% |
| Mixed 10–40% | 8 | 431 | 108 | 25.1% |
| Recoverable ≥40% | 5 | 233 | 136 | 58.4% |

Recoverable hosts include `whop.com` (67.9%), `apextraderfunding.com` (51.5%),
`lucidtrading.com` (62.5%), `bit.ly` (54.8%), and `x.com` (46.2%). Low-recovery
hosts include `atas.net`, `volfix.net`, `tradeneon.com`,
`www.dailyforex.com`, `maverickcurrencies.com`, `www.patreon.com`,
`www.instagram.com`, and `privacycenter.instagram.com`.

### Proposed policy shape (not implemented)

1. **Classify before prioritizing.** The current pending population is mostly
   `no_class` (1,416 of 1,534 jobs). Host-aware rules must not act on a host
   until the job has a classified observation; otherwise the policy would be
   guessing.
2. **Recoverable-host lane.** Hosts with ≥40% observed recovery get normal or
   slightly earlier retry scheduling. This is a prioritization hint, not an
   unlimited retry grant.
3. **Low-recovery-host cap.** Hosts with <10% recovery and ≥20 bad URLs get a
   bounded retry count or a longer backoff after the first rendered failure.
   The cap must remain per host + failure class, not global, so a new invite
   on the same host can still be attempted.
4. **Status-aware escalation.** 403 should prefer rendered escalation on
   host-level evidence (for example `docs.whop.com` has 64 static 403s and no
   rendered attempt). 404 should not be blanket-escalated; 406 should separate
   page URLs from image noise (`linktr.ee` is the dominant 406 host and page
   URLs do recover).
5. **No outcome changes.** Host policy may change when/what is retried; it must
   not change extraction, validation, or projection outcomes.

### Why this is prepare-only

- Host classification currently covers only 76 pending jobs; 1,416 are
  unclassified.
- The recovery numbers are observational, confounded by scheduling, mode, host
  changes, and time. They are not a controlled experiment.
- A policy that abandons low-recovery hosts can lose slow 404 recoveries; a
  policy that prioritizes recoverable hosts can starve everything else.

**Required before implementation:** a canary plan with pre-registered success
metrics (rendered `FOUND` conversion, attempts per success, backlog age, and
low-recovery-host abandonment rate), explicit approval, and no simultaneous
concurrency/queue change.

## 3. Investigated: long-attempt cap

### Evidence

- 3 community retry workers, 97.7% utilization over 24h.
- 593 attempts/day, ≈33–40 completions/day (5.6–6.7% yield).
- Attempt duration: mean 507s, p50 55s, p90 1,683s, max 6,465s.
- Last 24h: >30m attempts are 50/593 (8.4%) but consume **56.5%** of worker
  time; their completion rate is 32.0%. 5–30m attempts consume 38.6% of worker
  time at a 15.4% completion rate.

### Assessment

A hard 20–30m cap could free substantial capacity, but 32% of >30m attempts
complete, so a hard kill would discard real successes. A safer shape is a
**soft cap**: stop starting new click/scroll work after a generous deadline,
preserve already-discovered candidates and partial-coverage telemetry, and let
the normal retry path continue. The cap must not be implemented as an
unconditional process kill.

### Recommendation

1. Instrument attempt phase timing first (static fetch, rendered launch,
   interaction, extraction) so the cap targets the expensive phase.
2. Canary a soft deadline (for example 20–30 minutes of interaction work) on a
   bounded job subset.
3. Success criteria: reduced worker-seconds per attempt, no reduction in
   `FOUND` per attempt beyond the pre-registered tolerance, and no increase in
   partial-coverage retries.
4. No production change without explicit approval.

## 4. Investigated: queue re-dating

### Evidence

`server/communityRecovery.ts` re-dates capacity-deferred jobs every 5 hours:

```sql
UPDATE jobs
   SET created_at=now(), updated_at=now()
 WHERE type='RETRY_COMMUNITY_ACQUISITION'
   AND status IN ('PENDING','PROCESSING')
   AND last_error LIKE 'Community acquisition deferred:%'
   AND created_at < now() - interval '5 hours'
```

`claimNextJob` orders by `priority DESC, created_at ASC`. Effects:

- true backlog age is masked (p50 48.5h, max 453.5h using `retryObservedAt`);
- capacity-deferred jobs move to the back of the FIFO every 5 hours;
- 1,087 jobs “created today” include 913 with an earlier `retryObservedAt`;
  823 differ by >11h and 608 by <30m.

### Assessment

This is a secondary FIFO/observability distortion, not the primary cause of the
backlog. It should be corrected before `created_at` is used for backlog
management or SLA claims.

### Recommendation

1. Preserve an immutable first-enqueued/observed timestamp and use it for
   backlog age and FIFO ordering.
2. Stop mutating `created_at` for capacity deferrals; use `run_after` and
   `updated_at` for scheduling.
3. Backfill is not required to fix future behavior; historical age can be
   reconstructed from `retryObservedAt` where available.
4. This changes claim order and needs a canary plus explicit approval. It is not
   included in this remediation.

## 5. What is deliberately not changed

- No concurrency change (`COMMUNITY_RETRY_WORKER_CONCURRENCY`,
  `RENDERED_FALLBACK_CONCURRENCY`, or browser lease behavior).
- No queue settings, budgets, priorities, or migration.
- No production cleanup or purge of existing noise records.
- No host policy, long-attempt cap, or re-dating implementation.

These remain gated on a separate canary plan and explicit approval.
