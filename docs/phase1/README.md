# Phase 1 — durable source of truth

Last updated: 2026-10-24 (adaptive pilot predeclaration). This directory is the durable index for the Phase 1
discovery work. It records decisions and evidence, not deployment state. When a
document and a live system disagree, the live system wins and the document must
be corrected.

## Current gate status

| Item | State |
| --- | --- |
| PR #531 (migrations 146/147/148 + discovery hardening) | Open; code/test head `8e696ed` (docs follow-up on top); all code workflows green at that head; round-1 fixes pushed; round-2 follow-ups pushed and all 20 threads resolved. PR Agent still fails only on `API_KEY_INVALID` (tooling), not code. Proposed merge SHA and gates: [PRE_MERGE_REPORT_20261020.md](PRE_MERGE_REPORT_20261020.md) |
| PR #530 (discovery integrity) | **Merged into `phase1-hardening` at `6267ba1` by an external actor, not this session.** Added migrations 149–152 and changed the base/order; do not treat this as approval of #531 |
| Migrations 148 and 149–152 | In the `phase1-hardening` lineage; applied only to disposable CI databases; **not** applied to production |
| Hard cap (9,000 units/key/Pacific day) | Implemented on `feat/youtube-key-hard-cap` docs head `9ab4f35` (code/test `5ecd905`), rebased on phase1 `3c53e57`; CI run [39501810518](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39501810518) green (51/51 unit, 21/21 PostgreSQL, 0 skipped); **default OFF, not deployed, not enabled** |
| InnerTube production use | **Not authorized** — see [INNERTUBE_POLICY_POSITION_20261020.md](INNERTUBE_POLICY_POSITION_20261020.md) |
| Probe pilot | **Not runnable / not authorized.** No probe has been run. Under the option-2 decision, probe-origin official work may spend official quota but is capped by PR #546 (10,000 units/Pacific day) and, when enabled, by PR #533's 9,000/key cap. InnerTube retrieval itself is not billed. |
| Adaptive creator-derived pilot (PR #545) | **Default OFF, not activated, no live data.** Deterministic 50/50 country-day pilot; predeclared metrics and activation plan in [ADAPTIVE_DISCOVERY_PILOT_20261024.md](ADAPTIVE_DISCOVERY_PILOT_20261024.md). Migration 156 is additive and unapplied. |
| GCP key-suspension investigation | **Open / access-blocked** — see [GCP_SUSPENSION_DIAGNOSTIC_20261020.md](GCP_SUSPENSION_DIAGNOSTIC_20261020.md) |
| Merge / deploy / migration apply / flag changes / probes | **Not approved**; stop before any of these. Shadow/CI evidence is not production proof |

## Documents

| Document | Purpose |
| --- | --- |
| [ROLLBACK_TEST_20261019.md](ROLLBACK_TEST_20261019.md) | Migration 146/147 rollback proof and guards |
| [QUOTA_SHADOW_UNIT3_20261019.md](QUOTA_SHADOW_UNIT3_20261019.md) | Quota shadow evidence, 3-day replay, and default-OFF hard-cap design |
| [INNERTUBE_POLICY_POSITION_20261020.md](INNERTUBE_POLICY_POSITION_20261020.md) | Project policy decision for keyless InnerTube retrieval |
| [GCP_SUSPENSION_DIAGNOSTIC_20261020.md](GCP_SUSPENSION_DIAGNOSTIC_20261020.md) | Read-only suspension investigation, exact missing access, no cause claim |
| [PILOT_LIMITS_AND_CANARY_20261020.md](PILOT_LIMITS_AND_CANARY_20261020.md) | Code-enforced vs config-only limits; canary pass/fail |
| [QUALIFIED_CREATOR_FORECAST_20261020.md](QUALIFIED_CREATOR_FORECAST_20261020.md) | Evidence-based dates and yield scenarios for persisted qualified creators |
| [PRE_MERGE_REPORT_20261020.md](PRE_MERGE_REPORT_20261020.md) | Proposed heads, review dispositions, tests, residual issues, and closed gates |
| [ADAPTIVE_DISCOVERY_PILOT_20261024.md](ADAPTIVE_DISCOVERY_PILOT_20261024.md) | 14-day 50/50 pilot question, predeclared metrics, early read, and activation plan |

## Non-negotiable boundaries

- A discovered creator counts only if it is **persisted, verified, net-new**,
  and attributable to the probe. Raw returned channels, review-routed channels,
  and repeat sightings do not count.
- Shadow observations are not proof of enforcement and do not authorize
  activation.
- Probe results are not proof that the Discord/community promotion gate changed.
  The existing 3-creator / 2-community / evidence gates remain in force.
- No production probes, queue changes, flag changes, migration applies,
  deployments, or key/restriction changes are authorized by these documents.
