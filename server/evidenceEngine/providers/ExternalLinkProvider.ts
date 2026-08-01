import { EvidenceItem, EvidenceProvider, RawChannelInput, LayeredKnowledgeContext } from '../types';

export class ExternalLinkProvider implements EvidenceProvider {
  name = 'external_links' as const;

  availability(input: RawChannelInput) {
    return input.external_links?.length
      ? { availability: 'AVAILABLE' as const }
      : { availability: 'NOT_APPLICABLE' as const, reason: 'No external links were supplied.' };
  }

  async collectEvidence(input: RawChannelInput, knowledgeContext: LayeredKnowledgeContext): Promise<EvidenceItem[]> {
    const items: EvidenceItem[] = [];
    const links = input.external_links || [];
    const now = new Date().toISOString();
    const fieldsFor=(values:string[])=>(input.external_link_details||[]).flatMap((detail,index)=>values.some(value=>detail.url.toLocaleLowerCase('und').includes(value.toLocaleLowerCase('und'))||detail.domain?.toLocaleLowerCase('und')===value.toLocaleLowerCase('und'))?[{field:'external_link_domain' as const,index,sourceId:detail.url,sourceFamilyId:detail.source_family_id,sourceEntityId:detail.source_entity_id}]:[]);

    if (links.length === 0) {
      return items;
    }

    const matchedTradingSites: string[] = [];
    const matchedPropFirms: string[] = [];
    const matchedBrokers: string[] = [];

    const TRADING_DOMAINS = [
      'tradingview.com', 'ninjatrader.com', 'sierrachart.com', 'quantower.com', 'metatrader4.com',
      'metatrader5.com', 'tradovate.com', 'topstep.com', 'apextraderfunding.com', 'ftmo.com',
      'fundingpips.com', 'myfundedfx.com', 'thefundedtrader.com', 'interactivebrokers.com',
      'tastytrade.com', 'thinkorswim.com', 'binance.com', 'bybit.com'
    ];

    for (const link of links) {
      const l = link.toLowerCase();
      for (const domain of TRADING_DOMAINS) {
        if (l.includes(domain)) {
          if (!matchedTradingSites.includes(domain)) matchedTradingSites.push(domain);
        }
      }

      if (l.includes('topstep') || l.includes('apex') || l.includes('ftmo') || l.includes('funding')) {
        if (!matchedPropFirms.includes(link)) matchedPropFirms.push(link);
      }
    }

    if (matchedTradingSites.length > 0) {
      items.push({
        id: `ext_link_domain_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'external_links',
        polarity: 'POSITIVE',
        category: 'EXTERNAL_RESOURCE',
        fact: `Verified links to official trading tools/platforms: ${matchedTradingSites.join(', ')}`,
        rawMatches: matchedTradingSites,
        confidence: 95,
        reliability: 'VERY_HIGH',
        reliabilityMultiplier: 1.0,
        rawWeight: Math.min(30, matchedTradingSites.length * 15),
        finalWeight: Math.min(30, matchedTradingSites.length * 15) * 1.0 * 0.95,
        provenance: {
          provider: 'external_links',
          type: 'EXTERNAL_RESOURCE',
          matchedTerm: matchedTradingSites.join(', '),
          sourceRef: 'Channel External Links',fields:fieldsFor(matchedTradingSites)
        },
        timestamp: now
      });
    }

    if (matchedPropFirms.length > 0 && matchedTradingSites.length === 0) {
      items.push({
        id: `ext_link_prop_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        source: 'external_links',
        polarity: 'POSITIVE',
        category: 'PLATFORM_BROKER_PROPFIRM',
        fact: `External links reference prop firm trading evaluations`,
        rawMatches: matchedPropFirms.slice(0, 3),
        confidence: 90,
        reliability: 'HIGH',
        reliabilityMultiplier: 0.85,
        rawWeight: 20,
        finalWeight: 20 * 0.85 * 0.90,
        provenance: {
          provider: 'external_links',
          type: 'PLATFORM_BROKER_PROPFIRM',
          matchedTerm: matchedPropFirms.slice(0, 2).join(', '),
          sourceRef: 'Channel External Links',fields:fieldsFor(matchedPropFirms)
        },
        timestamp: now
      });
    }

    return items;
  }
}
