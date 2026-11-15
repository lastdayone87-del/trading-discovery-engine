import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ADMISSION_PRIMARY_MODEL } from './channelAdmission/admissionModels';
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

test('production manifest owns the measured admission model and revert baseline', () => {
  const manifest = loadProductionConfig(configPath);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.environment.ADMISSION_PRIMARY_MODEL, 'gemini-flash-lite-latest');
  assert.equal(manifest.environment.ADMISSION_PRIMARY_MODEL, DEFAULT_ADMISSION_PRIMARY_MODEL);
  assert.equal(manifest.environment.MULTILINGUAL_CANDIDATE_MODEL, 'gemini-3.5-flash-lite');
  assert.equal(manifest.environment.MULTILINGUAL_ADJUDICATOR_MODEL, 'gemini-3.5-flash-lite');
  assert.equal(manifest.environment.GROQ_CANDIDATE_MODEL, 'openai/gpt-oss-20b');
  assert.equal(manifest.environment.SEMANTIC_PROVIDER, 'gemini');
  assert.equal(manifest.environment.ENRICHMENT_WORKER_CONCURRENCY, '6');
  assert.equal(manifest.environment.ENRICHMENT_SCALE_GATE_ENABLED, 'true');
  assert.equal(manifest.environment.CLASSIFICATION_RENDERED_FALLBACK_MAX_WAIT_MS, '5000');
  assert.equal(manifest.environment.SEARCH_WORKER_CONCURRENCY, '2');
  assert.equal(manifest.environment.COMMUNITY_RETRY_WORKER_CONCURRENCY, '3');
  assert.equal(manifest.environment.RENDERED_ADMISSION_GOVERNOR_ENABLED, 'true');
  assert.equal(manifest.environment.RENDERED_FALLBACK_MAX_WAIT_MS, '90000');
  assert.ok(manifest.secretGroups.some(group => group.prefix === 'YOUTUBE_API_KEY_' && group.minimum === 58));
});

test('manifest parsing rejects malformed shapes instead of verifying a subset', () => {
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
    secretGroups: [{ prefix: '', minimum: 1 }],
    requiredSecrets: [],
  }), /secretGroups\[0\]\.prefix must be non-empty/);
});

test('environment comparison distinguishes unset overrides from mismatches', () => {
  const manifest = {
    version: 1,
    environment: {
      ADMISSION_PRIMARY_MODEL: 'gemini-flash-lite-latest',
      ADMISSION_SECONDARY_MODEL: null,
    },
    secretGroups: [],
    requiredSecrets: [],
  } as ProductionConfigManifest;

  const ok = compareEnvironment(manifest, {
    ADMISSION_PRIMARY_MODEL: 'gemini-flash-lite-latest',
  } as NodeJS.ProcessEnv);
  assert.equal(ok.every(check => check.ok), true);

  const unsetAsEmpty = compareEnvironment(manifest, {
    ADMISSION_PRIMARY_MODEL: 'gemini-flash-lite-latest',
    ADMISSION_SECONDARY_MODEL: '',
  } as NodeJS.ProcessEnv);
  assert.equal(unsetAsEmpty.every(check => check.ok), true);

  const drift = compareEnvironment(manifest, {
    ADMISSION_PRIMARY_MODEL: 'gemini-3.6-flash',
    ADMISSION_SECONDARY_MODEL: 'some-model',
  } as NodeJS.ProcessEnv);
  assert.equal(drift.filter(check => !check.ok).length, 2);
});

test('secret checks verify presence and minimum pool sizes without exposing values', () => {
  const manifest = {
    version: 1,
    environment: {},
    secretGroups: [
      { prefix: 'YOUTUBE_API_KEY_', minimum: 2 },
      { prefix: 'GEMINI_API_KEY', minimum: 1 },
    ],
    requiredSecrets: ['DATABASE_URL'],
  } as ProductionConfigManifest;

  const env = {
    YOUTUBE_API_KEY_1: 'secret-a',
    YOUTUBE_API_KEY_2: 'secret-b',
    GEMINI_API_KEY: 'secret-c',
    DATABASE_URL: 'postgres://example',
  } as NodeJS.ProcessEnv;
  assert.equal(checkSecretGroups(manifest, env).every(check => check.ok), true);
  assert.equal(checkRequiredSecrets(manifest, env).every(check => check.ok), true);

  const missing = checkSecretGroups(manifest, {
    YOUTUBE_API_KEY_1: 'secret-a',
    GEMINI_API_KEY: '',
  } as NodeJS.ProcessEnv);
  assert.equal(missing.filter(check => !check.ok).length, 2);
  assert.equal(checkRequiredSecrets(manifest, {} as NodeJS.ProcessEnv)[0]?.ok, false);
});

test('code default and summary checks fail closed', () => {
  const ok = checkCodeDefault('ADMISSION_PRIMARY_MODEL', 'gemini-flash-lite-latest', 'gemini-flash-lite-latest');
  assert.equal(ok.ok, true);
  const drift = checkCodeDefault('ADMISSION_PRIMARY_MODEL', 'gemini-flash-lite-latest', 'gemini-3.6-flash');
  assert.equal(drift.ok, false);
  assert.deepEqual(summarizeChecks([ok]), { ok: true, checks: 1, failures: 0 });
  assert.deepEqual(summarizeChecks([ok, drift]), { ok: false, checks: 2, failures: 1 });
});
