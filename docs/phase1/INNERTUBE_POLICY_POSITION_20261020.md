# InnerTube policy position — 2026-10-20

Status: **RESOLVED FOR THIS PROJECT: production use is NOT authorized.**
The bounded verification tranche is closed. No further production InnerTube
requests may be made under this policy.

## Evidence

- On 2026-10-19 the bounded verification tranche used **10 of 30** approved
  requests; **10/10 returned a usable result**. The local (not committed)
  transcripts are
  `/tmp/opencode/evidence/INNERTUBE_VERIFICATION_20261019_tranche1.txt` and
  `/tmp/opencode/evidence/ACTIVATION_EVIDENCE_PACK_20261019.md`; the durable
  finding is summarized here.
- The transport is the keyless, undocumented InnerTube path used by
  `server/youtubeInnertubeProvider.ts` (via the existing `youtubei.js` client).
  It is not the official YouTube Data API and is not covered by the official
  API key terms or quota contract.
- No written provider permission, commercial agreement, legal opinion, or
  operator-approved risk acceptance for production InnerTube use exists in this
  repository or in the evidence pack.
- Technical success does **not** establish permission. The 10/10 result proves
  reachability and response shape only.

## Decision

1. InnerTube remains **disabled for production probes and all production
   discovery traffic**.
2. The remaining 20 verification requests are **not** to be spent. The tranche
   is closed at 10/30.
3. Phase 2 probes must not be enabled on the assumption that InnerTube is an
   approved transport. The probe executor's default route is InnerTube; that
   default does not itself grant authority.
4. The official YouTube Data API is the supported fallback, but it is currently
   constrained by the suspended-key cohort and the default-OFF 9,000-unit cap.
   The probe executor also rejects non-InnerTube routes today
   (`OFFICIAL_ROUTE_NOT_IMPLEMENTED`); enabling official probes would require a
   separately reviewed implementation and budget approval.
5. If a future written authorization or an explicit, recorded operator risk
   acceptance is obtained, this decision must be replaced in a new dated
   document before any probe runs. Conditions for revisiting:
   - written permission or a documented legal/policy determination that covers
     the exact production use;
   - a reviewed kill switch, bounded budget, and monitoring plan;
   - explicit activation approval separate from this document.

## What this policy does not do

- It does not assert that InnerTube is unlawful or that a provider term has
  been breached; it records that permission is **not established**.
- It does not change any code, flag, key, queue, or production state.
- It does not authorize shadow or local-only traffic to be treated as production
  evidence.

## Operational consequence

The canary and qualified-creator forecast in this directory are **conditional**
and **not executable** while this position stands. See
[PILOT_LIMITS_AND_CANARY_20261020.md](PILOT_LIMITS_AND_CANARY_20261020.md)
and
[QUALIFIED_CREATOR_FORECAST_20261020.md](QUALIFIED_CREATOR_FORECAST_20261020.md).
