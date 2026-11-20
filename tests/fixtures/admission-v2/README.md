# Frozen admission cohort

These are the fixed 900-channel evaluation inputs used by
`scripts/evaluateDeterministicAdmission.ts` and the admission/classification
architecture work.

| File | SHA-256 |
|---|---|
| `fresh_cases.jsonl` | `9cc99810809c085b68b91f4f3ad07391dd4670ea6cc3955cf78f3c761d88dc41` |
| `fresh_truth.json` | `4d60d2c4ca3630d0f97609154b19f16a069db2d91a9ceaaa69bf69e4e34a25c2` |
| `fresh_classifier.jsonl` | `9a879be21515edeacfee4cb60ac6c59b4b87d670eec8ac979b16236300c4cf1c` |

Each case contains a channel id, name, description and, when available, a recent video sample.
The truth file contains the independent relevance/content-type/operator label.
Cases without a truth record fail the evaluation rather than being silently
dropped.

The cohort is frozen for regression comparisons and is not a blind holdout for
repository users because the truth labels are checked in. Do not tune rules
against it; use a separate external blind sample for final validation.
