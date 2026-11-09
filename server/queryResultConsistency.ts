import { detectScripts, dominantScript, expectedScriptsForCountry } from './terminologySearchability';

/**
 * Post-retrieval intent consistency.
 *
 * A query can be well-formed and still retrieve an entirely different market.
 * The production incident that motivated this guard is `STI analysis` for
 * Singapore: the acronym also means State Tax Inspector (an Indian exam) and
 * sexually transmitted infection (health), so the first page returned Indian
 * exam channels and health channels. The query was only quarantined after two
 * complete runs, after those channels had already been queued for enrichment.
 *
 * This guard is deliberately conservative and language/script based, not
 * keyword based. It holds a query only when a sufficient sample has a high
 * share of scripts outside the target country's expected script profile. A
 * small number of foreign-script creators, a bilingual market, or an
 * unsupported country never triggers a hold. The query is quarantined, not
 * deleted: its evidence and audit trail remain available for review.
 */
export const QUERY_RESULT_CONSISTENCY_POLICY_VERSION = 'query-result-consistency-v1';
export const QUERY_RESULT_CONSISTENCY_MIN_SAMPLE = 10;
export const QUERY_RESULT_CONSISTENCY_MAX_SAMPLE = 40;
export const QUERY_RESULT_CONSISTENCY_HOLD_SHARE = 0.6;

export interface QueryResultConsistencyChannel {
  channelName?: string | null;
  description?: string | null;
  matchedDocument?: {
    type: 'VIDEO' | 'CHANNEL' | 'PLAYLIST' | 'EXTERNAL' | 'MANUAL' | 'UNKNOWN';
    title?: string;
    description?: string;
  } | null;
}

export interface QueryResultConsistencyDecision {
  hold: boolean;
  sampleSize: number;
  incompatibleCount: number;
  incompatibleShare: number;
  incompatibleScripts: string[];
  expectedScripts: string[];
  reasonCodes: string[];
  policyVersion: string;
}

function channelContentTexts(channel: QueryResultConsistencyChannel): string[] {
  const document = channel.matchedDocument;
  const texts = [
    channel.description,
    document?.title,
    document?.description,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  // A channel name alone is a weak signal (brands are often Latin even when
  // the creator publishes in another script). Use it only when no content
  // field is available at all, so a Latin name cannot mask a non-Latin bio.
  return texts.length ? texts : (channel.channelName ? [channel.channelName] : []);
}

function textHasExpectedScript(text: string, expected: ReadonlySet<string>): boolean {
  const dominant = dominantScript(text);
  if (!dominant) return true;
  return expected.has(dominant);
}

/**
 * Evaluate one search page's results against the target country's expected
 * script profile. Pure and read-only: callers decide whether to quarantine the
 * query or continue.
 */
export function assessQueryResultConsistency(
  country: string,
  channels: QueryResultConsistencyChannel[],
  options: {
    minSample?: number;
    maxSample?: number;
    holdShare?: number;
  } = {},
): QueryResultConsistencyDecision {
  const expected = expectedScriptsForCountry(country);
  const policyVersion = QUERY_RESULT_CONSISTENCY_POLICY_VERSION;
  if (!expected) {
    return {
      hold: false,
      sampleSize: 0,
      incompatibleCount: 0,
      incompatibleShare: 0,
      incompatibleScripts: [],
      expectedScripts: [],
      reasonCodes: ['NO_COUNTRY_SCRIPT_PROFILE'],
      policyVersion,
    };
  }
  const expectedScripts = [...expected];
  const minSample = Math.max(1, Math.trunc(options.minSample ?? QUERY_RESULT_CONSISTENCY_MIN_SAMPLE));
  const maxSample = Math.max(minSample, Math.trunc(options.maxSample ?? QUERY_RESULT_CONSISTENCY_MAX_SAMPLE));
  const sample = channels
    .map(channel => ({ channel, texts: channelContentTexts(channel) }))
    .filter(item => item.texts.length > 0)
    .slice(0, maxSample);
  if (sample.length < minSample) {
    return {
      hold: false,
      sampleSize: sample.length,
      incompatibleCount: 0,
      incompatibleShare: 0,
      incompatibleScripts: [],
      expectedScripts,
      reasonCodes: ['INSUFFICIENT_RESULT_SAMPLE'],
      policyVersion,
    };
  }
  let incompatibleCount = 0;
  const incompatibleScripts = new Set<string>();
  for (const item of sample) {
    // Evaluate creator-content fields separately: a Latin brand name must not
    // mask a Marathi/Gujarati/other bio or matched document. A field is
    // compatible when its dominant script is expected; a field with a
    // dominant unexpected script (including an unmodeled script) is the
    // mismatch signal.
    const incompatibleText = item.texts.find(text => !textHasExpectedScript(text, expected));
    if (!incompatibleText) continue;
    incompatibleCount += 1;
    detectScripts(incompatibleText).forEach(script => {
      if (!expected.has(script)) incompatibleScripts.add(script);
    });
  }
  const incompatibleShare = incompatibleCount / sample.length;
  const holdShare = Math.max(0, Math.min(1, options.holdShare ?? QUERY_RESULT_CONSISTENCY_HOLD_SHARE));
  const hold = incompatibleShare >= holdShare;
  return {
    hold,
    sampleSize: sample.length,
    incompatibleCount,
    incompatibleShare: Number(incompatibleShare.toFixed(4)),
    incompatibleScripts: [...incompatibleScripts].sort(),
    expectedScripts,
    reasonCodes: hold
      ? ['QUERY_RESULT_SCRIPT_MISMATCH', 'QUERY_PROVISIONAL_HOLD']
      : ['QUERY_RESULT_SCRIPT_CONSISTENT'],
    policyVersion,
  };
}
