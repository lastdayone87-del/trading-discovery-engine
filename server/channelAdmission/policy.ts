import type {
  AdmissionEvidence,
  AdmissionPolicyResult,
  SemanticCitation,
  SemanticJudgment,
} from './types';

export const ADMISSION_POLICY_VERSION = 'semantic-admission-v1';

export const DEFAULT_REJECT_TRADING_FOCUS = 25;
export const DEFAULT_AMBIGUOUS_RATE_CAP = 0.35;

/**
 * High-specificity trading anchors. These are supporting features for the
 * query guard and for citation validation. They never decide channel
 * admission on their own.
 */
const TRADING_ANCHOR_PATTERNS: RegExp[] = [
  /\b(?:technical\s*analysis|price\s*action|order\s*flow|market\s*structure|volume\s*profile|risk\s*management|trade\s*setup|trade\s*journal|trade\s*analysis|trading\s*analysis|market\s*analysis|back\s*test|backtest|live\s*trad(?:e|ing)|day\s*trad(?:e|ing)|swing\s*trad(?:e|ing)|scalp(?:ing)?|prop\s*firm|funded\s*trader|trading\s*(?:strategy|education|signals?|course|system)|stock\s*(?:market|trading)|share\s*market|equity\s*market|forex(?:\s*(?:trading|market))?|futures?\s*(?:trading|market)|options?\s*(?:trading|market)|crypto\s*trading)\b/iu,
  /\b(?:eurusd|gbpusd|usdjpy|audusd|usdcad|usdchf|nzdusd|xauusd|xagusd|nifty|bank\s*nifty|sensex|dax|cac\s*40|ftse\s*100|nikkei|omx(?:c25|s30)?|aex|bel\s*20|smi|tsx|asx(?:\s*200)?|nasdaq|s&p\s*500|sp500|bitcoin|btc|ethereum|eth)\b/iu,
  /\b(?:gold|silver|crude|natural\s*gas|copper)\s+(?:analysis|forecast|outlook|trading|market|price)\b/iu,
  /\b(?:technische\s*analyse|analyse\s*(?:technique|boursi[eè]re)|analisi\s*tecnica|an[aá]lisis\s*t[eé]cnico|teknik\s*analiz|b[oö]rsenanalyse|beursanalyse)\b/iu,
  /(?:تداول|تحليل\s*فني|أسهم|الأسهم|بورصة|البورصة|فوركس|عملات\s*رقمية)/u,
  /(?:トレード|デイトレード|先物取引|テクニカル分析|板読み|オーダーフロー)/u,
  /(?:ट्रेडिंग|शेयर\s*बाजार|शेयर\s*मार्केट|निफ्टी|सेंसेक्स|स्टॉक\s*मार्केट|तकनीकी\s*विश्लेषण|प्राइस\s*एक्शन)/u,
  /(?:ટ્રેડિંગ|શેર\s*બજાર|નિફ્ટી|સેન્સેક્સ|સ્ટોક\s*માર્કેટ|ટેકનિકલ\s*વિશ્લેષણ)/u,
  /(?:தங்கம்|பங்கு|வர்த்தகம்|பகுப்பாய்வு|சந்தை|விலை\s*நிலை)/u,
  /(?:股票|期货|外汇|加密货币|技术分析)/u,
  /(?:주식|트레이딩|선물|외환)/u,
  /(?:трейдинг|акции|форекс|биржа|криптовалюта)/u,
  /(?:teknik\s*analiz|borsa|hisse|döviz|kripto)/iu,
];

const GAMBLING_PATTERNS: RegExp[] = [
  /\b(?:casino|roulette|blackjack|poker|sports?\s*betting|football\s*betting|betting\s*system|betting\s*strategy|martingale|anti-?martingale|d'?alembert|binary\s*options?|bookmaker|gambling|bet\s*champions|online\s*betting)\b/iu,
  /(?:कैसीनो|रूलेट|सट्टा|जुआ|लॉटरी)/u,
  /(?:カジノ|ルーレット|ギャンブル|競馬|パチンコ)/u,
  /(?:كازينو|روليت|مراهنات|مقامرة)/u,
];


export function normalizeEvidenceText(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en');
}

export function hasTradingAnchor(text: string): boolean {
  return TRADING_ANCHOR_PATTERNS.some(pattern => pattern.test(String(text || '')));
}

export function hasGamblingTerm(text: string): boolean {
  return GAMBLING_PATTERNS.some(pattern => pattern.test(String(text || '')));
}

/**
 * Query admission guard. An extracted query may enter the pool only when it
 * has a concrete trading anchor. Gambling/betting phrases are blocked unless a
 * concrete trading anchor is also present. A gambling source video can never
 * become a trading query.
 */
export function assessExtractedQueryAdmission(input: {
  candidateText: string;
  sourceTitle?: string | null;
  sourceTitles?: Array<string | null | undefined>;
  sourceKind?: string | null;
}): { eligible: boolean; reasonCodes: string[] } {
  const candidate = String(input.candidateText || '').trim();
  const sourceTexts = [input.sourceTitle, ...(input.sourceTitles || [])]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const source = sourceTexts.join(' ');
  const reasonCodes: string[] = [];
  if (!candidate) return { eligible: false, reasonCodes: ['QUERY_EMPTY'] };

  const candidateGambling = hasGamblingTerm(candidate);
  const sourceGambling = hasGamblingTerm(source);
  const candidateAnchor = hasTradingAnchor(candidate);

  // A gambling/betting source video never becomes a trading query, even if
  // its title also contains a trading word or anchor.
  if (sourceGambling) {
    return { eligible: false, reasonCodes: ['GAMBLING_SOURCE_VIDEO'] };
  }
  if (candidateGambling && !candidateAnchor) {
    return { eligible: false, reasonCodes: ['GAMBLING_QUERY_WITHOUT_TRADING_ANCHOR'] };
  }
  if (!candidateAnchor) {
    return { eligible: false, reasonCodes: ['NO_CONCRETE_TRADING_ANCHOR'] };
  }
  return { eligible: true, reasonCodes: [] };
}

function isMeaningfulCitationQuote(quote: string): boolean {
  const words = quote.split(/\s+/).filter(Boolean);
  if (quote.length < 4) return false;
  // A single short token can be a lucky substring (for example "the" or
  // "gold"). Require either a phrase or a substantive single token.
  return words.length >= 2 ? quote.length >= 5 : quote.length >= 6;
}

/**
 * A citation may quote one contiguous span or several exact spans separated by
 * an ellipsis. Every segment must appear verbatim, in order, in the same
 * field; an ellipsis never permits a fabricated or reordered quote. This
 * matches how models abbreviate long descriptions while preserving auditability.
 */
function textContainsCitation(text: string, quote: string): boolean {
  const normalizedText = normalizeEvidenceText(text);
  const segments = quote.split(/(?:\.\.\.|…)+/).map(segment => segment.trim()).filter(Boolean);
  if (!segments.length) return false;
  let cursor = 0;
  let matchedSegments = 0;
  let matchedChars = 0;
  for (const segment of segments) {
    if (segment.length < 4) continue;
    const index = normalizedText.indexOf(segment, cursor);
    if (index < 0) return false;
    matchedSegments += 1;
    matchedChars += segment.length;
    cursor = index + segment.length;
  }
  // A quote made only of short ellipsis-separated tokens must not pass by
  // matching nothing. Require at least one substantive exact segment; do not
  // impose an eight-character floor, which would reject valid short tickers
  // such as XAUUSD.
  return matchedSegments > 0;
}

function citationKey(evidence: AdmissionEvidence, citation: SemanticCitation): string | null {
  const quote = normalizeEvidenceText(citation.quote);
  if (!quote || !isMeaningfulCitationQuote(quote)) return null;
  if (citation.field === 'channel_name') {
    return textContainsCitation(evidence.channelName, quote) ? 'name' : null;
  }
  if (citation.field === 'bio') {
    return textContainsCitation(evidence.description, quote) ? 'bio' : null;
  }
  if (citation.field === 'link') {
    const index = evidence.links.findIndex(link => textContainsCitation(link, quote));
    return index >= 0 ? `link:${index}` : null;
  }
  if (citation.field === 'video_title' || citation.field === 'video_description') {
    const candidates = citation.index == null
      ? evidence.videos
      : [evidence.videos[citation.index]].filter(Boolean);
    for (let index = 0; index < candidates.length; index += 1) {
      const video = candidates[index];
      if (!video) continue;
      const actualIndex = citation.index == null ? index : citation.index;
      const text = citation.field === 'video_title' ? video.title : video.description;
      if (textContainsCitation(text, quote)) {
        // Title and description of the same video are one evidence source.
        return `video:${actualIndex}`;
      }
    }
  }
  return null;
}

export function validCitations(evidence: AdmissionEvidence, judgment: SemanticJudgment): SemanticCitation[] {
  return judgment.citations.filter(citation => citationKey(evidence, citation) !== null);
}

export function independentCitationCount(
  evidence: AdmissionEvidence,
  judgment: SemanticJudgment,
  supports: 'TRADING' | 'UNRELATED' | 'FINANCE_ADJACENT',
): number {
  const keys = new Set<string>();
  for (const citation of judgment.citations) {
    if (citation.supports !== supports) continue;
    const key = citationKey(evidence, citation);
    if (key) keys.add(key);
  }
  return keys.size;
}

function domainFamily(domain: string): string {
  const value = String(domain || '').toUpperCase();
  // Finance must be checked before NEWS so CRYPTO_NEWS and finance-news
  // domains corroborate with each other rather than splitting into NEWS.
  if (/(FINANCE|INVEST|PERSONAL_FINANCE|CRYPTO_NEWS)/.test(value)) return 'FINANCE';
  if (/(NEWS|POLITIC|BUSINESS_NEWS|CURRENT_AFFAIRS)/.test(value)) return 'NEWS';
  if (/(AI_RESEARCH|TECHNOLOGY|TECH_REVIEWS|CONSUMER_GOODS|SCIENCE|EDUCATION)/.test(value)) return 'TECH_EDUCATION';
  if (/(HOME|GARDEN|INTERIOR|ARCHITECTURE|DESIGN|HISTORY|ARCHAEOLOG|CULTURE)/.test(value)) return 'CULTURE_DESIGN';
  if (/(GAMBL|BETTING|CASINO|ROULETTE)/.test(value)) return 'GAMBLING';
  if (/(COOK|RECIPE|FOOD)/.test(value)) return 'COOKING';
  if (/(ANIME|FICTION|MANHWA|ENTERTAINMENT|MUSIC|MOVIE)/.test(value)) return 'ENTERTAINMENT';
  return value;
}

export function hasCorroboratedUnrelatedDomain(judgment: SemanticJudgment): boolean {
  const domains = judgment.unrelatedDomains
    .filter(item => Number(item.confidence) >= 0.6)
    .sort((a, b) => Number(b.confidence) - Number(a.confidence));
  if (!domains.length) {
    // A judge can identify the unrelated subject through several independent
    // citations without naming a taxonomy domain confidently. The caller
    // already requires validated citations, so three independent unrelated
    // citations are sufficient corroboration on their own.
    return judgment.citations.filter(citation => citation.supports === 'UNRELATED').length >= 3;
  }
  return new Set(domains.map(item => domainFamily(item.domain))).size === 1
    || (Number(domains[0].confidence) >= 0.8 && Number(domains[1]?.confidence || 0) < 0.5);
}

export function hasStrongTradingSupport(evidence: AdmissionEvidence, judgment: SemanticJudgment): boolean {
  const evidenceText = `${evidence.description} ${evidence.videos.map(video => `${video.title} ${video.description}`).join(' ')}`;
  if (judgment.mainSubject === 'TRADING') {
    return independentCitationCount(evidence, judgment, 'TRADING') >= 2
      || (independentCitationCount(evidence, judgment, 'TRADING') >= 1 && hasTradingAnchor(evidenceText));
  }
  if (judgment.mainSubject === 'FINANCE_ADJACENT') {
    return independentCitationCount(evidence, judgment, 'FINANCE_ADJACENT') >= 2
      || (independentCitationCount(evidence, judgment, 'FINANCE_ADJACENT') >= 1 && hasTradingAnchor(evidenceText));
  }
  return false;
}

/**
 * The semantic judgment is primary. Lexical support is used only to validate
 * citations and to flag single-mention risk; it never rejects on its own.
 */
export function decideAdmission(input: {
  evidence: AdmissionEvidence;
  judgment?: SemanticJudgment | null;
  secondJudgment?: SemanticJudgment | null;
  rejectTradingFocus?: number;
}): AdmissionPolicyResult {
  const { evidence, judgment, secondJudgment } = input;
  const rejectThreshold = input.rejectTradingFocus ?? DEFAULT_REJECT_TRADING_FOCUS;
  const reasonCodes: string[] = [];

  if (evidence.evidenceCoverage !== 'COMPLETE') {
    return {
      decision: 'HOLD_MISSING_EVIDENCE',
      status: 'WAITING_EVIDENCE',
      reasonCodes: ['EVIDENCE_INCOMPLETE', ...(evidence.failureReason ? [evidence.failureReason] : [])],
      rejected: false, admitted: false, hold: true, ambiguous: false,
      citationsValid: false, independentUnrelatedCitations: 0, independentTradingCitations: 0,
    };
  }
  if (!judgment) {
    return {
      decision: 'HOLD_MISSING_EVIDENCE',
      status: 'WAITING_EVIDENCE',
      reasonCodes: ['SEMANTIC_JUDGE_UNAVAILABLE'],
      rejected: false, admitted: false, hold: true, ambiguous: false,
      citationsValid: false, independentUnrelatedCitations: 0, independentTradingCitations: 0,
    };
  }

  const primary = judgment;
  const secondary = secondJudgment;
  const primaryUnrelatedCitations = independentCitationCount(evidence, primary, 'UNRELATED');
  const effective = secondary && (
    primary.mainSubject === 'MIXED'
    || primary.mainSubject === 'UNKNOWN'
    || (primary.mainSubject === 'UNRELATED' && primaryUnrelatedCitations < 2)
  ) ? secondary : primary;
  const effectiveRole = effective === secondary ? 'SECOND' : 'PRIMARY';
  const evidenceText = `${evidence.channelName} ${evidence.description} ${evidence.videos.map(video => `${video.title} ${video.description}`).join(' ')}`;
  const tradingCitations = independentCitationCount(evidence, effective, 'TRADING');
  const financeCitations = independentCitationCount(evidence, effective, 'FINANCE_ADJACENT');
  const unrelatedCitations = independentCitationCount(evidence, effective, 'UNRELATED');
  const valid = validCitations(evidence, effective).length;

  // A rejection is only allowed with two independent, valid unrelated
  // citations and a low semantic trading focus. Anything weaker is ambiguous,
  // and ambiguous candidates are admitted.
  const rejectable = effective.mainSubject === 'UNRELATED'
    && Number(effective.tradingFocus) <= rejectThreshold
    && unrelatedCitations >= 2
    && valid >= 2
    && hasCorroboratedUnrelatedDomain(effective)
    && !hasStrongTradingSupport(evidence, effective);

  if (rejectable) {
    reasonCodes.push('SEMANTIC_UNRELATED_WITH_INDEPENDENT_CITATIONS');
    for (const item of effective.unrelatedDomains) reasonCodes.push(`DOMAIN_${item.domain}`);
    return {
      decision: 'REJECT_UNRELATED',
      status: 'REJECTED_UNRELATED',
      reasonCodes,
      effectiveRole,
      rejected: true, admitted: false, hold: false, ambiguous: false,
      citationsValid: true, independentUnrelatedCitations: unrelatedCitations, independentTradingCitations: tradingCitations,
    };
  }

  const clearlyTrading = effective.mainSubject === 'TRADING' && hasStrongTradingSupport(evidence, effective);
  const financeWithTrading = effective.mainSubject === 'FINANCE_ADJACENT'
    && tradingCitations >= 1
    && (financeCitations >= 1 || hasTradingAnchor(evidenceText));
  if (clearlyTrading) {
    reasonCodes.push('SEMANTIC_TRADING_WITH_CITATIONS');
    return {
      decision: 'ADMIT',
      status: 'ADMITTED',
      reasonCodes,
      effectiveRole,
      rejected: false, admitted: true, hold: false, ambiguous: false,
      citationsValid: valid >= 2, independentUnrelatedCitations: unrelatedCitations, independentTradingCitations: tradingCitations,
    };
  }

  // Finance-adjacent is not confidently a trading creator. Admit it to the
  // downstream deterministic/AI classifier instead of bypassing #618.
  if (financeWithTrading) {
    reasonCodes.push('SEMANTIC_FINANCE_WITH_TRADING_ACTIVITY', 'ADMIT_FOR_DOWNSTREAM_CLASSIFICATION');
    return {
      decision: 'ADMIT_AMBIGUOUS',
      status: 'ADMITTED_AMBIGUOUS',
      reasonCodes,
      effectiveRole,
      rejected: false, admitted: true, hold: false, ambiguous: true,
      citationsValid: valid >= 2, independentUnrelatedCitations: unrelatedCitations, independentTradingCitations: tradingCitations,
    };
  }

  // A mixed/news channel with no trading citations is not a trading creator;
  // it is a general channel that happens to touch finance. This prevents
  // general news/business channels from being admitted as "ambiguous".
  if ((effective.mainSubject === 'MIXED' || effective.mainSubject === 'UNKNOWN')
    && (tradingCitations === 0 || Number(effective.tradingFocus) <= rejectThreshold)
    && unrelatedCitations >= 2
    && valid >= 2
    && hasCorroboratedUnrelatedDomain(effective)
    && !hasStrongTradingSupport(evidence, effective)) {
    return {
      decision: 'REJECT_UNRELATED',
      status: 'REJECTED_UNRELATED',
      reasonCodes: ['MIXED_WITHOUT_TRADING_EVIDENCE', ...effective.unrelatedDomains.map(item => `DOMAIN_${item.domain}`)],
      effectiveRole,
      rejected: true, admitted: false, hold: false, ambiguous: false,
      citationsValid: true, independentUnrelatedCitations: unrelatedCitations, independentTradingCitations: tradingCitations,
    };
  }

  if (effective.mainSubject === 'FINANCE_ADJACENT'
    && Number(effective.tradingFocus) < rejectThreshold
    && tradingCitations === 0
    && unrelatedCitations >= 2
    && valid >= 2
    && hasCorroboratedUnrelatedDomain(effective)) {
    return {
      decision: 'REJECT_UNRELATED',
      status: 'REJECTED_UNRELATED',
      reasonCodes: ['FINANCE_ADJACENT_WITHOUT_TRADING_FOCUS', ...effective.unrelatedDomains.map(item => `DOMAIN_${item.domain}`)],
      effectiveRole,
      rejected: true, admitted: false, hold: false, ambiguous: false,
      citationsValid: valid >= 2, independentUnrelatedCitations: unrelatedCitations, independentTradingCitations: tradingCitations,
    };
  }

  // Finance-adjacent creators that were not confidently rejected are routed
  // to the #618 downstream classifier. They never get a deterministic
  // admission verdict and never get a deterministic rejection.
  if (effective.mainSubject === 'FINANCE_ADJACENT') {
    reasonCodes.push('SEMANTIC_FINANCE_ADJACENT', 'ADMIT_FOR_DOWNSTREAM_CLASSIFICATION');
    return {
      decision: 'ADMIT_AMBIGUOUS',
      status: 'ADMITTED_AMBIGUOUS',
      reasonCodes,
      effectiveRole,
      rejected: false, admitted: true, hold: false, ambiguous: true,
      citationsValid: valid >= 2, independentUnrelatedCitations: unrelatedCitations, independentTradingCitations: tradingCitations,
    };
  }

  // A genuine semantic ambiguity after complete evidence has no safe
  // machine decision. Keep the candidate and its full evidence for human
  // review; never reject it and never consume it through enrichment.
  reasonCodes.push(
    effective.mainSubject === 'UNRELATED' ? 'UNRELATED_BUT_CITATIONS_INSUFFICIENT' : 'AMBIGUOUS_AFTER_COMPLETE_EVIDENCE',
    'ROUTE_TO_HUMAN_REVIEW',
  );
  return {
    decision: 'NEEDS_REVIEW',
    status: 'NEEDS_REVIEW',
    reasonCodes,
    effectiveRole,
    rejected: false, admitted: false, hold: false, ambiguous: false, review: true,
    citationsValid: valid >= 2, independentUnrelatedCitations: unrelatedCitations, independentTradingCitations: tradingCitations,
  };
}

export function normalizeSemanticJudgment(value: unknown, model?: string): SemanticJudgment | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, any>;
  const mainSubject = String(raw.main_subject || raw.mainSubject || '').toUpperCase();
  if (!['TRADING', 'FINANCE_ADJACENT', 'UNRELATED', 'MIXED', 'UNKNOWN'].includes(mainSubject)) return null;
  const citations = Array.isArray(raw.evidence_citations) ? raw.evidence_citations : Array.isArray(raw.citations) ? raw.citations : [];
  const unrelatedDomains = Array.isArray(raw.unrelated_domains)
    ? raw.unrelated_domains
    : Array.isArray(raw.unrelatedDomains) ? raw.unrelatedDomains : [];
  const incidentalMentions = Array.isArray(raw.incidental_trading_mentions)
    ? raw.incidental_trading_mentions
    : Array.isArray(raw.incidentalTradingMentions) ? raw.incidentalTradingMentions : [];
  return {
    mainSubject: mainSubject as SemanticJudgment['mainSubject'],
    tradingFocus: Math.max(0, Math.min(100, Number(raw.trading_focus ?? raw.tradingFocus ?? 0) || 0)),
    unrelatedDomains: unrelatedDomains.map((item: any) => ({
      domain: String(item?.domain || item?.name || 'UNKNOWN').toUpperCase(),
      confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)),
    })),
    incidentalTradingMentions: incidentalMentions.map((item: any) => ({
      field: String(item?.field || 'unknown'),
      index: Number.isInteger(item?.index) ? item.index : undefined,
      quote: String(item?.quote || ''),
    })),
    citations: citations.flatMap((item: any) => {
      const supports = String(item?.supports || '').toUpperCase();
      const field = String(item?.field || '').trim();
      if (!['TRADING', 'UNRELATED', 'FINANCE_ADJACENT'].includes(supports)) return [];
      if (!['channel_name', 'bio', 'link', 'video_title', 'video_description'].includes(field)) return [];
      return [{
        field: field as SemanticCitation['field'],
        index: Number.isInteger(item?.index) ? item.index : undefined,
        quote: String(item?.quote || ''),
        supports: supports as SemanticCitation['supports'],
      }];
    }).filter((item: SemanticCitation) => item.quote.trim().length > 0),
    language: raw.language ? String(raw.language) : undefined,
    explanation: String(raw.reasoning || raw.explanation || ''),
    model,
    provider: ['gemini_semantic', 'groq_semantic', 'gemini_free_semantic'].includes(String(raw.provider || ''))
      ? raw.provider as 'gemini_semantic' | 'groq_semantic' | 'gemini_free_semantic'
      : undefined,
    raw: value,
  };
}
