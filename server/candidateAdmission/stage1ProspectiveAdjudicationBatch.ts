import { CREATOR_TYPES, type CreatorType } from '../decisionEvaluation';
import type { Stage1AdjudicationLabel } from './stage1ProspectiveAdjudication';

export const STAGE1_BATCH_ADJUDICATION_CONFIRMATION = 'COMMIT_STAGE1_PROSPECTIVE_ADJUDICATION_BATCH';
export const STAGE1_BATCH_ADJUDICATION_MAX_ENTRIES = 20;

export interface Stage1BatchAdjudicationEntry {
  channel: string;
  label: Stage1AdjudicationLabel;
  creatorType: CreatorType;
  reasonCodes: string[];
  notes?: string;
}

export function parseStage1BatchAdjudicationEntries(raw: string): Stage1BatchAdjudicationEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('BATCH_JSON_INVALID');
  }

  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('BATCH_ENTRIES_REQUIRED');
  if (parsed.length > STAGE1_BATCH_ADJUDICATION_MAX_ENTRIES) {
    throw new Error(`BATCH_TOO_LARGE:${STAGE1_BATCH_ADJUDICATION_MAX_ENTRIES}`);
  }

  const seen = new Set<string>();
  return parsed.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`BATCH_ENTRY_INVALID:${index}`);
    const row = value as Record<string, unknown>;
    const channel = String(row.channel || '').trim();
    const label = String(row.label || '').trim().toUpperCase() as Stage1AdjudicationLabel;
    const creatorType = String(row.creator_type || row.creatorType || '').trim() as CreatorType;
    const notes = String(row.notes || '').trim();
    const rawReasons = row.reason_codes ?? row.reasonCodes;
    const reasonCodes = Array.isArray(rawReasons)
      ? rawReasons.map(item => String(item).trim()).filter(Boolean)
      : String(rawReasons || '').split(',').map(item => item.trim()).filter(Boolean);

    if (!channel) throw new Error(`BATCH_CHANNEL_REQUIRED:${index}`);
    if (label !== 'TRADING_CONFIRMED' && label !== 'NON_TRADING') throw new Error(`BATCH_LABEL_INVALID:${index}`);
    if (!CREATOR_TYPES.includes(creatorType)) throw new Error(`BATCH_CREATOR_TYPE_INVALID:${index}`);
    if (!reasonCodes.length) throw new Error(`BATCH_REASON_CODES_REQUIRED:${index}`);

    const key = channel.toLocaleLowerCase('en-US');
    if (seen.has(key)) throw new Error(`BATCH_DUPLICATE_CHANNEL:${channel}`);
    seen.add(key);

    return {
      channel,
      label,
      creatorType,
      reasonCodes: [...new Set(reasonCodes)],
      notes: notes || undefined
    };
  });
}
