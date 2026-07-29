# Phase 9 — Deterministic scoring and bounded AI assertions

## Decision, approved scope, and non-goals

Phase 9 is a shadow-only evidence layer over Phase 8's immutable, source-bound corpus.
It deterministically snapshots candidate frequency, independent entity-cluster and
source diversity, temporal stability/burst, dictionary lift, language affinity, and
anomaly features. It appends deterministic assertions and sends only ambiguous spans
to a separately controlled AI queue. It does **not** create concepts, resolve or merge
surfaces, publish a catalog, change query planning, spend search quota, or change Phase
F eligibility. Those remain later-phase work.

The principal trade-off is conservative recall: a small versioned dictionary can
accept clear trading spans and reject generic/prompt-injection spans, while everything
else remains ambiguous. This is preferable to silently manufacturing semantic truth.
The candidate key is a hash of the normalized literal, not a concept identity; Phase
10 owns semantic identity. Feature snapshots checksum ordered source coordinates and
lineage, so a version plus evidence checksum replays to the same result.

## Architecture and lineage

`TERM_HARVEST` completion enqueues `SCORE_CANDIDATES` with the document and feature-set
version. Scoring aggregates only exact Phase 8 occurrences, counts entity clusters
rather than treating every occurrence as independent, writes an immutable feature
snapshot and parallel deterministic assertion, and queues `AI_ADJUDICATE_CANDIDATE`
only for `AMBIGUOUS`. Job identities pin candidate/evidence and classifier versions.

The bounded provider prompt supplies one literal span and closed labels. Output must
have exactly the approved keys, reproduce the literal byte-for-byte, use a closed
label and valid confidence, and use `AMBIGUOUS` when abstaining. Unknown keys,
invented/rewritten terms, malformed JSON, timeouts, and invalid abstention fail closed.
Raw provider text is not retained; its hash, model/prompt/schema versions, token counts,
result status, and configured microunit cost are immutable evidence. Failed attempts
are retained separately while a retry may append a later assertion.

## Database, API, and compatibility

Migration 024 is expand-only and adds immutable feature snapshots, parallel
classification assertions, per-attempt adjudication results, anomaly flags, and a
singleton control row. Scoring and AI default paused with zero daily candidate,
assertion, and cost budgets. Existing tables are not changed or backfilled. Applying
the migration is safe with old application binaries because all additions are
independent; reverting the application leaves additive evidence readable later.

Authorized `GET /api/candidate-assertions?limit=N` compares deterministic/AI assertions
and reports abstention, errors, and aggregate AI cost. It is read-only and explicitly
reports `publicationEnabled: false`. There is no mutation or publication API. Existing
corpus and Phase F APIs and payloads are unchanged. Old workers ignore the new pending
job types; new workers claim them only when their dedicated controls are enabled.

## Operations, rollout, and rollback

1. Apply migration 024; verify both controls and queue controls are paused and budgets
   are zero. Confirm Phase F query output and replay totals are unchanged.
2. Set a reviewed deterministic candidate budget and enable scoring for a small,
   multilingual frozen cohort. Compare replay checksums, per-country confusion, cluster
   diversity, anomaly rates, queue latency, and storage growth.
3. Keep AI paused until the held-out set, source policy, model/prompt version, provider
   deadline, and `CANDIDATE_AI_COST_MICROUNITS` reservation are approved. Then set a
   non-zero assertion and microunit budget and enable one small ambiguous cohort.
4. Alert on malformed/failed-closed rate, abstention and label drift, daily token/cost
   totals, queue age, language confusion, and any literal mismatch. No production term
   becomes eligible regardless of these results.

Rollback is to pause AI first and scoring second, then restore the previous application
image. Pending new-type jobs remain durable and unclaimed by the old worker. Immutable
snapshots, attempts, assertions, and provider events remain for diagnosis; do not
delete or rewrite them. Because serving and Phase F are untouched, no catalog or query
rollback is necessary.

## Verification and go/no-go

Code gates prove additive/immutable schema, deterministic replay, correlated-source
handling, deterministic generic/injection rejection, closed-schema abstention, and
unseen-string rejection. The complete suite, TypeScript lint, build, migration
idempotence against PostgreSQL, multilingual held-out precision/calibration, human
agreement, provider timeout/retry, shadow cost reconciliation, and a rollback drill
form the release evidence package.

Implementation completion does not itself declare production **GO**. The Phase 9 gate
remains **NO-GO** until reviewed staging evidence demonstrates calibrated multilingual
held-out value over deterministic rules, intended abstention, reconciled cost, and zero
untraceable or model-invented accepted terms. Phase 10 remains blocked until that gate
is explicitly approved.
