import { timingSafeEqual } from 'node:crypto';

export interface ReviewerCredentialDefaults {
  apiToken?: string;
  identity?: string;
}

const trimmed = (value: string | undefined) => value?.trim() || undefined;

export function getReviewerCredentialDefaults(env: NodeJS.ProcessEnv = process.env): ReviewerCredentialDefaults {
  return {
    apiToken: trimmed(env.DEFAULT_REVIEWER_API_TOKEN),
    identity: trimmed(env.DEFAULT_REVIEWER_IDENTITY)
  };
}

export function reviewerDefaultsAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const defaults = getReviewerCredentialDefaults(env);
  return Boolean(defaults.apiToken && defaults.identity && reviewerTokenIsValid(undefined, env));
}

export function reviewerTokenIsValid(suppliedToken: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const defaults = getReviewerCredentialDefaults(env);
  const configured = trimmed(env.REVIEW_API_TOKEN) || defaults.apiToken;
  const supplied = trimmed(suppliedToken) || defaults.apiToken;
  if (!configured || !supplied) return false;

  const configuredBuffer = Buffer.from(configured);
  const suppliedBuffer = Buffer.from(supplied);
  return configuredBuffer.length === suppliedBuffer.length && timingSafeEqual(configuredBuffer, suppliedBuffer);
}

export function resolveReviewerIdentity(suppliedIdentity: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return trimmed(suppliedIdentity) || getReviewerCredentialDefaults(env).identity;
}
