/**
 * Offline intake replay / evaluation.
 *
 * Reads a JSONL snapshot of intake candidates and prints the decisions of the
 * production intake gate. This is a validation tool, not a serving path: it
 * never writes to the database or calls a provider.
 *
 * Usage:
 *   npx tsx scripts/intakeReplay.ts /tmp/intake.jsonl
 *
 * Expected row shape (extra fields are ignored):
 *   {
 *     "channelName": "...", "description": "...",
 *     "matchedTitle": "...", "matchedDescription": "...",
 *     "videoTitles": ["..."], "jobStatus": "PENDING",
 *     "tradingStatus": "UNCERTAIN", "countryStatus": "UNCERTAIN",
 *     "country": "India"
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
  jobStatus?: string;
  tradingStatus?: string;
  countryStatus?: string;
  country?: string;
};

const FINANCE = /(?:\b(?:trading|trader|intraday|scalping|technical analysis|price action|order flow|market structure|volume profile|smart money|ict|smc|fx trading|futures trading|options trading|cfd trading|prop firm|forex|futures|options|0dte|cfd|stocks|equities|shares|nasdaq|s&p|dax|cac|ftse|aex|bel ?20|smi|omx|tsx|asx|crypto|bitcoin|ethereum|btc|eth|nq futures|es futures|investing|investor|portfolio|broker)\b|ट्रेडिंग|शेयर|निवेश|बाज़ार|क्रिप्टो|ટ્રેડિંગ|શેર|બજાર|રોકાણ|ట్రేడింగ్|స్టాక్|ಮಾರುಕಟ್ಟೆ|ട്രേഡിംഗ്|ഓഹരി|ਟ੍ਰੇਡਿੰਗ|ਸ਼ੇਅਰ)/iu;

function text(row: Row): string {
  const videos = Array.isArray(row.videoTitles) ? row.videoTitles.join(' ') : row.videoTitles || '';
  return [row.channelName, row.description, row.matchedTitle, row.matchedDescription, videos]
    .filter(Boolean)
    .join(' ');
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] || 0) + 1;
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npx tsx scripts/intakeReplay.ts <candidates.jsonl>');
  process.exit(2);
}

const focusOnly = process.env.INTAKE_REPLAY_FOCUS_ONLY === '1';
const rows = readFileSync(inputPath, 'utf8')
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean)
  .flatMap(line => {
    try {
      return [JSON.parse(line) as Row];
    } catch {
      return [];
    }
  });

const focus: Record<string, number> = {};
const focusProxyNegative: Record<string, number> = {};
const focusProxyPositive: Record<string, number> = {};
const nonLatinFocus: Record<string, number> = {};
const country: Record<string, number> = {};
let proxyNegative = 0;
let proxyPositive = 0;
let investigated = 0;
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
    videoTitles: Array.isArray(row.videoTitles) ? row.videoTitles : undefined,
  });
  increment(focus, focusDecision.decision);
  if (hasCoveredNonLatinScript(fullText)) {
    nonLatinRows += 1;
    increment(nonLatinFocus, focusDecision.decision);
  }
  if (isProxyNegative) increment(focusProxyNegative, focusDecision.decision);
  else increment(focusProxyPositive, focusDecision.decision);

  if (!focusOnly) {
    const countryDecision = assessChannelCountry({
      channelName: row.channelName || '',
      aboutBio: row.description || '',
      videoTitles: Array.isArray(row.videoTitles) ? row.videoTitles : [],
      videoDescriptions: [],
      videoDescriptionsAuthoritative: false,
    }, INITIAL_EXCLUDED_COUNTRIES as never, []);
    increment(country, countryDecision.gateDisposition);
  }

  if (/BOOSTER UP|MISSION MPSC|JR Education Hub|Pyarelal Lamba/i.test(row.channelName || '')) investigated += 1;
}

console.log(JSON.stringify({
  rows: rows.length,
  proxyLabelNote: 'Proxy labels are evidence-presence heuristics, not human ground truth.',
  focus,
  focusProxyNegative,
  focusProxyPositive,
  nonLatinRows,
  nonLatinFocus,
  country,
  investigatedRows: investigated,
  proxyNegative,
  proxyPositive,
}, null, 2));
