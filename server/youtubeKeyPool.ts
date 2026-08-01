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

/** Return the configured, non-placeholder projects in stable rotation order. */
export function getConfiguredYouTubeKeys(environment: NodeJS.ProcessEnv = process.env): string[] {
  return getYouTubeApiKeyEnvNames(environment)
    .map(name => environment[name]?.trim())
    .filter((key): key is string => Boolean(key) && !key.startsWith('MY_'))
    .filter((key, index, keys) => keys.indexOf(key) === index);
}
