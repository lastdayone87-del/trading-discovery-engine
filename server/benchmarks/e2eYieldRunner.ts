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
  /** Expected cases (expectExtracted === true). */
  expectedCases: number;
  /** Expected cases successfully extracted. */
  successfulExpectedExtractions: number;
  /** Expected cases fully complete (extraction + expected fields). */
  completeExpectedExtractions: number;
  /** successfulExpectedExtractions / expectedCases (null when none expected). */
  extractionRate: number | null;
  /** completeExpectedExtractions / expectedCases (null when none expected). */
  completenessRate: number | null;
  /** Negative cases (!expectExtracted) unexpectedly extracted. */
  falsePositives: number;
  /** falsePositives / negative cases (null when no negative cases). */
  falsePositiveRate: number | null;
  details: YieldBenchDetail[];
}

/**
 * Offline E2E yield: frozen YouTube API payloads flow through the real
 * deterministic extraction path (extractDiscoveredChannels) with zero live
 * network calls. Rates use explicit denominators over EXPECTED extractions
 * only — negative cases never inflate them; unexpected extraction is tracked
 * separately as false positives. NOT live enrichment (requires keys).
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
    // Channel-lane extraction echoes the search query into videoTitles when
    // no source video exists, so title coverage there requires a title that
    // is not the query itself. Video-lane titles are always observed.
    const hasVideoTitles =
      item.payload.lane === 'VIDEO'
        ? Boolean(found?.videoTitles?.length)
        : Boolean(found?.videoTitles?.some(title => title && title !== item.payload.query));
    const complete =
      Boolean(found) === item.expectExtracted &&
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
  const expected = details.filter(d => d.expectExtracted);
  const negative = details.filter(d => !d.expectExtracted);
  const successfulExpectedExtractions = expected.filter(d => d.extracted).length;
  const completeExpectedExtractions = expected.filter(d => d.complete).length;
  const falsePositives = negative.filter(d => d.extracted).length;
  return {
    evaluated: details.length,
    expectedCases: expected.length,
    successfulExpectedExtractions,
    completeExpectedExtractions,
    extractionRate: expected.length > 0 ? successfulExpectedExtractions / expected.length : null,
    completenessRate: expected.length > 0 ? completeExpectedExtractions / expected.length : null,
    falsePositives,
    falsePositiveRate: negative.length > 0 ? falsePositives / negative.length : null,
    details,
  };
}
