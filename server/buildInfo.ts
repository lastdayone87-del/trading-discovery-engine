/**
 * Build identity for the running deployment (Phase 0 observability).
 *
 * Read-only: resolves the commit SHA from well-knownCI/platform environment
 * variables at call time so tests can inject values. Absence of provenance
 * is reported as 'unknown' — never fabricated.
 */

export interface BuildInfo {
  commitSha: string;
  commitSource: 'SOURCE_COMMIT' | 'RAILWAY_GIT_COMMIT_SHA' | 'GIT_COMMIT' | 'SOURCE_VERSION' | 'unknown';
  buildTime: string;
  buildTimeSource: 'BUILD_TIME' | 'startup';
}

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

function pickSha(env: NodeJS.ProcessEnv): { commitSha: string; commitSource: BuildInfo['commitSource'] } {
  const candidates = [
    // Coolify sets SOURCE_COMMIT on the running container. Prefer the
    // deployment's explicit source commit over CI-only variables so
    // /api/version always identifies the image that is actually serving.
    ['SOURCE_COMMIT', env.SOURCE_COMMIT],
    ['RAILWAY_GIT_COMMIT_SHA', env.RAILWAY_GIT_COMMIT_SHA],
    ['GIT_COMMIT', env.GIT_COMMIT],
    ['SOURCE_VERSION', env.SOURCE_VERSION],
  ] as const;
  for (const [source, value] of candidates) {
    const trimmed = String(value || '').trim();
    if (trimmed && SHA_PATTERN.test(trimmed)) return { commitSha: trimmed.toLowerCase(), commitSource: source };
  }
  return { commitSha: 'unknown', commitSource: 'unknown' };
}

export function resolveBuildInfo(
  env: NodeJS.ProcessEnv = process.env,
  now: () => string = () => new Date().toISOString(),
): BuildInfo {
  const { commitSha, commitSource } = pickSha(env);
  const buildTimeRaw = String(env.BUILD_TIME || '').trim();
  const buildTimeValid = buildTimeRaw && !Number.isNaN(Date.parse(buildTimeRaw));
  return {
    commitSha,
    commitSource,
    buildTime: buildTimeValid ? new Date(buildTimeRaw).toISOString() : now(),
    buildTimeSource: buildTimeValid ? 'BUILD_TIME' : 'startup',
  };
}
