import type { EvidenceItem, EvidenceProvider, LayeredKnowledgeContext, RawChannelInput } from '../types';
import { contentLanguagePacks } from '../multilingualTerminology';
import { buildCanonicalEvidenceCorpus, documentRef } from '../canonicalEvidencePlane';
import { findScopedTermMatches, type ClaimPolarity } from '../utils/claimPolarity';
import { pushUniqueMatch } from '../utils/textMatching';

export class MultilingualContextProvider implements EvidenceProvider {
  name = 'multilingual_context' as const;

  async collectEvidence(input: RawChannelInput, context: LayeredKnowledgeContext): Promise<EvidenceItem[]> {
    const packs = contentLanguagePacks(input,context);
    // C1a: retrieval provenance is never attributable evidence. Attribute a
    // phrase only to documents that individually assert it; a phrase that
    // exists only in the joined channel text spans documents and must not
    // satisfy the independence gate.
    const attributableDocuments=(input.evidence_corpus?.length
      ? input.evidence_corpus
      : buildCanonicalEvidenceCorpus(input)
    ).filter(document=>document.field!=='search_match_context');

    type LanguageKey = 'executionTerms' | 'educationalTerms' | 'businessNewsTerms' | 'genericFinanceTerms' | 'hypeTerms' | 'motivationTerms';
    const termMatchCache = new Map<string, Array<{ term: string; polarity: ClaimPolarity; cue?: string; document: typeof attributableDocuments[number] }>>();
    const matchesFor = (key: LanguageKey) => {
      if (termMatchCache.has(key)) return termMatchCache.get(key)!;
      const matches = packs.flatMap(pack =>
        attributableDocuments.flatMap(document =>
          findScopedTermMatches(document.text, pack[key], document.language).map(match => ({
            term: match.term,
            polarity: match.polarity,
            cue: match.cue,
            document,
          })),
        ),
      );
      termMatchCache.set(key, matches);
      return matches;
    };
    const assertedMatches = (key: LanguageKey): string[] => {
      const asserted: string[] = [];
      for (const match of matchesFor(key)) {
        if (match.polarity === 'ASSERTED') pushUniqueMatch(asserted, match.term);
      }
      return asserted;
    };
    const suppressedMatches = (key: LanguageKey): Array<{ term: string; polarity: ClaimPolarity; cue?: string }> => {
      const suppressed: Array<{ term: string; polarity: ClaimPolarity; cue?: string }> = [];
      const seen = new Set<string>();
      for (const match of matchesFor(key)) {
        if (match.polarity === 'ASSERTED') continue;
        const keyValue = `${match.term}:${match.polarity}`;
        if (seen.has(keyValue)) continue;
        seen.add(keyValue);
        suppressed.push({ term: match.term, polarity: match.polarity, cue: match.cue });
      }
      return suppressed;
    };

    const execution = assertedMatches('executionTerms');
    const education = assertedMatches('educationalTerms');
    const news = assertedMatches('businessNewsTerms');
    const genericFinance = assertedMatches('genericFinanceTerms');
    const hype = assertedMatches('hypeTerms');
    const motivation = assertedMatches('motivationTerms');
    const hasCreatorTradingPractice = execution.length > 0 || education.length > 0;
    const items: EvidenceItem[] = [];
    const now = new Date().toISOString();
    const fieldsFor=(terms:string[])=>{
      const exact=attributableDocuments.filter(document=>terms.some(term=>findScopedTermMatches(document.text,[term],document.language).some(match=>match.polarity==='ASSERTED')));
      if(exact.length)return exact.map(documentRef);
      const partial=attributableDocuments.filter(document=>terms.some(term=>String(term).split(/\s+/u).some(part=>part.length>2&&findScopedTermMatches(document.text,[part],document.language).some(match=>match.polarity==='ASSERTED'))));
      return partial.map(documentRef);
    };

    if (hasCreatorTradingPractice) {
      const asserted = [...execution, ...education];
      const rawWeight = Math.min(30, execution.length * 10 + education.length * 7);
      items.push({
        id: `multi_practice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        source: this.name,
        polarity: 'POSITIVE',
        category: 'METHODOLOGY_CONCEPT',
        fact: `Authentic ${(context.languageKnowledgePacks || [context.languageKnowledge]).filter(Boolean).map(item => item!.languageName).join('/') || 'English'} trading education/execution terminology appears across the complete channel context: ${asserted.join(', ')}`,
        rawMatches: asserted,
        confidence: execution.length >= 2 || (execution.length && education.length) ? 94 : 86,
        reliability: 'VERY_HIGH',
        reliabilityMultiplier: 1,
        rawWeight,
        finalWeight: rawWeight * (execution.length >= 2 ? 0.94 : 0.86),
        provenance: {
          provider: this.name,
          type: 'AUTHENTIC_TRADING_PRACTICE',
          matchedTerm: asserted.join(', '),
          sourceRef: 'Canonical evidence corpus',
          fields:fieldsFor(asserted),
          suppressedMatches: [...suppressedMatches('executionTerms'), ...suppressedMatches('educationalTerms')],
        },
        timestamp: now
      });
    }

    const addNegative = (
      asserted: string[],
      category: 'NON_TRADING_ADJACENT' | 'HYPE_SPECULATION',
      label: string,
      rawWeight: number,
      confidence: number,
      suppressed: Array<{ term: string; polarity: ClaimPolarity; cue?: string }>,
    ) => {
      if (!asserted.length) return;
      items.push({
        id: `multi_negative_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        source: this.name,
        polarity: 'NEGATIVE',
        category,
        fact: `${label}: ${asserted.join(', ')}`,
        rawMatches: asserted,
        confidence,
        reliability: 'HIGH',
        reliabilityMultiplier: 0.85,
        rawWeight,
        finalWeight: -rawWeight * 0.85 * (confidence / 100),
        claimPolarity: 'ASSERTED',
        provenance: {
          provider: this.name,
          type: category,
          matchedTerm: asserted.join(', '),
          sourceRef: 'Canonical evidence corpus contrast analysis',
          fields:fieldsFor(asserted),
          suppressedMatches: suppressed,
        },
        timestamp: now
      });
    };

    // Adjacent finance/news/motivation is negative only when creator-level trading
    // practice is absent; this protects legitimate educators who discuss news.
    // Disclaimers and quoted criticism are suppressed by claim polarity before
    // they can become negative evidence.
    if (!hasCreatorTradingPractice) {
      addNegative(news, 'NON_TRADING_ADJACENT', 'Business-news terminology without trading execution or education', 18, 88, suppressedMatches('businessNewsTerms'));
      addNegative(genericFinance, 'NON_TRADING_ADJACENT', 'Generic finance/investing terminology without trading practice', 20, 90, suppressedMatches('genericFinanceTerms'));
      addNegative(motivation, 'NON_TRADING_ADJACENT', 'Motivational wealth content without trading practice', 22, 92, suppressedMatches('motivationTerms'));
    }
    addNegative(hype, 'HYPE_SPECULATION', 'Crypto/speculation hype terminology', 32, 96, suppressedMatches('hypeTerms'));
    return items;
  }
}
