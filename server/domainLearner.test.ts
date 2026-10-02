import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DOMAIN_LEARNER_POLICY_VERSION,
  ROUTE_QUORUM_MIN_OBSERVATIONS,
  ROUTE_HALF_LIFE_MS,
  routePatternFor,
  shouldAccumulateRouteObservation,
  decayWeight,
  aggregateRouteStats,
  computeDomainWeights,
  buildWeightSnapshot,
  resolveRoutePick,
  revisitIntervalMs,
  runDomainLearningBatch,
  type DomainWeights,
} from './domainLearner';

const NOW = Date.parse('2026-10-01T00:00:00.000Z');
const hourAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

test('route patterns normalize numeric segments and reject non-pages', () => {
  assert.equal(routePatternFor('https://example.com/community/12345'), 'example.com/community/{n}');
  assert.equal(routePatternFor('https://example.com/About'), 'example.com/about');
  assert.equal(routePatternFor('https://example.com/community/12345'), routePatternFor('https://example.com/community/67890'));
  assert.notEqual(routePatternFor('https://example.com/a'), routePatternFor('https://example.com/b'));
  assert.equal(routePatternFor('not a url'), null);
  assert.equal(routePatternFor('ftp://example.com/x'), null);
});

test('only genuinely inspected pages accumulate; blocked states never become negative evidence', () => {
  for (const terminal of ['FOUND', 'INSPECTED_NO_MATCH', 'PARTIALLY_INSPECTED', 'OK']) {
    assert.equal(shouldAccumulateRouteObservation(terminal), true, `${terminal} was inspected`);
  }
  for (const terminal of [
    'ACQUISITION_FAILED', 'BLOCKED', 'NOT_INSPECTED', 'NOT_FOUND',
    'ROBOTS_DISALLOWED', 'LOGIN_WALL', 'PAYWALL', 'WAF_MANAGED',
    'RATE_LIMITED', 'UNREACHABLE', 'INCOMPLETE', '', 'whatever',
  ]) {
    assert.equal(shouldAccumulateRouteObservation(terminal), false, `${terminal || '(empty)'} carries no yield information`);
  }
});

test('decay halves weight per half-life and rejects garbage', () => {
  assert.equal(decayWeight(0, ROUTE_HALF_LIFE_MS), 1);
  assert.ok(Math.abs(decayWeight(ROUTE_HALF_LIFE_MS, ROUTE_HALF_LIFE_MS) - 0.5) < 1e-9);
  assert.ok(decayWeight(10 * ROUTE_HALF_LIFE_MS, ROUTE_HALF_LIFE_MS) < 0.01);
  assert.equal(decayWeight(NaN, ROUTE_HALF_LIFE_MS), 0);
  assert.equal(decayWeight(100, 0), 0);
});

test('aggregation is deterministic and order-independent', () => {
  const observations = [
    { siteIdentity: 's.example', pageUrl: 'https://s.example/join', evidenceUnits: 2, terminalState: 'FOUND', observedAt: hourAgo(2) },
    { siteIdentity: 's.example', pageUrl: 'https://s.example/about', evidenceUnits: 0, terminalState: 'INSPECTED_NO_MATCH', observedAt: hourAgo(3) },
    { siteIdentity: 's.example', pageUrl: 'https://s.example/join/', evidenceUnits: 1, terminalState: 'FOUND', observedAt: hourAgo(1) },
    { siteIdentity: 's.example', pageUrl: 'not-a-url', evidenceUnits: 9, terminalState: 'FOUND', observedAt: hourAgo(1) },
  ];
  const forward = aggregateRouteStats(observations);
  const reversed = aggregateRouteStats([...observations].reverse());
  assert.deepEqual(forward, reversed);
  assert.equal(forward.length, 2, 'unparsable URLs excluded, trailing-slash duplicate merged');
  const join = forward.find(stat => stat.routePattern === 's.example/join')!;
  assert.deepEqual([join.attempts, join.evidenceHits, join.evidenceUnits], [2, 2, 3]);
});

test('quorum gates weights: single observations never flip routing', () => {
  const stats = [
    { siteIdentity: 's.example', routePattern: 's.example/join', attempts: 1, evidenceHits: 1, evidenceUnits: 5, lastObservedAt: hourAgo(1) },
    { siteIdentity: 's.example', routePattern: 's.example/about', attempts: 5, evidenceHits: 4, evidenceUnits: 4, lastObservedAt: hourAgo(2) },
    { siteIdentity: 'other.example', routePattern: 'other.example/x', attempts: 9, evidenceHits: 9, evidenceUnits: 9, lastObservedAt: hourAgo(1) },
  ];
  const computed = computeDomainWeights('s.example', stats, { nowMs: NOW, quorum: ROUTE_QUORUM_MIN_OBSERVATIONS });
  assert.equal(computed.weights['s.example/join'], 0, 'below-quorum route gets zero weight despite 5 evidence units');
  assert.ok(computed.weights['s.example/about'] > 0);
  assert.deepEqual(computed.weights['other.example/x'], undefined, 'foreign-site rows never leak across sites');
  assert.equal(computed.metrics.qualifiedRoutes, 1);
  assert.equal(computed.codeVersion, DOMAIN_LEARNER_POLICY_VERSION);
});

test('weight snapshots are reproducible content hashes starting DRAFT', () => {
  const stats = [
    { siteIdentity: 's.example', routePattern: 's.example/join', attempts: 4, evidenceHits: 3, evidenceUnits: 3, lastObservedAt: hourAgo(1) },
  ];
  const first = buildWeightSnapshot(computeDomainWeights('s.example', stats, { nowMs: NOW }));
  const second = buildWeightSnapshot(computeDomainWeights('s.example', stats, { nowMs: NOW }));
  assert.equal(first.version, second.version, 'identical inputs reproduce identical versions');
  assert.match(first.version, /^dw-[0-9a-f]{16}$/);
  assert.equal(first.status, 'DRAFT');
  assert.notEqual(
    buildWeightSnapshot(computeDomainWeights('s.example', stats, { nowMs: NOW + 1 })).version,
    first.version,
    'different inputs version differently',
  );
});

test('exploration floor protects untested routes without disturbing exploitation', () => {
  const routes = [
    { pattern: 's.example/tried', weight: 0.9, attempts: 50 },
    { pattern: 's.example/fresh', weight: 0, attempts: 0 },
  ];
  assert.equal(resolveRoutePick(routes, 0, 'seed-1'), 's.example/tried', 'zero floor purely exploits');
  assert.equal(resolveRoutePick([], 5000, 'seed-1'), null);
  // Full floor always explores the least-tried route, deterministically.
  assert.equal(resolveRoutePick(routes, 10000, 'any-seed'), 's.example/fresh');
  assert.equal(resolveRoutePick(routes, 10000, 'any-seed'), resolveRoutePick(routes, 10000, 'any-seed'));
});

test('revisit intervals stay bounded and monotone in hit rate', () => {
  const base = { baseTtlMs: 30 * 24 * 3_600_000, minIntervalMs: 24 * 3_600_000, maxIntervalMs: 30 * 24 * 3_600_000 };
  const cold = revisitIntervalMs({ ...base, decayedHitRate: 0 });
  const warm = revisitIntervalMs({ ...base, decayedHitRate: 0.5 });
  const hot = revisitIntervalMs({ ...base, decayedHitRate: 1 });
  assert.ok(cold >= warm && warm >= hot, 'hotter routes revisit sooner');
  assert.ok(cold <= base.maxIntervalMs && hot >= base.minIntervalMs, 'hard bounds hold');
  assert.equal(revisitIntervalMs({ ...base, decayedHitRate: NaN }), base.baseTtlMs > base.maxIntervalMs ? base.maxIntervalMs : base.baseTtlMs);
});

test('batch run records DRAFT snapshots through injected deps, never promotes', async () => {
  const recorded: DomainWeights[] = [];
  const stats = [
    { siteIdentity: 's.example', routePattern: 's.example/join', attempts: 4, evidenceHits: 2, evidenceUnits: 2, lastObservedAt: hourAgo(1) },
  ];
  const result = await runDomainLearningBatch('s.example', {
    nowMs: NOW,
    deps: {
      getRouteStats: async () => stats,
      recordWeightSnapshot: async snapshot => { recorded.push(snapshot); },
    },
  });
  assert.equal(result.status, 'DRAFT_RECORDED');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].status, 'DRAFT');
  assert.equal(recorded[0].version, result.version);
  assert.equal((await runDomainLearningBatch('', { deps: { getRouteStats: async () => stats, recordWeightSnapshot: async () => {} } })).status, 'NO_DATA');
  assert.equal((await runDomainLearningBatch('empty.example', { deps: { getRouteStats: async () => [], recordWeightSnapshot: async () => { throw new Error('must not record'); } } })).status, 'NO_DATA');
});

test('migration 137 creates additive domain-memory tables only', () => {
  const raw = readFileSync(new URL('./db/migrations/137_domain_memory.sql', import.meta.url), 'utf8');
  const ddl = raw.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS domain_route_stats/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS domain_weight_snapshots/);
  assert.match(ddl, /PRIMARY KEY \(site_identity, route_pattern\)/);
  assert.match(ddl, /status TEXT NOT NULL DEFAULT 'DRAFT'/);
  assert.doesNotMatch(ddl, /DROP TABLE|ALTER TABLE|BACKFILL|UPDATE\s+\w+\s+SET/i);
});
