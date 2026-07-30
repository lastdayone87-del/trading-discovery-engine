/** Ordered environment variables that make up the ten-project YouTube pool. */
export const YOUTUBE_API_KEY_ENV_NAMES = [
  'YOUTUBE_API_KEY',
  ...Array.from({ length: 9 }, (_, index) => `YOUTUBE_API_KEY_${index + 1}`)
] as const;

/** Return the configured, non-placeholder projects in stable rotation order. */
export function getConfiguredYouTubeKeys(environment: NodeJS.ProcessEnv = process.env): string[] {
  return YOUTUBE_API_KEY_ENV_NAMES
    .map(name => environment[name]?.trim())
    .filter((key): key is string => Boolean(key) && !key.startsWith('MY_'))
    .filter((key, index, keys) => keys.indexOf(key) === index);
}
