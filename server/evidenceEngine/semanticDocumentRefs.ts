import { documentRef } from './canonicalEvidencePlane';
import type { EvidenceFieldRef, RawChannelInput } from './types';

/**
 * The exact document set a semantic model is shown. Prompt construction and
 * citation validation share this module so a citation can only ever attribute
 * a document that was actually supplied for the same input.
 *
 * Retrieval-only fields (`search_match_context`, activity metadata, country,
 * and language hints) are never model-facing evidence and are filtered out of
 * a prebuilt corpus.
 */
export function semanticFieldDocuments(input: RawChannelInput): Array<{ ref: EvidenceFieldRef; text: string }> {
  if (input.evidence_corpus?.length) {
    return input.evidence_corpus
      .filter(document => !['activity_metadata', 'search_match_context', 'country', 'language'].includes(document.field))
      .slice(0, 40)
      .map(document => ({ ref: documentRef(document), text: document.text }));
  }
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

/**
 * Exact field references emitted for one input (see buildSemanticPrompt).
 * Shared source of truth for validating cached and repaired citations.
 */
export function candidateDocumentRefs(input: RawChannelInput): EvidenceFieldRef[] {
  return semanticFieldDocuments(input).map(document => document.ref);
}

/**
 * True only when every citation resolves to a supplied document. A citation
 * with an index must match that index; an index-less citation is accepted only
 * when the field is unambiguous (or its sourceId is supplied).
 */
export function citationsReferenceSuppliedDocuments(
  citations: Array<{ field: string; index?: number; sourceId?: string }>,
  input: RawChannelInput,
): boolean {
  if (!citations.length) return false;
  const refs = candidateDocumentRefs(input);
  return citations.every(citation => {
    const candidates = refs.filter(ref => ref.field === citation.field);
    if (candidates.length === 0) return false;
    if (citation.index !== undefined) {
      return candidates.some(ref =>
        ref.index === citation.index
        && (citation.sourceId === undefined || ref.sourceId === citation.sourceId));
    }
    if (citation.sourceId !== undefined) {
      return candidates.some(ref => ref.sourceId === citation.sourceId);
    }
    return candidates.length === 1;
  });
}
