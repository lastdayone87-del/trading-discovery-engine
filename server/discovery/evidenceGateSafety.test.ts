import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * No-gate-bypass regression for the evidence-first discovery slice.
 *
 * The approved D4 change lets candidates without a curated vocabulary row reach
 * PROBE_ELIGIBLE. That must remain inert staging metadata: the new code may
 * never read or write `search_eligible`, never touch the canonical catalog, and
 * never advance the 3-creator / 2-community / 5-evidence promotion gate
 * (source-scan convention: executionLineageMetrics.test.ts, conceptGraph.test.ts).
 */

const MODULES = [
  'server/discovery/evidenceExtraction.ts',
  'server/discovery/evidenceScreening.ts',
  'server/discovery/evidenceStaging.ts',
  'server/discovery/evidencePipeline.ts',
];
const MIGRATION = 'server/db/migrations/146_evidence_extraction_staging.sql';

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '');
}

test('new discovery code never references search_eligible', () => {
  for (const path of MODULES) {
    const stripped = code(read(path));
    assert.doesNotMatch(stripped, /search_eligible/i, `${path} references search_eligible`);
  }
});

test('new discovery code never mutates the canonical catalog', () => {
  for (const path of MODULES) {
    const stripped = code(read(path));
    assert.doesNotMatch(stripped, /UPDATE\s+canonical_trading_terms/i, `${path} updates canonical_trading_terms`);
    assert.doesNotMatch(stripped, /INSERT\s+INTO\s+canonical_trading_terms/i, `${path} inserts canonical_trading_terms`);
    assert.doesNotMatch(stripped, /lifecycle_status|SEARCH_TRIAL|PROVEN_SEARCH_TERM/i, `${path} touches lifecycle states`);
  }
});

test('staging writer never emits the Brave pending resolution value', () => {
  const stripped = code(read('server/discovery/evidenceStaging.ts'));
  assert.doesNotMatch(stripped, /'PENDING'/);
  assert.match(stripped, /EVIDENCE_ONLY/);
});

test('migration is additive, creates no flag row, and widens the required domains', () => {
  const stripped = code(read(MIGRATION));
  assert.doesNotMatch(stripped, /search_eligible/i);
  assert.doesNotMatch(stripped, /INSERT\s+INTO\s+app_settings/i);
  assert.doesNotMatch(stripped, /\bDROP\s+(TABLE|COLUMN)\b/i);
  assert.match(stripped, /'EVIDENCE_EXTRACTION'/);
  assert.match(stripped, /'EVIDENCE_ONLY'/);
  assert.match(stripped, /'SEARCH_TERM'/);
  assert.match(stripped, /'evidence_extraction'/);
});

test('the extraction slice is flag-gated, fire-and-forget, and network-free', () => {
  for (const path of MODULES) {
    const stripped = code(read(path));
    assert.doesNotMatch(stripped, /\bfetch\s*\(/, `${path} performs network fetches`);
    assert.doesNotMatch(stripped, /node:https?|youtubei|crawlee/i, `${path} imports a network client`);
  }
  const pipeline = code(read('server/discovery/evidencePipeline.ts'));
  assert.match(pipeline, /discovery_extraction_enabled/);
  assert.match(pipeline, /\? 'false' : ''/);

  const ingestion = read('server/ingestionPipeline.ts');
  assert.match(ingestion, /import \{ maybeRunDiscoveryEvidenceExtraction \} from '\.\/discovery\/evidencePipeline'/);
  const hookStart = ingestion.indexOf('void maybeRunDiscoveryEvidenceExtraction(');
  assert.ok(hookStart >= 0, 'ingestion hook must call the runner fire-and-forget');
  const hookBlock = ingestion.slice(hookStart, ingestion.indexOf('const lowAudienceGate', hookStart));
  assert.match(hookBlock, /\.catch\(error/);
  assert.doesNotMatch(code(hookBlock), /search_eligible/i);
});
