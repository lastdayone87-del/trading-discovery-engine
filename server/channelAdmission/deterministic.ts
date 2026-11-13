import type { RawChannelInput } from '../evidenceEngine';
import { verifyChannelTradingRelevance } from '../evidenceEngine';
import type { VerificationDecision } from '../evidenceEngine/types';
import { resolveClassificationRouting } from '../classificationRouting/deterministicFirst';
import { hasTradingAnchor } from './policy';
import type { AdmissionEvidence, SemanticCitation, SemanticJudgment } from './types';

export interface DeterministicAdmissionResult {
  outcome: 'PASS' | 'REJECT' | 'AMBIGUOUS';
  route: string | null;
  confidence: number;
  reasonCodes: string[];
  citations: SemanticCitation[];
  judgment?: SemanticJudgment;
  priority: number;
}

const REJECT_DOMAINS: Array<{ domain: string; pattern: RegExp }> = [
  { domain: 'COOKING', pattern: /\b(?:cook(?:ing)?|recipe|baking|bake|bread|food|kitchen|chef|meal|dessert|pastry|sourdough|pasta|rice|sauce)\b/iu },
  { domain: 'HOME_DESIGN', pattern: /\b(?:architecture|architect|interior design|home design|house tour|garden|decoration|decor|townhouse|furniture|renovation)\b/iu },
  { domain: 'AI_RESEARCH', pattern: /\b(?:artificial intelligence|ai research|machine learning|deep learning|neural network|physicist|science|scientist|quantum|robot|simulation|technology|tech review|unboxing)\b/iu },
  { domain: 'GAMING_GAMBLING', pattern: /\b(?:gaming|gameplay|fortnite|minecraft|roulette|casino|betting|poker|blackjack|slot|gambling|esports)\b/iu },
  { domain: 'ANIME_ENTERTAINMENT', pattern: /\b(?:anime|manga|manhwa|recap|movie|film|music|song|dance|vlog|prank|celebrity|trailer)\b/iu },
  { domain: 'AUTOMOTIVE', pattern: /\b(?:car|cars|vehicle|ev|tire|tires|engine|motorsport|automotive|truck|suv)\b/iu },
  { domain: 'CHILDREN_LEARNING', pattern: /\b(?:toddler|baby|nursery rhymes|kids learning|preschool|children.s songs)\b/iu },
];

/**
 * A rejection is allowed only when no strong trading/finance context exists
 * anywhere in the creator evidence. This guard intentionally includes finance
 * and investing terms so finance-adjacent channels are never deterministically
 * rejected.
 */
const TRADING_FINANCE_GUARD = /\b(?:technical\s*analysis|price\s*action|market\s*analysis|market\s*structure|order\s*flow|volume\s*profile|risk\s*management|trade\s*setup|trade\s*journal|trade\s*analysis|trading\s*analysis|back\s*test|backtest|live\s*trad(?:e|ing)|day\s*trad(?:e|ing)|swing\s*trad(?:e|ing)|scalp(?:ing)?|prop\s*firm|funded\s*trader|trading\s*(?:strategy|education|signals?|course|system)|stock\s*(?:market|trading)|share\s*market|equity\s*market|forex(?:\s*(?:trading|market))?|futures?\s*(?:trading|market)|options?\s*(?:trading|market)|crypto\s*trading|bitcoin|btc|ethereum|eth|nasdaq|s&p\s*500|sp500|xauusd|xagusd|eurusd|gbpusd|usdjpy|audusd|usdcad|usdchf|nzdusd|nifty|bank\s*nifty|sensex|dax|cac\s*40|ftse\s*100|nikkei|trader|trading|invest(?:ing|or|ment)?|portfolio|dividend|etf|bourse|finance|financial|wealth|broker|equity|commodit(?:y|ies)|market\s*(?:update|recap|outlook|forecast|crash|news|commentary)|chart\s*analysis|support\s*and\s*resistance|candlestick|moving\s*average|rsi|macd|fibonacci|elliott|wyckoff|pnl|p\s*&\s*l)\b/iu;

const FINANCE_ADJACENT_EVIDENCE = /\b(?:personal finance|invest(?:ing|ment|or|ments)|investir|investissement|etf|dividend|portfolio|retirement|broker|budgeting|budget\s+(?:tips|plan|money)|savings account|wealth|stock market|stock investing|stock trading|stocks and shares|stock portfolio|equity market|equities|bond market|government bonds?|corporate bonds?|treasury bonds?|bond (?:fund|etf|yield)|index fund|mutual fund|real estate|mortgage|insurance|income tax|tax return|tax filing|tax planning|tax bracket|tax refund|bourse|courtier|épargne|assurance[- ]vie|scpi|patrimoine|finances personnelles|inversi[oó]n|bolsa|corredor|ahorro|jubilaci[oó]n|finanzas personales|investieren|b[oö]rse|sparen|altersvorsorge|finanzen)\b/iu;

/**
 * Active trading evidence is execution/analysis language, not merely the
 * existence of a market or an investment. Finance-adjacent creators may use
 * stock-market vocabulary without being trading creators, so a fast-pass
 * requires at least one of these anchors.
 */
const ACTIVE_TRADING_EVIDENCE = /\b(?:live[\s-]+trad(?:e|ing)|day[\s-]+trad(?:e|ing)|swing[\s-]+trad(?:e|ing)|scalp(?:ing)?|price action|technical analysis|market structure|order[\s-]*flow|order block|fair value gap|fvg|volume profile|support and resistance|risk management|trade[\s-]+(?:setup|recap|idea|execution|journal|plan|breakdown)|trading\s+(?:strategy|education|course|system)|stock\s+trading|crypto\s+trading|liquidity[\s-]*(?:pool|sweep)|back[\s-]*test|backtest|futures?\s*(?:trading|analysis|market|setup)|forex\s*(?:trading|analysis|strategy)|nifty\s*(?:analysis|trading|view|setup|outlook|forecast)|bank\s*nifty|sensex\s*(?:analysis|trading|view)|nq\s*(?:futures|analysis|trading|setup)|gold\s*(?:trading|analysis|forecast|setup)|bitcoin\s*(?:trading|analysis)|btc\s*(?:trading|analysis)|ethereum\s*(?:trading|analysis)|xauusd|xagusd|eurusd|gbpusd|usdjpy|audusd|usdcad|usdchf|nzdusd|candlestick|fibonacci|elliott|wyckoff|vwap|footprint|chart[\s-]+(?:analysis|setup|pattern|breakdown)|(?:ict|smc)\s+(?:trading|concepts?|model|strategy|trader|analysis)|funded\s+(?:account|challenge|trader))\b/iu;

export function isFinanceAdjacentWithoutActiveTrading(text: string): boolean {
  const value = String(text || '');
  return FINANCE_ADJACENT_EVIDENCE.test(value) && !ACTIVE_TRADING_EVIDENCE.test(value);
}

function evidenceToInput(evidence: AdmissionEvidence): RawChannelInput {
  return {
    channel_id: evidence.channelId,
    channel_name: evidence.channelName,
    description: evidence.description,
    // The target country is retrieval context, not creator evidence. Using it
    // as the creator country would apply the wrong regional knowledge pack.
    country: evidence.country || 'UNKNOWN',
    external_links: evidence.links,
    videos: evidence.videos.map(video => ({
      title: video.title,
      description: video.description,
      published_at: video.publishedAt,
    })),
    video_titles: evidence.videos.map(video => video.title),
    video_descriptions: evidence.videos.map(video => video.description),
    videoDescriptionsAuthoritative: true,
    detected_languages: evidence.declaredLanguage
      ? [{ language: evidence.declaredLanguage }]
      : undefined,
    enrichment_stage: 1,
  };
}

function citationFieldText(
  evidence: AdmissionEvidence,
  field: string,
  index?: number,
): string | null {
  switch (field) {
    case 'channel_bio':
      return evidence.description || '';
    case 'channel_title':
      return evidence.channelName || '';
    case 'video_title':
      return typeof index === 'number' ? evidence.videos[index]?.title ?? null : null;
    case 'video_description':
      return typeof index === 'number' ? evidence.videos[index]?.description ?? null : null;
    default:
      return null;
  }
}

function exactQuote(text: string, term: string): string | null {
  if (!text || !term) return null;
  const index = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  return index >= 0 ? text.slice(index, index + term.length) : null;
}

function citationTerms(matchedTerm: string): string[] {
  return matchedTerm
    .split(/[,;]/)
    .map(term => term.trim())
    .filter(term => term.length >= 4 && !/^\d|videos?\s+matching|\bterms?\b$/iu.test(term));
}

function citationFromEvidenceItem(
  evidence: AdmissionEvidence,
  item: VerificationDecision['positiveEvidence'][number],
): SemanticCitation | null {
  const terms = citationTerms(String(item.provenance?.matchedTerm || ''));
  if (!terms.length) return null;
  for (const fieldRef of item.provenance?.fields || []) {
    if (fieldRef.field === 'external_link_domain' || fieldRef.field === 'external_link_label') {
      for (const link of evidence.links) {
        for (const term of terms) {
          const quote = exactQuote(link, term);
          if (quote) return { field: 'link', quote, supports: 'TRADING' };
        }
      }
      continue;
    }
    const text = citationFieldText(evidence, fieldRef.field, fieldRef.index);
    if (text == null) continue;
    for (const term of terms) {
      const quote = exactQuote(text, term);
      if (!quote) continue;
      const field = fieldRef.field === 'channel_bio' ? 'bio'
        : fieldRef.field === 'channel_title' ? 'channel_name'
          : fieldRef.field as SemanticCitation['field'];
      return { field, index: fieldRef.index, quote, supports: 'TRADING' };
    }
  }
  return null;
}

function tradingCitations(evidence: AdmissionEvidence, decision: VerificationDecision): SemanticCitation[] {
  const citations: SemanticCitation[] = [];
  for (const item of decision.positiveEvidence) {
    const citation = citationFromEvidenceItem(evidence, item);
    if (citation && !citations.some(existing => existing.field === citation.field && existing.index === citation.index && existing.quote === citation.quote)) {
      citations.push(citation);
    }
  }
  return citations.slice(0, 6);
}

interface RejectSource {
  /** Independence key: the bio or one video. Title and description of the
   * same video are one creator-owned source, matching the policy citation
   * independence rule. */
  key: string;
  field: SemanticCitation['field'];
  index?: number;
  text: string;
}

function rejectSources(evidence: AdmissionEvidence): RejectSource[] {
  const sources: RejectSource[] = [
    { key: 'bio', field: 'bio', text: evidence.description || '' },
  ];
  evidence.videos.forEach((video, index) => {
    sources.push(
      { key: `video:${index}`, field: 'video_title', index, text: video.title || '' },
      { key: `video:${index}`, field: 'video_description', index, text: video.description || '' },
    );
  });
  return sources.filter(source => source.text.trim().length > 0);
}

function matchingQuote(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  if (!match || match.index === undefined) return null;
  const start = Math.max(0, match.index - 60);
  const end = Math.min(text.length, match.index + match[0].length + 60);
  return text.slice(start, end).trim();
}

/**
 * Strict deterministic rejection. This is deliberately conservative: it
 * rejects only a single high-specificity unrelated domain supported by at
 * least three matches across two independent sources, with no trading or
 * finance context anywhere in the evidence.
 */
export function evaluateStrictRejection(evidence: AdmissionEvidence): {
  domain: string;
  citations: SemanticCitation[];
  reasonCodes: string[];
} | null {
  const sources = rejectSources(evidence);
  const fullText = sources.map(source => source.text).join('\n');
  // Include the channel name and links, and use the shared multilingual
  // trading-anchor detector so a native-language trading creator is never
  // rejected because the English lexical guard missed its terminology.
  const guardText = `${evidence.channelName}\n${evidence.links.join('\n')}\n${fullText}`;
  if (TRADING_FINANCE_GUARD.test(guardText) || hasTradingAnchor(guardText)) return null;

  let best: { domain: string; total: number; matches: Array<{ source: RejectSource; quote: string }> } | null = null;
  for (const { domain, pattern } of REJECT_DOMAINS) {
    const matches: Array<{ source: RejectSource; quote: string }> = [];
    let total = 0;
    for (const source of sources) {
      const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
      const count = [...source.text.matchAll(matcher)].length;
      if (count === 0) continue;
      total += count;
      const quote = matchingQuote(source.text, new RegExp(pattern.source, pattern.flags));
      if (quote) matches.push({ source, quote });
    }
    // Two independent creator-owned sources are mandatory. Multiple title and
    // description matches from one video stay one source.
    if (new Set(matches.map(match => match.source.key)).size < 2 || total < 3) continue;
    if (!best || total > best.total) best = { domain, total, matches };
  }
  if (!best) return null;

  const citations: SemanticCitation[] = [];
  const usedSources = new Set<string>();
  for (const match of best.matches) {
    if (usedSources.has(match.source.key)) continue;
    usedSources.add(match.source.key);
    citations.push({
      field: match.source.field,
      index: match.source.index,
      quote: match.quote,
      supports: 'UNRELATED',
    });
    if (citations.length === 2) break;
  }
  if (citations.length < 2) return null;
  return {
    domain: best.domain,
    citations,
    reasonCodes: ['DETERMINISTIC_REJECTION', `DOMAIN_${best.domain}`, 'STRICT_REJECTION_TWO_SOURCE_THRESHOLD'],
  };
}

export async function evaluateDeterministicAdmission(evidence: AdmissionEvidence): Promise<DeterministicAdmissionResult> {
  const decision = await verifyChannelTradingRelevance(evidenceToInput(evidence), { semanticMode: 'OFF' });
  const videoTexts = evidence.videos.map(video => `${video.title}\n${video.description}`.trim());
  const corroboration = decision.stagedClassification?.stages.find(stage => stage.stage === 'CORROBORATION');
  const routing = resolveClassificationRouting(decision, {
    independentEvidence: corroboration?.disposition === 'PASS',
    videoTexts,
    mode: 'ACTIVE',
  });

  let passWithoutCitations = false;
  let passBlockedByFinanceAdjacency = false;
  const fullEvidenceText = `${evidence.channelName}\n${evidence.description}\n${evidence.links.join('\n')}\n${evidence.videos.map(video => `${video.title}\n${video.description}`).join('\n')}`;
  const financeAdjacentOnly = isFinanceAdjacentWithoutActiveTrading(fullEvidenceText);
  if (routing.route === 'DETERMINISTIC_TRADING'
    && decision.status === 'TRADING_CONFIRMED'
    && decision.evidenceCollection.sufficiency === 'SUFFICIENT') {
    const citations = tradingCitations(evidence, decision);
    if (citations.length > 0 && !financeAdjacentOnly) {
      const judgment: SemanticJudgment = {
        mainSubject: 'TRADING',
        tradingFocus: decision.confidenceScore,
        unrelatedDomains: [],
        incidentalTradingMentions: [],
        citations,
        explanation: 'Deterministic #618 classifier found decisive trading evidence.',
        model: 'deterministic-first-v1',
      };
      return {
        outcome: 'PASS',
        route: routing.route,
        confidence: decision.confidenceScore,
        reasonCodes: ['DETERMINISTIC_FAST_PASS', ...routing.reasonCodes],
        citations,
        judgment,
        priority: 10,
      };
    }
    // A decisive score without a source-anchored citation is not auditable
    // enough for admission. Let the semantic judge review it instead.
    if (citations.length === 0) passWithoutCitations = true;
    // Finance-adjacent creators must reach downstream classification rather
    // than bypass it with a deterministic trading fast-pass.
    if (financeAdjacentOnly) passBlockedByFinanceAdjacency = true;
  }

  // Finance-adjacent creators must never be deterministically rejected, even
  // if the unrelated-domain matcher finds corroborated non-finance content.
  if (financeAdjacentOnly) {
    return {
      outcome: 'AMBIGUOUS',
      route: routing.route,
      confidence: decision.confidenceScore,
      reasonCodes: ['FINANCE_ADJACENT_DEFERRED_TO_DOWNSTREAM', 'DETERMINISTIC_AMBIGUOUS', ...routing.reasonCodes],
      citations: [],
      priority: 20,
    };
  }

  const rejection = evaluateStrictRejection(evidence);
  if (rejection) {
    const judgment: SemanticJudgment = {
      mainSubject: 'UNRELATED',
      tradingFocus: 0,
      unrelatedDomains: [{ domain: rejection.domain, confidence: 1 }],
      incidentalTradingMentions: [],
      citations: rejection.citations,
      explanation: `Deterministic strict rejection: ${rejection.domain} evidence across independent sources.`,
      model: 'deterministic-first-v1',
    };
    return {
      outcome: 'REJECT',
      route: 'DETERMINISTIC_REJECTION',
      confidence: 100,
      reasonCodes: rejection.reasonCodes,
      citations: rejection.citations,
      judgment,
      priority: 30,
    };
  }

  return {
    outcome: 'AMBIGUOUS',
    route: routing.route,
    confidence: decision.confidenceScore,
    reasonCodes: [
      ...(passWithoutCitations ? ['DETERMINISTIC_PASS_WITHOUT_CITATIONS'] : []),
      ...(passBlockedByFinanceAdjacency ? ['FINANCE_ADJACENT_DEFERRED_TO_DOWNSTREAM'] : []),
      'DETERMINISTIC_AMBIGUOUS',
      ...routing.reasonCodes,
    ],
    citations: [],
    priority: decision.status === 'TRADING_CONFIRMED' ? 10 : 20,
  };
}
