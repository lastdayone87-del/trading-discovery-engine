import { EvidenceItem, EvidenceProvider, RawChannelInput, LayeredKnowledgeContext } from '../types';
import { textMatchesTerm } from '../utils/textMatching';

export class ChannelMetadataProvider implements EvidenceProvider {
  name = 'channel_metadata' as const;

  async collectEvidence(input: RawChannelInput, knowledgeContext: LayeredKnowledgeContext): Promise<EvidenceItem[]> {
    const items: EvidenceItem[] = [];
    const textBlob = `${input.channel_name} ${input.description || ''}`;
    const now = new Date().toISOString();
    const fieldsFor=(terms:string[])=>[
      ...(terms.some(term=>textMatchesTerm(input.channel_name,term))?[{field:'channel_title' as const,sourceFamilyId:input.channel_source_family_id,sourceEntityId:input.channel_entity_id}]:[]),
      ...(terms.some(term=>textMatchesTerm(input.description||'',term))?[{field:'channel_bio' as const,sourceFamilyId:input.channel_source_family_id,sourceEntityId:input.channel_entity_id}]:[])
    ];

    // 1. Match Global & Country Instruments in Channel Name/Description
    const matchedInstruments: string[] = [];
    const allInstruments = [
      ...knowledgeContext.globalInstruments,
      ...(knowledgeContext.countryKnowledge?.popularInstruments || [])
    ];

    for (const inst of allInstruments) {
      if (textMatchesTerm(textBlob, inst)) {
        if (!matchedInstruments.includes(inst)) matchedInstruments.push(inst);
      }
    }

    if (matchedInstruments.length > 0) {
      items.push({
        id: `chan_meta_inst_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'channel_metadata',
        polarity: 'POSITIVE',
        category: 'INSTRUMENT',
        fact: `Channel metadata references financial instruments: ${matchedInstruments.join(', ')}`,
        rawMatches: matchedInstruments,
        confidence: 85,
        reliability: 'HIGH',
        reliabilityMultiplier: 0.85,
        rawWeight: Math.min(25, matchedInstruments.length * 10),
        finalWeight: Math.min(25, matchedInstruments.length * 10) * 0.85 * 0.85,
        provenance: {
          provider: 'channel_metadata',
          type: 'INSTRUMENT',
          matchedTerm: matchedInstruments.join(', '),
          sourceRef: 'Channel Title / About Description', fields:fieldsFor(matchedInstruments)
        },
        timestamp: now
      });
    }

    // 2. Match Platforms, Brokers & Prop Firms
    const matchedPlatforms: string[] = [];
    const allPlatforms = [
      ...knowledgeContext.globalPlatformsPropFirms,
      ...(knowledgeContext.countryKnowledge?.localBrokers || []),
      ...(knowledgeContext.countryKnowledge?.localPropFirms || [])
    ];

    for (const platform of allPlatforms) {
      if (textMatchesTerm(textBlob, platform)) {
        if (!matchedPlatforms.includes(platform)) matchedPlatforms.push(platform);
      }
    }

    if (matchedPlatforms.length > 0) {
      items.push({
        id: `chan_meta_plat_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'channel_metadata',
        polarity: 'POSITIVE',
        category: 'PLATFORM_BROKER_PROPFIRM',
        fact: `Channel metadata explicitly references trading platform/broker/prop firm: ${matchedPlatforms.join(', ')}`,
        rawMatches: matchedPlatforms,
        confidence: 90,
        reliability: 'VERY_HIGH',
        reliabilityMultiplier: 1.0,
        rawWeight: Math.min(30, matchedPlatforms.length * 15),
        finalWeight: Math.min(30, matchedPlatforms.length * 15) * 1.0 * 0.90,
        provenance: {
          provider: 'channel_metadata',
          type: 'PLATFORM_BROKER_PROPFIRM',
          matchedTerm: matchedPlatforms.join(', '),
          sourceRef: 'Channel Title / About Description', fields:fieldsFor(matchedPlatforms)
        },
        timestamp: now
      });
    }

    // 3. Match Advanced Methodology / Educational Concepts across Global & Language packs
    const matchedConcepts: string[] = [];
    const allConcepts = [
      ...knowledgeContext.globalAdvancedConcepts,
      ...(knowledgeContext.languageKnowledge?.positiveTerms || []),
      ...(knowledgeContext.countryKnowledge?.nativeTradingTerminology || [])
    ];

    for (const concept of allConcepts) {
      if (textMatchesTerm(textBlob, concept)) {
        if (!matchedConcepts.includes(concept)) matchedConcepts.push(concept);
      }
    }

    if (matchedConcepts.length > 0) {
      // Recalibrated: Give methodology & educational concepts equal high reliability weight
      items.push({
        id: `chan_meta_concept_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'channel_metadata',
        polarity: 'POSITIVE',
        category: 'METHODOLOGY_CONCEPT',
        fact: `Channel metadata mentions educational trading concepts & methodologies: ${matchedConcepts.join(', ')}`,
        rawMatches: matchedConcepts,
        confidence: 90,
        reliability: 'HIGH',
        reliabilityMultiplier: 0.90,
        rawWeight: Math.min(30, matchedConcepts.length * 10),
        finalWeight: Math.min(30, matchedConcepts.length * 10) * 0.90 * 0.90,
        provenance: {
          provider: 'channel_metadata',
          type: 'METHODOLOGY_CONCEPT',
          matchedTerm: matchedConcepts.join(', '),
          sourceRef: 'Channel Title / About Description', fields:fieldsFor(matchedConcepts)
        },
        timestamp: now
      });
    }

    // 4. Negative Irrelevant Domain Matches
    const matchedNegative: string[] = [];
    const allNegative = [
      ...knowledgeContext.globalNegativeTerms,
      ...(knowledgeContext.countryKnowledge?.regionalNegativeTerms || []),
      ...(knowledgeContext.languageKnowledge?.negativeTerms || [])
    ];

    for (const neg of allNegative) {
      if (textMatchesTerm(textBlob, neg)) {
        if (!matchedNegative.includes(neg)) matchedNegative.push(neg);
      }
    }

    if (matchedNegative.length > 0) {
      items.push({
        id: `chan_meta_neg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'channel_metadata',
        polarity: 'NEGATIVE',
        category: 'IRRELEVANT_DOMAIN',
        fact: `Channel metadata contains non-trading / irrelevant domain signals: ${matchedNegative.join(', ')}`,
        rawMatches: matchedNegative,
        confidence: 85,
        reliability: 'HIGH',
        reliabilityMultiplier: 0.85,
        rawWeight: Math.min(35, matchedNegative.length * 15),
        finalWeight: -1 * Math.min(35, matchedNegative.length * 15) * 0.85 * 0.85,
        provenance: {
          provider: 'channel_metadata',
          type: 'IRRELEVANT_DOMAIN',
          matchedTerm: matchedNegative.join(', '),
          sourceRef: 'Channel Title / About Description', fields:fieldsFor(matchedNegative)
        },
        timestamp: now
      });
    }

    return items;
  }
}
