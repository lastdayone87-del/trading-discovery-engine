const projectSuspensions = new Map<string, number>();

/**
 * Project-scoped YouTube credential suspension. Google suspends projects as
 * well as individual keys; when one key in a configured `*_QUOTA_GROUP` is
 * denied, every key in that group must be ineligible until the durable retry
 * date. Groups are optional: without labels each key remains independent.
 */
export function suspendYouTubeProject(quotaGroup: string, retryAtMs: number, nowMs: number = Date.now()): number {
  if (!quotaGroup) return 0;
  const retryAt = Number.isFinite(retryAtMs) && retryAtMs > nowMs ? retryAtMs : nowMs;
  const existing = projectSuspensions.get(quotaGroup) || 0;
  const effective = Math.max(existing, retryAt);
  projectSuspensions.set(quotaGroup, effective);
  return effective;
}

export function isYouTubeProjectSuspended(quotaGroup: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!quotaGroup) return false;
  const retryAt = projectSuspensions.get(quotaGroup);
  if (!retryAt) return false;
  if (retryAt <= nowMs) {
    projectSuspensions.delete(quotaGroup);
    return false;
  }
  return true;
}

export function clearYouTubeProjectSuspension(quotaGroup: string | null | undefined): void {
  if (quotaGroup) projectSuspensions.delete(quotaGroup);
}

export function resetYouTubeProjectSuspensionsForTests(): void {
  projectSuspensions.clear();
}
