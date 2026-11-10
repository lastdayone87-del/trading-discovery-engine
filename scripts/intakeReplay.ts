/**
 * Offline intake replay / evaluation.
 *
 * Reads a JSONL snapshot of intake candidates and prints the decisions of the
 * production intake gate. This is a validation tool, not a serving path: it
 * never writes to the database or calls a provider.
 *
 * Usage:
 *   npx tsx scripts/intakeReplay.ts /tmp/intake.jsonl
 *   INTAKE_REPLAY_FOCUS_ONLY=1 npx tsx scripts/intakeReplay.ts /tmp/intake.jsonl
 *
 * Expected row shape (extra fields are ignored):
 *   {
 *     "channelName": "...", "description": "...",
 *     "matchedType": "CHANNEL", "matchedTitle": "...", "matchedDescription": "...",
 *     "videoTitles": ["..."], "videoDescriptions": ["..."],
 *     "jobStatus": "PENDING", "tradingStatus": "UNCERTAIN",
 *     "countryStatus": "UNCERTAIN", "country": "Singapore"
 *   }
 */
import { readFileSync } from 'node:fs';
import { assessIntakeTradingFocus, hasCoveredNonLatinScript } from '../server/intakeTradingFocus';
import { assessChannelCountry } from '../server/countryInference';
import { INITIAL_EXCLUDED_COUNTRIES } from '../src/data/initial_countries';

type Row = {
  channelName?: string;
  description?: string;
  matchedType?: string;
  matchedTitle?: string;
  matchedDescription?: string;
  videoTitles?: string[] | string;
  videoDescriptions?: string[] | string;
  jobStatus?: string;
  tradingStatus?: string;
  countryStatus?: string;
  country?: string;
};

const FINANCE = /(?:\b(?:trading|trader|intraday|scalping|technical analysis|price action|order flow|market structure|volume profile|smart money|ict|smc|fx trading|futures trading|options trading|cfd trading|prop firm|forex|futures|options|0dte|cfd|stocks|equities|shares|nasdaq|s&p|dax|cac|ftse|aex|bel ?20|smi|omx|tsx|asx|crypto|bitcoin|ethereum|btc|eth|nq futures|es futures|investing|investor|portfolio|broker)\b|ट्रेडिंग|शेयर|निवेश|बाज़ार|क्रिप्टो|ટ્રેડિંગ|શેર|બજાર|રોકાણ|ట్రేడింగ్|స్టాక్|ಮಾರುಕಟ್ಟೆ|ട്രേഡിംഗ്|ഓഹരി|ਟ੍ਰੇਡਿੰਗ|ਸ਼ੇਅਰ)/iu;

function stringList(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string' || !value.trim()) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [trimmed];
    }
  }
  return [trimmed];
}

function text(row: Row): string {
  return [
    row.channelName,
    row.description,
    row.matchedTitle,
    row.matchedDescription,
    ...stringList(row.videoTitles),
    ...stringList(row.videoDescriptions),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' ');
}

function increment(map: Record<string, number>, key: string | undefined): void {
  map[key || 'MISSING'] = (map[key || 'MISSING'] || 0) + 1;
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npx tsx scripts/intakeReplay.ts <candidates.jsonl>');
  process.exit(2);
}

const focusOnly = process.env.INTAKE_REPLAY_FOCUS_ONLY === '1';
const rows: Row[] = [];
const invalidRows: Array<{ line: number; error: string }> = [];
const lines = readFileSync(inputPath, 'utf8').split('\n');
lines.forEach((line, index) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      invalidRows.push({ line: index + 1, error: 'Expected a JSON object' });
      return;
    }
    rows.push(parsed as Row);
  } catch (error) {
    invalidRows.push({ line: index + 1, error: error instanceof Error ? error.message : String(error) });
  }
});

const focus: Record<string, number> = {};
const focusProxyNegative: Record<string, number> = {};
const focusProxyPositive: Record<string, number> = {};
const nonLatinFocus: Record<string, number> = {};
const country: Record<string, number> = {};
const jobStatus: Record<string, number> = {};
const tradingStatus: Record<string, number> = {};
const countryStatus: Record<string, number> = {};
let proxyNegative = 0;
let proxyPositive = 0;
let nonLatinRows = 0;

for (const row of rows) {
  const fullText = text(row);
  const finance = FINANCE.test(fullText);
  const isProxyNegative = !finance;
  if (isProxyNegative) proxyNegative += 1;
  else proxyPositive += 1;

  const focusDecision = assessIntakeTradingFocus({
    channelName: row.channelName,
    description: row.description,
    matchedDocument: {
      type: (row.matchedType as 'VIDEO' | 'CHANNEL' | undefined) || 'UNKNOWN',
      title: row.matchedTitle,
      description: row.matchedDescription,
    },
    videoTitles: stringList(row.videoTitles),
    videoDescriptions: stringList(row.videoDescriptions),
  });
  increment(focus, focusDecision.decision);
  if (hasCoveredNonLatinScript(fullText)) {
    nonLatinRows += 1;
    increment(nonLatinFocus, focusDecision.decision);
  }
  if (isProxyNegative) increment(focusProxyNegative, focusDecision.decision);
  else increment(focusProxyPositive, focusDecision.decision);
  increment(jobStatus, row.jobStatus);
  increment(tradingStatus, row.tradingStatus);
  increment(countryStatus, row.countryStatus);

  if (!focusOnly) {
    // Country replay uses creator-authored bio only. Search-result titles are
    // retrieval-selected and must not be replayed as creator evidence.
    const countryDecision = assessChannelCountry({
      channelName: row.channelName || '',
      aboutBio: row.description || '',
      videoTitles: [],
      videoDescriptions: [],
      videoDescriptionsAuthoritative: false,
      discoveryCountry: row.country || undefined,
    }, INITIAL_EXCLUDED_COUNTRIES as never, []);
    increment(country, countryDecision.gateDisposition);
  }
}

console.log(JSON.stringify({
  rows: rows.length,
  invalidRows,
  proxyLabelNote: 'Proxy labels are evidence-presence heuristics, not human ground truth.',
  focus,
  focusProxyNegative,
  focusProxyPositive,
  nonLatinRows,
  nonLatinFocus,
  country,
  jobStatus,
  tradingStatus,
  countryStatus,
  proxyNegative,
  proxyPositive,
}, null, 2));
