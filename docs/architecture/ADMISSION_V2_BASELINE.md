# Deterministic admission baseline (frozen 900)

This is a read-only offline evaluation of the current deterministic admission
gate. It calls `evaluateDeterministicAdmission()` with semantic providers OFF,
using the same admission-time field set (channel title, bio, recent videos).
It does not call AI, write production rows, or change behavior.

## Command

```bash
npx tsx scripts/evaluateDeterministicAdmission.ts \
  --cases /tmp/opencode/fresh_cases.jsonl \
  --truth /tmp/opencode/fresh_truth.json \
  --out /tmp/opencode/deterministic-eval.jsonl
```

## Result

| Metric | Value |
|---|---:|
| Cases | 900 |
| Deterministic confirm (`PASS`) | 536 |
| Deterministic reject (`REJECT`) | 2 |
| Abstain (`AMBIGUOUS`) | 362 |
| Decisive coverage | 59.8% |

### Confusion

| Truth | PASS | REJECT | AMBIGUOUS |
|---|---:|---:|---:|
| TRADING_RELEVANT (829) | 529 | 0 | 300 |
| FINANCE_ADJACENT (35) | 0 | 0 | 35 |
| UNRELATED (29) | 4 | 2 | 23 |
| AMBIGUOUS (7) | 3 | 0 | 4 |

### Gate metrics

- Confirm precision: **98.69%** (529/536)
- Hard unrelated confirmations: **4** (4/859 = 0.47% of resolved cases)
- Reject precision: **100%** (2/2)
- Unrelated rejection recall: **6.9%** (2/29); 23 unrelated cases abstain
- Trading-relevant deterministic recall: **63.8%** (529/829); 300 abstain
- Finance-adjacent false rejects: **0**

## What the failures tell us

### The four hard false confirmations

All four are channels whose bio/title says trading but whose recent uploads are
overwhelmingly unrelated:

| Case | Channel | Why it passed | Recent uploads |
|---:|---|---|---|
| 300 | RMDTrades | Bio says ICT/futures trader; title carries the trading anchor | Welding clips |
| 616 | TJRmindset | Clip channel around a trader; bio mentions trading | GTA 6, iShowSpeed, watches |
| 668 | Jason Raynor | Bio mentions forex futures; title/name carries trading | Audi engine builds |
| 707 | Tommy The Trader | Bio is explicit supply/demand trading education | Kids/Takis/bounce-house clips |

These are exactly the catalog-dominance failure mode: creator metadata is
trading, but the actual recent content is not. A fast pass must require recent
creator-owned content support, not just a trading bio/title. This is a
false-confirmation fix, not a new rejection rule.

Three additional `AMBIGUOUS` truth cases also fast-passed (Gamma Labs, Mamba
Trades, AlphaFx981). They are mixed/bait channels whose recent feeds are
majority non-financial. They should abstain for the AI judge, not confirm
deterministically.

### The unrelated abstentions

23 of 29 `UNRELATED` cases abstained. Reason codes:

- `INDEPENDENT_EVIDENCE_REQUIRED` — 11
- `INSUFFICIENT_EVIDENCE_ENRICH` — 10
- `FINANCE_ADJACENT_DEFERRED_TO_DOWNSTREAM` — 4
- `AMBIGUOUS_AFTER_SEMANTIC_ENRICH` — 2

The strict-rejection path is too conservative. It requires independent
corroborating citations that are often not available at admission time. A clear
unrelated channel with recent non-financial video content should be rejectable
without needing a second independent surface.

### The trading-relevant abstentions

300 trading-relevant cases abstained:

- 122 `INDEPENDENT_EVIDENCE_REQUIRED`
- 122 `FINANCE_ADJACENT_DEFERRED_TO_DOWNSTREAM`
- 84 `AMBIGUOUS_AFTER_SEMANTIC_ENRICH`
- 54 `INSUFFICIENT_EVIDENCE_ENRICH`
- 6 `DETERMINISTIC_TRADING_MINORITY`

By content type: 103 trading education, 93 investing education, 63 active
trading, 13 financial news, 10 hype, 10 market institution, 8 signal provider.

This shows two different gaps:

1. **Evidence coverage/corroboration**: many genuine trading creators have
   enough content but not enough source-anchored citations at admission time.
2. **Finance-adjacent deferral is too broad**: a genuine trading creator with a
   finance-adjacent bio is deferred even when recent videos contain active
   trading/execution language.

## Implications for PR5

The deterministic gate should be strengthened in this order:

1. **Recent-content dominance guard for deterministic confirmation.** If
   creator-owned recent videos are available and the substantive majority is
   unrelated, do not fast-pass on bio/title alone. Abstain for the full AI
   judge. This targets the 4 hard false confirmations and the 3 mixed cases
   without globally lowering thresholds.
2. **Recent-content-based unrelated rejection.** Use independent creator-owned
   video evidence plus bio/title to reject clear unrelated channels; do not
   require a second non-video surface when the recent feed is decisive.
3. **Finance-adjacent vs active-trading separation.** Do not defer a channel
   with explicit live execution/trade recap/analysis evidence merely because
   its bio contains personal-finance or investing vocabulary.
4. **Citation/coverage expansion.** Use the authoritative snapshot videos and
   source-anchored field references instead of relying on model citations for
   deterministic fast paths.
5. **Measured local n-gram pilot.** Only integrate if it improves multilingual
   and indirect-title recall without adding hard false confirmations.

## Interpretation limits

This is an offline evaluation on the frozen cohort, not production outcomes.
It uses admission-time evidence and semantic mode OFF. It does not measure the
one-AI-judge architecture, enrichment yield, or final pipeline recall. Those
are measured after the architecture changes in the isolated integration run.
