# Independent Classification Audit v1

**Status:** evidence report for the deterministic-first classifier. No production decisions were changed to produce this report.

## Methodology

- **Sampling:** 300 channels stratified from real production classification evidence:
  - 100 from `TRADING_CONFIRMED`
  - 50 from `NON_TRADING`
  - 75 from `NEEDS_REVIEW`
  - 75 from `UNCERTAIN`
- **Prediction-blind worklist:** each row contained only the channel id/name, country, bio, video titles/descriptions, and links. Production status and classifier suggestions were excluded from the labeling file.
- **Independent audit:** six batches of 50 channels were audited from the raw evidence. Every decisive label required supporting quotes; every quote was checked as an exact substring of the cited field.
- **Labels:** `TRADING_CONFIRMED` (165), `NON_TRADING` (56), `UNCERTAIN` (79). The labels do not use production classifications as ground truth.
- **Label isolation:** audit labels live in the append-only `classification_audit_labels` ledger. They are never written into `evaluation_ground_truth_labels`, so they cannot enter the sealed evaluation dataset or production review decisions.
- **Diagnostic coverage:** 250 of the 300 audited channels had a production classification diagnostic suitable for full-engine replay.

## Results

For the 221 decisive audit labels:

| Evaluated decision | Precision | Recall | FPR | Explicit FNR | Positive miss | Coverage |
|---|---:|---:|---:|---:|---:|---:|
| Stored full engine decision | 95.9% | 70.3% | 8.9% | 0.0% | 29.7% | 74.7% |
| New routing + precision guard | **100.0%** | 69.7% | **0.0%** | **0.0%** | 30.3% | 71.9% |
| Deterministic-only engine | **100.0%** | 64.8% | **0.0%** | **0.0%** | 35.2% | 49.3% |

`Explicit FNR` counts only explicit `NON_TRADING` predictions. `Positive miss` includes audited trading labels that abstained or remained unresolved. For the routing decision, 50 positive labels were unresolved rather than explicitly rejected; for the deterministic-only engine, 58 were unresolved. This is why explicit FNR is 0% while recall is below 100%.

- Confusion matrix for the routing + guard: TP 115, FP 0, TN 44, FN 0.
- The deterministic-only engine resolves obvious trading channels without semantic spend and without false positives in this sample. The replay treats the sampled channel videos as hydrated evidence (stage 1), not as retrieval-selected match text. The remainder goes to AI/enrichment, not human review.
- The new routing guard escalates confirmed channels to human review when the video sample repeatedly contradicts the bio. It never rejects.

### Cohort breakdown

The sample is stratified by production cohort, so the headline figures are sample-weighted. The per-cohort figures below are the unbiased view for each cohort.

| Source cohort | Decisive labels | Routing resolved | Coverage | Precision | Recall | FPR |
|---|---:|---:|---:|---:|---:|---:|
| `TRADING_CONFIRMED` | 93 | 88 | 94.6% | 100% | 100% | 0% |
| `NEEDS_REVIEW` | 70 | 22 | 31.4% | 100% | 33.8% | 0% |
| `NON_TRADING` | 44 | 44 | 100% | N/A (no positives) | N/A | 0% |
| `UNCERTAIN` | 14 | 5 | 35.7% | 100% | 41.7% | 0% |

`NON_TRADING` precision/recall are undefined because that cohort contains no trading labels; all 44 resolved non-trading labels were correct.

### Country breakdown (stored engine → routing)

| Country | Decisive labels | Stored precision | Stored recall | Routing precision | Routing recall |
|---|---:|---:|---:|---:|---:|
| Unknown | 104 | 97.8% | 62.5% | 100% | 62.5% |
| United States | 50 | 93.9% | 79.5% | 100% | 76.9% |
| Germany | 20 | 100% | 76.5% | 100% | 76.5% |
| United Kingdom | 11 | 100% | 90.0% | 100% | 90.0% |
| France | 6 | 100% | 66.7% | 100% | 66.7% |
| United Arab Emirates | 5 | 75.0% | 100% | 100% | 100% |
| Australia | 5 | 100% | 60.0% | 100% | 40.0% |
| Canada | 5 | n/a (all abstained) | n/a | n/a | n/a |

The country table shows the eight largest groups. The remaining 15 decisive labels are distributed across other countries.

### Script breakdown

| Script | Decisive labels | Stored precision | Stored recall | Routing precision | Routing recall |
|---|---:|---:|---:|---:|---:|
| Latin | 201 | 96.5% | 72.8% | 100% | 71.5% |
| Mixed/multi-script | 20 | 85.7% | 42.9% | 100% | 42.9% |

## False positives found in the stored full engine

All five were escalated to human review by the new precision guard:

1. **AEX NL** — stock-exchange corporate/ceremonial channel, not trading content.
2. **Trading Live: Stock Forex Cryptocurrency** — trading keyword bio but dance/music uploads.
3. **Rachel Cruze** — personal finance/debt/budgeting, not financial-market trading.
4. **Crypto Woman** — sponsored NFT/play-to-earn promotions, not trading analysis.
5. **Pino** — memecoin marketing/skits, not trading analysis.

## False negatives

No explicit false-negative prediction was observed among the 221 decisive labels. This does not mean every trading channel was resolved: 50 routing positive labels and 58 deterministic-only positive labels abstained or remained unresolved. This is a small sample; zero observed false negatives does not prove zero population false negatives.

## Unresolved cases

79 channels were labeled `UNCERTAIN` because the available evidence was genuinely insufficient or mixed. Examples:

- **Andy Campillo** — multi-topic lifestyle channel where trading is one of several pillars; no videos available.
- **Analyshasse** — mostly lifestyle/wealth clips; trading appears through a community link and one earnings video.
- **CoderForTraders** — single bio line about trading-product development; no corroborating videos.
- **Nq Zeus** — two trading repost clips mixed with an unrelated broadcast.
- **Crypto Hulk** — crypto news/opinion and buy calls with a broker affiliate, without clear trading education or analysis.

These cases require more evidence or operator judgment; they are not counted as correct or incorrect in precision/recall.

## Limitations

- Labels are an independent **AI-assisted evidence audit** with exact quotes, not operator-entered human labels. The classification audit console lets operators inspect, filter, and correct every label with an append-only history. The report therefore says “audit labels,” not “human labels.”
- Audit labels are isolated from the sealed evaluation dataset. The audit ledger does not widen or write to `evaluation_ground_truth_labels`.
- Negative sample size is 56; FPR estimates have wide uncertainty.
- 50 audited channels had no production diagnostic and are excluded from the full-engine comparison.
- The sample is stratified by production cohort; it is not a uniform random sample of all channels.
- `TRADING_CONFIRMED` vs finance-adjacent (personal finance, investing, exchange corporate, crypto promotion) is a judgment boundary. The report uses a trading-activity/analysis/education definition.

## Reproduction

```bash
npm run classification:seed-audit
npm run classification:import-audit-labels
npm run classification:evaluate-audit
npx tsx scripts/evaluateClassificationAuditFull.ts
```

The worklist, labels, diagnostics export, and full evaluation JSON are generated under the configured audit data directory. The commands are read-only with respect to production classification decisions; the seed/import commands write only to the isolated audit items and labels ledgers.
