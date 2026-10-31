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

The review-only retention is honored across restarts too: the startup
exclusion audit reads `scan_status` and leaves the retained invite of a channel
explicitly withheld for human review (`NEEDS_REVIEW`) in place until the review
resolves, instead of clearing it as a stale invite on the next boot. An
exhausted stored locator becomes a terminal `FAILED_OPERATIONAL` verdict even
when a serving selection already exists, so the scan-attempt reset cannot
recreate `locator-unvalidated` retry work and the channel reaches a verdict
while its established projection is preserved.

Classification-only writes are race-safe as well: the ingestion pipeline opts
into `preserveDiscordOnUpdate`, and `upsertChannel` overlays the Discord
projection read from the row it already locks inside the upsert transaction.
A validation result committed while classification was running therefore wins
over the stale in-memory snapshot, and non-Discord fields still come from the
caller. The insert path keeps the caller's defaults.

## A1 last-known-good retention

A provider lookup can succeed operationally while returning no serving invite
and no usable relevance evidence (`SUCCEEDED` with a null `inviteUrl`,
`relevanceStatus=UNCERTAIN`, and `status=UNCERTAIN`). That is ambiguity, not
proof that the previously served invite is invalid. Before this fix the
ambiguous result projected `UNCERTAIN`/null over a live selection, so a channel
could stop serving an invite that was never shown to be dead.

The retention invariant is now applied at three enforcement points:

1. **Projection.** An ambiguous successful revalidation retains the current
   serving invite, `discord_status` (`ACTIVE`/`ACTIVE_LOW_VOLUME`), candidate
   identity/locator, resolution and discovery state. The existing
   `discord_relevance_status` is set to `UNCERTAIN` to record that the current
   revalidation is uncertain; no schema migration is required.
2. **Startup exclusion audit.** A retained row is exempt from stale-invite
   cleanup only when it has the full retained evidence (serving invite, live
   liveness, completed validation, `VALIDATED` discovery, `UNCERTAIN`
   relevance). `DEAD`/`NON_TRADING` rows and rejected-channel cleanup still
   clear normally, except that a `NEEDS_REVIEW` row keeps its invite until the
   review resolves (the existing review hold).
3. **Upsert.** An ordinary stale-snapshot write cannot clear or downgrade a
   locked row that still serves a completed, live, validated invite, and it
   cannot assert a terminal `DEAD`/`NON_TRADING` verdict over that invite either.
   Fresh validation writes (including a genuine terminal projection) and
   explicit intentional cleanup (`allowDiscordClear`) still replace the
   projection.

`rowToChannel` derives two read-only fields: `discord_invite_last_verified_at`
(the latest successful serving attempt from `discord_check_attempts`) and
`discord_invite_revalidation_uncertain` (the retained-last-known-good marker).
The UI labels these rows “Previously verified … · currently uncertain” rather
than presenting them as freshly validated.

Candidate selection has a matching guard: a `SUCCEEDED` attempt with no usable
serving invite cannot outrank a genuinely usable candidate solely because of
its status. Usable means `SUCCEEDED`, `ACTIVE`/`ACTIVE_LOW_VOLUME`, and a
non-null invite.

Definitive invalidity is unchanged. `CONFIRMED_INVALID` for the same selected
candidate still projects `DEAD`; `NON_TRADING` still clears the serving
projection; rejected-channel cleanup still removes stale invites; and an
explicit audit cleanup bypasses the upsert retention guard. Retention is not a
substitute for validation and does not alter validation outcomes,
classification, or attempt-ledger semantics.

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
  no established selection is recognized;
- the startup exclusion-audit decision preserving a review-pending invite while
  still cleaning stale non-review invites and rejected-cleanup rows;
- an exhausted stored locator reaching a terminal verdict even when an
  established serving selection exists, without re-arming retry work;
- a classification-only upsert keeping the locked row's Discord projection:
  a stale `ACTIVE` snapshot cannot resurrect a concurrent `DEAD` verdict, and
  a stale `DEAD` snapshot cannot downgrade a newer live projection
  (`server/channelUpsertDiscordProjection.postgres.test.ts`);
- A1 retention: an ambiguous `SUCCEEDED` revalidation keeps the serving invite,
  status, and candidate identity, records uncertainty in
  `discord_relevance_status`, and derives the last-verified timestamp from the
  serving attempt;
- A1 clearing paths: `CONFIRMED_INVALID`/`DEAD`, `NON_TRADING`, stale-invite
  audit cleanup, rejected-channel cleanup, and explicit `allowDiscordClear`
  still clear;
- A1 candidate selection: an ambiguous successful candidate cannot outrank a
  usable candidate, while a genuinely usable candidate still wins normally;
- A1 startup audit: a full-evidence retained `UNCERTAIN` row is exempt, while
  partial evidence and terminal rows are still cleaned.

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
