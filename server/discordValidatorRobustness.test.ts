import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDiscordInvite } from './discordValidator';

const noopEmit = async () => {};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const inviteBody = (overrides: Record<string, unknown> = {}) => ({
  code: 'room',
  approximate_member_count: 100,
  approximate_presence_count: 10,
  guild: { id: 'guild-1', name: 'General Community', description: '', features: [] },
  channel: { name: 'general' },
  ...overrides,
});
const opts = (fetchImpl: (input: unknown, init?: unknown) => Promise<Response>, extra: Record<string, unknown> = {}) => ({
  fetchImpl: fetchImpl as typeof fetch,
  emitProviderEvent: noopEmit as never,
  retryDelayMs: 1,
  maxAttempts: 2,
  ...extra,
});

// Normalization must be canonical across legitimate invite formats.
for (const raw of [
  'https://discord.gg/AbC123',
  'https://discord.com/invite/AbC123',
  'https://discordapp.com/invite/AbC123',
  'https://discord.app/invite/AbC123',
  'discord.gg/AbC123',
  'https://discord.gg/AbC123?si=xyz#frag',
]) {
  test(`normalizes ${raw} to the canonical invite locator`, async () => {
    const result = await validateDiscordInvite(
      raw,
      opts(async (input) => {
        assert.match(String(input), /\/invites\/AbC123\?/);
        return json(inviteBody({ code: 'AbC123', guild: { id: 'g', name: 'Forex Trading Signals', description: 'crypto trade ideas' } }));
      }),
    );
    assert.equal(result.candidateInviteUrl, 'https://discord.gg/AbC123');
  });
}

// Reserved/short locators are terminal but never valid and never dead.
for (const raw of ['invite', 'about', 'x']) {
  test(`reserved/short locator '${raw}' is INVALID_LOCATOR without validity or death`, async () => {
    const result = await validateDiscordInvite(raw, opts(async () => json({}, 200)));
    assert.equal(result.operationalOutcome, 'INVALID_LOCATOR');
    assert.equal(result.retryable, false);
    assert.equal(result.livenessStatus, 'UNCERTAIN');
    assert.equal(result.inviteUrl, null);
    assert.notEqual(result.status, 'ACTIVE');
    assert.notEqual(result.status, 'DEAD');
  });
}

// First 404/10006 is inconclusive (retryable), never definitive death.
test('first unknown-invite 404 stays INVALID_OBSERVED/RETRY_PENDING, never DEAD', async () => {
  const result = await validateDiscordInvite(
    'deadcode1',
    opts(async () => json({ code: 10006, message: 'Unknown Invite' }, 404)),
  );
  assert.equal(result.operationalOutcome, 'INVALID_OBSERVED');
  assert.equal(result.livenessStatus, 'INVALID_OBSERVED');
  assert.equal(result.validationStatus, 'RETRY_PENDING');
  assert.equal(result.retryable, true);
  assert.equal(result.inviteUrl, null);
  assert.notEqual(result.status, 'DEAD');
});

// Only durable confirmation (separate prior observation) may kill.
test('repeated unknown-invite 404 with prior observation becomes CONFIRMED_INVALID/DEAD', async () => {
  const result = await validateDiscordInvite(
    'deadcode1',
    opts(async () => json({ code: 10006, message: 'Unknown Invite' }, 404), { priorInvalidObservations: 1 }),
  );
  assert.equal(result.operationalOutcome, 'CONFIRMED_INVALID');
  assert.equal(result.livenessStatus, 'DEAD');
  assert.equal(result.retryable, false);
});

// 404 without the unknown-invite code is operational, not invalid.
test('404 without unknown-invite code stays retryable and inconclusive', async () => {
  const result = await validateDiscordInvite(
    'flakycode',
    opts(async () => json({ message: 'not here' }, 404)),
  );
  assert.equal(result.validationStatus, 'RETRY_PENDING');
  assert.equal(result.retryable, true);
  assert.notEqual(result.status, 'DEAD');
  assert.equal(result.inviteUrl, null);
});

// Rate limiting is retried, then parked — never invalid.
test('persistent 429 exhausts attempts into RETRY_PENDING, never DEAD/ACTIVE', async () => {
  let calls = 0;
  const result = await validateDiscordInvite(
    'ratelimited',
    opts(async () => {
      calls++;
      return json({ message: 'rate limited' }, 429);
    }),
  );
  assert.equal(calls, 2);
  assert.equal(result.operationalOutcome, 'RATE_LIMITED');
  assert.equal(result.validationStatus, 'RETRY_PENDING');
  assert.equal(result.retryable, true);
  assert.notEqual(result.status, 'DEAD');
  assert.equal(result.inviteUrl, null);
  assert.ok(result.attempts.length > 0 && result.attempts[0].reason.length > 0);
});

// Server errors are retried, then parked — never invalid.
test('persistent 500 exhausts attempts into RETRY_PENDING with evidence', async () => {
  let calls = 0;
  const result = await validateDiscordInvite(
    'servererror',
    opts(async () => {
      calls++;
      return json({ message: 'oops' }, 500);
    }),
  );
  assert.equal(calls, 2);
  assert.equal(result.operationalOutcome, 'PROVIDER_FAILURE');
  assert.equal(result.validationStatus, 'RETRY_PENDING');
  assert.notEqual(result.status, 'DEAD');
  assert.equal(result.inviteUrl, null);
});

// Auth/challenge responses are operational dead-ends for this attempt, never validity verdicts.
test('401 is FAILED_OPERATIONAL/UNCERTAIN, never ACTIVE or DEAD', async () => {
  const result = await validateDiscordInvite(
    'challenged',
    opts(async () => json({ message: 'unauthorized' }, 401)),
  );
  assert.equal(result.operationalOutcome, 'AUTHENTICATION_FAILURE');
  assert.equal(result.livenessStatus, 'UNCERTAIN');
  assert.equal(result.inviteUrl, null);
  assert.notEqual(result.status, 'ACTIVE');
  assert.notEqual(result.status, 'DEAD');
});

// Transport failures are retried to the attempt budget, then parked.
test('transport failures exhaust attempts into RETRY_PENDING, never invalid', async () => {
  let calls = 0;
  const result = await validateDiscordInvite(
    'unreachable',
    opts(async () => {
      calls++;
      throw new Error('socket hangup');
    }),
  );
  assert.equal(calls, 2);
  assert.equal(result.validationStatus, 'RETRY_PENDING');
  assert.equal(result.livenessStatus, 'UNCERTAIN');
  assert.notEqual(result.status, 'DEAD');
  assert.equal(result.inviteUrl, null);
  assert.equal(result.attempts.length, 2);
});

// Malformed success payloads are inconclusive, never invalid.
test('malformed guild payload is RETRY_PENDING, never DEAD', async () => {
  const result = await validateDiscordInvite(
    'malformed',
    opts(async () => json({ unexpected: true })),
  );
  assert.equal(result.operationalOutcome, 'MALFORMED_RESPONSE');
  assert.equal(result.validationStatus, 'RETRY_PENDING');
  assert.notEqual(result.status, 'DEAD');
});

// Definitely-valid path still exists with durable evidence.
test('trading guild with members validates ACTIVE with a serving invite', async () => {
  const result = await validateDiscordInvite(
    ' BoxOffice '.trim(),
    opts(async () => json(inviteBody({ code: 'BoxOffice', guild: { id: 'g', name: 'Forex Trading Signals', description: 'crypto trade ideas' } }))),
  );
  assert.equal(result.livenessStatus, 'ACTIVE');
  assert.equal(result.inviteUrl, 'https://discord.gg/BoxOffice');
});

// Definitely-non-trading path is explicit, not uncertain.
test('gaming guild resolves NON_TRADING, never ACTIVE', async () => {
  const result = await validateDiscordInvite(
    'gamehall',
    opts(async () => json(inviteBody({ code: 'gamehall', guild: { id: 'g', name: 'Minecraft Gaming Community', description: '' } }))),
  );
  assert.equal(result.relevanceStatus, 'NON_TRADING');
  assert.notEqual(result.status, 'ACTIVE');
});
