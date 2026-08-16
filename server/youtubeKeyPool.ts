/**
 * Resolve the pool size from configuration. Thirty is the production default,
 * while deployments can raise or lower it without an application change.
 */
export function getYouTubeApiKeyPoolSize(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.YOUTUBE_API_KEY_POOL_SIZE?.trim();
  if (!raw) return 30;
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new Error('YOUTUBE_API_KEY_POOL_SIZE must be a positive integer.');
  }
  return size;
}

/** Ordered environment variables used for the default production pool. */
export const YOUTUBE_API_KEY_ENV_NAMES = Object.freeze([
  'YOUTUBE_API_KEY',
  ...Array.from({ length: getYouTubeApiKeyPoolSize({}) - 1 }, (_, index) => `YOUTUBE_API_KEY_${index + 1}`)
]);

export function getYouTubeApiKeyEnvNames(environment: NodeJS.ProcessEnv = process.env): string[] {
  return ['YOUTUBE_API_KEY', ...Array.from({ length: getYouTubeApiKeyPoolSize(environment) - 1 }, (_, index) => `YOUTUBE_API_KEY_${index + 1}`)];
}

export interface ConfiguredYouTubeProvider {
  key: string;
  envName: string;
  /** Optional non-secret label identifying the Google Cloud project/quota domain for this key. */
  quotaGroup?: string;
}

/**
 * Optional quota-domain labels use the API-key environment-variable name plus
 * `_QUOTA_GROUP`, for example YOUTUBE_API_KEY_QUOTA_GROUP=project-a and
 * YOUTUBE_API_KEY_1_QUOTA_GROUP=project-b. Labels are never sent to Google.
 */
export function getConfiguredYouTubeProviders(environment: NodeJS.ProcessEnv = process.env): ConfiguredYouTubeProvider[] {
  const providers: ConfiguredYouTubeProvider[] = [];
  const seen = new Set<string>();
  for (const envName of getYouTubeApiKeyEnvNames(environment)) {
    const key = environment[envName]?.trim();
    if (!key || key.startsWith('MY_') || seen.has(key)) continue;
    seen.add(key);
    const quotaGroup = environment[`${envName}_QUOTA_GROUP`]?.trim();
    providers.push({ key, envName, ...(quotaGroup ? { quotaGroup } : {}) });
  }
  return providers;
}

/** Return the configured, non-placeholder projects in stable rotation order. */
export function getConfiguredYouTubeKeys(environment: NodeJS.ProcessEnv = process.env): string[] {
  return getConfiguredYouTubeProviders(environment).map(provider => provider.key);
}

export function getYouTubeQuotaGroupForKey(key: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  return getConfiguredYouTubeProviders(environment).find(provider => provider.key === key)?.quotaGroup;
}
