import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Regression coverage for the intended crawl enqueue/filter policy and the
// compact drop instrumentation. Pure-policy units plus wiring assertions;
// budgets themselves are unchanged (rendered 6/5/4, 60s timeout).
import {
  COMMUNITY_HINTS,
} from './browserCommunityFallback';
import {
  communityNavigationScore,
  shouldFollowCommunityTarget,
} from './inspector';
import {
  CRAWL_DROP_REASONS,
  createDropCounter,
  isCrawlDropReason,
  renderedCrawlerTelemetry,
  safeCrawlerTelemetry,
  staticCrawlerTelemetry,
} from './crawlerTelemetry';

test('relevant same-host URL with a recognized community hint is enqueueable', () => {
  assert.ok(communityNavigationScore('https://example.com/community', 'Join us') > 0);
  assert.ok(communityNavigationScore('https://example.com/discord', '') >= 100);
  assert.ok(communityNavigationScore('https://example.com/contact', '') > 0);
  // Higher-signal pages sort first: community outranks contact.
  assert.ok(
    communityNavigationScore('https://example.com/community', '') >
    communityNavigationScore('https://example.com/contact', '')
  );
});

test('score-0 URL is dropped, never enqueued', () => {
  assert.equal(communityNavigationScore('https://example.com/blog/market-recap', 'Weekly notes'), 0);
  assert.equal(communityNavigationScore('https://example.com/pricing', 'Plans'), 0);
});

test('disallowed cross-origin URL is dropped; allowed hosts stay eligible', () => {
  assert.equal(shouldFollowCommunityTarget('https://example.com/community', ''), false);
  assert.equal(shouldFollowCommunityTarget('https://linktr.ee/somecreator', ''), true);
  assert.equal(shouldFollowCommunityTarget('https://whop.com/some-desk', ''), true);
  assert.equal(shouldFollowCommunityTarget('not a url', ''), false);
});

test('rendered hint vocabulary is unchanged (no widening without capacity)', () => {
  assert.equal(
    COMMUNITY_HINTS.source,
    'discord|community|join|chat|member|membership|vip|group|private|trading.?room|links?|social|contact|about'
  );
  assert.ok(COMMUNITY_HINTS.test('https://example.com/community'));
  assert.ok(!COMMUNITY_HINTS.test('https://example.com/blog/market-recap'));
  assert.ok(!COMMUNITY_HINTS.test('https://example.com/pricing'));
});

test('drop counter tallies taxonomy reasons only', () => {
  const drops = createDropCounter();
  drops.count('score-zero');
  drops.count('score-zero');
  drops.count('queue-cap');
  drops.count('bogus-reason' as never);
  drops.count('duplicate', 0);
  drops.count('duplicate', -2);
  assert.deepEqual(drops.snapshot(), { 'score-zero': 2, 'queue-cap': 1 });
  assert.ok(isCrawlDropReason('score-zero'));
  assert.ok(!isCrawlDropReason('bogus-reason'));
  assert.equal(CRAWL_DROP_REASONS.length, 13);
});

test('sanitizer keeps compact counters, strips unknown and non-positive values', () => {
  const kept = safeCrawlerTelemetry({
    mode: 'STATIC',
    redirectsFollowed: 0,
    pagesInspected: 3,
    budgetExhausted: false,
    dropReasons: { 'score-zero': 4, 'bogus': 9, 'duplicate': -1 } as never,
  });
  assert.deepEqual(kept?.dropReasons, { 'score-zero': 4 });
  assert.equal(kept?.scrollsUsed, undefined);
  const scrolled = safeCrawlerTelemetry({
    mode: 'RENDERED',
    redirectsFollowed: 0,
    pagesInspected: 2,
    budgetExhausted: false,
    scrollsUsed: 5,
    dropReasons: { 'control-slice': 8, 'hint-rejected': 3 },
  });
  assert.equal(scrolled?.scrollsUsed, 5);
  assert.deepEqual(scrolled?.dropReasons, { 'control-slice': 8, 'hint-rejected': 3 });
});

test('telemetry constructors carry drops and scroll usage', () => {
  const stat = staticCrawlerTelemetry({ redirectsFollowed: 0, pagesInspected: 2, budgetExhausted: false, dropReasons: { 'score-zero': 2 } });
  assert.deepEqual(stat.dropReasons, { 'score-zero': 2 });
  const rendered = renderedCrawlerTelemetry({ inspectedPages: 2, clicks: 1, complete: true, scrollsUsed: 4, dropReasons: { 'hint-rejected': 1 } });
  assert.equal(rendered.scrollsUsed, 4);
  assert.deepEqual(rendered.dropReasons, { 'hint-rejected': 1 });
  const empty = renderedCrawlerTelemetry({ inspectedPages: 1, clicks: 0, complete: true });
  assert.equal(empty.scrollsUsed, undefined);
  assert.equal(empty.dropReasons, undefined);
});

test('static exploration bound is 12 with drop accounting at every rule', () => {
  const source = readFileSync(new URL('./inspector.ts', import.meta.url), 'utf8');
  assert.match(source, /while\(queue\.length&&explored<12\)/);
  for (const marker of [
    "drops.count('invalid-protocol')",
    "drops.count('cross-origin-disallowed')",
    "drops.count('cross-origin-allowed')",
    "drops.count('score-zero')",
    "drops.count('duplicate'",
    "drops.count('queue-cap'",
    "drops.count('depth-limit')",
    "drops.count('already-visited')",
    "drops.count('exploration-limit'",
    'dropReasons:drops.snapshot()',
  ]) {
    assert.ok(source.includes(marker), `missing static wiring: ${marker}`);
  }
});

test('rendered control-slice, hint-reject, scroll, and stop accounting are wired', () => {
  const source = readFileSync(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8');
  assert.ok(source.includes("drops.count('control-slice'"));
  assert.ok(source.includes("drops.count('hint-rejected')"));
  assert.ok(source.includes("drops.count('page-budget')"));
  assert.ok(source.includes("drops.count('queue-exhausted')"));
  assert.ok(source.includes('dropReasons:drops.snapshot()'));
  const inspector = readFileSync(new URL('./inspector.ts', import.meta.url), 'utf8');
  assert.ok(inspector.includes('scrollsUsed:rendered.scrolls'));
});

test('direct Discord invite in URL is captured without crawling', () => {
  const source = readFileSync(new URL('./inspector.ts', import.meta.url), 'utf8');
  const direct = source.slice(
    source.indexOf('const seedLocators=extractDiscordCandidates(url,surface,url)'),
    source.indexOf('let pagesInspected=0,redirectsFollowed=0,budgetExhausted=false;')
  );
  assert.match(direct, /if\(direct\.length\)/);
  assert.match(direct, /outcome:'FOUND'/);
});
