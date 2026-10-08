# Frozen Benchmark Specification / Preregistration v2

**Status: PREREGISTRATION ONLY — no benchmark has been executed under this specification.**
**Do not modify this document after benchmark execution begins. Any change requires a new spec version.**

- Benchmark specification version: `benchmark-preregistration-v2`
- Supersedes (does not modify): `docs/BENCHMARK_PREREGISTRATION.md` (`benchmark-preregistration-v1`, frozen, byte-unchanged).
- Engine base: current `origin/main` at v2 branch creation (record exact SHA in the execution record; the runner records `runningCommit` explicitly — no silent later commit).

## 1. What changes from v1

Exactly the following versioned literals, and nothing else:

| Item | v1 value | v2 value |
|---|---|---|
| Spec version | `benchmark-preregistration-v1` | `benchmark-preregistration-v2` |
| Scope size (`BENCHMARK_PREREG_SCOPE_SIZE`) | `300` | `120` |
| Pool rules version | `pool-rules-benchmark-prereg-v1` | `pool-rules-benchmark-prereg-v2` |
| Selection experimentId | `benchmark-prereg-v1-selection` | `benchmark-prereg-v2-selection` |
| Ordering experimentId | `benchmark-prereg-v1-ordering` | `benchmark-prereg-v2-ordering` |
| Pool opportunity prefix | `benchmark-prereg-v1:pool:` | `benchmark-prereg-v2:pool:` |
| Runner log/out namespace | `benchmark-prereg-v1` | `benchmark-prereg-v2` (out dir `./benchmark-prereg-v2`) |

New v2 identities guarantee zero observation collisions with any v1 execution, past or future.

## 2. Why scope 120 (the complete rationale, fixed before execution)

- §9-equivalent floor (unchanged from v1): minimum 30 eligible *attributed* observations per reported arm (CONTROL/THOMPSON/CONTEXTUAL); arms below minimum report `INSUFFICIENT_SAMPLE — no comparison`.
- 120 is the smallest scope that tolerates up to 25% zero-attribution exclusions while keeping all three arms at minimum (120 × 0.75 / 3 = 30/arm exactly). Scopes below 120 require near-zero exclusions, which every observed snapshot refutes (intent rotation alone always excludes a large group).
- 120 is plannable on observed production states (eligible range [128, 141] across 7 read-only censuses, 2026-10-07/08); larger values were never observed attainable and the data ceiling is ~186.
- **Explicitly accepted risk:** if runtime exclusions exceed 25%, one or more arms complete with `INSUFFICIENT_SAMPLE`. That is a valid terminal outcome under the unchanged analysis rules, not a protocol violation. A repeat would be a new execution with full disclosure of all runs, never a silent replacement.

## 3. Everything else frozen (identical to v1)

Assignment math (§6-equivalent), all §7 parameters, gates and defaults, exclusion rules, UCB1 control, arms/basis-points/priors/weights, stopping rules (14-day ceiling, coded caps only), failure/exclusion handling, analysis rules (descriptive only, no statistical claims), provenance requirements, production-safety posture. No tuning, no threshold/parameter/gate changes, no favorable selection of any kind.

## 4. Validation before freezing (no benchmark run)

- `npx tsc --noEmit` (full-project typecheck).
- Contract/unit suites: `querySelectionExperiments`, `retrievalExperiment`, `discoveryFrontierTrials`, `relationshipCanary`, `benchmarkPreregFindings.contract`, `benchmarkPreregV1` tests.
- CI workflows covering touched paths.
- A `--plan` dry-run is part of validation only insofar as it proves plumbing; the authorizing plan is produced fresh at execution time.

## 5. Authorization record

- v2 drafted on branch `benchmark-prereg-v2` from `origin/main`; PR opened, NOT merged, awaiting explicit review + execution authorization.
- `--execute` additionally requires: a successful same-day `--plan`, stopped autonomous scheduler (production config change, separately authorized), and a write-capable database path.
