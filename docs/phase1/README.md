# Phase 1 — durable source of truth

Last updated: 2026-10-24 (hard-cap, probe-allocation, and adaptive pilot predeclaration). This directory is the durable index for the Phase 1
discovery work. It records decisions and evidence, not deployment state. When a
document and a live system disagree, the live system wins and the document must
be corrected.

## Current gate status

| Item | State |
| --- | --- |
| PR #531 (migrations 146/147/148 + discovery hardening) | **Merged** on 2026-10-20T23:37:42Z (with #532; #530 already merged). No merge, deploy, migration apply, or flag change was performed by this session |
| PR #530 (discovery integrity) | **Merged into `phase1-hardening` at `6267ba1` by an external actor, not this session.** Added migrations 149–152 and changed the base/order |
| Migrations 148–155 | Applied on production at schema **155** (`5822da4`, 2026-10-24). Migration 156 exists only on PR #545 and is unapplied. |
| Hard cap (9,000 units/key/Pacific day) | Deployed in #533 (`024782d`); **default OFF, not enabled**. CI at code/test head `c7fae59` was green (53/53 unit, 23/23 PostgreSQL; rotation 71/71). |
| Probe-origin official allocation (#546) | Deployed in #546 (`5822da4`); migrations 154–155 applied. Option 2: probe-origin work may spend official quota only through its independent, capped Pacific-day bucket; **default OFF, no probe has been activated**. |
| PR #545 (adaptive creator-derived pilot) | Open against `main`, rebased onto `5822da4`. Predeclared 14-day 50/50 metrics and activation plan. **Default OFF, no live data, migration 156 unapplied.** |
| Merge order | **#533 → #546 → #545.** #533 and #546 are merged and deployed; #545 remains subject to final checks and merge. |
| InnerTube production use | **Not authorized** — see [INNERTUBE_POLICY_POSITION_20261020.md](INNERTUBE_POLICY_POSITION_20261020.md) |
| Probe pilot | **Not runnable / not authorized.** No probe has been run. Under the option-2 decision, probe-origin official work may spend official quota but is capped by PR #546 (10,000 units/Pacific day) and, when enabled, by PR #533's 9,000/key cap. InnerTube retrieval itself is not billed. |
| Adaptive creator-derived pilot (PR #545) | **Default OFF, not activated, no live data.** Deterministic 50/50 country-day pilot; predeclared metrics and activation plan in [ADAPTIVE_DISCOVERY_PILOT_20261024.md](ADAPTIVE_DISCOVERY_PILOT_20261024.md). Migration 156 is additive and unapplied. |
| GCP key-suspension investigation | **Open / access-blocked** — see [GCP_SUSPENSION_DIAGNOSTIC_20261020.md](GCP_SUSPENSION_DIAGNOSTIC_20261020.md) |
| Merge / deploy / migration apply / flag changes / probes | **Not approved for hard cap, probe activation, or adaptive activation**; #533/#546 merges were approved and deployed. Shadow/CI evidence is not production proof. |

## Documents

| Document | Purpose |
| --- | --- |
| [ROLLBACK_TEST_20261019.md](ROLLBACK_TEST_20261019.md) | Migration 146/147 rollback proof and guards |
| [QUOTA_SHADOW_UNIT3_20261019.md](QUOTA_SHADOW_UNIT3_20261019.md) | Quota shadow evidence, 3-day replay, default-OFF hard-cap design, and 2026-10-24 review fixes |
| [INNERTUBE_POLICY_POSITION_20261020.md](INNERTUBE_POLICY_POSITION_20261020.md) | Project policy decision for keyless InnerTube retrieval |
| [GCP_SUSPENSION_DIAGNOSTIC_20261020.md](GCP_SUSPENSION_DIAGNOSTIC_20261020.md) | Read-only suspension investigation, exact missing access, no cause claim |
| [PILOT_LIMITS_AND_CANARY_20261020.md](PILOT_LIMITS_AND_CANARY_20261020.md) | Code-enforced vs config-only limits; option-2 probe accounting; canary pass/fail |
| [PROBE_QUOTA_ALLOCATION_20261024.md](PROBE_QUOTA_ALLOCATION_20261024.md) | Option-2 decision, exact bucket, path coverage, drain procedure, units per creator |
| [QUALIFIED_CREATOR_FORECAST_20261020.md](QUALIFIED_CREATOR_FORECAST_20261020.md) | Evidence-based yield scenarios and expected official units per qualified creator |
| [PRE_MERGE_REPORT_20261020.md](PRE_MERGE_REPORT_20261020.md) | Proposed heads, review dispositions, tests, residual issues, and closed gates |
| [ADAPTIVE_DISCOVERY_PILOT_20261024.md](ADAPTIVE_DISCOVERY_PILOT_20261024.md) | 14-day 50/50 pilot question, predeclared metrics, early read, and activation plan |

## Non-negotiable boundaries

- A discovered creator counts only if it is **persisted, verified, net-new**,
  and attributable to the probe. Raw returned channels, review-routed channels,
  and repeat sightings do not count. Probe origin alone never triggers human
  review or promotion.
- Shadow observations are not proof of enforcement and do not authorize
  activation.
- Probe results are not proof that the Discord/community promotion gate changed.
  The existing 3-creator / 2-community / evidence gates remain in force.
- No production probes, queue changes, flag changes, migration applies,
  deployments, or key/restriction changes are authorized by these documents.
