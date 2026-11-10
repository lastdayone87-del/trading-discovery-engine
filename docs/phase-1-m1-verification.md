# Phase 1 M1 — end-to-end pipeline verification

**Status:** verification coverage complete.
**Scope:** Phase 1 tracking issue #594, item M1.

## What this verifies

`server/phase1EndToEndVerification.test.ts` drives representative source
surfaces through the same boundaries used in production:

1. **Acquisition/inspection** — `runChannelInspection` with deterministic fake
   transports and the shared acquisition policies. The suite uses
   `publicTestResolver` in place of production DNS; real DNS/destination
   resolution is not exercised. It exercises the static acquisition path;
   rendered fallback/click behavior is not exercised here and is covered by
   the browser suites (M2b/rendered).
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

**Persistence/DB writes are not exercised by this suite.** It verifies the pure
projection outputs that feed `upsertChannel`; actual upsert/database behavior is
covered by the existing pg-tests and is a separate integration boundary. The
suite injects `creatorLikelyTrading:false` and an empty URL failure-history
loader and deletes `DATABASE_URL` for its test process, so `getDb()` cannot
open, migrate, or seed a configured developer database; settings reads fail
closed to defaults and no DB writes occur.

## Scenario matrix

| Surface | Scenario | Asserted outcome |
|---|---|---|
| H1 | Discord server page link | `h1-room` candidate from `CHANNEL_EXTERNAL_LINKS`, validated and projected |
| H1 | server-page/widget fetch failure | `ACQUISITION_FAILED`, durable retry directive, pending projection |
| H3 | invite in the tenth acquired description | `h3-room` from `RECENT_VIDEO_DESCRIPTIONS` |
| L1 | invite in pinned comment | `l1-room` with `PINNED_COMMENT` provenance; alone remains `UNCERTAIN` |
| M2a | form submit button with literal `formaction` | `m2-room` extracted statically. M2b click exclusion is verified separately by `m2bSafeClickDisposition.test.ts` and the browser workflow; this static matrix does not exercise rendered clicks. |
| M4a | Discord widget iframe | `m4a-room` via `widget.json`; parent is optional and iframe HTML is not fetched |
| M4a | widget.json failure | `PARTIALLY_INSPECTED`, durable retry directive, pending projection |
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

Results: M1 matrix **13/13**; Phase 1 regression sweep **201/201**; `tsc`
passes. The suite was also run with a deliberately invalid `DATABASE_URL` to
prove it does not connect to a configured database. No production code, settings, data, migrations, or deployments were
changed by this verification unit.
