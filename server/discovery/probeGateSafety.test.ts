import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * No-gate-bypass / no-network regression for the bounded probe layer.
 *
 * Probes are inert evidence retrieval: they may never read or write
 * `search_eligible`, never mutate the canonical catalog or lifecycle tables,
 * never touch serving/planner paths, and never call the official YouTube API
 * (the official route is rejected unless the operator flag is exactly 'true').
 */

const MODULES = [
  'server/discovery/probeLedger.ts',
  'server/discovery/probeExecutor.ts',
];
const MIGRATION = 'server/db/migrations/147_discovery_probe_ledger.sql';

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '');
}

test('probe code never references search_eligible', () => {
  for (const path of MODULES) {
    assert.doesNotMatch(code(read(path)), /search_eligible/i, `${path} references search_eligible`);
  }
});

test('probe code never mutates the catalog, lifecycle, or serving tables', () => {
  for (const path of MODULES) {
    const stripped = code(read(path));
    for (const pattern of [
      /UPDATE\s+canonical_trading_terms/i,
      /INSERT\s+INTO\s+canonical_trading_terms/i,
      /lifecycle_status|SEARCH_TRIAL|PROVEN_SEARCH_TERM/i,
      /UPDATE\s+catalog_lifecycle/i,
      /INSERT\s+INTO\s+catalog_lifecycle/i,
      /UPDATE\s+serving_catalog/i,
      /INSERT\s+INTO\s+serving_catalog/i,
      /UPDATE\s+active_catalog_pointers/i,
      /INSERT\s+INTO\s+app_settings/i,
    ]) {
      assert.doesNotMatch(stripped, pattern, `${path} matches forbidden pattern ${pattern}`);
    }
  }
});

test('probe code imports no HTTP client and no official YouTube API module', () => {
  for (const path of MODULES) {
    const stripped = code(read(path));
    assert.doesNotMatch(stripped, /\bfetch\s*\(|globalThis\.fetch/i, `${path} performs network fetches`);
    assert.doesNotMatch(
      stripped,
      /youtubei\.js|crawlee|node:https?|axios|playwright|puppeteer|youtube-search-api/i,
      `${path} imports a network client`
    );
    assert.doesNotMatch(stripped, /from\s+["']\.\.\/youtube["']/, `${path} imports the official YouTube API module`);
    assert.doesNotMatch(stripped, /import\s*\(\s*["']\.\.\/youtube["']\s*\)/, `${path} dynamically imports the official YouTube API module`);
    assert.doesNotMatch(stripped, /searchYouTubeChannels|searchYouTubeChannelPage/, `${path} calls the official API`);
  }
});

test('probe executor uses the existing InnerTube executor and ingestion pipeline', () => {
  const executor = code(read('server/discovery/probeExecutor.ts'));
  assert.match(executor, /executeInnertubeRetrievalPage/);
  assert.match(executor, /processChannelThroughPipeline/);
  assert.match(executor, /DISCOVERY_PROBE_FLAG_KEY/);
  assert.match(executor, /DISCOVERY_PROBE_KILL_SWITCH_KEY/);
  assert.match(executor, /PROBE_PAGE_SIZE = 20/);
  assert.match(executor, /MAX_CHANNELS_INGESTED_PER_PROBE = 20/);
  const ledger = code(read('server/discovery/probeLedger.ts'));
  assert.match(ledger, /discovery_probe_enabled/);
  assert.match(ledger, /discovery_probe_kill_switch/);
});

test('migration 147 is additive, flag-free, and enforces probe idempotency', () => {
  const stripped = code(read(MIGRATION));
  assert.doesNotMatch(stripped, /search_eligible/i);
  assert.doesNotMatch(stripped, /INSERT\s+INTO\s+app_settings/i);
  assert.doesNotMatch(stripped, /\bDROP\s+(TABLE|COLUMN)\b/i);
  assert.doesNotMatch(stripped, /ALTER\s+TABLE/i);
  assert.doesNotMatch(stripped, /UPDATE\s+discovery_candidate_staging/i);
  assert.match(stripped, /CREATE TABLE IF NOT EXISTS discovery_probe_ledger/);
  assert.match(stripped, /UNIQUE \(candidate_key, attempt_no\)/);
  assert.match(stripped, /idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(stripped, /CHECK \(units >= 0\)/);
});

test('ledger SQL reserves under an advisory lock with ON CONFLICT idempotency', () => {
  const ledger = code(read('server/discovery/probeLedger.ts'));
  assert.match(ledger, /pg_advisory_xact_lock/);
  assert.match(ledger, /ON CONFLICT DO NOTHING/);
  assert.match(ledger, /UNIQUE|findAttempt/);
  assert.match(ledger, /discovery_probe_enabled/);
  assert.match(ledger, /discovery_probe_allow_official/);
  assert.match(ledger, /settingsUnavailable/);
});

test('the probe layer is not wired into any automatic runtime path', () => {
  const output = execFileSync(
    'grep',
    ['-rl', 'runApprovedProbe\\|sweepExpiredProbes\\|inspectProbeLedger', 'server', '--include=*.ts'],
    { encoding: 'utf8', cwd: new URL('../../', import.meta.url).pathname }
  )
    .split('\n')
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    output,
    [
      'server/discovery/probeExecutor.ts',
      'server/discovery/probeExecutor.test.ts',
      'server/discovery/probeLedger.ts',
      'server/discovery/probeLedger.test.ts',
      'server/discovery/probeGateSafety.test.ts',
    ].sort()
  );
});
