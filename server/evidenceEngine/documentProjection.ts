import { createHash } from 'node:crypto';
import type { EvidenceFieldType, EvidenceItem, RawChannelInput } from './types';
import type { CanonicalEvidenceDocument } from './canonicalEvidencePlane';
import {
  EVIDENCE_ASSERTION_SCHEMA_VERSION, EVIDENCE_DOCUMENT_SCHEMA_VERSION,
  type EvidenceAssertionObservation, type EvidenceDocumentObservation, type EvidenceDocumentType
} from './documentTypes';

const stable = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item
);
export const evidenceDocumentChecksum = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
function uuid(scope: string, value: string) {
  const hash = evidenceDocumentChecksum(`${scope}|${value}`).split('');
  hash[12] = '5'; hash[16] = ((parseInt(hash[16], 16) & 3) | 8).toString(16);
  return `${hash.slice(0, 8).join('')}-${hash.slice(8, 12).join('')}-${hash.slice(12, 16).join('')}-${hash.slice(16, 20).join('')}-${hash.slice(20, 32).join('')}`;
}

const documentType: Record<EvidenceFieldType, EvidenceDocumentType> = {
  channel_title: 'CHANNEL_TITLE', channel_bio: 'CHANNEL_ABOUT', video_title: 'VIDEO_TITLE', video_description: 'VIDEO_DESCRIPTION',
  playlist_name: 'PLAYLIST_TITLE', playlist_description: 'PLAYLIST_DESCRIPTION', external_link_label: 'EXTERNAL_LINK',
  external_link_domain: 'EXTERNAL_LINK', country: 'LOCATION', language: 'LOCATION', transcript_excerpt: 'TRANSCRIPT_EXCERPT',
  visual_evidence: 'VISUAL_OBSERVATION', discord_invite: 'COMMUNITY_METADATA', pinned_comment: 'PINNED_COMMENT',
  activity_metadata: 'ACTIVITY_METADATA', location: 'LOCATION', search_match_context: 'SEARCH_MATCH_CONTEXT'
};
const providerFor = (field: EvidenceFieldType) => field === 'discord_invite' ? 'discord'
  : field.startsWith('external_link') ? 'external-link' : field === 'visual_evidence' ? 'visual-provider'
    : field === 'country' || field === 'language' || field === 'location' ? 'declared-context' : 'youtube';

export function projectEvidenceDocuments(input: RawChannelInput, corpus: CanonicalEvidenceDocument[], observedAt: string): EvidenceDocumentObservation[] {
  const channelId = input.channel_id || `unknown:${evidenceDocumentChecksum({ name: input.channel_name, country: input.country }).slice(0, 24)}`;
  const subjectEntityId = input.channel_entity_id || uuid('channel', channelId);
  return corpus.map(document => {
    const normalizedText = document.text.normalize('NFKC').trim(), provider = providerFor(document.field), providerNativeId = document.providerNativeId;
    const canonicalLocator = { field: document.field, index: document.index ?? null, providerNativeId: providerNativeId || null, canonicalDocumentId: document.id };
    const textChecksum = evidenceDocumentChecksum(normalizedText);
    const rawPayloadChecksum = evidenceDocumentChecksum({ text: document.text, language: document.language, script: document.script, publishedAt: document.publishedAt, contentType: document.contentType, provenance: document.provenance });
    const keyInput = { subjectEntityId, documentType: documentType[document.field], canonicalLocator, sourceFamilyId: document.sourceFamilyId, textChecksum, rawPayloadChecksum, publishedAt: document.publishedAt || null, schema: EVIDENCE_DOCUMENT_SCHEMA_VERSION };
    return {
      documentKey: evidenceDocumentChecksum(keyInput), canonicalDocumentId: document.id, subjectEntityId, channelId,
      documentType: documentType[document.field], provider, providerNativeId, canonicalLocator,
      sourceFamilyId: document.sourceFamilyId, sourceEntityId: document.sourceEntityId, language: document.language,
      script: document.script, contentType: document.contentType, publishedAt: document.publishedAt, observedAt,
      normalizedText, textChecksum, rawPayloadChecksum,
      provenance: { field: document.field, index: document.index ?? null, source: 'canonical-evidence-plane', ...(document.provenance || {}) },
      schemaVersion: EVIDENCE_DOCUMENT_SCHEMA_VERSION
    };
  });
}

function supportingDocuments(item: EvidenceItem, documents: EvidenceDocumentObservation[]) {
  const fields = item.provenance?.fields || [];
  return documents.filter(document => fields.some(ref => {
    const provenance = document.provenance as { field?: string; index?: number | null };
    return provenance.field === ref.field && (ref.index === undefined || provenance.index === ref.index)
      && (ref.sourceFamilyId === undefined || document.sourceFamilyId === ref.sourceFamilyId)
      && (ref.sourceId === undefined || document.canonicalDocumentId === ref.sourceId || document.providerNativeId === ref.sourceId);
  }));
}

export function projectEvidenceAssertions(input: RawChannelInput, evidence: EvidenceItem[], documents: EvidenceDocumentObservation[], observedAt: string): EvidenceAssertionObservation[] {
  const channelId = documents[0]?.channelId || input.channel_id || 'unknown';
  const subjectEntityId = documents[0]?.subjectEntityId || input.channel_entity_id || uuid('channel', channelId);
  return evidence.flatMap(item => {
    const isAbstention = item.category === 'SEMANTIC_ABSTENTION';
    if (!item.rawMatches.length && !isAbstention) return [];
    const supporting = supportingDocuments(item, documents);
    if (!supporting.length) return [];
    const documentKeys = [...new Set(supporting.map(document => document.documentKey))].sort();
    const sourceFamilyIds = [...new Set(supporting.map(document => document.sourceFamilyId))].sort();
    const semantic = item.provenance?.semantic;
    const assertionInput = {
      subjectEntityId, provider: item.source, category: item.category, polarity: isAbstention ? 'ABSTAIN' : item.polarity,
      confidence: item.confidence, reliability: item.reliability, rawWeight: item.rawWeight, finalWeight: item.finalWeight,
      fact: item.fact, documentKeys, matches: [...item.rawMatches].sort(), modelOrRuleVersion: semantic?.modelVersion || EVIDENCE_ASSERTION_SCHEMA_VERSION
    };
    return [{
      assertionKey: evidenceDocumentChecksum(assertionInput), subjectEntityId, channelId, assertionType: item.category,
      hypothesis: item.category, polarity: isAbstention ? 'ABSTAIN' : item.polarity,
      confidenceBasisPoints: Math.round(Math.max(0, Math.min(100, item.confidence)) * 100), reliability: item.reliability,
      documentKeys, sourceFamilyIds, modelOrRuleVersion: semantic?.modelVersion || EVIDENCE_ASSERTION_SCHEMA_VERSION,
      provider: item.source, languageCapability: semantic ? { detectedLanguages: semantic.detectedLanguages, supported: !isAbstention } : { governedDeterministicProvider: true },
      reasonCodes: semantic?.reasonCodes || [], derivation: { schemaVersion: EVIDENCE_ASSERTION_SCHEMA_VERSION, evidenceItem: item }, observedAt
    }];
  });
}

export function assertionsToLegacyEvidenceItems(assertions: EvidenceAssertionObservation[]): EvidenceItem[] {
  return assertions.flatMap(assertion => {
    const item = (assertion.derivation as { evidenceItem?: EvidenceItem }).evidenceItem;
    return item ? [item] : [];
  });
}
