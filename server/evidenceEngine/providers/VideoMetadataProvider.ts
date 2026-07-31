import { EvidenceItem, EvidenceProvider, RawChannelInput, LayeredKnowledgeContext } from '../types';
import { textMatchesTerm } from '../utils/textMatching';
import { isTradingFocusedText } from '../multilingualTerminology';

export class VideoMetadataProvider implements EvidenceProvider {
  name = 'video_metadata' as const;

  availability(input: RawChannelInput) {
    return input.video_titles?.length
      ? { availability: 'AVAILABLE' as const }
      : { availability: 'NOT_APPLICABLE' as const, reason: 'No recent video titles were supplied.' };
  }

  async collectEvidence(input: RawChannelInput, knowledgeContext: LayeredKnowledgeContext): Promise<EvidenceItem[]> {
    const items: EvidenceItem[] = [];
    const titles = input.video_titles || [];
    const descriptions = input.video_descriptions || [];
    const now = new Date().toISOString();

    if (titles.length === 0) {
      return items;
    }

    let tradingFocusedCount = 0;
    const matchedInstrumentsInVideos: string[] = [];
    const matchedPlatformsInVideos: string[] = [];
    const matchedConceptsInVideos: string[] = [];

    for (let i = 0; i < titles.length; i++) {
      const title = titles[i] || '';
      const desc = descriptions[i] || '';
      const combo = `${title} ${desc}`;

      const isTrading = isTradingFocusedText(combo, knowledgeContext);
      if (isTrading) {
        tradingFocusedCount++;
      }

      // Collect specific instrument references
      for (const inst of knowledgeContext.globalInstruments) {
        if (textMatchesTerm(combo, inst) && !matchedInstrumentsInVideos.includes(inst)) {
          matchedInstrumentsInVideos.push(inst);
        }
      }

      // Collect specific platform references
      for (const plat of knowledgeContext.globalPlatformsPropFirms) {
        if (textMatchesTerm(combo, plat) && !matchedPlatformsInVideos.includes(plat)) {
          matchedPlatformsInVideos.push(plat);
        }
      }

      // Collect educational concepts & trading methodology references
      for (const concept of knowledgeContext.globalAdvancedConcepts) {
        if (textMatchesTerm(combo, concept) && !matchedConceptsInVideos.includes(concept)) {
          matchedConceptsInVideos.push(concept);
        }
      }
      for (const langTerm of knowledgeContext.languageKnowledge?.positiveTerms || []) {
        if (textMatchesTerm(combo, langTerm) && !matchedConceptsInVideos.includes(langTerm)) {
          matchedConceptsInVideos.push(langTerm);
        }
      }
      for (const countryTerm of knowledgeContext.countryKnowledge?.nativeTradingTerminology || []) {
        if (textMatchesTerm(combo, countryTerm) && !matchedConceptsInVideos.includes(countryTerm)) {
          matchedConceptsInVideos.push(countryTerm);
        }
      }
    }

    const consistencyRatio = tradingFocusedCount / titles.length;

    // 1. Multi-Video Consistency Evidence
    if (consistencyRatio >= 0.30) {
      const reliabilityMultiplier = consistencyRatio >= 0.6 ? 1.0 : 0.85;
      items.push({
        id: `vid_meta_consist_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'video_metadata',
        polarity: 'POSITIVE',
        category: 'MULTI_VIDEO_CONSISTENCY',
        fact: `Multi-video consistency check: ${tradingFocusedCount}/${titles.length} recent videos (${Math.round(consistencyRatio * 100)}%) focused on trading topics & education`,
        rawMatches: titles.slice(0, 5),
        confidence: Math.round(consistencyRatio * 100),
        reliability: consistencyRatio >= 0.6 ? 'VERY_HIGH' : 'HIGH',
        reliabilityMultiplier,
        rawWeight: Math.round(30 * consistencyRatio),
        finalWeight: Math.round(30 * consistencyRatio) * reliabilityMultiplier,
        provenance: {
          provider: 'video_metadata',
          type: 'MULTI_VIDEO_CONSISTENCY',
          matchedTerm: `${tradingFocusedCount}/${titles.length} videos matching trading terms`,
          sourceRef: 'Sample Video Titles'
        },
        timestamp: now
      });
    }

    // 2. Specific Instrument References in Video Uploads
    if (matchedInstrumentsInVideos.length > 0) {
      items.push({
        id: `vid_meta_inst_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'video_metadata',
        polarity: 'POSITIVE',
        category: 'INSTRUMENT',
        fact: `Recent video uploads cover financial instruments: ${matchedInstrumentsInVideos.join(', ')}`,
        rawMatches: matchedInstrumentsInVideos,
        confidence: 90,
        reliability: 'VERY_HIGH',
        reliabilityMultiplier: 1.0,
        rawWeight: Math.min(25, matchedInstrumentsInVideos.length * 10),
        finalWeight: Math.min(25, matchedInstrumentsInVideos.length * 10) * 1.0 * 0.90,
        provenance: {
          provider: 'video_metadata',
          type: 'INSTRUMENT',
          matchedTerm: matchedInstrumentsInVideos.join(', '),
          sourceRef: 'Sample Video Titles & Descriptions'
        },
        timestamp: now
      });
    }

    // 3. Specific Platform/Broker References in Video Uploads
    if (matchedPlatformsInVideos.length > 0) {
      items.push({
        id: `vid_meta_plat_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'video_metadata',
        polarity: 'POSITIVE',
        category: 'PLATFORM_BROKER_PROPFIRM',
        fact: `Recent video uploads reference platforms/prop firms: ${matchedPlatformsInVideos.join(', ')}`,
        rawMatches: matchedPlatformsInVideos,
        confidence: 95,
        reliability: 'VERY_HIGH',
        reliabilityMultiplier: 1.0,
        rawWeight: Math.min(30, matchedPlatformsInVideos.length * 15),
        finalWeight: Math.min(30, matchedPlatformsInVideos.length * 15) * 1.0 * 0.95,
        provenance: {
          provider: 'video_metadata',
          type: 'PLATFORM_BROKER_PROPFIRM',
          matchedTerm: matchedPlatformsInVideos.join(', '),
          sourceRef: 'Sample Video Titles & Descriptions'
        },
        timestamp: now
      });
    }

    // 4. Educational Concepts & Methodology in Video Uploads
    if (matchedConceptsInVideos.length > 0) {
      items.push({
        id: `vid_meta_concept_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'video_metadata',
        polarity: 'POSITIVE',
        category: 'METHODOLOGY_CONCEPT',
        fact: `Recent video titles & descriptions demonstrate educational trading concepts: ${matchedConceptsInVideos.join(', ')}`,
        rawMatches: matchedConceptsInVideos,
        confidence: 90,
        reliability: 'HIGH',
        reliabilityMultiplier: 0.90,
        rawWeight: Math.min(25, matchedConceptsInVideos.length * 8),
        finalWeight: Math.min(25, matchedConceptsInVideos.length * 8) * 0.90 * 0.90,
        provenance: {
          provider: 'video_metadata',
          type: 'METHODOLOGY_CONCEPT',
          matchedTerm: matchedConceptsInVideos.join(', '),
          sourceRef: 'Sample Video Titles & Descriptions'
        },
        timestamp: now
      });
    }

    return items;
  }
}
