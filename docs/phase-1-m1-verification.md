# Phase 1 M1 — end-to-end pipeline verification

**Status:** verification coverage complete.
**Scope:** Phase 1 tracking issue #594, item M1.

## What this verifies

`server/phase1EndToEndVerification.test.ts` drives representative source
surfaces through the same boundaries used in production:

1. **Acquisition/inspection** — `runChannelInspection` with real static/rendered
   fake transports and the shared acquisition policies.
2. **Candidate extraction** — structured `DiscordCandidate` retention, canonical
   invite identity, and source-surface observations.
3. **Deduplication/ownership** — `mergeDiscordCandidates` with creator context;
   duplicate invites collapse to one candidate while preserving every surface
   observation.
4. **Validation** — `validateDiscordInvite` against a fake Discord API; the
   retained candidate resolves to a live, trading-relevant invite.
5. **Final status accounting** — `projectDiscordValidation` produces
   `ACTIVE`/`SUCCEEDED`/`VALIDATED`; `projectNotFoundAfterInspection` produces a
   clean `NOT_FOUND` only for a genuinely inspected negative;
   `detectPendingDiscoveryWork` keeps partial surfaces retry-owned.

The persistence boundary is exercised through the same pure projection helpers
that feed `upsertChannel`; no database writes are made by this suite.

## Scenario matrix

| Surface | Scenario | Asserted outcome |
|---|---|---|
| H1 | Discord server page link | `h1-room` candidate from `CHANNEL_EXTERNAL_LINKS`, validated and projected |
| H3 | invite in the tenth acquired description | `h3-room` from `RECENT_VIDEO_DESCRIPTIONS` |
| L1 | invite in pinned comment | `l1-room` with `PINNED_COMMENT` provenance; alone remains `UNCERTAIN` |
| M2a/M2b | form submit button with literal `formaction` | `m2-room` extracted statically; M2b never clicks the submit control |
| M4a | Discord widget iframe | `m4a-room` via `widget.json`; parent is optional and iframe HTML is not fetched |
| M4b | same-origin iframe | `m4b-room` from iframe content |
| Dedupe | same invite from H1 server page + L1 pinned comment | one canonical candidate, both observations, `CREATOR_OWNED` |
| H2 | confirmed optional 404 | clean `INSPECTED_NO_MATCH` -> `NOT_FOUND`, no retry |
| H2 | optional 503 | `PARTIALLY_INSPECTED`, durable retry directive, pending work |
| M4b | failed same-origin iframe | `PARTIALLY_INSPECTED`, durable retry directive, pending work |

## Verification commands

```text
npx tsc --noEmit -p tsconfig.json
node --import tsx --test server/phase1EndToEndVerification.test.ts
node --import tsx --test \
  server/phase1EndToEndVerification.test.ts \
  server/acquisitionV2Contracts.test.ts \
  server/communityAcquisitionSemantics.test.ts \
  server/discordSurfaceCoverage.test.ts \
  server/pinnedCommentProvenance.test.ts \
  server/sameOriginIframeCoverage.test.ts \
  server/allVideoDescriptions.test.ts \
  server/staticControlCoverage.test.ts \
  server/m2bSafeClickDisposition.test.ts \
  server/discordCandidates.ownership.test.ts \
  server/discordDiscoveryRecall.test.ts \
  server/recallSafeAcquisition.test.ts
```

Results: M1 matrix **10/10**; Phase 1 regression sweep **198/198**; `tsc`
passes. No production code, settings, data, migrations, or deployments were
changed by this verification unit.
