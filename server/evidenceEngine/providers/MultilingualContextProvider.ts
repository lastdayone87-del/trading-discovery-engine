import type { EvidenceItem, EvidenceProvider, LayeredKnowledgeContext, RawChannelInput } from '../types';
import { completeChannelText, contentLanguagePacks, matchedTerms } from '../multilingualTerminology';
import { documentRef } from '../canonicalEvidencePlane';

export class MultilingualContextProvider implements EvidenceProvider {
  name = 'multilingual_context' as const;

  async collectEvidence(input: RawChannelInput, context: LayeredKnowledgeContext): Promise<EvidenceItem[]> {
    const packs = contentLanguagePacks(input,context);
    const text = completeChannelText(input);
    const matches = (key: 'executionTerms' | 'educationalTerms' | 'businessNewsTerms' | 'genericFinanceTerms' | 'hypeTerms' | 'motivationTerms') => [...new Set(packs.flatMap(pack => matchedTerms(text, pack[key])))];
    const execution = matches('executionTerms');
    const education = matches('educationalTerms');
    const news = matches('businessNewsTerms');
    const genericFinance = matches('genericFinanceTerms');
    const hype = matches('hypeTerms');
    const motivation = matches('motivationTerms');
    const hasCreatorTradingPractice = execution.length > 0 || education.length > 0;
    const items: EvidenceItem[] = [];
    const now = new Date().toISOString();
    const fieldsFor=(terms:string[])=>(input.evidence_corpus||[]).filter(document=>terms.some(term=>matchedTerms(document.text,[term]).length>0)).map(documentRef);

    if (hasCreatorTradingPractice) {
      const matches = [...execution, ...education];
      const rawWeight = Math.min(30, execution.length * 10 + education.length * 7);
      items.push({
        id: `multi_practice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        source: this.name,
        polarity: 'POSITIVE',
        category: 'METHODOLOGY_CONCEPT',
        fact: `Authentic ${(context.languageKnowledgePacks || [context.languageKnowledge]).filter(Boolean).map(item => item!.languageName).join('/') || 'English'} trading education/execution terminology appears across the complete channel context: ${matches.join(', ')}`,
        rawMatches: matches,
        confidence: execution.length >= 2 || (execution.length && education.length) ? 94 : 86,
        reliability: 'VERY_HIGH',
        reliabilityMultiplier: 1,
        rawWeight,
        finalWeight: rawWeight * (execution.length >= 2 ? 0.94 : 0.86),
        provenance: { provider: this.name, type: 'AUTHENTIC_TRADING_PRACTICE', matchedTerm: matches.join(', '), sourceRef: 'Canonical evidence corpus', fields:fieldsFor(matches) },
        timestamp: now
      });
    }

    const addNegative = (matches: string[], category: 'NON_TRADING_ADJACENT' | 'HYPE_SPECULATION', label: string, rawWeight: number, confidence: number) => {
      if (!matches.length) return;
      items.push({
        id: `multi_negative_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        source: this.name,
        polarity: 'NEGATIVE',
        category,
        fact: `${label}: ${matches.join(', ')}`,
        rawMatches: matches,
        confidence,
        reliability: 'HIGH',
        reliabilityMultiplier: 0.85,
        rawWeight,
        finalWeight: -rawWeight * 0.85 * (confidence / 100),
        provenance: { provider: this.name, type: category, matchedTerm: matches.join(', '), sourceRef: 'Canonical evidence corpus contrast analysis', fields:fieldsFor(matches) },
        timestamp: now
      });
    };

    // Adjacent finance/news/motivation is negative only when creator-level trading
    // practice is absent; this protects legitimate educators who discuss news.
    if (!hasCreatorTradingPractice) {
      addNegative(news, 'NON_TRADING_ADJACENT', 'Business-news terminology without trading execution or education', 18, 88);
      addNegative(genericFinance, 'NON_TRADING_ADJACENT', 'Generic finance/investing terminology without trading practice', 20, 90);
      addNegative(motivation, 'NON_TRADING_ADJACENT', 'Motivational wealth content without trading practice', 22, 92);
    }
    addNegative(hype, 'HYPE_SPECULATION', 'Crypto/speculation hype terminology', 32, 96);
    return items;
  }
}
