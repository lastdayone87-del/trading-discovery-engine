import { createHash } from 'node:crypto';
import type { RawChannelInput } from './evidenceEngine/types';

/**
 * Stable, attribution-free projection of a channel classification input.
 *
 * `job_id` and `run_id` are observability attribution, not classification
 * evidence. Excluding them keeps the checksum stable when the same channel
 * evidence is replayed under a different job or query run. That property is
 * required by both the immutable diagnostics ledger and the semantic result
 * cache (Phase 4).
 */

/**
 * Deterministic JSON for hashing. Object keys are sorted recursively because
 * two callers can assemble the same evidence in different insertion order.
 * Array order is preserved: it carries evidence index/order semantics.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJsonStringify(item === undefined ? null : item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Algorithm marker stored beside every new `input_checksum`. Rows written
 * before this version used insertion-order `JSON.stringify`; the marker lets
 * an auditor tell which normalization produced a stored fingerprint instead
 * of assuming the current canonical algorithm.
 */
export const CLASSIFICATION_INPUT_CHECKSUM_VERSION = 'canonical-json-v1';

export function normalizeClassificationInput(input: RawChannelInput): RawChannelInput & { input_checksum: string; input_checksum_version: string } {
  const classificationInput: RawChannelInput = { ...input };
  // Attribution and audience metadata are not classification evidence.
  // `subscriber_count`/`video_count` change on every channel refresh, and a
  // checksum that moves with them would miss the semantic cache and rewrite
  // the diagnostic ledger for an unchanged evidence set.
  delete classificationInput.job_id;
  delete classificationInput.run_id;
  delete classificationInput.subscriber_count;
  delete classificationInput.video_count;
  // The checksum fields are derived output. A stored diagnostic row carries
  // them inside `normalized_input`, so they must be stripped before hashing or
  // re-normalizing a replay would hash a different payload.
  const derived = classificationInput as RawChannelInput & { input_checksum?: string; input_checksum_version?: string };
  delete derived.input_checksum;
  delete derived.input_checksum_version;
  const stable: RawChannelInput = {
    ...classificationInput,
    channel_name: String(classificationInput.channel_name || '').normalize('NFKC').trim(),
    description: classificationInput.description || '',
    external_links: [...(classificationInput.external_links || [])].sort()
  };
  return {
    ...stable,
    input_checksum_version: CLASSIFICATION_INPUT_CHECKSUM_VERSION,
    input_checksum: createHash('sha256').update(canonicalJsonStringify(stable)).digest('hex')
  };
}

export function classificationInputChecksum(input: RawChannelInput): string {
  return normalizeClassificationInput(input).input_checksum;
}
