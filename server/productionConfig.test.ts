import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ADMISSION_PRIMARY_MODEL } from './channelAdmission/admissionModels';
import {
  DEFAULT_GROQ_CANDIDATE_MODEL,
  DEFAULT_MULTILINGUAL_ADJUDICATOR_MODEL,
  DEFAULT_MULTILINGUAL_CANDIDATE_MODEL,
} from './evidenceEngine/modelDefaults';
import {
  checkCodeDefault,
  checkRequiredSecrets,
  checkSecretGroups,
  compareEnvironment,
  loadProductionConfig,
  parseProductionConfig,
  summarizeChecks,
  type ProductionConfigManifest,
} from './productionConfig';

const configPath = fileURLToPath(new URL('../config/production.json', import.meta.url));

test('production manifest owns the measured model defaults and revert baseline', () => {
  const manifest = loadProductionConfig(configPath);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.environment.ADMISSION_PRIMARY_MODEL, 'gemini-flash-lite-latest');
  assert.equal(manifest.environment.ADMISSION_PRIMARY_MODEL, DEFAULT_ADMISSION_PRIMARY_MODEL);
  assert.equal(manifest.environment.MULTILINGUAL_CANDIDATE_MODEL, DEFAULT_MULTILINGUAL_CANDIDATE_MODEL);
  assert.equal(manifest.environment.MULTILINGUAL_ADJUDICATOR_MODEL, DEFAULT_MULTILINGUAL_ADJUDICATOR_MODEL);
  assert.equal(manifest.environment.GROQ_CANDIDATE_MODEL, DEFAULT_GROQ_CANDIDATE_MODEL);
  assert.equal(manifest.environment.SEMANTIC_PROVIDER, 'gemini');
  assert.equal(manifest.environment.ENRICHMENT_WORKER_CONCURRENCY, '6');
  assert.equal(manifest.environment.ENRICHMENT_SCALE_GATE_ENABLED, 'true');
  assert.equal(manifest.environment.CLASSIFICATION_RENDERED_FALLBACK_MAX_WAIT_MS, '5000');
  assert.equal(manifest.environment.SEARCH_WORKER_CONCURRENCY, '2');
  assert.equal(manifest.environment.COMMUNITY_RETRY_WORKER_CONCURRENCY, '3');
  assert.equal(manifest.environment.RENDERED_ADMISSION_GOVERNOR_ENABLED, 'true');
  assert.equal(manifest.environment.RENDERED_FALLBACK_MAX_WAIT_MS, '90000');
  assert.ok(manifest.secretGroups.some(group => group.kind === 'youtube' && group.minimum === 58));
});

test('manifest parsing rejects malformed shapes and secret-like environment keys', () => {
  assert.throws(() => parseProductionConfig(null), /INVALID_PRODUCTION_CONFIG/);
  assert.throws(() => parseProductionConfig({ version: 2 }), /version must be 1/);
  assert.throws(() => parseProductionConfig({
    version: 1,
    environment: { BAD_KEY: 1 },
    secretGroups: [],
    requiredSecrets: [],
  }), /environment\.BAD_KEY must be string or null/);
  assert.throws(() => parseProductionConfig({
    version: 1,
    environment: {},
    secretGroups: [{ kind: 'youtube', minimum: 0 }],
    requiredSecrets: [],
  }), /minimum must be an integer >= 1/);
  assert.throws(() => parseProductionConfig({
    version: 1,
    environment: { DATABASE_URL: 'postgres://secret' },
    secretGroups: [],
    requiredSecrets: [],
  }), /looks secret/);
  assert.throws(() => parseProductionConfig({
    version: 1,
    environment: { GEMINI_API_KEY: 'secret' },
    secretGroups: [],
    requiredSecrets: [],
  }), /looks secret/);
});

test('environment comparison distinguishes unset overrides, drift, and redacted values', () => {
  const manifest = {
    version: 1,
    environment: {
      ADMISSION_PRIMARY_MODEL: 'gemini-flash-lite-latest',
      ADMISSION_SECONDARY_MODEL: null,
      DATABASE_URL: 'expected-placeholder',
    },
    secretGroups: [],
    requiredSecrets: [],
  } as ProductionConfigManifest;

  const ok = compareEnvironment(manifest, {
    ADMISSION_PRIMARY_MODEL: 'gemini-flash-lite-latest',
    DATABASE_URL: 'postgres://must-not-print',
  } as NodeJS.ProcessEnv);
  assert.equal(ok[0]?.ok, true);
  assert.equal(ok[1]?.ok, true);
  assert.equal(ok[2]?.actual, '<redacted>', 'secret-like values must never be printed');
  assert.equal(ok[2]?.ok, false);

  const unsetAsEmpty = compareEnvironment(manifest, {
    ADMISSION_PRIMARY_MODEL: 'gemini-flash-lite-latest',
    ADMISSION_SECONDARY_MODEL: '',
  } as NodeJS.ProcessEnv);
  assert.equal(unsetAsEmpty[1]?.ok, true);

  const drift = compareEnvironment(manifest, {
    ADMISSION_PRIMARY_MODEL: 'gemini-3.6-flash',
    ADMISSION_SECONDARY_MODEL: 'some-model',
  } as NodeJS.ProcessEnv);
  assert.equal(drift[0]?.ok, false);
  assert.equal(drift[1]?.ok, false);
});

test('secret checks use canonical provider slots and deduplicate values', () => {
  const manifest = {
    version: 1,
    environment: {},
    secretGroups: [
      { kind: 'youtube', minimum: 2 },
      { kind: 'gemini', minimum: 1 },
      { kind: 'groq', minimum: 2 },
    ],
    requiredSecrets: ['DATABASE_URL'],
  } as ProductionConfigManifest;

  const env = {
    YOUTUBE_API_KEY: 'youtube-a',
    YOUTUBE_API_KEY_1: 'youtube-b',
    YOUTUBE_API_KEY_1_QUOTA_GROUP: 'project-a',
    YOUTUBE_API_KEY_0: 'ignored-malformed',
    YOUTUBE_API_KEY_2: 'youtube-a',
    YOUTUBE_API_KEY_1000000_QUOTA_GROUP: 'ignored-metadata',
    GEMINI_API_KEY: 'gemini-a',
    GEMINI_API_KEY_2: 'gemini-a',
    GEMINI_API_KEY_EXTRA: 'ignored-malformed',
    GROQ_API_KEY: 'groq-a',
    GROQ_API_KEY_2: 'groq-b',
    GROQ_API_KEY_EXTRA: 'ignored-malformed',
    GROQ_API_KEY_0: 'ignored-malformed',
    DATABASE_URL: 'postgres://example',
  } as NodeJS.ProcessEnv;
  assert.equal(checkSecretGroups(manifest, env).every(check => check.ok), true);
  assert.equal(checkRequiredSecrets(manifest, env).every(check => check.ok), true);

  const missing = checkSecretGroups(manifest, {
    YOUTUBE_API_KEY_1_QUOTA_GROUP: 'project-a',
    GEMINI_API_KEY: '',
  } as NodeJS.ProcessEnv);
  assert.equal(missing[0]?.actual, '0');
  assert.equal(missing[0]?.ok, false);
  assert.equal(missing[1]?.ok, false);
  assert.equal(missing[2]?.ok, false);
});

test('production config commands run the compiled bundle, not development tsx', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(pkg.scripts['config:verify'] || '', /^node dist\/config\/verifyProductionConfig\.cjs$/);
  assert.match(pkg.scripts['config:apply'] || '', /^node dist\/config\/applyProductionConfig\.cjs$/);
  assert.match(pkg.scripts.build || '', /config:build/);
  assert.match(pkg.scripts['config:build'] || '', /scripts\/verifyProductionConfig\.ts/);
});

test('gemini canonical slots include 10-19 without accepting malformed names', () => {
  const manifest = {
    version: 1,
    environment: {},
    secretGroups: [{ kind: 'gemini', minimum: 2 }],
    requiredSecrets: [],
  } as ProductionConfigManifest;
  const checks = checkSecretGroups(manifest, {
    GEMINI_API_KEY: 'gemini-a',
    GEMINI_API_KEY_10: 'gemini-b',
    GEMINI_API_KEY_02: 'ignored-leading-zero',
    GEMINI_API_KEY_19_METADATA: 'ignored-metadata',
  } as NodeJS.ProcessEnv);
  assert.equal(checks[0]?.actual, '2');
  assert.equal(checks[0]?.ok, true);
});

test('code default and summary checks fail closed', () => {
  const ok = checkCodeDefault('ADMISSION_PRIMARY_MODEL', 'gemini-flash-lite-latest', 'gemini-flash-lite-latest');
  assert.equal(ok.ok, true);
  const drift = checkCodeDefault('ADMISSION_PRIMARY_MODEL', 'gemini-flash-lite-latest', 'gemini-3.6-flash');
  assert.equal(drift.ok, false);
  assert.deepEqual(summarizeChecks([ok]), { ok: true, checks: 1, failures: 0 });
  assert.deepEqual(summarizeChecks([ok, drift]), { ok: false, checks: 2, failures: 1 });
});
