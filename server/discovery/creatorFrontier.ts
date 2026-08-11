export const CREATOR_FRONTIER_POLICY_VERSION = 'creator-frontier-v1-shadow-1' as const;

export type EvidenceSufficiency = 'MISSING' | 'INSUFFICIENT' | 'SUFFICIENT';
export type CreatorFrontierDisposition = 'PRIORITIZE' | 'EXPLORE' | 'DEPRIORITIZE';

export interface CreatorFrontierSignals {
  channelId: string;
  lastUploadAt?: string | null;
  uploadsLast90Days?: number | null;
  evidenceSufficiency: EvidenceSufficiency;
  authorityScore?: number | null;
  communityScore?: number | null;
  uncertainty?: number | null;
}

export interface CreatorFrontierProjection {
  policyVersion: typeof CREATOR_FRONTIER_POLICY_VERSION;
  servingAuthority: false;
  channelId: string;
  disposition: CreatorFrontierDisposition;
  score: number;
  reasons: string[];
  signals: CreatorFrontierSignals;
}

const clamp01 = (value: number | null | undefined): number =>
  Math.max(0, Math.min(1, Number.isFinite(value) ? Number(value) : 0));

function recencyScore(lastUploadAt?: string | null, now = new Date()): number {
  if (!lastUploadAt) return 0;
  const timestamp = new Date(lastUploadAt).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (now.getTime() - timestamp) / 86_400_000);
  if (ageDays <= 30) return 1;
  if (ageDays <= 90) return 0.75;
  if (ageDays <= 180) return 0.4;
  if (ageDays <= 365) return 0.15;
  return 0;
}

function vitalityScore(uploadsLast90Days?: number | null): number {
  if (!Number.isFinite(uploadsLast90Days)) return 0;
  return clamp01(Number(uploadsLast90Days) / 8);
}

function sufficiencyScore(value: EvidenceSufficiency): number {
  if (value === 'SUFFICIENT') return 1;
  if (value === 'INSUFFICIENT') return 0.45;
  return 0;
}

/**
 * Read-only Stage 6 projection. It MUST NOT alter discovery allocation,
 * query execution, review materialization, enrichment, or serving behavior.
 */
export function projectCreatorFrontier(
  signals: CreatorFrontierSignals,
  now = new Date(),
): CreatorFrontierProjection {
  const recency = recencyScore(signals.lastUploadAt, now);
  const vitality = vitalityScore(signals.uploadsLast90Days);
  const sufficiency = sufficiencyScore(signals.evidenceSufficiency);
  const authority = clamp01(signals.authorityScore);
  const community = clamp01(signals.communityScore);
  const uncertainty = clamp01(signals.uncertainty);

  // Uncertainty receives positive weight so shadow measurement continues to
  // surface unknown creators instead of collapsing recall around known winners.
  const score = Number((
    recency * 0.25 +
    vitality * 0.20 +
    sufficiency * 0.25 +
    authority * 0.10 +
    community * 0.10 +
    uncertainty * 0.10
  ).toFixed(4));

  const reasons: string[] = [];
  if (recency >= 0.75) reasons.push('RECENT_UPLOADS');
  if (vitality >= 0.5) reasons.push('ACTIVE_CREATOR');
  if (signals.evidenceSufficiency === 'SUFFICIENT') reasons.push('SUFFICIENT_EVIDENCE');
  if (authority >= 0.5) reasons.push('AUTHORITY_SIGNAL');
  if (community >= 0.5) reasons.push('COMMUNITY_SIGNAL');
  if (uncertainty >= 0.5) reasons.push('UNCERTAINTY_EXPLORATION_VALUE');
  if (signals.evidenceSufficiency === 'MISSING') reasons.push('MISSING_EVIDENCE');
  if (recency === 0 && vitality === 0) reasons.push('LOW_VITALITY');

  const disposition: CreatorFrontierDisposition =
    score >= 0.65 ? 'PRIORITIZE' : score >= 0.3 ? 'EXPLORE' : 'DEPRIORITIZE';

  return {
    policyVersion: CREATOR_FRONTIER_POLICY_VERSION,
    servingAuthority: false,
    channelId: signals.channelId,
    disposition,
    score,
    reasons,
    signals,
  };
}
