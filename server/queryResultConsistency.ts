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

/**
 * The only place that decides whether a held query may enqueue another page.
 * Kept pure so the hold/continuation contract is tested directly instead of
 * only by grepping the worker.
 */
export function shouldContinueSearchAfterConsistency(args: {
  queryResultHold: boolean;
  continuationEnabled: boolean;
  decisionShouldContinue: boolean;
  hasNextPageToken: boolean;
}): boolean {
  return args.continuationEnabled
    && !args.queryResultHold
    && args.decisionShouldContinue
    && args.hasNextPageToken;
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

function sameSurface(a: string, b: string): boolean {
  const clean = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
  return clean(a) === clean(b);
}

function channelContentTexts(channel: QueryResultConsistencyChannel): string[] {
  const document = channel.matchedDocument;
  const channelDescription = typeof channel.description === 'string' ? channel.description.trim() : '';
  const documentTitle = typeof document?.title === 'string' ? document.title.trim() : '';
  const documentDescription = typeof document?.description === 'string' ? document.description.trim() : '';
  // A channel name alone is a weak signal: brands are often Latin even when
  // the creator publishes in another script, and a non-Latin name is not
  // evidence of the channel's content language. A matched document title that
  // merely repeats the channel name is still name-only. Exclude those rows; if
  // that leaves too few rows the guard fails open.
  const titleIsJustName = Boolean(
    documentTitle
    && channel.channelName
    && sameSurface(documentTitle, channel.channelName)
    && !documentDescription
    && !channelDescription,
  );
  return [
    channelDescription,
    titleIsJustName ? '' : documentTitle,
    documentDescription,
  ].filter((value): value is string => value.length > 0);
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
