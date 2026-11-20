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
verdict. Tier-A refers to the classifier's strongest creator-owned content families (for example an explicit trading bio or a substantive trading video), as defined in `server/evidenceEngine/contextualComposition.ts`.

## Frozen-900 deterministic result

| Metric | Before | After |
|---|---:|---:|
| Deterministic PASS | 593 | 439 |
| Deterministic REJECT | 2 | 2 |
| Deterministic abstain | 305 | 459 |
| Decisive coverage | 66.1% | 49.0% |
| Confirm precision | 98.65% | **99.54%** |
| Hard UNRELATED confirmations | 5 | **0** |
| Trading-relevant deterministic recall | 70.6% | 52.7% |
| Unrelated rejection recall | 6.9% | 6.9% |

Blocked fast passes abstain and reach the one AI judge. No global threshold
was lowered.

## Existing full-classifier validation

The frozen full-classifier cohort (893 non-ambiguous cases, checked into
`tests/fixtures/admission-v2`) measures **97.94% precision / 97.47% recall**,
**4 hard `UNRELATED` predictions (0.45%)**, and **70.66% content-type exact**.
Three non-ambiguous cases have no stored prediction and are counted as misses.
Reproduce with:

```bash
npx tsx scripts/evaluateFrozenClassifierCohort.ts
```

Those predictions predate the routing change. The AI-led path does not add a
rejection rule; it removes the Tier-A confirmation veto only when a semantic
trading verdict has a creator-owned citation, confidence >=70, a valid category,
and no material contradiction. A post-deploy replay is required to measure the
new routing on fresh production evidence.

## Deployment and rollback

The release is a single cutover. Production ran the old image until this PR
merged. No shadow or canary path was deployed. Image rollback is the previous
production image (`75694245`); migrations are additive and do not require a
destructive rollback. Existing affected records are reprocessed under the new
path in bounded batches; no mass approval.

Post-deploy checks:

1. `/api/health` ready, restarts 0, new symbols present in the bundle.
2. One ambiguous admission creates one stage-1 `ENRICH_CHANNEL` job and no
   semantic admission judgement.
3. One classifier AI judgement after enrichment; unchanged evidence hits cache.
4. Confirmed/non-trading terminal rows are preserved on rediscovery.
5. Monitor confirmation, rejection, review, ENRICH, AI calls, cache hits and
   provider retries before enlarging reprocessing batches.
