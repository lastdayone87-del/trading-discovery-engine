import { EvidenceItem, EvidenceProvider, RawChannelInput, LayeredKnowledgeContext } from '../types';
import { textMatchesTerm } from '../utils/textMatching';
import { documentRef } from '../canonicalEvidencePlane';

export class CountryKnowledgeProvider implements EvidenceProvider {
  name = 'country_knowledge' as const;

  async collectEvidence(input: RawChannelInput, knowledgeContext: LayeredKnowledgeContext): Promise<EvidenceItem[]> {
    const items: EvidenceItem[] = [];
    const textBlob = `${input.channel_name} ${input.description || ''} ${(input.video_titles || []).join(' ')}`;
    const now = new Date().toISOString();
    const countryPack = knowledgeContext.countryKnowledge;
    const langPack = knowledgeContext.languageKnowledge;
    const langPacks=knowledgeContext.languageKnowledgePacks||[langPack].filter((pack):pack is NonNullable<typeof pack>=>Boolean(pack));
    const fieldsFor=(terms:string[])=>(input.evidence_corpus||[]).filter(document=>terms.some(term=>textMatchesTerm(document.text,term))).map(documentRef);

    if (!countryPack && !langPack) {
      return items;
    }

    // 1. Match Regional Exchanges & Local Instruments
    const matchedRegionalExchanges: string[] = [];
    if (countryPack) {
      for (const exch of countryPack.regionalExchanges) {
        if (textMatchesTerm(textBlob, exch)) {
          if (!matchedRegionalExchanges.includes(exch)) matchedRegionalExchanges.push(exch);
        }
      }
    }

    if (matchedRegionalExchanges.length > 0) {
      items.push({
        id: `cntry_know_exch_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'country_knowledge',
        polarity: 'POSITIVE',
        category: 'INSTRUMENT',
        fact: `Country knowledge match: References regional market exchange(s) for ${countryPack?.countryName}: ${matchedRegionalExchanges.join(', ')}`,
        rawMatches: matchedRegionalExchanges,
        confidence: 90,
        reliability: 'VERY_HIGH',
        reliabilityMultiplier: 1.0,
        rawWeight: Math.min(25, matchedRegionalExchanges.length * 12),
        finalWeight: Math.min(25, matchedRegionalExchanges.length * 12) * 1.0 * 0.90,
        provenance: {
          provider: 'country_knowledge',
          type: 'INSTRUMENT',
          matchedTerm: matchedRegionalExchanges.join(', '),
          sourceRef: `Country Knowledge Pack (${countryPack?.countryName || 'Global'})`, fields:fieldsFor(matchedRegionalExchanges)
        },
        timestamp: now
      });
    }

    // 2. Match Native Language / Country Trading Terminology
    const matchedNativeTerms: string[] = [];
    const nativeTermsList = [
      ...(countryPack?.nativeTradingTerminology || []),
      ...langPacks.flatMap(pack=>pack.positiveTerms),
      ...langPacks.flatMap(pack=>pack.commonPhrases)
    ];

    for (const term of nativeTermsList) {
      if (textMatchesTerm(textBlob, term)) {
        if (!matchedNativeTerms.includes(term)) matchedNativeTerms.push(term);
      }
    }

    if (matchedNativeTerms.length > 0) {
      items.push({
        id: `cntry_know_native_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'country_knowledge',
        polarity: 'POSITIVE',
        category: 'TERMINOLOGY',
        fact: `Local language trading terminology detected for ${countryPack?.countryName || langPack?.languageName}: ${matchedNativeTerms.slice(0, 5).join(', ')}`,
        rawMatches: matchedNativeTerms,
        confidence: 85,
        reliability: 'HIGH',
        reliabilityMultiplier: 0.85,
        rawWeight: Math.min(25, matchedNativeTerms.length * 8),
        finalWeight: Math.min(25, matchedNativeTerms.length * 8) * 0.85 * 0.85,
        provenance: {
          provider: 'country_knowledge',
          type: 'TERMINOLOGY',
          matchedTerm: matchedNativeTerms.slice(0, 5).join(', '),
          sourceRef: `Language Pack (${langPack?.languageName || 'English'})`, fields:fieldsFor(matchedNativeTerms)
        },
        timestamp: now
      });
    }

    // 3. Match Regional Negative Exclusion Terms
    const matchedRegionalNegative: string[] = [];
    const regionalNegativesList = [
      ...(countryPack?.regionalNegativeTerms || []),
      ...langPacks.flatMap(pack=>pack.negativeTerms)
    ];

    for (const neg of regionalNegativesList) {
      if (textMatchesTerm(textBlob, neg)) {
        if (!matchedRegionalNegative.includes(neg)) matchedRegionalNegative.push(neg);
      }
    }

    if (matchedRegionalNegative.length > 0) {
      items.push({
        id: `cntry_know_neg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'country_knowledge',
        polarity: 'NEGATIVE',
        category: 'IRRELEVANT_DOMAIN',
        fact: `Regional exclusion terms detected for ${countryPack?.countryName || langPack?.languageName}: ${matchedRegionalNegative.join(', ')}`,
        rawMatches: matchedRegionalNegative,
        confidence: 85,
        reliability: 'HIGH',
        reliabilityMultiplier: 0.85,
        rawWeight: Math.min(25, matchedRegionalNegative.length * 10),
        finalWeight: -1 * Math.min(25, matchedRegionalNegative.length * 10) * 0.85 * 0.85,
        provenance: {
          provider: 'country_knowledge',
          type: 'IRRELEVANT_DOMAIN',
          matchedTerm: matchedRegionalNegative.join(', '),
          sourceRef: `Country Exclusions (${countryPack?.countryName || langPack?.languageName})`, fields:fieldsFor(matchedRegionalNegative)
        },
        timestamp: now
      });
    }

    return items;
  }
}
