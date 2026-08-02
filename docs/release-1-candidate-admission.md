# Release 1 candidate admission contract

Release 1 implements only the foundations, nomination lineage, and shadow
admission projection from the authoritative candidate-admission roadmap. It does
not change the dashboard corpus, classification thresholds, review eligibility,
or evidence-provider model.

## Safety invariants

- A nomination has no serving authority.
- `candidate_admission_mode=OFF` performs no admission writes; `SHADOW`,
  `CANARY`, and `ACTIVE` currently remain observational and return
  `servingAuthority: false`. Later releases must pass governed promotion gates
  before either can affect serving.
- Only a classifier or authoritative human confirmation can produce the shadow
  `ADMITTED_CONFIRMED` state.
- Sparse evidence, unsupported language, provider failure, and an absent trading
  hypothesis never produce confirmation or a semantic non-trading decision.
- Operational failure is represented separately from semantic review.
- Immutable nominations, nomination events, admission decisions, and admission
  events are the replay authorities. Candidate and admission tables are
  repairable projections.
- The legacy dashboard predicate remains unchanged throughout Release 1.

## Controls

| Setting | Default | Release 1 behavior |
| --- | --- | --- |
| `nomination_ledger_enabled` | `false` | Enables immutable nomination writes. |
| `candidate_admission_mode` | `OFF` | Enables observational admission decisions in non-OFF modes. |
| `candidate_admission_canary_basis_points` | `0` | Reserved for deterministic later serving rollout; grants no Release 1 serving authority. |

Rollback turns the write controls off. Existing immutable observations remain
available for audit and replay; no reverse or destructive migration is needed.

## Operational verification

- `npm run migrate`
- `npm test`
- `npm run lint`
- `npm run build`
- `tsx scripts/verifyAdmissionProjection.ts [cutoff]`
- `tsx scripts/rebuildAdmissionProjection.ts <actor> [cutoff]`

The baseline endpoint requires a fixed cutoff and explicitly reports denominator
definitions and data limitations. Recall is never inferred from production
outcomes; the existing propensity-aware evaluation plane remains authoritative.
