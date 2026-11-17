import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyCategoryPrecisionGuard,
  adjudicateCategory,
  buildCategoryAdjudicatorPrompt,
  deterministicCategoryGuard,
  type PrecisionGuardResult,
} from './categoryPrecisionGuard';
import { FALSE_POSITIVE_CASES, GENUINE_EDUCATION_CASES, type CategoryPrecisionCase } from './fixtures/categoryPrecisionCases';
import type { RawChannelInput } from './types';

function input(c: CategoryPrecisionCase): RawChannelInput {
  return {
    channel_name: c.name,
    description: c.description,
    video_titles: c.videoTitles,
    country: 'United States',
  };
}

function result(category: PrecisionGuardResult['category']): PrecisionGuardResult {
  return { category, source: 'ADJUDICATOR', confidence: 90, reasonCodes: ['TEST'] };
}

test('deterministic guard catches the high-confidence false-positive cases', () => {
  let caught = 0;
  for (const c of FALSE_POSITIVE_CASES) {
    const guarded = deterministicCategoryGuard(input(c));
    if (guarded) {
      caught += 1;
      assert.equal(guarded.category, c.expected, c.name);
      assert.equal(guarded.source, 'DETERMINISTIC');
    }
  }
  // The remaining four are deliberately left to the conservative adjudicator.
  assert.equal(caught, 13);
});

test('deterministic guard never downgrades a genuine education channel', () => {
  for (const c of GENUINE_EDUCATION_CASES) {
    assert.equal(deterministicCategoryGuard(input(c)), null, c.name);
  }
});

test('hybrid guard catches every false positive and keeps every genuine educator', async () => {
  const fallback: Record<string, PrecisionGuardResult['category']> = {
    BasedClips: 'FINANCIAL_NEWS',
    JezzaBTC: 'FINANCIAL_NEWS',
    'Fx Crack Robo House': 'MARKET_INSTITUTION',
    shashwat01: 'HYPE',
  };
  const adjudicator = async (value: RawChannelInput): Promise<PrecisionGuardResult | null> => {
    const category = fallback[String(value.channel_name).trim()];
    return category ? result(category) : null;
  };

  for (const c of FALSE_POSITIVE_CASES) {
    const guarded = await applyCategoryPrecisionGuard(input(c), 'INVESTING_EDUCATION', {
      enabled: true,
      adjudicator,
    });
    assert.ok(guarded, c.name);
    assert.equal(guarded.category, c.expected, c.name);
  }

  for (const c of GENUINE_EDUCATION_CASES) {
    const guarded = await applyCategoryPrecisionGuard(input(c), 'INVESTING_EDUCATION', {
      enabled: true,
      adjudicator: async () => null,
    });
    assert.equal(guarded, null, c.name);
  }
});

test('a signal-first brand is HYPE even with an educational disclaimer', () => {
  const signal = deterministicCategoryGuard({
    channel_name: 'Signal Room',
    description: 'Market analysis and trade breakdowns. This content is for educational purposes only.',
    video_titles: ['Gold setup', 'BTC entry'],
  });
  assert.equal(signal?.category, 'HYPE');
  const academy = deterministicCategoryGuard({
    channel_name: 'Signal Academy',
    description: 'Market analysis and trade breakdowns. This content is for educational purposes only.',
    video_titles: ['Gold setup', 'BTC entry'],
  });
  assert.equal(academy, null);
});

test('weak words do not create a signal-product downgrade', () => {
  assert.equal(deterministicCategoryGuard({
    channel_name: 'Trading Made Simple',
    description: 'Stress-free trading education. Signal-Based Trading and momentum strategies.',
    video_titles: ['Oil live analysis', 'Risk management', 'Blown accounts explained'],
  }), null);
  assert.equal(deterministicCategoryGuard({
    channel_name: 'Trade With Shukla',
    description: 'Practical trading education, market analysis and psychology. FREE TELEGRAM community.',
    video_titles: ['Gold live analysis', 'Bitcoin live trading', 'Risk management'],
  }), null);
});

test('teaching prop-firm strategy is education, not a prop firm', () => {
  assert.equal(deterministicCategoryGuard({
    channel_name: 'Squid Traders',
    description: 'We teach prop firm survival strategies and ICT mentorship through daily breakdowns.',
    video_titles: ['NQ live at the open', 'When to flip your bias', 'Prop firm risk plan'],
  }), null);
});

test('a sparse or empty video sample cannot support an unrelated downgrade', () => {
  assert.equal(deterministicCategoryGuard({
    channel_name: 'Fitness Coach',
    description: 'Fitness tips, workout plans, tourist vlogs and bodybuilding.',
    video_titles: [],
  }), null);
  assert.equal(deterministicCategoryGuard({
    channel_name: 'Fitness Coach',
    description: 'Fitness tips, workout plans, tourist vlogs and bodybuilding.',
    video_titles: ['𝐋𝐈𝐕𝐄 𝐓𝐫𝐚𝐝𝐢𝐧𝐠 𝐅𝐎𝐑𝐄𝐗', '𝐋𝐈𝐕𝐄 𝐓𝐫𝐚𝐝𝐢𝐧𝐠 𝐗𝐀𝐔𝐔𝐒𝐃', '𝐋𝐈𝐕𝐄 𝐓𝐫𝐚𝐝𝐢𝐧𝐠 𝐍𝐐'],
  }), null);
});

test('the guard is on by default and can be disabled explicitly', async () => {
  const c = FALSE_POSITIVE_CASES.find(value => value.name === 'CryptoDexWorld')!;
  const guarded = await applyCategoryPrecisionGuard(input(c), 'INVESTING_EDUCATION', {
    adjudicator: async () => result('HYPE'),
  });
  assert.equal(guarded?.category, 'HYPE');
  assert.equal(await applyCategoryPrecisionGuard(input(c), 'INVESTING_EDUCATION', {
    enabled: false,
    adjudicator: async () => result('HYPE'),
  }), null);
});

test('guard is disabled by flag and only runs for a relevant first-pass label', async () => {
  const c = FALSE_POSITIVE_CASES.find(value => value.name === 'CryptoDexWorld')!;
  assert.equal(await applyCategoryPrecisionGuard(input(c), 'INVESTING_EDUCATION', { enabled: false }), null);
  assert.equal(await applyCategoryPrecisionGuard(input(c), 'FINANCIAL_NEWS', { enabled: true }), null);
});

test('adjudicator may downgrade only to the approved precision categories', async () => {
  const c = FALSE_POSITIVE_CASES.find(value => value.name === 'CryptoDexWorld')!;
  const client = (value: unknown) => ({
    classify: async (prompt: string) => {
      assert.match(prompt, /KEEP_RELEVANT/);
      assert.match(prompt, /First-pass label: INVESTING_EDUCATION/);
      return value;
    },
  });
  const market = await adjudicateCategory(input(c), 'INVESTING_EDUCATION', { client: client({ label: 'MARKET_INSTITUTION', confidence: 91 }) });
  assert.equal(market?.category, 'MARKET_INSTITUTION');
  // Providers may return a probability instead of a percentage.
  const probability = await adjudicateCategory(input(c), 'INVESTING_EDUCATION', { client: client({ label: 'UNRELATED', confidence: 0.95 }) });
  assert.equal(probability?.category, 'UNRELATED');
  assert.equal(probability?.confidence, 95);
  const keep = await adjudicateCategory(input(c), 'INVESTING_EDUCATION', { client: client({ label: 'KEEP_RELEVANT', confidence: 99 }) });
  assert.equal(keep, null);
  const low = await adjudicateCategory(input(c), 'INVESTING_EDUCATION', { client: client({ label: 'HYPE', confidence: 60 }) });
  assert.equal(low, null);
  const invalid = await adjudicateCategory(input(c), 'INVESTING_EDUCATION', { client: client({ label: 'ACTIVE_TRADING', confidence: 99 }) });
  assert.equal(invalid, null);
});

test('adjudicator failure or absence keeps the first-pass result', async () => {
  const c = FALSE_POSITIVE_CASES.find(value => value.name === 'CryptoDexWorld')!;
  const throwing = { classify: async () => { throw new Error('provider down'); } };
  assert.equal(await adjudicateCategory(input(c), 'INVESTING_EDUCATION', { client: throwing }), null);
  assert.equal(await adjudicateCategory(input(c), 'INVESTING_EDUCATION', { client: null }), null);
});

test('adjudicator prompt explicitly forbids relevant-to-relevant relabeling', () => {
  const c = FALSE_POSITIVE_CASES.find(value => value.name === 'CryptoDexWorld')!;
  const prompt = buildCategoryAdjudicatorPrompt(input(c), 'INVESTING_EDUCATION');
  assert.match(prompt, /Allowed labels: MARKET_INSTITUTION, HYPE, FINANCIAL_NEWS, UNRELATED, KEEP_RELEVANT/);
  assert.match(prompt, /When uncertain, return KEEP_RELEVANT/);
  assert.match(prompt, /Do not downgrade a genuine educator/);
  assert.match(prompt, /confidence \(0-100\)/);
  assert.match(prompt, /watchlist, alerts, or a paid community/);
  assert.match(prompt, /signal-first brand|named for signals/);
});
