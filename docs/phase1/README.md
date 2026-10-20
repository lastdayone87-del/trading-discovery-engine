# Phase 1 — durable source of truth

Last updated: 2026-10-20. This directory is the durable index for the Phase 1
discovery work. It records decisions and evidence, not deployment state. When a
document and a live system disagree, the live system wins and the document must
be corrected.

## Current gate status

| Item | State |
| --- | --- |
| PR #531 (migrations 146/147 + discovery hardening) | Open; fixes committed on `phase1-hardening`; CI and review round 1 pending |
| Migration 148 (quota lease/event storage) | In PR #531 lineage; not applied to production |
| Hard cap (9,000 units/key/Pacific day) | Implemented on `feat/youtube-key-hard-cap`; **default OFF, not deployed, not enabled** |
| InnerTube production use | **Not authorized** — see [INNERTUBE_POLICY_POSITION_20261020.md](INNERTUBE_POLICY_POSITION_20261020.md) |
| Probe pilot | **Not runnable** while the InnerTube position is unresolved; limits below |
| GCP key-suspension investigation | **Open / access-blocked** — see [GCP_SUSPENSION_DIAGNOSTIC_20261020.md](GCP_SUSPENSION_DIAGNOSTIC_20261020.md) |
| Merge / deploy / migration apply / flag changes / probes | **Not approved**; stop before any of these |

## Documents

| Document | Purpose |
| --- | --- |
| [ROLLBACK_TEST_20261019.md](ROLLBACK_TEST_20261019.md) | Migration 146/147 rollback proof and guards |
| [QUOTA_SHADOW_UNIT3_20261019.md](QUOTA_SHADOW_UNIT3_20261019.md) | Quota shadow evidence, 3-day replay, and default-OFF hard-cap design |
| [INNERTUBE_POLICY_POSITION_20261020.md](INNERTUBE_POLICY_POSITION_20261020.md) | Project policy decision for keyless InnerTube retrieval |
| [GCP_SUSPENSION_DIAGNOSTIC_20261020.md](GCP_SUSPENSION_DIAGNOSTIC_20261020.md) | Read-only suspension investigation, exact missing access, no cause claim |
| [PILOT_LIMITS_AND_CANARY_20261020.md](PILOT_LIMITS_AND_CANARY_20261020.md) | Code-enforced vs config-only limits; canary pass/fail |
| [QUALIFIED_CREATOR_FORECAST_20261020.md](QUALIFIED_CREATOR_FORECAST_20261020.md) | Evidence-based dates and yield scenarios for persisted qualified creators |

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
