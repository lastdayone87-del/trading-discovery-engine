/**
 * R6 follow-up independent feature flags (one PR, four flags).
 *
 * Each behavioral fix reads its own flag so any one can be disabled without
 * reverting the PR. All flags fail open to legacy behavior when the setting
 * is missing, unreadable, or errors.
 *
 * - relevance_enforcement_enabled: global relevance BLOCK/DEMOTE enforcement.
 *   Ships DISABLED pending BLOCK/DEMOTE/ELIGIBLE rule + replay review.
 *   Capable of immediate disable.
 * - login_block_semantics_enabled: confirmed-login-wall terminal semantics.
 * - path_aware_shortlink_borrow_enabled: FOUND borrow requires coverage/binding.
 * - partial_static_retry_enabled: safe partial-static retryable gaps.
 */
import { getAppSetting } from './dbCore';

export const R6_FLAG_KEYS = {
  relevanceEnforcement: 'relevance_enforcement_enabled',
  loginBlockSemantics: 'login_block_semantics_enabled',
  pathAwareShortlinkBorrow: 'path_aware_shortlink_borrow_enabled',
  partialStaticRetry: 'partial_static_retry_enabled',
} as const;

export const R6_FLAG_ENVS = {
  relevanceEnforcement: 'RELEVANCE_ENFORCEMENT_ENABLED',
  loginBlockSemantics: 'LOGIN_BLOCK_SEMANTICS_ENABLED',
  pathAwareShortlinkBorrow: 'PATH_AWARE_SHORTLINK_BORROW_ENABLED',
  partialStaticRetry: 'PARTIAL_STATIC_RETRY_ENABLED',
} as const;

async function readFlag(
  key: string,
  envKey: string,
  fallback: 'true' | 'false',
  readSetting: (key: string, fallback: string) => Promise<string> = getAppSetting,
): Promise<boolean> {
  try {
    const env = process.env[envKey];
    if (typeof env === 'string' && env.length > 0) {
      return env === 'true';
    }
    return (await readSetting(key, fallback)) === 'true';
  } catch {
    return fallback === 'true';
  }
}

export function isRelevanceEnforcementEnabled(
  readSetting?: (key: string, fallback: string) => Promise<string>,
): Promise<boolean> {
  // Ships DISABLED until BLOCK/DEMOTE/ELIGIBLE rules + 7-day replay reviewed.
  return readFlag(
    R6_FLAG_KEYS.relevanceEnforcement,
    R6_FLAG_ENVS.relevanceEnforcement,
    'false',
    readSetting,
  );
}

export function isLoginBlockSemanticsEnabled(
  readSetting?: (key: string, fallback: string) => Promise<string>,
): Promise<boolean> {
  return readFlag(
    R6_FLAG_KEYS.loginBlockSemantics,
    R6_FLAG_ENVS.loginBlockSemantics,
    'true',
    readSetting,
  );
}

export function isPathAwareShortlinkBorrowEnabled(
  readSetting?: (key: string, fallback: string) => Promise<string>,
): Promise<boolean> {
  return readFlag(
    R6_FLAG_KEYS.pathAwareShortlinkBorrow,
    R6_FLAG_ENVS.pathAwareShortlinkBorrow,
    'true',
    readSetting,
  );
}

export function isPartialStaticRetryEnabled(
  readSetting?: (key: string, fallback: string) => Promise<string>,
): Promise<boolean> {
  return readFlag(
    R6_FLAG_KEYS.partialStaticRetry,
    R6_FLAG_ENVS.partialStaticRetry,
    'true',
    readSetting,
  );
}
