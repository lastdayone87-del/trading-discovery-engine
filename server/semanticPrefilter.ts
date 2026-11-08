import type { RawChannelInput } from './evidenceEngine/types';

/**
 * Phase 4 deterministic semantic prefilter.
 *
 * Purpose: avoid spending semantic-provider quota on creator surfaces that
 * are obviously unrelated to trading. This is a cheap routing firewall, not
 * evidence: a withheld channel still runs the deterministic providers and the
 * normal decision policy. Only the *semantic* call is skipped, and only in
 * `enforce` mode.
 *
 * Rollout is shadow-first:
 *   - `off`     — never evaluate.
 *   - `shadow`  — evaluate and count, always classify (default).
 *   - `enforce` — a WITHHOLD decision makes semantic providers NOT_APPLICABLE.
 *
 * The policy is deliberately precision-first. Any finance/trading signal
 * suppresses withholding, so a dormant or low-audience trading educator is
 * still classified. The finance veto scans every model-facing evidence field
 * at full length; the 4,000-character projection limit only applies to the
 * unrelated-domain heuristic, never to the veto.
 */
export const SEMANTIC_PREFILTER_POLICY_VERSION = 'semantic-prefilter-v2';

export type SemanticPrefilterDisposition = 'CLASSIFY' | 'WITHHOLD_SEMANTIC';
export type SemanticPrefilterMode = 'off' | 'shadow' | 'enforce';

export interface SemanticPrefilterInput {
  channelName?: string;
  description?: string;
  country?: string;
  detectedLanguages?: string[];
  videoTitles?: string[];
  videoDescriptions?: string[];
  playlistNames?: string[];
  playlistDescriptions?: string[];
  externalLinks?: string[];
  externalLinkLabels?: string[];
  transcriptExcerpts?: string[];
  visualEvidence?: string[];
  evidenceCorpus?: string[];
  pinnedComment?: string;
  subscriberCount?: number;
  videoCount?: number;
  latestUploadAt?: string;
  uploadsLast365Days?: number;
}

export interface SemanticPrefilterDecision {
  disposition: SemanticPrefilterDisposition;
  reasonCodes: string[];
  matchedSignals: string[];
  policyVersion: string;
}

/**
 * Finance/trading vocabulary across the production market languages. A single
 * match vetoes withholding. This list intentionally errs broad: one extra
 * semantic call is cheaper than losing a real trading creator.
 *
 * Boundaries are Unicode-aware lookarounds rather than `\b`, because `\b`
 * treats accented letters (for example `marché`) as non-word characters and
 * would silently miss them.
 */
const FINANCE_SIGNALS: Array<[string, RegExp]> = [
  ['TRADING_LITERAL', /(?<![\p{L}\p{N}])(trading|trader|day\s*trading|swing\s*trading|scalping|forex|fx|futures?|options?|cfd|stocks?|equities|shares?|investing|investor|portfolio|market\s*analysis|technical\s*analysis|price\s*action|order\s*flow|crypto|bitcoin|ethereum|blockchain|prop\s*firm|broker)(?![\p{L}\p{N}])/iu],
  ['SPANISH_PORTUGUESE_FINANCE', /(?<![\p{L}\p{N}])(bolsa|acciones|mercado|inversi[oó]n|inversiones|inversor|divisas|trading|criptomonedas|a[cç][oõ]es|investimento|mercado\s*financeiro)(?![\p{L}\p{N}])/iu],
  ['FRENCH_FINANCE', /(?<![\p{L}\p{N}])(bourse|march[eé]|investissement|investisseur|actions?|devises|trading|analyse\s*technique|crypto)(?![\p{L}\p{N}])/iu],
  ['GERMAN_DUTCH_FINANCE', /(?<![\p{L}\p{N}])(b[oö]rse|aktien?|finanzen|investment|anleger|handel|trading|beleggen|aandelen|beurs|analyse\s*technique)(?![\p{L}\p{N}])/iu],
  ['ITALIAN_FINANCE', /(?<![\p{L}\p{N}])(borsa|azioni|mercato|investimento|investitore|valute|trading|criptovalute)(?![\p{L}\p{N}])/iu],
  ['NORDIC_POLISH_FINANCE', /(?<![\p{L}\p{N}])(b[oø]rs|aktier|investering|marknad|inwestycje|giełda|akcje|rynek|trading)(?![\p{L}\p{N}])/iu],
  ['TURKISH_FINANCE', /(?<![\p{L}\p{N}])(borsa|hisse|hisseler|yatırım|yatirim|döviz|doviz|piyasa|kripto|forex|trading|teknik\s*analiz)(?![\p{L}\p{N}])/iu],
  ['INDONESIAN_MALAY_FINANCE', /(?<![\p{L}\p{N}])(saham|investasi|investor|pasar|kripto|forex|trading|analisis)(?![\p{L}\p{N}])/iu],
  ['THAI_FINANCE', /(หุ้น|การลงทุน|เทรด|ตลาด|คริปโต|ฟอเร็กซ์)/u],
  ['VIETNAMESE_FINANCE', /(?<![\p{L}\p{N}])(chứng\s*khoán|chung\s*khoan|đầu\s*tư|dau\s*tu|giao\s*dịch|giao\s*dich|cổ\s*phiếu|co\s*phieu|tiền\s*điện\s*tử|tien\s*dien\s*tu|forex|trading)(?![\p{L}\p{N}])/iu],
  ['JAPANESE_FINANCE', /(トレード|投資|株式|相場|為替|先物|仮想通貨|テクニカル)/u],
  ['KOREAN_FINANCE', /(주식|투자|트레이딩|선물|외환|코인|차트)/u],
  ['CHINESE_FINANCE', /(股票|投资|交易|期货|外汇|加密货币|技术分析)/u],
  ['ARABIC_FINANCE', /(تداول|أسهم|استثمار|عملات|فوركس|تحليل\s*فني)/u],
  ['CYRILLIC_FINANCE', /(трейдинг|акции|инвестиции|форекс|биржа|криптовалюта)/u],
  ['HINDI_FINANCE', /(ट्रेडिंग|शेयर|निवेश|बाज़ार|क्रिप्टो)/u],
  ['FINANCE_LINK', /(?<![\p{L}\p{N}])(tradingview\.com|forexfactory\.com|myfxbook\.com|broker|propfirm|investing\.com)(?![\p{L}\p{N}])/iu],
];

/** Strong unrelated-domain cues. Only a match with no finance signal can withhold. */
const UNRELATED_DOMAIN_SIGNALS: Array<[string, RegExp]> = [
  ['GAMING', /(?<![\p{L}\p{N}])(gameplay|walkthrough|playthrough|minecraft|roblox|fortnite|valorant|league\s*of\s*legends|gta\s*v|gta\s*5|call\s*of\s*duty|pokemon|pokémon|genshin|esports?|speedrun)(?![\p{L}\p{N}])/iu],
  ['COOKING', /(?<![\p{L}\p{N}])(recipe|recipes|cooking|kitchen|bake|baking|chef|cuisine|mukbang|street\s*food)(?![\p{L}\p{N}])/iu],
  ['MUSIC', /(?<![\p{L}\p{N}])(official\s*music\s*video|music\s*video|official\s*audio|lyrics?|lyric\s*video|album|singer|songwriter|record\s*label|clip\s*officiel|chanson)(?![\p{L}\p{N}])/iu],
  ['BEAUTY_ENTERTAINMENT', /(?<![\p{L}\p{N}])(celebrity\s*gossip|makeup\s*tutorial|beauty\s*vlog|toy\s*review|prank|unboxing)(?![\p{L}\p{N}])/iu],
  ['SPORTS', /(?<![\p{L}\p{N}])(highlights|match\s*replay|full\s*game|nba|nfl|premier\s*league|world\s*cup|football\s*skills)(?![\p{L}\p{N}])/iu],
  ['LIFESTYLE_TRAVEL', /(?<![\p{L}\p{N}])(travel\s*vlog|daily\s*vlog|food\s*vlog|fitness\s*routine|workout\s*plan)(?![\p{L}\p{N}])/iu],
];

const FINANCE_LANGUAGE_CODES = new Set([
  'en', 'es', 'pt', 'fr', 'de', 'nl', 'it', 'pl', 'sv', 'no', 'nb', 'da', 'fi',
  'ja', 'ko', 'zh', 'cmn', 'ar', 'ru', 'hi', 'tr', 'id', 'ms', 'th', 'vi',
]);

const warnedUnknownPrefilterModes = new Set<string>();

/** Test seam: allows a warning assertion to run more than once per process. */
export function resetSemanticPrefilterWarningsForTests(): void {
  warnedUnknownPrefilterModes.clear();
}

export function semanticPrefilterMode(env: NodeJS.ProcessEnv = process.env): SemanticPrefilterMode {
  const value = String(env.SEMANTIC_PREFILTER_MODE || 'shadow').trim().toLowerCase();
  if (value === 'off' || value === 'enforce' || value === 'shadow') return value;
  // A mistyped rollback value must be visible instead of silently running
  // shadow. Warn once per distinct token so a repeated availability() probe
  // does not flood the log.
  if (!warnedUnknownPrefilterModes.has(value)) {
    warnedUnknownPrefilterModes.add(value);
    console.warn(`[Semantic Prefilter] Unrecognized SEMANTIC_PREFILTER_MODE="${value}"; falling back to "shadow". Supported values are "off", "shadow", "enforce".`);
  }
  return 'shadow';
}

function numeric(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function semanticPrefilterInputFromRaw(input: RawChannelInput): SemanticPrefilterInput {
  const videos = input.videos?.length
    ? input.videos
    : (input.video_titles || []).map((title, index) => ({ title, description: input.video_descriptions?.[index] }));
  return {
    channelName: input.channel_name,
    description: input.description,
    country: input.country,
    detectedLanguages: (input.detected_languages || []).map(language => language.language),
    videoTitles: videos.map(video => video.title),
    videoDescriptions: videos.map(video => video.description || ''),
    playlistNames: input.playlists?.map(playlist => playlist.name) || [],
    playlistDescriptions: input.playlists?.map(playlist => playlist.description || '') || [],
    externalLinks: [
      ...(input.external_links || []),
      ...(input.external_link_details || []).flatMap(link => [link.url, link.domain || '']),
    ],
    externalLinkLabels: (input.external_link_details || []).map(link => link.label || ''),
    transcriptExcerpts: (input.transcript_excerpts || []).map(excerpt => excerpt.text),
    visualEvidence: (input.visual_evidence || []).map(visual => visual.description),
    evidenceCorpus: (input.evidence_corpus || []).map(document => document.text),
    pinnedComment: input.pinned_comment,
    subscriberCount: numeric(input.subscriber_count),
    videoCount: numeric(input.video_count),
    latestUploadAt: input.activity_metadata?.latest_upload_at,
    uploadsLast365Days: input.activity_metadata?.uploads_last_365_days,
  };
}

function clean(value: unknown, limit = 4000): string {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function staleDays(latestUploadAt: string | undefined, nowMs: number): number | undefined {
  if (!latestUploadAt) return undefined;
  const parsed = Date.parse(latestUploadAt);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, (nowMs - parsed) / 86_400_000);
}

function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * One evaluation per channel object/provider pair. The evidence engine probes
 * `availability()` before execution and may probe again inside the semantic
 * chain; both calls describe the same evaluation and must not inflate the
 * shadow/false-negative counters.
 */
let evaluationCache = new WeakMap<RawChannelInput, Map<string, { mode: SemanticPrefilterMode; decision: SemanticPrefilterDecision; skip: boolean }>>();

export function evaluateSemanticPrefilter(
  input: SemanticPrefilterInput,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): SemanticPrefilterDecision {
  // Finance evidence is collected from every model-facing field before any
  // length cap. A shared 4,000-character projection must never discard the
  // veto that protects a trading channel from enforcement.
  const financeTexts = [
    input.channelName,
    input.description,
    input.pinnedComment,
    ...(input.videoTitles || []),
    ...(input.videoDescriptions || []),
    ...(input.playlistNames || []),
    ...(input.playlistDescriptions || []),
    ...(input.externalLinks || []),
    ...(input.externalLinkLabels || []),
    ...(input.transcriptExcerpts || []),
    ...(input.visualEvidence || []),
    ...(input.evidenceCorpus || []),
  ].map(value => String(value || '').normalize('NFKC')).filter(Boolean);

  const creatorText = clean([
    input.channelName,
    input.description,
    input.pinnedComment,
    ...(input.videoTitles || []).slice(0, 24),
    ...(input.videoDescriptions || []).slice(0, 12),
    ...(input.playlistNames || []).slice(0, 12),
    ...(input.playlistDescriptions || []).slice(0, 12),
    ...(input.externalLinks || []),
  ].filter(Boolean).join(' | '));

  const financeSignals = FINANCE_SIGNALS
    .filter(([, pattern]) => financeTexts.some(text => pattern.test(text)))
    .map(([name]) => name);
  const unrelatedSignals = UNRELATED_DOMAIN_SIGNALS
    .filter(([, pattern]) => pattern.test(creatorText))
    .map(([name]) => name);

  // A finance signal always wins. The only exception is when the channel text
  // is entirely empty, which the provider-level creator-context gate already
  // handles as NOT_APPLICABLE.
  if (financeSignals.length > 0 || creatorText.length === 0) {
    return {
      disposition: 'CLASSIFY',
      reasonCodes: [
        creatorText.length === 0 ? 'NO_CREATOR_CONTEXT' : 'FINANCE_SIGNAL_PRESENT',
        'SEMANTIC_CLASSIFICATION_RETAINED',
      ],
      matchedSignals: financeSignals,
      policyVersion: SEMANTIC_PREFILTER_POLICY_VERSION,
    };
  }

  // A language the cheap lexicon does not model needs semantics regardless of
  // an English unrelated cue in the title. Any unmodeled language in a mixed
  // hint list vetoes withholding: the finance content may live in that
  // language. Check this before every withhold rule so a non-lexicon finance
  // creator is never filtered out.
  const unmodeledLanguage = (input.detectedLanguages || []).length > 0 &&
    (input.detectedLanguages || []).some(code => !FINANCE_LANGUAGE_CODES.has(String(code || '').toLowerCase().split(/[-_]/)[0]));
  if (unmodeledLanguage) {
    return {
      disposition: 'CLASSIFY',
      reasonCodes: ['UNMODELED_LANGUAGE_NEEDS_SEMANTICS', 'SEMANTIC_CLASSIFICATION_RETAINED'],
      matchedSignals: ['LANGUAGE_OUTSIDE_CHEAP_LEXICON'],
      policyVersion: SEMANTIC_PREFILTER_POLICY_VERSION,
    };
  }

  if (unrelatedSignals.length > 0) {
    return {
      disposition: 'WITHHOLD_SEMANTIC',
      reasonCodes: [
        'EXPLICIT_UNRELATED_DOMAIN_DETECTED',
        'NO_FINANCE_SIGNAL',
        'DO_NOT_SPEND_SEMANTIC_QUOTA',
      ],
      matchedSignals: unrelatedSignals,
      policyVersion: SEMANTIC_PREFILTER_POLICY_VERSION,
    };
  }

  const daysSinceUpload = staleDays(input.latestUploadAt, nowMs);
  const noRecentUploads = input.uploadsLast365Days !== undefined && input.uploadsLast365Days <= 0;
  const configuredStaleDays = envNumber(env, 'SEMANTIC_PREFILTER_STALE_DAYS', 730);
  // 0 disables the staleness rule, matching sibling triage age knobs.
  const staleThresholdDays = configuredStaleDays > 0 ? configuredStaleDays : Number.POSITIVE_INFINITY;
  const lowAudienceThreshold = envNumber(env, 'SEMANTIC_PREFILTER_MIN_SUBSCRIBERS', 50);
  const lowAudience = input.subscriberCount !== undefined &&
    Number.isFinite(input.subscriberCount) &&
    input.subscriberCount < lowAudienceThreshold &&
    (input.videoCount === undefined || input.videoCount <= 2) &&
    clean(input.description).length < 40 &&
    (input.externalLinks || []).length === 0;

  if (daysSinceUpload !== undefined && daysSinceUpload > staleThresholdDays && noRecentUploads) {
    return {
      disposition: 'WITHHOLD_SEMANTIC',
      reasonCodes: [
        'STALE_AND_INACTIVE_CHANNEL',
        'NO_FINANCE_SIGNAL',
        'DO_NOT_SPEND_SEMANTIC_QUOTA',
      ],
      matchedSignals: [`STALE_DAYS_${Math.floor(daysSinceUpload || 0)}`],
      policyVersion: SEMANTIC_PREFILTER_POLICY_VERSION,
    };
  }

  if (lowAudience) {
    return {
      disposition: 'WITHHOLD_SEMANTIC',
      reasonCodes: [
        'LOW_AUDIENCE_THIN_SURFACE',
        'NO_FINANCE_SIGNAL',
        'DO_NOT_SPEND_SEMANTIC_QUOTA',
      ],
      matchedSignals: [`SUBSCRIBERS_${input.subscriberCount}`],
      policyVersion: SEMANTIC_PREFILTER_POLICY_VERSION,
    };
  }

  return {
    disposition: 'CLASSIFY',
    reasonCodes: ['NO_CONFIDENT_PREFILTER_SKIP', 'SEMANTIC_CLASSIFICATION_RETAINED'],
    matchedSignals: [],
    policyVersion: SEMANTIC_PREFILTER_POLICY_VERSION,
  };
}

export interface SemanticPrefilterMetrics {
  mode: SemanticPrefilterMode;
  evaluations: number;
  withheld: number;
  enforcedWithholds: number;
  /**
   * Shadow comparisons: a channel the prefilter would withhold still reached
   * the semantic provider. This is how the enforce gate gathers real-traffic
   * false-negative evidence before withholding anything.
   */
  shadowComparisons: number;
  /** Withheld by policy but the semantic model returned a positive label. */
  shadowFalseNegatives: number;
  /** Bounded, non-secret samples for operator review. */
  recentFalseNegatives: SemanticPrefilterFalseNegativeSample[];
  reasonCounts: Record<string, number>;
  providerCounts: Record<string, number>;
}

export interface SemanticPrefilterFalseNegativeSample {
  provider: string;
  channelId?: string;
  channelName: string;
  semanticLabel: string;
  reasonCodes: string[];
  matchedSignals: string[];
  observedAt: string;
}

const FALSE_NEGATIVE_SAMPLE_LIMIT = 20;

const SEMANTIC_POSITIVE_LABELS = new Set(['ACTIVE_TRADING', 'INVESTING_EDUCATION']);

let metrics: SemanticPrefilterMetrics = {
  mode: semanticPrefilterMode(),
  evaluations: 0,
  withheld: 0,
  enforcedWithholds: 0,
  shadowComparisons: 0,
  shadowFalseNegatives: 0,
  recentFalseNegatives: [],
  reasonCounts: {},
  providerCounts: {},
};

function recordPrefilter(decision: SemanticPrefilterDecision, provider: string, mode: SemanticPrefilterMode): void {
  metrics.mode = mode;
  metrics.evaluations += 1;
  metrics.providerCounts[provider] = (metrics.providerCounts[provider] || 0) + 1;
  if (decision.disposition === 'WITHHOLD_SEMANTIC') {
    metrics.withheld += 1;
    if (mode === 'enforce') metrics.enforcedWithholds += 1;
    for (const reason of decision.reasonCodes) {
      metrics.reasonCounts[reason] = (metrics.reasonCounts[reason] || 0) + 1;
    }
  }
}

function decisionForPrefilter(
  input: RawChannelInput,
  provider: string,
  env: NodeJS.ProcessEnv,
  record = true,
): { skip: boolean; decision?: SemanticPrefilterDecision } {
  const mode = semanticPrefilterMode(env);
  if (mode === 'off') return { skip: false };
  const key = `${provider}|${mode}`;
  let byProvider = evaluationCache.get(input);
  const cached = byProvider?.get(key);
  if (cached) return { skip: cached.skip, decision: cached.decision };
  const decision = evaluateSemanticPrefilter(semanticPrefilterInputFromRaw(input), Date.now(), env);
  const result = { skip: mode === 'enforce' && decision.disposition === 'WITHHOLD_SEMANTIC', decision };
  if (!byProvider) {
    byProvider = new Map();
    evaluationCache.set(input, byProvider);
  }
  byProvider.set(key, { mode, ...result });
  if (record) recordPrefilter(decision, provider, mode);
  return result;
}

/**
 * Evaluate and, in enforce mode, tell the provider to become NOT_APPLICABLE.
 * Shadow mode is observability-only: it always returns skip=false.
 */
export function applySemanticPrefilter(
  input: RawChannelInput,
  provider: string,
  env: NodeJS.ProcessEnv = process.env
): { skip: boolean; decision?: SemanticPrefilterDecision } {
  return decisionForPrefilter(input, provider, env);
}

/**
 * Shadow validation: compare a completed semantic result with what the
 * prefilter would have done. In `shadow` mode this produces the real-traffic
 * false-negative evidence required before switching to `enforce`. In `enforce`
 * mode withheld channels never reach this call, so it records nothing.
 *
 * This is observability only: it never changes the classification.
 */
export function recordSemanticPrefilterOutcome(
  input: RawChannelInput,
  provider: string,
  semanticLabel: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (semanticPrefilterMode(env) !== 'shadow') return;
  const decision = decisionForPrefilter(input, provider, env, false).decision
    || evaluateSemanticPrefilter(semanticPrefilterInputFromRaw(input), Date.now(), env);
  if (decision.disposition !== 'WITHHOLD_SEMANTIC') return;
  metrics.shadowComparisons += 1;
  if (!SEMANTIC_POSITIVE_LABELS.has(semanticLabel)) return;
  metrics.shadowFalseNegatives += 1;
  metrics.recentFalseNegatives.push({
    provider,
    ...(input.channel_id ? { channelId: input.channel_id } : {}),
    channelName: String(input.channel_name || '').slice(0, 160),
    semanticLabel,
    reasonCodes: [...decision.reasonCodes],
    matchedSignals: [...decision.matchedSignals],
    observedAt: new Date().toISOString(),
  });
  if (metrics.recentFalseNegatives.length > FALSE_NEGATIVE_SAMPLE_LIMIT) {
    metrics.recentFalseNegatives.splice(0, metrics.recentFalseNegatives.length - FALSE_NEGATIVE_SAMPLE_LIMIT);
  }
}

export function semanticPrefilterSnapshot(): SemanticPrefilterMetrics {
  return {
    ...metrics,
    recentFalseNegatives: metrics.recentFalseNegatives.map(sample => ({ ...sample })),
    reasonCounts: { ...metrics.reasonCounts },
    providerCounts: { ...metrics.providerCounts },
  };
}

/** Test seam. */
export function resetSemanticPrefilterMetricsForTests(env: NodeJS.ProcessEnv = process.env): void {
  evaluationCache = new WeakMap();
  metrics = {
    mode: semanticPrefilterMode(env),
    evaluations: 0,
    withheld: 0,
    enforcedWithholds: 0,
    shadowComparisons: 0,
    shadowFalseNegatives: 0,
    recentFalseNegatives: [],
    reasonCounts: {},
    providerCounts: {},
  };
}
