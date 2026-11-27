import { readFileSync } from 'node:fs';

/**
 * Code-owned, non-secret production runtime safety baseline.
 *
 * This manifest is intentionally limited to behavior settings that were
 * changed or reverted in production: model selection, worker requests,
 * rendered-admission waits, and retry-lane limits. Operational state such as
 * discovery pause and queue controls is not part of this code contract; it is
 * preserved by the application database backup and the migration runbook.
 *
 * Secrets are never stored here. API keys, database URLs, and operator tokens
 * are represented only by key names/minimum counts so the verifier can fail
 * closed without printing a secret.
 */
export type SecretGroupKind = 'youtube' | 'gemini' | 'groq';

export interface ProductionConfigManifest {
  version: 1;
  description?: string;
  environment: Record<string, string | null>;
  secretGroups: Array<{ kind: SecretGroupKind; minimum: number }>;
  requiredSecrets: string[];
}

/**
 * Defense in depth: the manifest is for non-secret values only. A custom
 * manifest supplied through --config must not be able to smuggle a credential
 * into comparison output.
 */
const SENSITIVE_ENV_KEY = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|PRIVATE_KEY|CREDENTIALS?)(?:_|$)/i;
const SECRET_GROUP_KINDS = new Set<SecretGroupKind>(['youtube', 'gemini', 'groq']);

/** The manifest is a closed contract: only these non-secret settings may be compared. */
export const ALLOWED_MANIFEST_ENV_KEYS = new Set([
  'ADMISSION_PRIMARY_MODEL',
  'ADMISSION_SECONDARY_MODEL',
  'MULTILINGUAL_CANDIDATE_MODEL',
  'MULTILINGUAL_ADJUDICATOR_MODEL',
  'GROQ_CANDIDATE_MODEL',
  'SEMANTIC_PROVIDER',
  'ENRICHMENT_WORKER_CONCURRENCY',
  'ENRICHMENT_SCALE_GATE_ENABLED',
  'CLASSIFICATION_RENDERED_FALLBACK_MAX_WAIT_MS',
  'SEARCH_WORKER_CONCURRENCY',
  'COMMUNITY_RETRY_WORKER_CONCURRENCY',
  'RENDERED_ADMISSION_GOVERNOR_ENABLED',
  'RENDERED_ADMISSION_NOMINAL_PER_HOUR',
  'RENDERED_ADMISSION_EMERGENCY_PER_HOUR',
  'RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT',
  'BROWSER_RUNTIME_CONCURRENCY',
  'RENDERED_FALLBACK_MAX_WAIT_MS',
  'CRAWLEE_MEMORY_MBYTES',
]);

export type ConfigCheckSource = 'environment' | 'code' | 'secret';

export interface ConfigCheck {
  source: ConfigCheckSource;
  key: string;
  expected: string | null;
  actual: string | null;
  ok: boolean;
}

export interface ConfigCheckSummary {
  ok: boolean;
  checks: number;
  failures: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new Error(`INVALID_PRODUCTION_CONFIG: ${message}`);
}

/**
 * Validate and normalize a raw manifest. Throws on unknown versions, missing
 * sections, wrong value types, or empty secret groups. This is intentionally
 * strict: a malformed manifest must fail the deployment check, not silently
 * verify a subset of settings.
 */
export function parseProductionConfig(raw: unknown): ProductionConfigManifest {
  if (!isRecord(raw)) invalid('root must be an object');
  if (raw.version !== 1) invalid('version must be 1');
  if (!isRecord(raw.environment)) invalid('environment must be an object');
  if (!Array.isArray(raw.secretGroups)) invalid('secretGroups must be an array');
  if (!Array.isArray(raw.requiredSecrets)) invalid('requiredSecrets must be an array');

  const environment: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw.environment)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) invalid(`environment key is not a valid env name: ${key}`);
    if (!ALLOWED_MANIFEST_ENV_KEYS.has(key)) invalid(`environment.${key} is not an allowed non-secret setting`);
    if (value === null) {
      environment[key] = null;
      continue;
    }
    if (typeof value !== 'string') invalid(`environment.${key} must be string or null`);
    environment[key] = value;
  }

  const secretGroups = raw.secretGroups.map((group, index) => {
    if (!isRecord(group)) invalid(`secretGroups[${index}] must be an object`);
    if (typeof group.kind !== 'string' || !SECRET_GROUP_KINDS.has(group.kind as SecretGroupKind)) {
      invalid(`secretGroups[${index}].kind must be one of youtube, gemini, groq`);
    }
    if (!Number.isInteger(group.minimum) || Number(group.minimum) < 1) invalid(`secretGroups[${index}].minimum must be an integer >= 1`);
    return { kind: group.kind as SecretGroupKind, minimum: Number(group.minimum) };
  });

  const requiredSecrets = raw.requiredSecrets.map((key, index) => {
    if (typeof key !== 'string' || !key.trim()) invalid(`requiredSecrets[${index}] must be non-empty`);
    return key;
  });

  return {
    version: 1,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    environment,
    secretGroups,
    requiredSecrets,
  };
}

export function loadProductionConfig(path = 'config/production.json'): ProductionConfigManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`PRODUCTION_CONFIG_UNREADABLE: ${path}: ${message}`);
  }
  return parseProductionConfig(parsed);
}

function normalizedEnvValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function rawEnvValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.trim() === '' ? null : text;
}

/** Compare the manifest environment against a process-style env object. */
export function compareEnvironment(
  manifest: ProductionConfigManifest,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ConfigCheck[] {
  return Object.entries(manifest.environment).map(([key, expected]) => {
    const actualRaw = rawEnvValue(env[key]);
    const actual = actualRaw === null ? null : (SENSITIVE_ENV_KEY.test(key) ? '<redacted>' : actualRaw);
    return {
      source: 'environment',
      key,
      expected,
      actual,
      ok: expected === null ? actualRaw === null : actual === expected,
    };
  });
}

/**
 * Canonical provider key slots, matching the runtime loaders. This excludes
 * metadata variables such as YOUTUBE_API_KEY_1_QUOTA_GROUP, malformed slots
 * such as GROQ_API_KEY_EXTRA or *_0, and duplicate key values.
 */
function canonicalSecretSlot(kind: SecretGroupKind, name: string): number | null {
  if (kind === 'youtube') {
    if (name === 'YOUTUBE_API_KEY') return 0;
    const match = /^YOUTUBE_API_KEY_([1-9][0-9]*)$/.exec(name);
    if (!match) return null;
    const slot = Number(match[1]);
    return Number.isSafeInteger(slot) && slot >= 1 ? slot : null;
  }
  if (kind === 'gemini') {
    if (name === 'GEMINI_API_KEY') return 1;
    const match = /^GEMINI_API_KEY_([2-9]|[1-9][0-9]+)$/.exec(name);
    if (!match) return null;
    const slot = Number(match[1]);
    return Number.isSafeInteger(slot) && slot >= 2 ? slot : null;
  }
  if (name === 'GROQ_API_KEY') return 1;
  const match = /^GROQ_API_KEY_([2-9]|[1-9][0-9]+)$/.exec(name);
  if (!match) return null;
  const slot = Number(match[1]);
  return Number.isSafeInteger(slot) && slot >= 2 ? slot : null;
}

function countCanonicalSecretValues(
  kind: SecretGroupKind,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): number {
  const values = new Set<string>();
  for (const [name, raw] of Object.entries(env)) {
    if (canonicalSecretSlot(kind, name) === null) continue;
    const value = normalizedEnvValue(raw);
    if (value === null) continue;
    // The YouTube loader treats MY_* placeholders as unconfigured.
    if (kind === 'youtube' && value.startsWith('MY_')) continue;
    values.add(value);
  }
  return values.size;
}

/**
 * Verify the minimum number of usable provider routes without exposing any
 * value. Counts follow the provider loaders' canonical slot rules and
 * deduplicate repeated key values.
 */
export function checkSecretGroups(
  manifest: ProductionConfigManifest,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ConfigCheck[] {
  return manifest.secretGroups.map(({ kind, minimum }) => {
    const count = countCanonicalSecretValues(kind, env);
    return {
      source: 'secret',
      key: kind,
      expected: `>=${minimum}`,
      actual: String(count),
      ok: count >= minimum,
    };
  });
}

/** Verify each required secret is present and non-empty, without printing it. */
export function checkRequiredSecrets(
  manifest: ProductionConfigManifest,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ConfigCheck[] {
  return manifest.requiredSecrets.map(key => {
    const present = normalizedEnvValue(env[key]) !== null;
    return {
      source: 'secret',
      key,
      expected: '<set>',
      actual: present ? '<set>' : '<missing>',
      ok: present,
    };
  });
}

/** Verify a code-owned default matches the manifest value. */
export function checkCodeDefault(
  key: string,
  expected: string | null,
  actual: string,
): ConfigCheck {
  return {
    source: 'code',
    key,
    expected: expected ?? '<missing>',
    actual,
    ok: expected !== null && actual === expected,
  };
}

export function summarizeChecks(checks: ConfigCheck[]): ConfigCheckSummary {
  const failures = checks.filter(check => !check.ok).length;
  return { ok: failures === 0, checks: checks.length, failures };
}
