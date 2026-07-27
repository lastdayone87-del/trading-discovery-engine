import { GoogleGenAI } from '@google/genai';
import { EvidenceItem, EvidenceProvider, RawChannelInput, LayeredKnowledgeContext } from '../types';

let aiClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI | null {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (key) {
      aiClient = new GoogleGenAI({ apiKey: key });
    }
  }
  return aiClient;
}

async function callGeminiSafe<T>(promptFn: () => Promise<T>): Promise<T> {
  try {
    return await promptFn();
  } catch (e: any) {
    const errStr = String(e?.message || e || '');
    if (errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED') || errStr.includes('quota') || errStr.includes('high demand')) {
      // Throw fast so rule-based evidence engine proceeds deterministically without 10-second delays
      const fastErr = new Error('QUOTA_LIMIT_429');
      (fastErr as any).isQuota = true;
      throw fastErr;
    }
    throw e;
  }
}

export class GeminiSemanticProvider implements EvidenceProvider {
  name = 'gemini_semantic' as const;

  async collectEvidence(input: RawChannelInput, knowledgeContext: LayeredKnowledgeContext): Promise<EvidenceItem[]> {
    const items: EvidenceItem[] = [];
    const ai = getGenAI();
    const now = new Date().toISOString();

    if (!ai) {
      return items;
    }

    const modelName = 'gemini-3.6-flash';
    const countryName = input.country || knowledgeContext.countryKnowledge?.countryName || 'UNKNOWN';
    const langName = knowledgeContext.languageKnowledge?.languageName || 'English';

    const prompt = `You are an OSINT Financial Market Intelligence Auditor extracting evidence from a YouTube creator.
Your role is to EXTRACT STRUCTURED SEMANTIC EVIDENCE from the content to determine if this creator is actively focused on FINANCIAL MARKET TRADING (futures, forex, stock options, crypto futures, technical analysis, price action, or prop firm trading).

==================================================
COUNTRY & LOCAL MARKET CONTEXT
==================================================
Target Region: ${countryName}
Primary Language: ${langName}
Known Local Exchanges / Terms: ${knowledgeContext.countryKnowledge?.regionalExchanges.join(', ') || 'Global'}

==================================================
CREATOR METADATA TO ANALYZE
==================================================
Channel Name: "${input.channel_name}"
Description: "${(input.description || '').slice(0, 1200)}"
Recent Video Titles:
${(input.video_titles || []).slice(0, 10).map(t => `- ${t}`).join('\n') || '- (None)'}
Video Content Snippet:
"${(input.video_descriptions || []).join(' ').slice(0, 600)}"

Respond strictly with a JSON object in this exact schema:
{
  "isTrading": "YES" | "NO" | "UNCERTAIN",
  "confidenceScore": number (0 to 100),
  "concepts": string[],
  "instruments": string[],
  "contradictorySignals": string[],
  "reason": "Clear single-sentence explanation of detected evidence."
}`;

    try {
      const response = await callGeminiSafe(() => ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: { responseMimeType: 'application/json' }
      }));

      const resText = response.text || '';
      if (resText) {
        const parsed = JSON.parse(resText);
        const confidence = typeof parsed.confidenceScore === 'number' ? parsed.confidenceScore : 75;
        const isTrading = parsed.isTrading || 'UNCERTAIN';
        const concepts = Array.isArray(parsed.concepts) ? parsed.concepts : [];
        const instruments = Array.isArray(parsed.instruments) ? parsed.instruments : [];
        const contradictory = Array.isArray(parsed.contradictorySignals) ? parsed.contradictorySignals : [];
        const reason = parsed.reason || 'Gemini OSINT semantic analysis complete.';

        if (isTrading === 'YES') {
          items.push({
            id: `gemini_pos_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            source: 'gemini_semantic',
            polarity: 'POSITIVE',
            category: 'METHODOLOGY_CONCEPT',
            fact: `AI OSINT Evidence: ${reason} (Detected: ${[...concepts, ...instruments].slice(0, 5).join(', ')})`,
            rawMatches: [...concepts, ...instruments],
            confidence,
            reliability: 'MEDIUM',
            reliabilityMultiplier: 0.65,
            rawWeight: 25,
            finalWeight: 25 * 0.65 * (confidence / 100),
            provenance: {
              provider: 'gemini_semantic',
              type: 'METHODOLOGY_CONCEPT',
              matchedTerm: [...concepts, ...instruments].slice(0, 5).join(', ') || 'Trading Concepts',
              sourceRef: `Gemini OSINT Audit (${modelName})`
            },
            timestamp: now
          });
        } else if (isTrading === 'NO') {
          items.push({
            id: `gemini_neg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            source: 'gemini_semantic',
            polarity: 'NEGATIVE',
            category: 'IRRELEVANT_DOMAIN',
            fact: `AI OSINT Negative Signal: ${reason} (Contradictory signals: ${contradictory.join(', ')})`,
            rawMatches: contradictory,
            confidence,
            reliability: 'MEDIUM',
            reliabilityMultiplier: 0.65,
            rawWeight: 30,
            finalWeight: -1 * 30 * 0.65 * (confidence / 100),
            provenance: {
              provider: 'gemini_semantic',
              type: 'IRRELEVANT_DOMAIN',
              matchedTerm: contradictory.slice(0, 5).join(', ') || 'Non-Trading Domain',
              sourceRef: `Gemini OSINT Audit (${modelName})`
            },
            timestamp: now
          });
        } else {
          items.push({
            id: `gemini_unc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            source: 'gemini_semantic',
            polarity: 'POSITIVE',
            category: 'TERMINOLOGY',
            fact: `AI OSINT Semantic Audit: Creator focus is uncertain or ambiguous. ${reason}`,
            rawMatches: [],
            confidence: 50,
            reliability: 'LOWER',
            reliabilityMultiplier: 0.40,
            rawWeight: 5,
            finalWeight: 5 * 0.40 * 0.50,
            provenance: {
              provider: 'gemini_semantic',
              type: 'AMBIGUOUS',
              matchedTerm: 'Ambiguous Signal',
              sourceRef: `Gemini OSINT Audit (${modelName})`
            },
            timestamp: now
          });
        }
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota')) {
        console.warn('[GeminiSemanticProvider] Gemini API quota limit reached (429). Proceeding deterministically with rule-based evidence.');
      } else {
        console.warn('[GeminiSemanticProvider] Gemini notice:', msg.length > 120 ? msg.slice(0, 120) + '...' : msg);
      }
    }

    return items;
  }
}
