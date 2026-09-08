import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discordCandidateDisplayUrl, extractDiscordInviteCode } from '../src/utils/discordLocator';

// Regression: Discord invite codes are case-sensitive. The stored
// normalized_locator is lowercased (dedupe key) and 404s for mixed-case
// invites, so display must use case-preserved sources.
test('mixed-case invite G2YjkcCgY stays exactly case-preserved', () => {
  const shown = discordCandidateDisplayUrl({
    display_locator: 'https://discord.gg/G2YjkcCgY',
    raw_locator: 'https://discord.gg/G2YjkcCgY',
    normalized_locator: 'https://discord.gg/g2yjkccgy',
  });
  assert.equal(shown, 'https://discord.gg/G2YjkcCgY');
  assert.notEqual(shown, 'https://discord.gg/g2yjkccgy');
});

test('second confirmed example vxHWkA9EjG stays exactly case-preserved', () => {
  const shown = discordCandidateDisplayUrl({
    display_locator: 'https://discord.gg/vxHWkA9EjG',
    raw_locator: 'https://discord.gg/vxHWkA9EjG',
    normalized_locator: 'https://discord.gg/vxhwka9ejg',
  });
  assert.equal(shown, 'https://discord.gg/vxHWkA9EjG');
});

test('raw locator wrapper falls back to latest-attempt casing, then normalized key', () => {
  // Wrapper/affiliate raw locators carry no invite code: latest-attempt case wins.
  assert.equal(
    discordCandidateDisplayUrl({
      display_locator: 'https://discord.gg/xk35FssWWF',
      raw_locator: 'https://link.alpha-futures.com/jXz6em',
      normalized_locator: 'https://discord.gg/xk35fsswwf',
    }),
    'https://discord.gg/xk35FssWWF'
  );
  // No case-preserved source at all: normalized key remains the fallback.
  assert.equal(
    discordCandidateDisplayUrl({ normalized_locator: 'https://discord.gg/abc' }),
    'https://discord.gg/abc'
  );
  assert.equal(discordCandidateDisplayUrl({}), null);
});

test('code extraction preserves case across invite URL variants', () => {
  assert.equal(extractDiscordInviteCode('https://discord.gg/AbC-123_x'), 'AbC-123_x');
  assert.equal(extractDiscordInviteCode('https://discord.com/invite/Xt9NbAq5s7'), 'Xt9NbAq5s7');
  assert.equal(extractDiscordInviteCode('https://kick.com/some/chat'), null);
});

test('lookup index exactly mirrors the display_locator predicate (no seq/filter scans)', () => {
  const migration = readFileSync(
    'server/db/migrations/129_discord_display_locator_lookup.sql',
    'utf8'
  );
  const dbCore = readFileSync('server/dbCore.ts', 'utf8');
  // Index leading columns must equal the subquery's equality predicate + ordering.
  assert.match(
    migration,
    /ON discord_check_attempts \(channel_id, lower\(COALESCE\(resolved_locator, invite_locator\)\), checked_at DESC\)/
  );
  assert.match(dbCore, /a\.channel_id=dc\.channel_id/);
  assert.match(
    dbCore,
    /lower\(COALESCE\(a\.resolved_locator, a\.invite_locator\)\)=dc\.normalized_locator/
  );
  assert.match(dbCore, /ORDER BY a\.checked_at DESC LIMIT 1/);
  // Index migration is structure-only: no row writes, safe to deploy unapplied.
  assert.doesNotMatch(migration, /UPDATE|DELETE|INSERT INTO discord_candidates/);
});

test('listing API supplies latest-attempt casing without touching stored keys', () => {
  const dbCore = readFileSync('server/dbCore.ts', 'utf8');
  assert.match(dbCore, /display_locator/);
  assert.match(dbCore, /COALESCE\(a\.resolved_locator, a\.invite_locator\)/);
  assert.match(dbCore, /ORDER BY a\.checked_at DESC LIMIT 1/);
  // Dedupe key stays lowercased; only the additive display field carries case.
  assert.match(dbCore, /lower\(\$4\)/);
});

test('validation input and serving projection never consume the lowercased key', () => {
  const queue = readFileSync('server/queueManager.ts', 'utf8');
  assert.match(queue, /validateDiscordInvite\(candidate\.nativeInviteCode,/);
  const projection = readFileSync('server/discordProjection.ts', 'utf8');
  assert.match(projection, /primary\.normalizedLocator \|\| `https:\/\/discord\.gg\/\$\{primary\.nativeInviteCode\}`/);
  const ui = readFileSync('src/components/ResultsTable.tsx', 'utf8');
  assert.match(ui, /discordCandidateDisplayUrl\(candidate\)/);
});
