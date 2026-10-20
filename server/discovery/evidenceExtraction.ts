/**
 * Evidence-first discovery Phase 1 — deterministic evidence extraction.
 *
 * Pure, DB-free, network-free. Consumes channel/video metadata text that the
 * existing ingestion/enrichment paths already parsed (never triggers fetches)
 * and emits literal, provenance-bound candidate signals: hashtags, handles/
 * mentions, video tags, topic labels, and bounded n-gram phrases. Reuses the
 * P1 surface extractors for hashtag/handle spans (shared code-point offset
 * semantics) and the repo-wide normalizeTerm normalization.
 *
 * Phase 1 authority boundary: candidates produced here are inert evidence.
 * This module never reads or writes `search_eligible`, never writes the
 * canonical catalog, and cannot satisfy or bypass the 3-creator /
 * 2-community / 5-evidence promotion gate by design.
 */

import { createHash } from 'node:crypto';
import { extractHandlesWithOffsets, extractHashtagsWithOffsets } from '../surfaceExtractors';
import { normalizeTerm } from '../terminologyIntelligence';

export const EVIDENCE_EXTRACTION_VERSION = 'evidence-extraction-v1';
export const EVIDENCE_CANDIDATE_TYPE = 'SEARCH_TERM';
export const EVIDENCE_EXTRACTION_DISCOVERY_MODE = 'EVIDENCE_EXTRACTION';
export const EVIDENCE_EXTRACTION_PROVIDER_KEY = 'evidence_extraction';
export const EVIDENCE_EXTRACTION_RETRIEVAL_SURFACE = 'INGESTION_METADATA';
export const EVIDENCE_EXTRACTION_PROVIDER_CAPABILITY = 'EXTRACT_METADATA_EVIDENCE';

/** Backpressure bounds: one channel pass can never stage an unbounded batch. */
export const MAX_CANDIDATES_PER_EXTRACTION = 200;
export const MAX_PROVENANCE_PER_CANDIDATE = 5;
export const NGRAM_MIN_TOKENS = 2;
export const NGRAM_MAX_TOKENS = 4;
export const MAX_NGRAM_CANDIDATES_PER_SOURCE = 60;
export const NGRAM_MIN_CODE_POINTS = 4;
export const NGRAM_MAX_CODE_POINTS = 80;

export type EvidenceSignalKind =
  | 'HASHTAG'
  | 'HANDLE'
  | 'MENTION'
  | 'VIDEO_TAG'
  | 'TOPIC_LABEL'
  | 'NGRAM_PHRASE';

export type EvidenceSourceType =
  | 'CHANNEL_NAME'
  | 'CHANNEL_DESCRIPTION'
  | 'CHANNEL_HANDLE'
  | 'VIDEO_TITLE'
  | 'VIDEO_DESCRIPTION'
  | 'VIDEO_TAG'
  | 'TOPIC_DETAIL'
  | 'PINNED_COMMENT';

export type EvidenceExtractionMethod =
  | 'HASHTAG'
  | 'HANDLE'
  | 'MENTION'
  | 'VIDEO_TAG'
  | 'TOPIC_DETAIL'
  | 'NGRAM';

/** Code-point offsets, matching surfaceExtractors / candidateCorpus semantics. */
export interface EvidenceTextSpan {
  start: number;
  end: number;
}

export interface EvidenceProvenance {
  sourceType: EvidenceSourceType;
  /** Stable source identity: `channel:<id>`, `video:<id|index>`, `tag:<index>`, `topic:<index>`. */
  sourceId: string;
  /** Index within the source array/list; 0 for singular fields. */
  sourceIndex: number;
  /** Literal occurrence span in the cited text, or null for discrete values. */
  textSpan: EvidenceTextSpan | null;
  extractionMethod: EvidenceExtractionMethod;
  /** SHA-256 of the NFKC-normalized full source text (observation dedup identity). */
  sourceHash: string;
}

export interface EvidenceCandidate {
  /** Literal observed surface (original casing/punctuation, trimmed). */
  rawTerm: string;
  /** normalizeTerm(rawTerm) — the canonical comparison form. */
  normalizedTerm: string;
  /** Primary (first-observed) signal kind; merged synonyms keep their own provenance. */
  signalKind: EvidenceSignalKind;
  /** `SEARCH_TERM:<normalizedTerm>` — staging canonical identity. */
  canonicalIdentity: string;
  /** sha256(canonicalIdentity) — staging/dedup key. */
  canonicalCandidateKey: string;
  /** Total occurrences observed in this extraction input (not just the stored provenance). */
  frequency: number;
  /** First-observed provenance, capped at MAX_PROVENANCE_PER_CANDIDATE. */
  provenance: EvidenceProvenance[];
}

export interface EvidenceExtractionInput {
  channelId: string;
  channelName?: string;
  /** Channel handle/custom URL from metadata (with or without a leading '@'). */
  channelHandle?: string | null;
  description?: string;
  pinnedComment?: string;
  videoTitles?: string[];
  videoDescriptions?: Array<string | undefined>;
  videoTags?: string[];
  topicLabels?: string[];
  /**
   * Structured recent videos. When present these take precedence over the
   * parallel videoTitles/videoDescriptions arrays so one video is never
   * harvested twice (frequency inflation) from duplicate representations.
   */
  videos?: Array<{ id?: string; title?: string; description?: string }>;
}

/**
 * Boundary stopwords for n-gram segmentation (segment split, not rejection).
 * Deliberately small, multilingual, and data-independent.
 *
 * Single-character words stay in this set (and in the token stream): the
 * tokenizer must not drop them before segmentation. Otherwise `alpha a beta`
 * becomes the fabricated term `alpha beta`, and Spanish `y` / Portuguese `e`
 * silently merge unrelated phrases.
 */
export const NGRAM_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'in', 'is', 'it', 'its',
  'not', 'of', 'on', 'or', 'our', 'out', 'she', 'that', 'the', 'their', 'them',
  'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
  'will', 'with', 'you', 'your',
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'pour', 'avec',
  'vous', 'votre', 'mon', 'ma', 'mes', 'au', 'aux', 'en', 'par', 'sur', 'ce',
  'cette', 'ces', 'dans', 'est', 'sont', 'nous', 'je', 'tu', 'il', 'elle',
  'à',
  'der', 'die', 'das', 'und', 'für', 'mit', 'ihr', 'ihre', 'dein', 'deine',
  'von', 'zu', 'im', 'ist', 'sind', 'auf', 'als', 'ein', 'eine', 'einen',
  'el', 'los', 'las', 'una', 'del', 'y', 'para', 'con', 'tu', 'su', 'por',
  'como', 'más', 'mas', 'es', 'son', 'se', 'nos', 'u',
  'o', 'os', 'as', 'um', 'uma', 'do', 'da', 'dos', 'das', 'e', 'é', 'è', 'com', 'seu',
  'sua', 'são', 'sao', 'não', 'nao', 'você', 'voce',
  'il', 'lo', 'gli', 'di', 'per', 'che', 'non', 'sono',
]);

const WORD_POINT = /[\p{L}\p{N}\p{M}]/u;
const LETTER = /\p{L}/u;

interface SourceContext {
  sourceType: EvidenceSourceType;
  sourceId: string;
  sourceIndex: number;
  sourceHash: string;
}

interface Token {
  text: string;
  normalized: string;
  start: number;
  end: number;
}

interface Accumulator {
  rawTerm: string;
  normalizedTerm: string;
  signalKind: EvidenceSignalKind;
  frequency: number;
  provenance: EvidenceProvenance[];
}

/** Deterministic canonical identity for an extracted term (staging key basis). */
export function evidenceCanonicalIdentity(normalizedTerm: string): string {
  return `${EVIDENCE_CANDIDATE_TYPE}:${normalizeTerm(normalizedTerm)}`;
}

/** sha256 of the canonical identity — identical to the staging dedup key basis. */
export function evidenceCandidateKeyForTerm(normalizedTerm: string): string {
  return createHash('sha256').update(evidenceCanonicalIdentity(normalizedTerm)).digest('hex');
}

export function hashEvidenceSource(text: string): string {
  return createHash('sha256').update(text.normalize('NFKC')).digest('hex');
}

function tokenizeWithCodePointOffsets(text: string): Token[] {
  const points = Array.from(text.normalize('NFC'));
  const tokens: Token[] = [];
  let index = 0;
  while (index < points.length) {
    if (!WORD_POINT.test(points[index])) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < points.length && WORD_POINT.test(points[index])) index += 1;
    const tokenText = points.slice(start, index).join('');
    // Keep single-character tokens here. They may be stopword boundaries
    // (a/y/e/o/u/i/à/é/è) or meaningful one-letter identifiers; either way,
    // dropping them before segmenting fabricates cross-boundary n-grams.
    // The final candidate-length check still rejects a one-character term.
    tokens.push({ text: tokenText, normalized: normalizeTerm(tokenText), start, end: index });
  }
  return tokens;
}

/**
 * Extracts deterministic candidate signals from already-parsed metadata.
 * Same input always yields the identical (deep-equal) ordered output.
 */
export function extractEvidenceCandidates(input: EvidenceExtractionInput): EvidenceCandidate[] {
  const accumulators = new Map<string, Accumulator>();

  const push = (
    rawTerm: string,
    normalizedTerm: string,
    signalKind: EvidenceSignalKind,
    method: EvidenceExtractionMethod,
    source: SourceContext,
    textSpan: EvidenceTextSpan | null
  ): void => {
    const normalized = normalizeTerm(normalizedTerm);
    if (!normalized || Array.from(normalized).length < 2) return;
    const key = normalized;
    let entry = accumulators.get(key);
    if (!entry) {
      entry = { rawTerm, normalizedTerm: normalized, signalKind, frequency: 0, provenance: [] };
      accumulators.set(key, entry);
    }
    entry.frequency += 1;
    const provenanceKey = `${method}|${source.sourceType}|${source.sourceId}|${textSpan ? `${textSpan.start}-${textSpan.end}` : 'null'}`;
    if (
      entry.provenance.length < MAX_PROVENANCE_PER_CANDIDATE &&
      !entry.provenance.some(
        existing =>
          `${existing.extractionMethod}|${existing.sourceType}|${existing.sourceId}|${
            existing.textSpan ? `${existing.textSpan.start}-${existing.textSpan.end}` : 'null'
          }` === provenanceKey
      )
    ) {
      entry.provenance.push({
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceIndex: source.sourceIndex,
        textSpan,
        extractionMethod: method,
        sourceHash: source.sourceHash,
      });
    }
  };

  const harvestNgrams = (text: string, points: string[], source: SourceContext) => {
    const tokens = tokenizeWithCodePointOffsets(text);
    if (tokens.length < NGRAM_MIN_TOKENS) return;
    let emitted = 0;
    // Stopwords split the token stream into segments; n-grams never span a
    // segment boundary (deterministic, language-agnostic boundary rule).
    const segments: Token[][] = [];
    let current: Token[] = [];
    for (const token of tokens) {
      if (NGRAM_STOPWORDS.has(token.normalized)) {
        if (current.length) segments.push(current);
        current = [];
      } else {
        current.push(token);
      }
    }
    if (current.length) segments.push(current);
    outer: for (const segment of segments) {
      for (let start = 0; start < segment.length; start += 1) {
        for (let size = NGRAM_MIN_TOKENS; size <= NGRAM_MAX_TOKENS; size += 1) {
          const end = start + size - 1;
          if (end >= segment.length) break;
          const raw = points.slice(segment[start].start, segment[end].end).join('');
          const normalized = normalizeTerm(segment.slice(start, end + 1).map(token => token.text).join(' '));
          const codePoints = Array.from(normalized).length;
          if (codePoints < NGRAM_MIN_CODE_POINTS || codePoints > NGRAM_MAX_CODE_POINTS) continue;
          if (!LETTER.test(raw)) continue;
          push(raw, normalized, 'NGRAM_PHRASE', 'NGRAM', source, { start: segment[start].start, end: segment[end].end });
          emitted += 1;
          if (emitted >= MAX_NGRAM_CANDIDATES_PER_SOURCE) break outer;
        }
      }
    }
  };

  const harvestText = (
    text: string | undefined | null,
    sourceType: EvidenceSourceType,
    sourceId: string,
    sourceIndex: number
  ) => {
    if (!text || !text.trim()) return;
    const source: SourceContext = {
      sourceType,
      sourceId,
      sourceIndex,
      sourceHash: hashEvidenceSource(text),
    };
    for (const span of extractHashtagsWithOffsets(text)) {
      push(span.literal, span.literal, 'HASHTAG', 'HASHTAG', source, { start: span.startOffset, end: span.endOffset });
    }
    for (const span of extractHandlesWithOffsets(text)) {
      push(span.literal, span.literal, 'MENTION', 'MENTION', source, { start: span.startOffset, end: span.endOffset });
    }
    harvestNgrams(text, Array.from(text.normalize('NFC')), source);
  };

  // Deterministic harvest order: handle, tags, topics, then text fields.
  const channelSourceId = `channel:${input.channelId}`;
  if (input.channelHandle && input.channelHandle.trim()) {
    const trimmed = input.channelHandle.trim();
    const rawHandle = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
    push(rawHandle, rawHandle, 'HANDLE', 'HANDLE', {
      sourceType: 'CHANNEL_HANDLE',
      sourceId: channelSourceId,
      sourceIndex: 0,
      sourceHash: hashEvidenceSource(trimmed),
    }, null);
  }
  (input.videoTags || []).forEach((tag, index) => {
    if (typeof tag !== 'string' || !tag.trim()) return;
    const trimmed = tag.trim();
    push(trimmed, trimmed, 'VIDEO_TAG', 'VIDEO_TAG', {
      sourceType: 'VIDEO_TAG',
      sourceId: `tag:${index}`,
      sourceIndex: index,
      sourceHash: hashEvidenceSource(trimmed),
    }, null);
  });
  (input.topicLabels || []).forEach((topic, index) => {
    if (typeof topic !== 'string' || !topic.trim()) return;
    const trimmed = topic.trim();
    push(trimmed, trimmed, 'TOPIC_LABEL', 'TOPIC_DETAIL', {
      sourceType: 'TOPIC_DETAIL',
      sourceId: `topic:${index}`,
      sourceIndex: index,
      sourceHash: hashEvidenceSource(trimmed),
    }, null);
  });

  harvestText(input.channelName, 'CHANNEL_NAME', channelSourceId, 0);
  harvestText(input.description, 'CHANNEL_DESCRIPTION', channelSourceId, 0);

  if (input.videos && input.videos.length) {
    input.videos.forEach((video, index) => {
      const videoSourceId = `video:${video?.id || index}`;
      harvestText(video?.title, 'VIDEO_TITLE', videoSourceId, index);
      harvestText(video?.description, 'VIDEO_DESCRIPTION', videoSourceId, index);
    });
  } else {
    (input.videoTitles || []).forEach((title, index) => {
      harvestText(title, 'VIDEO_TITLE', `video:${index}`, index);
    });
    (input.videoDescriptions || []).forEach((description, index) => {
      harvestText(description, 'VIDEO_DESCRIPTION', `video:${index}`, index);
    });
  }

  harvestText(input.pinnedComment, 'PINNED_COMMENT', channelSourceId, 0);

  const candidates: EvidenceCandidate[] = [...accumulators.values()].map(entry => ({
    rawTerm: entry.rawTerm,
    normalizedTerm: entry.normalizedTerm,
    signalKind: entry.signalKind,
    canonicalIdentity: evidenceCanonicalIdentity(entry.normalizedTerm),
    canonicalCandidateKey: evidenceCandidateKeyForTerm(entry.normalizedTerm),
    frequency: entry.frequency,
    provenance: entry.provenance,
  }));
  // Deterministic ordering: canonical key first, literal as tiebreaker.
  candidates.sort((a, b) =>
    a.canonicalCandidateKey < b.canonicalCandidateKey ? -1
    : a.canonicalCandidateKey > b.canonicalCandidateKey ? 1
    : a.rawTerm < b.rawTerm ? -1
    : a.rawTerm > b.rawTerm ? 1
    : 0
  );
  return candidates.slice(0, MAX_CANDIDATES_PER_EXTRACTION);
}
