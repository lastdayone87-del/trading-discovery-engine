import { GoogleGenAI } from '@google/genai';
import { appendProviderCallEvent } from '../../db';
import { executeProviderCall, ProviderCallError, resolveGeminiRouteId } from '../../providerResilience';
import { calibrateSemanticConfidence, SEMANTIC_CALIBRATION_VERSION } from '../semanticCalibration';
import type { EvidenceCategory, EvidenceFieldRef, EvidenceItem, EvidenceProvider, LayeredKnowledgeContext, RawChannelInput } from '../types';
import { documentRef } from '../canonicalEvidencePlane';

export const SEMANTIC_PROMPT_VERSION = 'priority2-multilingual-structured-1';
export const SEMANTIC_FEATURE_VERSION = 'field-aware-evidence-1';
export const SEMANTIC_TAXONOMY = ['ACTIVE_TRADING', 'INVESTING_EDUCATION', 'FINANCIAL_NEWS', 'PERSONAL_FINANCE', 'HYPE', 'UNRELATED', 'AMBIGUOUS'] as const;
export const DEFAULT_MULTILINGUAL_CANDIDATE_MODEL = 'gemini-3.6-flash';
export const DEFAULT_MULTILINGUAL_ADJUDICATOR_MODEL = 'gemini-3.6-flash';
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

export interface GeminiRoute { id: string; key: string; }

/** Return only ordered, non-empty route slots; credentials never leave this process. */
export function configuredGeminiRoutes(env: NodeJS.ProcessEnv = process.env): GeminiRoute[] {
  const names = Object.keys(env).filter(name => name === 'GEMINI_API_KEY' || /^GEMINI_API_KEY_[2-9][0-9]*$/.test(name));
  names.sort((a, b) => {
    const routeNumber = (name: string) => name === 'GEMINI_API_KEY' ? 1 : Number(name.slice('GEMINI_API_KEY_'.length));
    return routeNumber(a) - routeNumber(b);
  });
  const seen = new Set<string>();
  return names.flatMap(name => {
    const key = String(env[name] || '').trim();
    if (!key || seen.has(key)) return [];
    seen.add(key);
    const numeric = name === 'GEMINI_API_KEY' ? 1 : Number(name.slice('GEMINI_API_KEY_'.length));
    return [{ id: resolveGeminiRouteId(`gemini-${numeric}`), key }];
  });
}

export async function runGeminiRouteFailover<T>(routes: GeminiRoute[], call: (route: GeminiRoute) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const route of routes) {
    try {
      return await call(route);
    } catch (error) {
      lastError = error;
      if (!(error instanceof ProviderCallError) || !error.retryable) throw error;
    }
  }
  throw lastError || new ProviderCallError('No configured Gemini route is available.','TRANSIENT',true,{providerReasons:['GEMINI_ROUTE_POOL_EXHAUSTED']});
}

const sdkByRoute = new Map<string, GoogleGenAI>();
function defaultClient(): SemanticModelClient | undefined {
  const routes = configuredGeminiRoutes();
  if (!routes.length) return undefined;
  const sdkFor = (route: GeminiRoute) => {
    const existing = sdkByRoute.get(route.id);
    if (existing) return existing;
    const created = new GoogleGenAI({ apiKey: route.key });
    sdkByRoute.set(route.id, created);
    return created;
  };
  return { classify: async (prompt, model) => {
    const response = await runGeminiRouteFailover(routes, route => executeProviderCall({
      context: { provider: 'gemini', operation: 'multilingual-semantic-classification', requestMetadata: { geminiRoute: route.id } },
      timeoutMs: Number(process.env.GEMINI_PROVIDER_TIMEOUT_MS || '135000'),
      enabled: process.env.PROVIDER_DEADLINES_ENABLED !== 'false', emit: appendProviderCallEvent,
      call: (signal) => sdkFor(route).models.generateContent({ model, contents: prompt, config: { responseMimeType: 'application/json', temperature: 0, abortSignal: signal } })
    }));
    return JSON.parse(response.text || '{}');
  }};
}

function fieldDocuments(input: RawChannelInput) {
  if(input.evidence_corpus?.length)return input.evidence_corpus.filter(document=>!['activity_metadata','search_match_context','country','language'].includes(document.field)).slice(0,40).map(document=>({ref:documentRef(document),text:document.text}));
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

function hasCreatorLevelSemanticContext(input: RawChannelInput): boolean {
  const retrievalOnly = !!input.search_match_context && (input.enrichment_stage || 0) === 0;
  if (!retrievalOnly) return true;
  return (input.description?.trim().length || 0) >= 20 ||
    (input.external_links?.length || 0) > 0 ||
    (input.playlists?.length || 0) > 0 ||
    (input.transcript_excerpts?.length || 0) > 0 ||
    (input.videos?.length || 0) > 0;
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

async function classifyCandidateWith404Fallback(client: SemanticModelClient, candidatePrompt: string, candidateModel: string, fallbackModel: string) {
  try {
    return { value: await client.classify(candidatePrompt, candidateModel), model: candidateModel, fallbackUsed: false };
  } catch (error) {
    const isModel404 = error instanceof ProviderCallError && error.errorClass === 'PERMANENT_INPUT' && error.status === 404;
    if (!isModel404 || candidateModel === fallbackModel) throw error;
    console.warn('[Gemini Semantic] Candidate model returned 404; retrying once with configured adjudicator model.', { candidateModel, fallbackModel });
    return { value: await client.classify(candidatePrompt, fallbackModel), model: fallbackModel, fallbackUsed: true };
  }
}

export class GeminiSemanticProvider implements EvidenceProvider {
  name = 'gemini_semantic' as const;
  constructor(private readonly injectedClient?: SemanticModelClient) {}
  private client() { return this.injectedClient || defaultClient(); }
  availability(input: RawChannelInput) {
    if (!this.client()) return { availability: 'UNAVAILABLE' as const, reason: 'GEMINI_API_KEY is not configured.' };
    if (!hasCreatorLevelSemanticContext(input)) {
      return { availability: 'NOT_APPLICABLE' as const, reason: 'Retrieval-only candidate has no independent creator-level semantic context yet.' };
    }
    return { availability: 'AVAILABLE' as const };
  }

  async collectEvidence(input: RawChannelInput, _knowledge: LayeredKnowledgeContext): Promise<EvidenceItem[]> {
    const client = this.client();
    if (!client) return [];
    const candidateModel = process.env.MULTILINGUAL_CANDIDATE_MODEL || DEFAULT_MULTILINGUAL_CANDIDATE_MODEL;
    const adjudicatorModel = process.env.MULTILINGUAL_ADJUDICATOR_MODEL || DEFAULT_MULTILINGUAL_ADJUDICATOR_MODEL;
    const candidatePrompt = prompt(input, 'CANDIDATE');
    const candidate = await classifyCandidateWith404Fallback(client, candidatePrompt, candidateModel, adjudicatorModel);
    let result = parse(candidate.value);
    let model = candidate.model;
    const fallbackReasonCodes = candidate.fallbackUsed ? ['SEMANTIC_CANDIDATE_MODEL_404_FALLBACK'] : [];
    if (result.supportedLanguage && (result.label === 'AMBIGUOUS' || result.confidence < 70) && process.env.MULTILINGUAL_ADJUDICATION_ENABLED === 'true' && model !== adjudicatorModel) {
      result = parse(await client.classify(prompt(input, 'ADJUDICATION'), adjudicatorModel)); model = adjudicatorModel;
    }
    const calibrated = calibrateSemanticConfidence(result.confidence);
    const abstained = !result.supportedLanguage || result.label === 'AMBIGUOUS' || calibrated < 50 || result.citations.length === 0;
    const positive = result.label === 'ACTIVE_TRADING' || result.label === 'INVESTING_EDUCATION';
    const category: EvidenceCategory = abstained ? 'SEMANTIC_ABSTENTION' : positive ? 'METHODOLOGY_CONCEPT' : result.label === 'HYPE' ? 'HYPE_SPECULATION' : result.label === 'UNRELATED' ? 'IRRELEVANT_DOMAIN' : 'NON_TRADING_ADJACENT';
    const rawWeight = abstained ? 0 : positive ? 24 : 26;
    const finalWeight = abstained ? 0 : rawWeight * .65 * (calibrated / 100) * (positive ? 1 : -1);
    const semantic = { modelVersion: model, promptVersion: SEMANTIC_PROMPT_VERSION, featureVersion: SEMANTIC_FEATURE_VERSION, calibrationVersion: SEMANTIC_CALIBRATION_VERSION, taxonomyLabel: result.label, rawConfidence: result.confidence, calibratedConfidence: calibrated, detectedLanguages: result.languages, reasonCodes: [...fallbackReasonCodes, ...result.reasonCodes, ...(abstained ? ['SEMANTIC_MODEL_ABSTAINED'] : [])] };
    const citations=result.citations.map(ref=>{const video=ref.field==='video_title'||ref.field==='video_description'?input.videos?.[ref.index||0]:undefined,family=video?.source_family_id||(ref.field==='channel_title'||ref.field==='channel_bio'?input.channel_source_family_id:undefined),entity=video?.source_entity_id||((video||ref.field==='channel_title'||ref.field==='channel_bio')?input.channel_entity_id:undefined);return {...ref,...(family?{sourceFamilyId:family}:{}),...(entity?{sourceEntityId:entity}:{})};});
    return [{
      id: `semantic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, source: this.name, polarity: positive || abstained ? 'POSITIVE' : 'NEGATIVE', category,
      fact: `Multilingual semantic evidence [${result.label}]: ${result.explanation}`, rawMatches: abstained ? [] : result.concepts,
      confidence: calibrated, reliability: abstained ? 'LOWER' : 'MEDIUM', reliabilityMultiplier: abstained ? .4 : .65, rawWeight, finalWeight,
      provenance: { provider: this.name, type: category, matchedTerm: result.concepts.join(', ') || result.label, sourceRef: `structured-semantic:${model}`, fields: citations, semantic }, timestamp: new Date().toISOString()
    }];
  }
}
