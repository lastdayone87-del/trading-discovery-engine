import { GoogleGenAI } from '@google/genai';
import { appendProviderCallEvent } from '../../db';
import { executeProviderCall } from '../../providerResilience';
import { calibrateSemanticConfidence, SEMANTIC_CALIBRATION_VERSION } from '../semanticCalibration';
import type { EvidenceCategory, EvidenceFieldRef, EvidenceItem, EvidenceProvider, LayeredKnowledgeContext, RawChannelInput } from '../types';
import { documentRef } from '../canonicalEvidencePlane';

export const SEMANTIC_PROMPT_VERSION = 'priority2-multilingual-structured-1';
export const SEMANTIC_FEATURE_VERSION = 'field-aware-evidence-1';
export const SEMANTIC_TAXONOMY = ['ACTIVE_TRADING', 'INVESTING_EDUCATION', 'FINANCIAL_NEWS', 'PERSONAL_FINANCE', 'HYPE', 'UNRELATED', 'AMBIGUOUS'] as const;
type SemanticLabel = typeof SEMANTIC_TAXONOMY[number];

export interface SemanticModelResult {
  label: SemanticLabel;
  confidence: number;
  supportedLanguage: boolean;
  reasonCodes: string[];
  explanation: string;
  concepts: string[];
  languages: Array<{ language: string; script: string; confidence: number; field: EvidenceFieldRef['field'] }>;
  citations: EvidenceFieldRef[];
}

export interface SemanticModelClient {
  classify(prompt: string, model: string): Promise<unknown>;
}

let sdk: GoogleGenAI | undefined;
function defaultClient(): SemanticModelClient | undefined {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return undefined;
  sdk ||= new GoogleGenAI({ apiKey: key });
  return { classify: async (prompt, model) => {
    const response = await executeProviderCall({
      context: { provider: 'gemini', operation: 'multilingual-semantic-classification' },
      timeoutMs: Number(process.env.GEMINI_PROVIDER_TIMEOUT_MS || '45000'),
      enabled: process.env.PROVIDER_DEADLINES_ENABLED === 'true', emit: appendProviderCallEvent,
      call: () => sdk!.models.generateContent({ model, contents: prompt, config: { responseMimeType: 'application/json', temperature: 0 } })
    });
    return JSON.parse(response.text || '{}');
  }};
}

function fieldDocuments(input: RawChannelInput) {
  if(input.evidence_corpus?.length)return input.evidence_corpus.filter(document=>document.field!=='activity_metadata').slice(0,40).map(document=>({ref:documentRef(document),text:document.text}));
  return [
    { ref: { field: 'channel_title' as const }, text: input.channel_name },
    { ref: { field: 'channel_bio' as const }, text: input.description },
    ...(input.videos || (input.video_titles || []).map((title, index) => ({ title, description: input.video_descriptions?.[index] }))).slice(0, 12).flatMap((video, index) => [
      { ref: { field: 'video_title' as const, index, sourceId: 'id' in video ? video.id : undefined, publishedAt: 'published_at' in video ? video.published_at : undefined }, text: video.title },
      { ref: { field: 'video_description' as const, index, sourceId: 'id' in video ? video.id : undefined }, text: video.description || '' }
    ]),
    ...(input.playlists || []).slice(0, 6).flatMap((playlist, index) => [
      { ref: { field: 'playlist_name' as const, index, sourceId: playlist.id }, text: playlist.name },
      { ref: { field: 'playlist_description' as const, index, sourceId: playlist.id }, text: playlist.description || '' }
    ]),
    ...(input.transcript_excerpts || []).slice(0, 4).map((excerpt, index) => ({ ref: { field: 'transcript_excerpt' as const, index, sourceId: excerpt.video_id }, text: excerpt.text }))
  ].filter(document => document.text?.trim()).map(document => ({ ...document, text: document.text.slice(0, 1200) }));
}

function prompt(input: RawChannelInput, tier: 'CANDIDATE' | 'ADJUDICATION') {
  return JSON.stringify({
    task: tier, promptVersion: SEMANTIC_PROMPT_VERSION, closedTaxonomy: SEMANTIC_TAXONOMY,
    instructions: [
      'Infer meaning across languages, scripts, transliteration, loanwords, and code-switching.',
      'Classify creator focus, not isolated keywords. Cite only supplied field references.',
      'Set supportedLanguage=false and label=AMBIGUOUS when meaning cannot be reliably interpreted.',
      'Distinguish active trading, investing education, financial news, personal finance, hype, and unrelated content.',
      'Return JSON with label, confidence 0..100, supportedLanguage, reasonCodes, explanation, concepts, languages, citations.'
    ],
    declaredCountry: input.country || null, declaredLanguageHints: input.detected_languages || [], documents: fieldDocuments(input)
  });
}

function parse(value: any): SemanticModelResult {
  const label = SEMANTIC_TAXONOMY.includes(value?.label) ? value.label : 'AMBIGUOUS';
  const fields = new Set(['channel_title','channel_bio','video_title','video_description','playlist_name','playlist_description','external_link_label','external_link_domain','country','language','transcript_excerpt','visual_evidence','discord_invite']);
  return {
    label, confidence: Math.max(0, Math.min(100, Number(value?.confidence) || 0)), supportedLanguage: value?.supportedLanguage === true,
    reasonCodes: Array.isArray(value?.reasonCodes) ? value.reasonCodes.map(String).slice(0, 8) : [],
    explanation: String(value?.explanation || 'Semantic model abstained.'), concepts: Array.isArray(value?.concepts) ? value.concepts.map(String).slice(0, 12) : [],
    languages: Array.isArray(value?.languages) ? value.languages.filter((x: any) => fields.has(x?.field)).map((x: any) => ({ language: String(x.language), script: String(x.script), confidence: Math.max(0, Math.min(100, Number(x.confidence) || 0)), field: x.field })) : [],
    citations: Array.isArray(value?.citations) ? value.citations.filter((x: any) => fields.has(x?.field)).map((x: any) => ({ field: x.field, index: Number.isInteger(x.index) ? x.index : undefined, sourceId: x.sourceId ? String(x.sourceId) : undefined })) : []
  };
}

export class GeminiSemanticProvider implements EvidenceProvider {
  name = 'gemini_semantic' as const;
  constructor(private readonly injectedClient?: SemanticModelClient) {}
  private client() { return this.injectedClient || defaultClient(); }
  availability() { return this.client() ? { availability: 'AVAILABLE' as const } : { availability: 'UNAVAILABLE' as const, reason: 'GEMINI_API_KEY is not configured.' }; }

  async collectEvidence(input: RawChannelInput, _knowledge: LayeredKnowledgeContext): Promise<EvidenceItem[]> {
    const client = this.client();
    if (!client) return [];
    const candidateModel = process.env.MULTILINGUAL_CANDIDATE_MODEL || 'gemini-2.5-flash-lite';
    const adjudicatorModel = process.env.MULTILINGUAL_ADJUDICATOR_MODEL || 'gemini-2.5-flash';
    let result = parse(await client.classify(prompt(input, 'CANDIDATE'), candidateModel));
    let model = candidateModel;
    if (result.supportedLanguage && (result.label === 'AMBIGUOUS' || result.confidence < 70) && process.env.MULTILINGUAL_ADJUDICATION_ENABLED === 'true') {
      result = parse(await client.classify(prompt(input, 'ADJUDICATION'), adjudicatorModel)); model = adjudicatorModel;
    }
    const calibrated = calibrateSemanticConfidence(result.confidence);
    const abstained = !result.supportedLanguage || result.label === 'AMBIGUOUS' || calibrated < 50 || result.citations.length === 0;
    const positive = result.label === 'ACTIVE_TRADING' || result.label === 'INVESTING_EDUCATION';
    const category: EvidenceCategory = abstained ? 'SEMANTIC_ABSTENTION' : positive ? 'METHODOLOGY_CONCEPT' : result.label === 'HYPE' ? 'HYPE_SPECULATION' : result.label === 'UNRELATED' ? 'IRRELEVANT_DOMAIN' : 'NON_TRADING_ADJACENT';
    const rawWeight = abstained ? 0 : positive ? 24 : 26;
    const finalWeight = abstained ? 0 : rawWeight * .65 * (calibrated / 100) * (positive ? 1 : -1);
    const semantic = { modelVersion: model, promptVersion: SEMANTIC_PROMPT_VERSION, featureVersion: SEMANTIC_FEATURE_VERSION, calibrationVersion: SEMANTIC_CALIBRATION_VERSION, taxonomyLabel: result.label, rawConfidence: result.confidence, calibratedConfidence: calibrated, detectedLanguages: result.languages, reasonCodes: [...result.reasonCodes, ...(abstained ? ['SEMANTIC_MODEL_ABSTAINED'] : [])] };
    const citations=result.citations.map(ref=>{const video=ref.field==='video_title'||ref.field==='video_description'?input.videos?.[ref.index||0]:undefined,family=video?.source_family_id||(ref.field==='channel_title'||ref.field==='channel_bio'?input.channel_source_family_id:undefined),entity=video?.source_entity_id||((video||ref.field==='channel_title'||ref.field==='channel_bio')?input.channel_entity_id:undefined);return {...ref,...(family?{sourceFamilyId:family}:{}),...(entity?{sourceEntityId:entity}:{})};});
    return [{
      id: `semantic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, source: this.name, polarity: positive || abstained ? 'POSITIVE' : 'NEGATIVE', category,
      fact: `Multilingual semantic evidence [${result.label}]: ${result.explanation}`, rawMatches: abstained ? [] : result.concepts,
      confidence: calibrated, reliability: abstained ? 'LOWER' : 'MEDIUM', reliabilityMultiplier: abstained ? .4 : .65, rawWeight, finalWeight,
      provenance: { provider: this.name, type: category, matchedTerm: result.concepts.join(', ') || result.label, sourceRef: `structured-semantic:${model}`, fields: citations, semantic }, timestamp: new Date().toISOString()
    }];
  }
}
