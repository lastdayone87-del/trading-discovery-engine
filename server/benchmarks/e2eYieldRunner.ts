import { extractDiscoveredChannels } from '../youtube';
import type { RetrievalLane } from '../retrievalLanes';

export interface FrozenApiPayload {
  lane: RetrievalLane;
  query: string;
  /** Pre-cached YouTube API response items (search.list page payload). */
  items: unknown[];
}

export interface FrozenYieldCase {
  channelId: string;
  payload: FrozenApiPayload;
  expectExtracted: boolean;
  expectDescription: boolean;
  expectVideoTitles: boolean;
}

export interface YieldBenchDetail extends FrozenYieldCase {
  extracted: boolean;
  hasDescription: boolean;
  hasVideoTitles: boolean;
  complete: boolean;
}

export interface YieldBenchResult {
  evaluated: number;
  extracted: number;
  complete: number;
  extractionRate: number | null;
  completenessRate: number | null;
  details: YieldBenchDetail[];
}

/**
 * Offline E2E yield: frozen YouTube API payloads flow through the real
 * deterministic extraction path (extractDiscoveredChannels) with zero live
 * network calls. Measures parser/extraction yield and field completeness —
 * NOT live enrichment, which requires keys and runs in production.
 */
export function runE2EYield(cases: FrozenYieldCase[]): YieldBenchResult {
  const details: YieldBenchDetail[] = cases.map(item => {
    const extracted = extractDiscoveredChannels(
      item.payload.items as any[],
      item.payload.lane,
      item.payload.query,
    );
    const found = extracted.find(c => c.channelId === item.channelId);
    const hasDescription = Boolean(found?.description);
    const hasVideoTitles = Boolean(found?.videoTitles?.length);
    const complete =
      (!item.expectExtracted || Boolean(found)) &&
      (!item.expectDescription || hasDescription) &&
      (!item.expectVideoTitles || hasVideoTitles);
    return {
      ...item,
      extracted: Boolean(found),
      hasDescription,
      hasVideoTitles,
      complete,
    };
  });
  const extracted = details.filter(d => d.extracted).length;
  const complete = details.filter(d => d.complete).length;
  return {
    evaluated: details.length,
    extracted,
    complete,
    extractionRate: details.length > 0 ? extracted / details.length : null,
    completenessRate: details.length > 0 ? complete / details.length : null,
    details,
  };
}
