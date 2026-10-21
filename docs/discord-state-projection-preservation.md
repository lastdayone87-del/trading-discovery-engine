# Discord state projection preservation

## Incident

Channel `UCBW5wxHVa0pyrR_wpRUBn4Q` (`cbrackn`) had a validated live Discord
selection, then a trading-classification pass reset the shared top-level
`discord_status` to `UNCERTAIN`. A later validation run selected a different,
terminal-invalid candidate (`RuhggKuW`, Discord API 404/10006) and projected it
over the row. The result was `discord_status=DEAD`, `discord_invite=NULL`, and
loss of the valid serving invite even though the established candidate was
still live.

## Root cause

The replacement guard asked whether the *mutable* `discord_status` was
`ACTIVE` or `DEAD`. Trading reclassification had already changed it to
`UNCERTAIN`, so an established validation looked unvalidated. The retry path
was then allowed to project a different terminal-invalid candidate.

## Fix

The durable fields are now authoritative:

- `discord_discovery_status`
- `discord_validation_status`
- `discord_candidate_id` / `discord_candidate_locator` / `discord_invite`

A trading-classification pass may change trading/scan state but cannot clear a
validated Discord status or serving invite. A completed Discord validation may
only be replaced by:

1. a new successful validation, or
2. `CONFIRMED_INVALID` for the **same** selected candidate.

A terminal-invalid different candidate cannot replace an established
selection. Failed, partial, pending-work, and absence reconciliation paths all
use the same durable predicate, so they cannot downgrade a completed
validation either.

## Regression coverage

`server/discordStateProjectionPreservation.test.ts` covers:

- the real `aHJH5Zuxgb` → `UNCERTAIN` → `RuhggKuW` sequence;
- a validated `ACTIVE` invite surviving trading reclassification;
- an invalid-only inspection unable to replace the selected live invite;
- a genuinely dead selected candidate still transitioning to `DEAD`;
- a new valid candidate still being selected;
- dashboard count/filter/recent-confirmed consistency;
- failed/partial reconciliation not downgrading completed validation;
- legacy `ACTIVE`/`DEAD` rows defaulted to `NOT_DISCOVERED` by migration 067
  remaining established when they carry a serving invite;
- the post-enrichment review-only path retaining an existing invite even when
  no established selection is recognized.

## Separate follow-ups (not changed here)

### Stale `LOCKED` scan status

The investigated channel was `LOCKED` with no `PROCESSING` job. Its enrichment
job had already completed with a YouTube-quota block, and the process restarted
after the lock timestamp. The crawl was interrupted rather than completed.
Migration `090_reconcile_stale_channel_locks.sql` only reconciles
`PROCESSING → PENDING`; a separate stale-lock recovery fix is required.

### Channel-level duplicate-owner flag

The duplicate-owner flag came from the discarded `d3QZuQUbYh` invite, which
resolves to the Order Flow Mafia guild and is claimed by another channel.
`Bjm4dEeveq` resolves to the same guild through a different invite code, while
the selected `aHJH5Zuxgb` resolves to TradeZella, a different guild. The current
claim/protection is invite-code-level, but the UI flag is channel-level, so it
can hide a channel whose selected invite is unique. Do not weaken the guard or
permit cross-channel ownership; a guild-level/provenance-aware follow-up is
needed.

### KPI/list count difference

The dashboard active count and the filtered channel list intentionally use
different scopes (serving/audience eligibility and recent-confirmed filters).
The observed four-row difference was pre-existing. Count semantics were not
changed in this fix.
