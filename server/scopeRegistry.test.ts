import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  INITIAL_COUNTRY_VOCABULARIES,
  SUPPORTED_DORMANT_COUNTRIES,
  SUPPORTED_PRODUCTION_COUNTRIES,
} from '../src/data/initial_countries';
import { assertProductionCountryArchitecture } from './productionCountryArchitecture';
import { canonicalCountry } from './countryInference';
import { getCuratedQueryCountries } from './queryPlanner';
import { COUNTRY_KNOWLEDGE_PACKS, LANGUAGE_KNOWLEDGE_PACKS } from './evidenceEngine/knowledgePacks';
import { resolveScopeEligibility } from './scopeEligibility';
import { resolveAutonomousCountries } from './autonomousDiscovery';

const ALL_20 = [...SUPPORTED_PRODUCTION_COUNTRIES] as string[];

test('supported universe is exactly 20 countries including Norway', () => {
  assert.equal(ALL_20.length, 20);
  assert.ok(ALL_20.includes('Norway'));
  assert.equal(new Set(ALL_20).size, 20);
  const vocab = INITIAL_COUNTRY_VOCABULARIES.find(v => v.country === 'Norway');
  assert.ok(vocab);
  for (const field of [
    'languages',
    'native_trading_terminology',
    'popular_instruments',
    'local_market_phrases',
    'common_content_format_names',
  ] as const) {
    assert.ok(vocab[field].length > 0, `Norway vocabulary.${field} is empty`);
  }
});

test('dormant scope is exactly the five supported-but-unswept countries', () => {
  assert.deepEqual([...SUPPORTED_DORMANT_COUNTRIES].sort(), [
    'Italy',
    'Japan',
    'Norway',
    'Spain',
    'United Arab Emirates',
  ]);
  for (const country of SUPPORTED_DORMANT_COUNTRIES) {
    assert.ok(ALL_20.includes(country), `${country} must stay supported`);
  }
});

test('startup invariant holds at 20 with Norway canonicalized end to end', () => {
  assert.doesNotThrow(assertProductionCountryArchitecture);
  assert.equal(canonicalCountry('NO'), 'Norway');
  assert.equal(canonicalCountry('norge'), 'Norway');
  assert.ok(getCuratedQueryCountries().includes('Norway'));
  assert.ok(COUNTRY_KNOWLEDGE_PACKS['Norway']);
  assert.ok(LANGUAGE_KNOWLEDGE_PACKS['no']);
});

test('scope eligibility separates market validity from country verdicts', () => {
  assert.equal(resolveScopeEligibility('Germany'), 'IN_SCOPE');
  assert.equal(resolveScopeEligibility('Norway'), 'IN_SCOPE');
  assert.equal(resolveScopeEligibility('Italy'), 'IN_SCOPE');
  assert.equal(resolveScopeEligibility('  Germany  '), 'IN_SCOPE');
  assert.equal(resolveScopeEligibility('GERMANY'), 'IN_SCOPE');
  assert.equal(resolveScopeEligibility('Vietnam'), 'OUT_OF_SCOPE');
  assert.equal(resolveScopeEligibility('Brazil'), 'OUT_OF_SCOPE');
  assert.equal(resolveScopeEligibility(null), 'UNRESOLVED');
  assert.equal(resolveScopeEligibility(''), 'UNRESOLVED');
  assert.equal(resolveScopeEligibility('   '), 'UNRESOLVED');
});

test('autonomous sweep preserves dormant countries but honors explicit targets', () => {
  const vocabs = [...ALL_20];
  const global = resolveAutonomousCountries(vocabs, [], [], 'GLOBAL');
  assert.equal(global.length, 15);
  for (const dormant of SUPPORTED_DORMANT_COUNTRIES) {
    assert.ok(!global.includes(dormant), `${dormant} must not be swept`);
  }
  const selected = resolveAutonomousCountries(
    vocabs,
    [],
    ['Norway', 'Germany'],
    'SELECTED_COUNTRIES',
  );
  assert.deepEqual(selected, ['Germany']);
  assert.deepEqual(
    resolveAutonomousCountries(vocabs, [], [], 'GLOBAL', 'Norway'),
    ['Norway'],
  );
  assert.deepEqual(
    resolveAutonomousCountries(vocabs, ['Germany'], [], 'GLOBAL').filter(c => c === 'Germany'),
    [],
  );
});

test('migration supported universe matches the application registry', () => {
  // Guard against registry/SQL drift: the migration cannot import application
  // constants, so this test fails loudly on divergence instead.
  const sql = readFileSync('server/db/migrations/131_scope_eligibility.sql', 'utf8');
  const inList = sql.slice(sql.indexOf('WHEN LOWER(BTRIM(country)) IN ('));
  const sqlNames = new Set(
    [...inList.matchAll(/'([a-z][a-z .'-]*)'/g)]
      .map(match => match[1])
      .filter(name => !['in_scope', 'out_of_scope', 'unresolved'].includes(name)),
  );
  const registryNames = new Set(
    [...SUPPORTED_PRODUCTION_COUNTRIES].map(country =>
      country.normalize('NFKC').trim().toLocaleLowerCase('en'),
    ),
  );
  assert.deepEqual([...sqlNames].sort(), [...registryNames].sort());
});
test('migration 131 adds scope_eligibility non-destructively', () => {
  const raw = readFileSync('server/db/migrations/131_scope_eligibility.sql', 'utf8');
  // Strip SQL line comments so assertions target statements, not prose.
  const sql = raw
    .split('\n')
    .filter(line => !line.trimStart().startsWith('--'))
    .join('\n');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS scope_eligibility/);
  assert.ok(!/country_status\s*=/.test(sql), 'migration must never write country_status');
  assert.ok(!/confidence_score\s*=/.test(sql), 'migration must never write confidence_score');
  assert.ok(!/DROP\s+(COLUMN|TABLE)/i.test(sql), 'migration must not drop columns or tables');
  assert.equal(
    (sql.match(/^UPDATE channels/mg) || []).length,
    1,
    'backfill must run as a single pass, not repeated full-table updates',
  );
  assert.ok(!/NOT VALID/i.test(sql), 'no NOT VALID split: runner is single-transaction');
  assert.ok(!/VALIDATE CONSTRAINT/i.test(sql), 'no separate VALIDATE: illegal inside the migration transaction');
  assert.ok(sql.includes("'Norway'") || sql.includes("'norway'"), 'backfill IN_SCOPE list must include Norway');
  assert.ok(sql.includes("'IN_SCOPE'") && sql.includes("'OUT_OF_SCOPE'") && sql.includes("'UNRESOLVED'"));
  assert.match(sql, /LOWER\(BTRIM\(country\)\)/, 'backfill must canonicalize case/whitespace like the resolver');
});

test('unsupported-universe gate rejects CONFIRMED foreign domicile, preserves fail-open', async () => {
  const { assessChannelCountry } = await import('./countryInference');
  const base: any = {
    channelName: 'Edge Trading Journal',
    videoTitles: [],
    videoDescriptions: [],
    videoDescriptionsAuthoritative: false,
    playlists: [],
  };
  const confirmed = assessChannelCountry(
    { ...base, aboutBio: 'Trader based in Brazil covering Latin American equity futures.' },
    [],
    [],
  );
  assert.equal(confirmed.detectedCreatorCountry, 'Brazil');
  assert.equal(confirmed.countryStatus, 'REJECTED');
  assert.equal(confirmed.gateDisposition, 'REJECT_UNSUPPORTED');
  const bare = assessChannelCountry(
    { ...base, aboutBio: 'English-language quant channel. We comment on Brazil market opens for context.' },
    [],
    [],
  );
  assert.notEqual(bare.countryStatus, 'REJECTED');
  assert.notEqual(bare.gateDisposition, 'REJECT_UNSUPPORTED');
  const empty = assessChannelCountry({ ...base, aboutBio: '' }, [], []);
  assert.equal(empty.countryStatus, 'UNCERTAIN');
  assert.equal(empty.gateDisposition, 'CONTINUE_CRAWLING');
  const supported = assessChannelCountry(
    { ...base, aboutBio: 'Trader based in Germany covering DAX futures.' },
    [],
    [],
  );
  assert.equal(supported.detectedCreatorCountry, 'Germany');
  assert.notEqual(supported.gateDisposition, 'REJECT_UNSUPPORTED');
});

test('exclusion gate keeps precedence over unsupported-universe gate', async () => {
  const { assessChannelCountry } = await import('./countryInference');
  const res = assessChannelCountry(
    {
      channelName: 'Edge Trading Journal',
      aboutBio: 'Trader based in Vietnam covering Asian equity futures.',
      videoTitles: [],
      videoDescriptions: [],
      videoDescriptionsAuthoritative: false,
      playlists: [],
    } as any,
    [{ country_name: 'Vietnam', reason: 'test exclusion' }],
    [],
  );
  assert.equal(res.gateDisposition, 'REJECT_EXCLUDED');
});

test('content-origin phrasing never authorizes rejection', async () => {
  const { assessChannelCountry } = await import('./countryInference');
  const base: any = {
    channelName: 'Edge Trading Journal',
    videoTitles: [],
    videoDescriptions: [],
    videoDescriptionsAuthoritative: false,
    playlists: [],
  };
  for (const bio of [
    'Daily market reports from Brazil covering Latin American equities.',
    'Morning news from Brazil with Asian market recap.',
  ]) {
    const res = assessChannelCountry({ ...base, aboutBio: bio }, [], []);
    assert.notEqual(res.countryStatus, 'REJECTED', bio);
    assert.notEqual(res.gateDisposition, 'REJECT_UNSUPPORTED', bio);
  }
});

test('alias-covered countries without signal gaps reach the unsupported gate', async () => {
  const { assessChannelCountry, canonicalCountry } = await import('./countryInference');
  assert.equal(canonicalCountry('mx'), 'Mexico');
  const base: any = {
    channelName: 'Edge Trading Journal',
    videoTitles: [],
    videoDescriptions: [],
    videoDescriptionsAuthoritative: false,
    playlists: [],
  };
  const res = assessChannelCountry(
    { ...base, aboutBio: 'Trader based in Mexico covering futures and forex.' },
    [],
    [],
  );
  assert.equal(res.detectedCreatorCountry, 'Mexico');
  assert.equal(res.countryStatus, 'REJECTED');
  assert.equal(res.gateDisposition, 'REJECT_UNSUPPORTED');
});

test('write-path invariant: final country always determines scope, stale values die', async () => {
  const { scopeEligibilityForWrite } = await import('./scopeEligibility');
  assert.equal(
    scopeEligibilityForWrite({ country: 'Brazil', scope_eligibility: 'IN_SCOPE' }),
    'OUT_OF_SCOPE',
  );
  assert.equal(
    scopeEligibilityForWrite({ country: 'Germany', scope_eligibility: 'OUT_OF_SCOPE' }),
    'IN_SCOPE',
  );
  assert.equal(
    scopeEligibilityForWrite({ country: null, scope_eligibility: 'IN_SCOPE' }),
    'UNRESOLVED',
  );
  assert.equal(scopeEligibilityForWrite({ country: 'Germany' }), 'IN_SCOPE');
});

test('upsertChannel derives scope from the row country and reads no stored value', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const upsert = source.slice(
    source.indexOf('export async function upsertChannel'),
    source.indexOf('export async function upsertChannel') + 6000,
  );
  assert.match(upsert, /scopeEligibilityForWrite\(channel\)/);
  assert.ok(
    !upsert.includes('channel.scope_eligibility'),
    'upsert must never read a stored eligibility value',
  );
});

test('dormant exclusion is intentional and total across scope modes', async () => {
  // Invariant: dormant supported countries are never swept autonomously in
  // any mode (they stay valid for manual search, explicit single targets,
  // and cross-border flows). An operator retaining them in persistent
  // selection sees the UI note; the scheduler silently ignoring them is
  // intended, tested behavior — not a bug.
  const { resolveAutonomousCountries } = await import('./autonomousDiscovery');
  const { SUPPORTED_PRODUCTION_COUNTRIES, SUPPORTED_DORMANT_COUNTRIES } = await import(
    '../src/data/initial_countries'
  );
  const all = [...SUPPORTED_PRODUCTION_COUNTRIES] as string[];
  assert.equal(
    resolveAutonomousCountries(all, [], [], 'GLOBAL').length,
    all.length - SUPPORTED_DORMANT_COUNTRIES.length,
  );
  assert.deepEqual(
    resolveAutonomousCountries(all, [], [...SUPPORTED_DORMANT_COUNTRIES, 'Germany'], 'SELECTED_COUNTRIES'),
    ['Germany'],
  );
  assert.deepEqual(resolveAutonomousCountries(all, [], [...SUPPORTED_DORMANT_COUNTRIES], 'SELECTED_COUNTRIES'), []);
});
