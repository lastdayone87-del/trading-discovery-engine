# Phase 19 — Conservative entity resolution and source-family independence

## Scope and authority

Phase 19 establishes identity and evidence-correlation semantics before the
temporal research frontier can traverse relationships. It separates:

- canonical entities such as channels, creators, firms, brokers, exchanges,
  platforms, websites, and communities;
- provider identifiers and observed aliases;
- evidence nodes and immutable source artifacts;
- source families that identify documents sharing one causal origin;
- proposed versus approved bindings.

The mutable evidence graph remains offline. Entity observation is default-off,
and production classification consumes only source/entity identifiers already
transported with its immutable input.

## Conservative resolution contract

Normalization is namespace-aware and Unicode-safe. Provider-native identifiers
preserve case where identity requires it; domains use IDNA ASCII; URLs remove
fragments and tracking parameters without discarding meaningful query identity.

An exact provider-native channel identifier may deterministically create and
bind one `CHANNEL` entity. A same-provider canonical URL remains proposed. Other
cross-source identifiers require at least two independent source families and
two independent source entities merely to create a link proposal. They do not
merge entities or become approved features.

Conflicting approved identifiers abstain with `ABSTAIN_CONFLICT`. Insufficient
or correlated evidence abstains with `ABSTAIN_INSUFFICIENT`. No occurrence
volume, model score, country, language, or lexical similarity can override these
states.

Bindings are governed projections with optimistic versions. Approval,
rejection, and supersession require an authenticated actor, reason, expected
version, evidence checksum, and immutable decision/event. Automatic entity merge
is intentionally absent.

## Source-family independence

Source families are deterministic correlation units derived, in descending
strength, from:

1. explicit syndication identity;
2. exact content fingerprint;
3. canonical document URL;
4. provider-native document identity;
5. a unique unknown-artifact identity.

Several pages repeating one syndicated document count as one family even when
different sites host them. Distinct provider-native videos remain separate
families. Entity diversity and family diversity are reported independently.

Channel, video, semantic citation, and external-link evidence now transport
`sourceFamilyId` and `sourceEntityId`. The production corroboration stage
collapses correlated observations before evaluating repetition, provider, field,
or evidence-dimension diversity. A single family cannot manufacture
corroboration through multiple provider emissions.

## Rollout, compatibility, and measurement

`entity_observation_enabled=false` leaves persistence disabled while the
deterministic provenance transport and conservative corroboration rule remain
replayable. Existing evidence without family metadata receives a unique
observation fallback for backward-compatible historical replay; new production
YouTube fields receive stable family identities.

The inspection API reports entity, approved/proposed binding, abstention, and
source-family counts. Stage 1 evaluation must compare terminal precision,
confirmation recall, abstention/review rate, correlated-corroboration vetoes,
language/script slices, and false merge/link corrections before any broader
entity consumer is canaried.

This stage adds no provider requests. Persistence failures are observational and
cannot fail classification. Rollback disables entity observation; source-family
fields remain harmless provenance and the classifier continues to abstain rather
than infer negative evidence.
