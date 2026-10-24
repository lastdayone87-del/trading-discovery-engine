# Phase 1 — durable source of truth

Last updated: 2026-10-24 (hard-cap and probe-allocation review hardening). This directory is the durable index for the Phase 1
discovery work. It records decisions and evidence, not deployment state. When a
document and a live system disagree, the live system wins and the document must
be corrected.

## Current gate status

| Item | State |
| --- | --- |
| PR #531 (migrations 146/147/148 + discovery hardening) | **Merged** on 2026-10-20T23:37:42Z (with #532; #530 already merged). No merge, deploy, migration apply, or flag change was performed by this session |
| PR #530 (discovery integrity) | **Merged into `phase1-hardening` at `6267ba1` by an external actor, not this session.** Added migrations 149–152 and changed the base/order |
| Migrations 148–153 | Present on `main` (`13a151b`); migrations 154–155 are only on the stacked #546 branch. Applied only to disposable CI databases; **not** applied to production |
| Hard cap (9,000 units/key/Pacific day) | Implemented on `feat/youtube-key-hard-cap` code/test head `c7fae59`, rebased on current main `13a151b`; CI run [40062160087](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/40062160087) green (53/53 unit, 23/23 PostgreSQL, 0 skipped) and rotation run [40062163280](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/40062163280) green (71/71); **default OFF, not deployed, not enabled** |
| Probe-origin official allocation (#546) | Stacked on #533 at `ea92fdc`; default OFF, not deployed, migrations 154–155 unapplied. Option 2: probe-origin work may spend official quota only through its independent, capped Pacific-day bucket; no probe has been activated |
| InnerTube production use | **Not authorized** — see [INNERTUBE_POLICY_POSITION_20261020.md](INNERTUBE_POLICY_POSITION_20261020.md) |
| Probe pilot | **Not runnable** while the InnerTube position is unresolved; limits below. No probe has been run. Probe-ledger units are retrieval-only; delegated ingestion official spend is separately accounted |
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
