/**
 * YouTube API keys use a stable indexed naming convention:
 * YOUTUBE_API_KEY, YOUTUBE_API_KEY_1, YOUTUBE_API_KEY_2, ...
 *
 * Thirty slots remain the backwards-compatible default shape, but runtime
 * configuration is no longer bounded by that declared range. Any non-empty,
 * canonically indexed key environment variable is discovered automatically.
 * YOUTUBE_API_KEY_POOL_SIZE remains supported as an optional minimum declared
 * range for deployments that intentionally provision blank/reserved slots.
 */
const DEFAULT_YOUTUBE_API_KEY_POOL_SIZE = 30;

function getDeclaredYouTubeApiKeyPoolSize(environment: NodeJS.ProcessEnv): number {
  const raw = environment.YOUTUBE_API_KEY_POOL_SIZE?.trim();
  if (!raw) return DEFAULT_YOUTUBE_API_KEY_POOL_SIZE;
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new Error('YOUTUBE_API_KEY_POOL_SIZE must be a positive integer.');
  }
  return size;
}

function getYouTubeApiKeyEnvName(index: number): string {
  return index === 0 ? 'YOUTUBE_API_KEY' : `YOUTUBE_API_KEY_${index}`;
}

function getYouTubeApiKeyEnvIndex(envName: string): number | null {
  if (envName === 'YOUTUBE_API_KEY') return 0;
  const match = /^YOUTUBE_API_KEY_([1-9]\d*)$/.exec(envName);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : null;
}

/** Ordered environment variables used for the default production pool. */
export const YOUTUBE_API_KEY_ENV_NAMES = Object.freeze(
  Array.from({ length: DEFAULT_YOUTUBE_API_KEY_POOL_SIZE }, (_, index) => getYouTubeApiKeyEnvName(index))
);

/**
 * Return the effective key-slot names in deterministic numeric order.
 *
 * The declared pool range is retained for backwards compatibility, while any
 * additional non-empty indexed key is included automatically. Sparse extra
 * indexes do not allocate every missing intermediate slot, so a typo such as
 * YOUTUBE_API_KEY_1000000 cannot create a million-entry in-memory pool.
 */
export function getYouTubeApiKeyEnvNames(environment: NodeJS.ProcessEnv = process.env): string[] {
  const declaredSize = getDeclaredYouTubeApiKeyPoolSize(environment);
  const names = new Set<string>(
    Array.from({ length: declaredSize }, (_, index) => getYouTubeApiKeyEnvName(index))
  );

  for (const [envName, rawValue] of Object.entries(environment)) {
    if (!rawValue?.trim()) continue;
    if (getYouTubeApiKeyEnvIndex(envName) === null) continue;
    names.add(envName);
  }

  return [...names].sort((left, right) => {
    const leftIndex = getYouTubeApiKeyEnvIndex(left) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = getYouTubeApiKeyEnvIndex(right) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

/** Number of recognized key slots after declared-range plus runtime discovery. */
export function getYouTubeApiKeyPoolSize(environment: NodeJS.ProcessEnv = process.env): number {
  return getYouTubeApiKeyEnvNames(environment).length;
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
