import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ChannelRecord } from '../src/types';
import { writeChannelUpsert } from './dbCore';
import { stringifyWellFormedJson, toWellFormedDeep, toWellFormedString } from './unicodeSafety';

const LONE_HIGH = '\udcca';
const LONE_LOW = '\ud800';
const VALID_PAIR = '\ud83d\ude00';

function hasUnpairedSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

test('toWellFormedString replaces only unpaired surrogates', () => {
  assert.equal(toWellFormedString(`a${LONE_HIGH}b`), 'a\uFFFDb');
  assert.equal(toWellFormedString(`a${LONE_LOW}b`), 'a\uFFFDb');
  assert.equal(toWellFormedString(`a${VALID_PAIR}b`), `a${VALID_PAIR}b`);
  assert.equal(toWellFormedString('plain text'), 'plain text');
});

test('toWellFormedDeep normalizes nested values and keys without mutating input', () => {
  const original = {
    [`bad${LONE_HIGH}key`]: `text ${LONE_HIGH}`,
    nested: [{ value: `low ${LONE_LOW}` }],
    valid: VALID_PAIR,
    count: 3,
    flag: true,
    empty: null,
  };
  const safe = toWellFormedDeep(original);
  assert.equal(original[`bad${LONE_HIGH}key`], `text ${LONE_HIGH}`);
  assert.deepEqual(safe, {
    'bad\uFFFDkey': 'text \uFFFD',
    nested: [{ value: 'low \uFFFD' }],
    valid: VALID_PAIR,
    count: 3,
    flag: true,
    empty: null,
  });
});

test('stringifyWellFormedJson emits parseable JSON without surrogate escapes', () => {
  const json = stringifyWellFormedJson({
    text: `bio ${LONE_HIGH} and ${LONE_LOW}`,
    valid: VALID_PAIR,
    nested: [{ details: `trail ${LONE_HIGH}` }],
  });
  assert.ok(!/\\udcca|\\ud800/i.test(json));
  assert.ok(json.includes(VALID_PAIR));
  assert.doesNotThrow(() => JSON.parse(json));
  assert.ok(!hasUnpairedSurrogate(json));
});

function channelWithSurrogates(): ChannelRecord {
  return {
    channel_id: 'UCabcdefghijklmnopqrstuv',
    channel_name: `Bad ${LONE_HIGH} name`,
    youtube_url: 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv',
    country: 'US',
    country_status: 'CONFIRMED',
    confidence_score: 80,
    discord_status: 'PENDING',
    discord_invite: null,
    scan_status: 'COMPLETED',
    scan_attempts: 1,
    discovery_source: 'automated_query',
    first_seen: '2026-10-25T00:00:00.000Z',
    last_checked: '2026-10-25T00:00:00.000Z',
    inspection_trail: [
      {
        step: 'BIO',
        title: 'Bio',
        status: 'FOUND',
        details: `creator bio ${LONE_HIGH} socialBios/videoTitles`,
        timestamp: '2026-10-25T00:00:00.000Z',
      },
    ],
    quality_breakdown: { notes: `quality ${LONE_LOW}` },
    trading_relevance_breakdown: { notes: `trading ${LONE_HIGH}` },
    community_intents: [{ kind: 'DISCORD', detail: `intent ${LONE_HIGH}` }],
  } as unknown as ChannelRecord;
}

test('writeChannelUpsert normalizes unpaired surrogates at the database boundary', async () => {
  let captured: unknown[] | undefined;
  const client = {
    query: async (_text: string, params?: unknown[]) => {
      captured = params;
      return {};
    },
  };
  await writeChannelUpsert(client as never, channelWithSurrogates());
  assert.ok(captured, 'writeChannelUpsert must issue its INSERT');
  for (const value of captured) {
    if (typeof value === 'string') assert.ok(!hasUnpairedSurrogate(value));
  }
  assert.equal(captured[1], 'Bad \uFFFD name');
  const trail = String(captured[14]);
  assert.ok(!/\\udcca/i.test(trail));
  assert.ok(trail.includes('\uFFFD'));
  assert.doesNotThrow(() => JSON.parse(trail));
  assert.doesNotThrow(() => JSON.parse(String(captured[18])));
  assert.doesNotThrow(() => JSON.parse(String(captured[22])));
  assert.doesNotThrow(() => JSON.parse(String(captured[46])));
});

test('country boundary recovery serializes trails through the Unicode-safe helper', () => {
  const source = readFileSync(new URL('./countryBoundaryRecovery.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /JSON\.stringify\(channel\.inspection_trail\)/);
  assert.match(source, /stringifyWellFormedJson\(channel\.inspection_trail\)/);
});
