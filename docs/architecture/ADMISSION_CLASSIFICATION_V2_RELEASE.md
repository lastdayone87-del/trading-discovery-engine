# Admission and classification v2 release

This release completes the six-part correction:

1. deterministic admission measurement and frozen-900 baseline;
2. authoritative creator-owned snapshot video retention;
3. reliable evidence-checksum semantic caching;
4. one post-enrichment AI judge with no Tier-A confirmation veto;
5. substantive recent-video guard for deterministic fast passes;
6. final production cutover and verification.

## Runtime flow

```text
discovery
  -> deterministic admission
       clear trading      -> confirm, no AI
       clear unrelated    -> reject, no AI
       ambiguous/thin     -> stage-1 enrichment
  -> one full AI judge on complete creator-owned evidence
  -> confirm if valid category, creator-owned citation, confidence >=70,
     no material contradiction
  -> enrich/review if genuinely insufficient
```

Semantic admission is no longer a decision judge. It remains ledger/audit
provenance only. The full classifier's composition/recognition remains a
coverage/contradiction signal; it cannot independently veto a valid AI trading
verdict.

## Frozen-900 deterministic result

| Metric | Before | After |
|---|---:|---:|
| Deterministic PASS | 593 | 514 |
| Deterministic REJECT | 2 | 2 |
| Deterministic abstain | 305 | 384 |
| Confirm precision | 98.65% | **99.61%** |
| Hard UNRELATED confirmations | 5 | **0** |
| Trading-relevant deterministic recall | 70.6% | 61.8% |
| Unrelated rejection recall | 6.9% | 6.9% |

Blocked fast passes abstain and reach the one AI judge. No global threshold
was lowered.

## Existing full-classifier validation

The frozen full-classifier cohort remains at **99.26% precision / 98.28%
recall** with **0 confirmed UNRELATED** in the resolved set. The new policy
cannot reduce semantic recall; its AI-led confirmation path only removes the
Tier-A veto for verdicts with creator-owned citations and no contradiction.

## Deployment

The release is a single cutover. Production ran the old image until this PR
merged. No shadow or canary path was deployed. Existing affected records are
reprocessed under the new path in bounded batches; no mass approval.
