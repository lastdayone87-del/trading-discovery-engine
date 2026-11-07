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
export function normalizeClassificationInput(input: RawChannelInput): RawChannelInput & { input_checksum: string } {
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
    input_checksum: createHash('sha256').update(JSON.stringify(stable)).digest('hex')
  };
}

export function classificationInputChecksum(input: RawChannelInput): string {
  return normalizeClassificationInput(input).input_checksum;
}
