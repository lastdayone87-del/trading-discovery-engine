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
export interface ProductionConfigManifest {
  version: 1;
  description?: string;
  environment: Record<string, string | null>;
  secretGroups: Array<{ prefix: string; minimum: number }>;
  requiredSecrets: string[];
}

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
    if (value === null) {
      environment[key] = null;
      continue;
    }
    if (typeof value !== 'string') invalid(`environment.${key} must be string or null`);
    environment[key] = value;
  }

  const secretGroups = raw.secretGroups.map((group, index) => {
    if (!isRecord(group)) invalid(`secretGroups[${index}] must be an object`);
    if (typeof group.prefix !== 'string' || !group.prefix.trim()) invalid(`secretGroups[${index}].prefix must be non-empty`);
    if (!Number.isInteger(group.minimum) || Number(group.minimum) < 1) invalid(`secretGroups[${index}].minimum must be an integer >= 1`);
    return { prefix: group.prefix, minimum: Number(group.minimum) };
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
  const text = String(value);
  return text.trim() === '' ? null : text;
}

/** Compare the manifest environment against a process-style env object. */
export function compareEnvironment(
  manifest: ProductionConfigManifest,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ConfigCheck[] {
  return Object.entries(manifest.environment).map(([key, expected]) => {
    const actual = normalizedEnvValue(env[key]);
    return {
      source: 'environment',
      key,
      expected,
      actual,
      ok: expected === null ? actual === null : actual === expected,
    };
  });
}

/**
 * Verify the minimum number of configured provider keys without exposing any
 * value. Prefix matching is intentional: key slots are added/removed at
 * runtime, while the manifest records the minimum expected pool size.
 */
export function checkSecretGroups(
  manifest: ProductionConfigManifest,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ConfigCheck[] {
  return manifest.secretGroups.map(({ prefix, minimum }) => {
    const count = Object.entries(env)
      .filter(([key, value]) => key.startsWith(prefix) && normalizedEnvValue(value) !== null)
      .length;
    return {
      source: 'secret',
      key: prefix,
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
  expected: string,
  actual: string,
): ConfigCheck {
  return {
    source: 'code',
    key,
    expected,
    actual,
    ok: actual === expected,
  };
}

export function summarizeChecks(checks: ConfigCheck[]): ConfigCheckSummary {
  const failures = checks.filter(check => !check.ok).length;
  return { ok: failures === 0, checks: checks.length, failures };
}
