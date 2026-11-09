/**
 * Native-discovery measurement harness.
 *
 * The engine's existing dashboards report quota yield and duplicate ratios, but
 * they do not answer the questions that decide whether native discovery is
 * working: precision, recall, country relevance, language match, unique
 * discovery yield and false-positive rate on a human-labelled sample.
 *
 * This module is deliberately pure and read-only. It consumes labels (CSV or
 * database export) and returns point estimates with Wilson 95% intervals so a
 * target is judged on the lower bound, not on a favourable point estimate.
 */

export interface NativeDiscoveryLabel {
  channelId: string;
  country: string;
  language: string;
  /** Human label: is this a genuine trading creator/community for the market? */
  tradingRelevant: boolean;
  /** Did the engine discover/persist this creator? */
  discovered: boolean;
  /** Human label for discovered creators; null when not evaluated. */
  discoveredCountryMatch?: boolean | null;
  /** Human label for discovered creators; null when not evaluated. */
  discoveredLanguageMatch?: boolean | null;
  /** Did the discovery meet the quality threshold? Null when not evaluated. */
  quality?: boolean | null;
  /** Did the discovery expose a community? Null when not evaluated. */
  community?: boolean | null;
  provider?: string;
}

export interface ProportionEstimate {
  successes: number;
  total: number;
  rate: number | null;
  lower95: number | null;
  upper95: number | null;
}

export interface NativeDiscoveryMetrics {
  sampleSize: number;
  relevantInSample: number;
  discovered: number;
  discoveredRelevant: number;
  precision: ProportionEstimate;
  recall: ProportionEstimate;
  countryRelevance: ProportionEstimate;
  languageMatch: ProportionEstimate;
  qualityYield: ProportionEstimate;
  communityYield: ProportionEstimate;
  falsePositiveRate: ProportionEstimate;
}

export interface ProviderYieldInput {
  provider: string;
  requests: number;
  newConfirmedCreators: number;
}

export interface ProviderYield extends ProviderYieldInput {
  newConfirmedPer100Requests: number;
}

export interface NativeDiscoveryReport {
  generatedAt: string;
  overall: NativeDiscoveryMetrics;
  byCountry: Record<string, NativeDiscoveryMetrics>;
  byLanguage: Record<string, NativeDiscoveryMetrics>;
  providerYield: ProviderYield[];
  evidence: {
    /** The investigation's minimum useful sample for a market-level claim. */
    recommendedLabelsPerMarket: number;
    marketsBelowRecommendedSample: string[];
    /**
     * True when the overall precision/recall lower bounds and every reported
     * country/language precision/recall lower bound meet the target.
     */
    meets90PercentLowerBound: boolean;
  };
}

export interface NativeDiscoveryCsvParseResult {
  labels: NativeDiscoveryLabel[];
  /** Rows dropped because a required boolean could not be parsed. */
  skippedRows: number;
}

const TARGET = 0.9;
const RECOMMENDED_LABELS_PER_MARKET = 300;

export function wilsonInterval(successes: number, total: number, z = 1.96): { lower: number; upper: number } {
  const n = Math.max(0, Math.trunc(total));
  const x = Math.max(0, Math.min(n, Math.trunc(successes)));
  if (n === 0) return { lower: 0, upper: 1 };
  const p = x / n;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    lower: Math.max(0, (centre - margin) / denominator),
    upper: Math.min(1, (centre + margin) / denominator),
  };
}

export function proportion(successes: number, total: number): ProportionEstimate {
  const n = Math.max(0, Math.trunc(total));
  const x = Math.max(0, Math.min(n, Math.trunc(successes)));
  if (n === 0) return { successes: 0, total: 0, rate: null, lower95: null, upper95: null };
  const interval = wilsonInterval(x, n);
  return { successes: x, total: n, rate: x / n, lower95: interval.lower, upper95: interval.upper };
}

function metricsFor(labels: NativeDiscoveryLabel[]): NativeDiscoveryMetrics {
  const discovered = labels.filter(label => label.discovered);
  const relevant = labels.filter(label => label.tradingRelevant);
  const discoveredRelevant = discovered.filter(label => label.tradingRelevant);
  const countryEvaluated = discovered.filter(label => label.discoveredCountryMatch !== undefined && label.discoveredCountryMatch !== null);
  const languageEvaluated = discovered.filter(label => label.discoveredLanguageMatch !== undefined && label.discoveredLanguageMatch !== null);
  // Optional quality/community labels are only evaluated when present; an
  // absent column must not be reported as a zero-yield outcome.
  const qualityEvaluated = discovered.filter(label => label.quality !== undefined && label.quality !== null);
  const communityEvaluated = discovered.filter(label => label.community !== undefined && label.community !== null);
  const negatives = labels.filter(label => !label.tradingRelevant);
  return {
    sampleSize: labels.length,
    relevantInSample: relevant.length,
    discovered: discovered.length,
    discoveredRelevant: discoveredRelevant.length,
    precision: proportion(discoveredRelevant.length, discovered.length),
    recall: proportion(discoveredRelevant.length, relevant.length),
    countryRelevance: proportion(countryEvaluated.filter(label => label.discoveredCountryMatch === true).length, countryEvaluated.length),
    languageMatch: proportion(languageEvaluated.filter(label => label.discoveredLanguageMatch === true).length, languageEvaluated.length),
    qualityYield: proportion(qualityEvaluated.filter(label => label.quality === true).length, qualityEvaluated.length),
    communityYield: proportion(communityEvaluated.filter(label => label.community === true).length, communityEvaluated.length),
    // FPR is the share of labelled non-relevant creators that were
    // incorrectly discovered, not 1 - precision among discoveries.
    falsePositiveRate: proportion(negatives.filter(label => label.discovered).length, negatives.length),
  };
}

function groupBy(labels: NativeDiscoveryLabel[], key: (label: NativeDiscoveryLabel) => string): Record<string, NativeDiscoveryMetrics> {
  const groups = new Map<string, NativeDiscoveryLabel[]>();
  for (const label of labels) {
    const value = key(label) || 'unknown';
    const list = groups.get(value) || [];
    list.push(label);
    groups.set(value, list);
  }
  return Object.fromEntries([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, rows]) => [name, metricsFor(rows)]));
}

/**
 * New confirmed creators per 100 provider requests. One request can confirm
 * several creators, so a binomial/Wilson proportion interval (bounded at 1)
 * would contradict the reported rate. The count rate is reported without that
 * misleading interval.
 */
export function evaluateProviderYield(inputs: ProviderYieldInput[]): ProviderYield[] {
  return inputs.map(input => {
    const requests = Math.max(0, Math.trunc(input.requests));
    const confirmed = Math.max(0, Math.trunc(input.newConfirmedCreators));
    return {
      ...input,
      requests,
      newConfirmedCreators: confirmed,
      newConfirmedPer100Requests: requests > 0 ? (confirmed / requests) * 100 : 0,
    };
  });
}

function validateLabelIdentity(labels: NativeDiscoveryLabel[]): void {
  const seen = new Map<string, NativeDiscoveryLabel>();
  for (const label of labels) {
    const channelId = String(label.channelId || '').trim();
    if (!channelId) throw new Error('NATIVE_DISCOVERY_EMPTY_CHANNEL');
    const prior = seen.get(channelId);
    if (prior) {
      const conflicting = prior.country !== label.country
        || prior.language !== label.language
        || prior.tradingRelevant !== label.tradingRelevant
        || prior.discovered !== label.discovered;
      throw new Error(`NATIVE_DISCOVERY_${conflicting ? 'CONFLICTING' : 'DUPLICATE'}_CHANNEL:${channelId}`);
    }
    seen.set(channelId, label);
  }
}

export function evaluateNativeDiscovery(args: {
  labels: NativeDiscoveryLabel[];
  providerYield?: ProviderYieldInput[];
  generatedAt?: string;
  recommendedLabelsPerMarket?: number;
}): NativeDiscoveryReport {
  validateLabelIdentity(args.labels);
  const recommended = Math.max(1, args.recommendedLabelsPerMarket ?? RECOMMENDED_LABELS_PER_MARKET);
  const overall = metricsFor(args.labels);
  const byCountry = groupBy(args.labels, label => label.country);
  const byLanguage = groupBy(args.labels, label => label.language);
  const marketsBelowRecommendedSample = Object.entries(byCountry)
    .filter(([, metrics]) => metrics.sampleSize < recommended)
    .map(([country]) => country);
  // A pooled pass cannot hide a failing or under-sampled market: every
  // reported country and language slice must have measurable precision and
  // recall lower bounds at or above the target.
  const meetsTarget = (metrics: NativeDiscoveryMetrics) =>
    metrics.precision.lower95 !== null
    && metrics.precision.lower95 >= TARGET
    && metrics.recall.lower95 !== null
    && metrics.recall.lower95 >= TARGET;
  const meets90PercentLowerBound = meetsTarget(overall)
    && Object.values(byCountry).every(meetsTarget)
    && Object.values(byLanguage).every(meetsTarget);
  return {
    generatedAt: args.generatedAt || new Date().toISOString(),
    overall,
    byCountry,
    byLanguage,
    providerYield: evaluateProviderYield(args.providerYield || []),
    evidence: {
      recommendedLabelsPerMarket: recommended,
      marketsBelowRecommendedSample,
      meets90PercentLowerBound,
    },
  };
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n']);

function parseBoolean(value: string | undefined): boolean | null {
  const normalized = String(value || '').trim().toLocaleLowerCase('en');
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return null;
}

/**
 * Parse a labelled creator CSV. The header is required; unknown columns are
 * ignored. Quoted fields are rejected because this schema is comma-only and a
 * quoted comma would shift every later column. Rows whose required booleans are
 * malformed are skipped and counted instead of silently disappearing.
 */
export function parseNativeDiscoveryCsv(csv: string): NativeDiscoveryCsvParseResult {
  const lines = String(csv || '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!lines.length) return { labels: [], skippedRows: 0 };
  if (lines[0].includes('"')) throw new Error('NATIVE_DISCOVERY_CSV_QUOTED_ROW:1');
  const header = lines[0].split(',').map(value => value.trim().toLocaleLowerCase('en'));
  const index = (name: string) => header.indexOf(name);
  const required = ['channel_id', 'country', 'language', 'trading_relevant', 'discovered'];
  for (const name of required) if (index(name) < 0) throw new Error(`NATIVE_DISCOVERY_CSV_MISSING_COLUMN:${name}`);
  const rows: NativeDiscoveryLabel[] = [];
  const channelIds = new Set<string>();
  let skippedRows = 0;
  for (const [offset, line] of lines.slice(1).entries()) {
    const rowNumber = offset + 2;
    if (line.includes('"')) throw new Error(`NATIVE_DISCOVERY_CSV_QUOTED_ROW:${rowNumber}`);
    const cells = line.split(',').map(value => value.trim());
    if (cells.length !== header.length) throw new Error(`NATIVE_DISCOVERY_CSV_COLUMN_COUNT:${rowNumber}`);
    const get = (name: string) => index(name) >= 0 ? cells[index(name)] : undefined;
    const tradingRelevant = parseBoolean(get('trading_relevant'));
    const discovered = parseBoolean(get('discovered'));
    if (tradingRelevant === null || discovered === null) {
      skippedRows += 1;
      continue;
    }
    const channelId = String(get('channel_id') || '').trim();
    if (!channelId) throw new Error(`NATIVE_DISCOVERY_CSV_EMPTY_CHANNEL:${rowNumber}`);
    if (channelIds.has(channelId)) throw new Error(`NATIVE_DISCOVERY_CSV_DUPLICATE_CHANNEL:${rowNumber}:${channelId}`);
    channelIds.add(channelId);
    rows.push({
      channelId,
      country: get('country') || 'unknown',
      language: get('language') || 'und',
      tradingRelevant,
      discovered,
      discoveredCountryMatch: parseBoolean(get('country_match')),
      discoveredLanguageMatch: parseBoolean(get('language_match')),
      quality: parseBoolean(get('quality')),
      community: parseBoolean(get('community')),
      provider: get('provider') || undefined,
    });
  }
  return { labels: rows, skippedRows };
}
