/**
 * P6 conditional mechanisms (CONDITIONAL, default-off scaffolding).
 * No active behavior. Each mechanism lists prerequisites; the gate returns
 * false until ALL are satisfied AND explicitly enabled. This preserves
 * testability without assuming superiority or activating unreviewed paths.
 * Excluded paths (official captions download, relatedToVideoId, auto-merge,
 * uncontrolled LLM invention, open crawl) are NOT represented here — they
 * remain REJECTED per approved architecture.
 */
export const CONDITIONAL_MECHANISMS_VERSION = 'conditional-mechanisms-v1';

export type ConditionalMechanism =
  | 'SUGGEST_MINING'
  | 'EMBEDDING_RERANKER'
  | 'VISIBILITY_SERVING'
  | 'COMMENTER_LEADS'
  | 'PUBLIC_SUBS_EDGE'
  | 'LEGITIMATE_TRANSCRIPT';

export interface MechanismPrerequisites {
  tosReviewed: boolean;
  evalHarnessReady: boolean;
  explicitlyEnabled: boolean;
  /** Mechanism-specific extra (e.g. index built, benchmark passed). */
  extraSatisfied: boolean;
}

/** Fail-closed: all prerequisites required. Default-off. */
export function isMechanismEnabled(prereqs: MechanismPrerequisites): boolean {
  return prereqs.tosReviewed && prereqs.evalHarnessReady && prereqs.explicitlyEnabled && prereqs.extraSatisfied;
}

/** Documents what each mechanism waits on (informational, not executable). */
export const CONDITIONAL_PREREQUISITE_NOTES: Record<ConditionalMechanism, string> = {
  SUGGEST_MINING: 'ToS review + SUGGEST_SURFACE provenance + breakage monitor + governance gate',
  EMBEDDING_RERANKER: 'Frozen corpus index + eval harness + cost approval',
  VISIBILITY_SERVING: 'Labeled validation of thresholds; descriptive analytics only until then',
  COMMENTER_LEADS: 'Spam analysis + quota approval; opportunistic only',
  PUBLIC_SUBS_EDGE: 'Hidden-subs analysis; opportunistic only, never primary',
  LEGITIMATE_TRANSCRIPT: 'Legal/reliability review of timedtext/player path; official captions stay REJECTED',
};
