import type { LayeredKnowledgeContext, RawChannelInput } from './types';
import { textMatchesTerm } from './utils/textMatching';
import {
  isAffirmativeTradingText,
  tierATradingSignals,
} from './tradingSignalTaxonomy';
import { SUPPORTED_PRODUCTION_COUNTRIES } from '../../src/data/initial_countries';
import {
  MULTILINGUAL_CLASSIFICATION_PACKS,
  type MultilingualClassificationPack,
} from './multilingualClassificationPacks';

/** Backward-compatible export backed by the single production-country registry. */
export const SUPPORTED_CLASSIFICATION_COUNTRIES = SUPPORTED_PRODUCTION_COUNTRIES;
export { MULTILINGUAL_CLASSIFICATION_PACKS };
export type { MultilingualClassificationPack };

/**
 * C1a retrieval firewall: only creator-owned corpus documents contribute to
 * text. `search_match_context` is retrieval provenance, not creator evidence.
 */
export function completeChannelText(input: RawChannelInput): string {
  return (input.evidence_corpus?.filter(document => document.field !== 'search_match_context').map(document=>document.text) || [input.channel_name, input.description, ...(input.video_titles || []), ...(input.video_descriptions || []), input.location_tag, ...(input.external_links || [])]).filter(Boolean).join(' ');
}

/** Select languages from actual field content and declared field hints, not country alone. */
export function contentLanguagePacks(input:RawChannelInput,context:LayeredKnowledgeContext):MultilingualClassificationPack[]{
  const text=completeChannelText(input),hinted=new Set([...(input.detected_languages||[]).filter(item=>(item.confidence??100)>=50).map(item=>item.language.toLocaleLowerCase('und').split('-')[0]),...(input.evidence_corpus||[]).filter(item=>item.field!=='search_match_context').map(item=>item.language?.toLocaleLowerCase('und').split('-')[0]).filter((x):x is string=>Boolean(x))]);
  const configured=(context.languageKnowledgePacks||[context.languageKnowledge]).map(item=>item?.languageCode).filter((x):x is string=>Boolean(x));
  const contentMatched=Object.values(MULTILINGUAL_CLASSIFICATION_PACKS).filter(pack=>[...pack.executionTerms,...pack.educationalTerms,...pack.businessNewsTerms,...pack.genericFinanceTerms,...pack.hypeTerms,...pack.motivationTerms].some(term=>textMatchesTerm(text,term))).map(pack=>pack.languageCode);
  const codes=[...new Set([...configured,...hinted,...contentMatched])];
  return codes.map(code=>MULTILINGUAL_CLASSIFICATION_PACKS[code as keyof typeof MULTILINGUAL_CLASSIFICATION_PACKS]).filter((pack):pack is MultilingualClassificationPack=>Boolean(pack));
}

export function matchedTerms(text: string, terms: string[]): string[] {
  return terms.filter(term => textMatchesTerm(text, term));
}

/**
 * C2 predicate correction. Providers and C5 now share one taxonomy: a text is
 * trading-focused when the same polarity-aware assessment that builds the
 * composition classifies it as core or adjacent trading evidence. Generic
 * method/education vocabulary alone remains insufficient because the taxonomy
 * requires an independent market/instrument/venue dimension.
 */
export function isTradingFocusedText(text: string, context: LayeredKnowledgeContext): boolean {
  const normalized = String(text || '').normalize('NFKC');
  // The predicate must see language packs matched from the text itself, not
  // only the country's configured language. A US channel can post German or
  // Japanese trading titles.
  const contentPacks = contentLanguagePacks({ channel_name: '', description: normalized }, context);
  const byCode = new Map((context.languageKnowledgePacks || []).map(pack => [pack.languageCode, pack]));
  for (const pack of contentPacks) {
    if (!byCode.has(pack.languageCode)) {
      byCode.set(pack.languageCode, {
        languageCode: pack.languageCode,
        languageName: pack.languageCode,
        positiveTerms: [],
        negativeTerms: [],
        commonPhrases: [],
      });
    }
  }
  return isAffirmativeTradingText(normalized, {
    ...context,
    languageKnowledgePacks: [...byCode.values()],
  });
}

/** Known Tier A signals, used for C2 aggregation (distinct signals, not repeats). */
export function matchedTierATradingSignals(text: string, context?: LayeredKnowledgeContext): string[] {
  return tierATradingSignals(String(text || '').normalize('NFKC'), context);
}
