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
  delete classificationInput.job_id;
  delete classificationInput.run_id;
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
