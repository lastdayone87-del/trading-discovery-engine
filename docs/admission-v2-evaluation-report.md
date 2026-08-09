# Admission V2 Evaluation Report

**Evaluation date:** 2026-08-09  
**Policy evaluated:** `creator-admission-v2-offline-poc-1`  
**Report status:** Incomplete: historical evaluation data was not reachable  
**Production authority exercised:** None

## Executive finding

Admission V2 cannot yet be judged semantically from the evidence available in
this execution environment. The configured PostgreSQL endpoint could not be
resolved, and the repository contains no local sealed decision-evaluation
dataset with matching immutable creator-focus and evidence-coverage snapshots.
Consequently:

- zero sealed datasets were inventoried;
- zero Admission V2 examples were evaluated;
- zero creator decisions were produced;
- precision, recall, false-positive reduction, projected enrichment reduction,
  and projected review reduction are not estimable;
- there are no observed false positives or false negatives to attribute;
- no threshold or calibration adjustment is supported by evaluation evidence.

This is an evidence-availability result, not a negative semantic result for the
policy. It does, however, block any production progression because the central
hypothesis remains untested.

## 1. Evaluation protocol

The intended evaluation used the existing offline POC without modifying its
policy or any production path:

1. Enumerate `decision_evaluation_datasets` and identify representative sealed
   datasets by cutoff, country, language, discovery origin, and test sample size.
2. Run `npm run admission:v2-poc -- <sealed-dataset-uuid>` for each representative
   dataset.
3. Retain only immutable `TEST` examples with the POC's pinned creator-focus and
   evidence-coverage policy versions.
4. Compare Admission V2 decisions with sealed ground truth using logged inclusion
   probabilities.
5. Aggregate results globally and by language, country, and acquisition source.
6. Inspect every ground-truth non-trading creator not withheld and every genuine
   creator withheld, then attribute the failure.

The POC loader is appropriate for this protocol because it uses a PostgreSQL
`READ ONLY` transaction and reads the sealed test examples plus diagnostic-linked
creator-focus and coverage snapshots. It performs no write or provider operation.

## 2. Dataset inventory result

### Configured historical store

`DATABASE_URL` was configured, but the Railway proxy hostname
`trolley.proxy.rlwy.net` failed DNS resolution on every connection attempt with
`getaddrinfo EAI_AGAIN`. A direct DNS check returned the same result. No SQL query
reached PostgreSQL.

### Local repository data

The local `data/` directory contains legacy database files only:

- `data/test.db`
- `data/trading_engine.db`
- `data/trading_engine.backup.db`

Repository inspection found no local export of:

- `decision_evaluation_datasets`;
- `decision_evaluation_examples`;
- `evaluation_ground_truth_labels`;
- `creator_focus_classification_snapshots`;
- `evidence_coverage_snapshots`.

The legacy local files therefore cannot be substituted for the sealed immutable
input contract without violating the evaluation design.

### Representativeness assessment

| Required dimension | Available datasets | Evaluated examples | Result |
| --- | ---: | ---: | --- |
| Multiple time periods | 0 | 0 | Not measurable |
| Multiple countries | 0 | 0 | Not measurable |
| Multiple languages | 0 | 0 | Not measurable |
| Multiple acquisition sources | 0 | 0 | Not measurable |

No claim about cross-country, multilingual, acquisition-source, or temporal
stability can be made.

## 3. Aggregate metrics

| Metric | Result | Interpretation |
| --- | ---: | --- |
| Precision | Not estimable | No eligible sealed test examples were loaded |
| Genuine creator recall | Not estimable | No ground-truth genuine creators were loaded |
| False-positive reduction | Not estimable | No ground-truth non-trading creators were loaded |
| Projected review-volume reduction | Not estimable | No legacy unresolved-work baseline was loaded |
| Projected enrichment reduction | Not estimable | No legacy unresolved-work baseline was loaded |
| Historical evidence eligibility | Not estimable | Dataset denominator could not be queried |
| Effective sample size | 0 | Below the POC minimum of 30 for both required cohorts |

The offline policy's own fail-closed assessment would be
`INSUFFICIENT_EVIDENCE`: neither required cohort has a measurable effective
sample, and historical evidence eligibility cannot be established.

## 4. Breakdown by language

No sealed examples were available. There are no language-specific confusion
matrices, precision estimates, recall estimates, or workload projections.

This missing breakdown is promotion-blocking. The policy explicitly defers when
the creator-focus language stage does not pass, so aggregate-only evidence would
not be sufficient even if it were available.

## 5. Breakdown by country

No sealed examples were available. There are no country-specific precision,
recall, false-positive reduction, or workload estimates.

Country-level evidence is required because document availability, language
coverage, query behavior, and acquisition-source mix can differ materially by
market. No global inference is made from the repository's synthetic unit tests.

## 6. Breakdown by acquisition source

No sealed examples were available. There are no results for autonomous search,
manual search, playlist, featured-channel, or other discovery origins.

The sealed evaluation schema stores `discoveryOrigin` in each example segment,
so this analysis can be completed without a schema or runtime change once the
historical database or a read-only export is accessible.

## 7. False-positive analysis

### Observed count

Zero examples were evaluated; therefore zero Admission V2 false positives were
observed and zero cases can be individually analyzed.

### Required case definition for the rerun

Every ground-truth `NON_TRADING` example with an Admission V2 decision other than
`WITHHOLD` must be listed individually with:

- channel and example identity;
- production baseline status and score;
- creator-focus distribution, probability, and lower confidence bound;
- creator-focus proposed status and reason codes;
- coverage disposition and independent-family count;
- language and temporal stage disposition;
- country, language, and acquisition source;
- primary failure attribution.

Deferral is not a semantic false-positive admission, but it is a failure to
achieve the POC's intended false-positive workload reduction and must be included
in operational burden analysis.

## 8. False-negative analysis

### Observed count

Zero examples were evaluated; therefore zero genuine-creator retention failures
were observed and zero cases can be individually analyzed.

### Required case definition for the rerun

Every ground-truth `TRADING_CONFIRMED` example receiving `WITHHOLD` is a recall
failure and must be analyzed individually using the same evidence fields. Genuine
creators receiving `DEFER_INVESTIGATION` remain retained under the POC's recall
definition but must be reported separately because excessive deferral would
prevent useful confirmation and merely move workload rather than resolve it.

## 9. Failure-cause framework

No observed failure can be assigned to a cause. On rerun, each false positive,
false negative, and non-trading deferral should receive one primary attribution:

| Cause | Attribution rule |
| --- | --- |
| Missing evidence | Coverage missing/insufficient, fewer than two independent families, absent recent evidence, or unsupported language prevented a decision |
| Calibration | Creator-focus ranking is directionally correct, but probability/lower bound is inconsistent with labeled frequency or stratum calibration |
| Creator-focus classification | The creator-focus distribution places mass on the wrong creator hypothesis despite sufficient representative evidence |
| Policy thresholds | Creator-focus metrics are directionally correct and calibrated, but fixed Admission V2 boundaries produce the wrong decision |
| Historical data quality | Incorrect label, identity conflict, snapshot after label leakage, corrupt/misaligned provenance, or nonrepresentative sampling invalidates the example |

Attribution must begin with historical-data validity, then evidence completeness,
then creator-focus correctness, then calibration, and finally policy thresholds.
This order prevents threshold tuning from masking missing or invalid evidence.

## 10. Policy and calibration assessment

### Evidence-supported adjustments

None.

Changing the current thresholds would be unsupported because no empirical error
distribution was observed. In particular, this evaluation does not support:

- lowering the 0.8 alternative-focus withholding boundary;
- increasing the 0.2 maximum trading mass for withholding;
- lowering the 0.7 trading confirmation/lower-bound requirement;
- changing the 0.35 plausible-review threshold;
- weakening independent-family, language, temporal, or coverage gates;
- changing the 95% retained genuine-creator recall floor;
- lowering the effective sample or historical evidence eligibility requirements.

### POC measurement limitations to account for on rerun

The POC directly reports false-positive reduction and genuine-creator retention,
but it does not expose a separately named precision field. Precision must be
calculated from the per-example decisions as:

```text
ground-truth genuine ADMIT_CONFIRMED
--------------------------------------------------
all ADMIT_CONFIRMED
```

Review and enrichment reductions are explicitly projections based on legacy
`UNCERTAIN`/`NEEDS_REVIEW` status, not observed job or review execution. They
should be presented as workload proxies rather than realized savings.

These limitations do not require a production change, feature flag, or schema
change. They can be handled in the evaluation analysis over the existing report.

## 11. Stability and progression assessment

The current policy has unit-level evidence for deterministic behavior and
fail-closed handling, but no accessible historical evidence establishing:

- precision on real admitted creators;
- retained genuine-creator recall;
- positive false-positive reduction;
- stable results by language and country;
- stable results across acquisition sources;
- stability across time periods;
- adequate creator-focus and evidence-coverage availability;
- calibration adequacy on the target population.

Unit fixtures cannot substitute for sealed historical evaluation. Production
progression would therefore violate the POC's own minimum effective-sample and
historical-evidence eligibility requirements.

## 12. Required evidence to complete this evaluation

No implementation change is required. Provide either:

1. network access from the evaluation environment to the configured read-only
   PostgreSQL endpoint; or
2. a read-only PostgreSQL export containing the sealed dataset, test examples,
   creator-focus snapshots, evidence-coverage snapshots, and referenced policy
   metadata.

The rerun should include every qualifying sealed dataset rather than selecting
only favorable cohorts, then choose representative time periods and report any
dataset excluded for insufficient country, language, source, or sample coverage.

## Final recommendation

**Needs more evidence/calibration**
