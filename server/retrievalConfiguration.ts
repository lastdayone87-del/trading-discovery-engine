import { createHash } from 'node:crypto';
import { getDb } from './db';
import type { RetrievalLane } from './retrievalLanes';
import type { SearchOrdering } from './searchOrdering';

export const CURRENT_RETRIEVAL_POLICY_VERSION = 'retrieval-policy-v1';

export type ContinuationMode = 'STANDARD' | 'FRESH_PROBE' | 'SHALLOW' | 'BOUNDED_DEEP';
export type FreshnessMode = 'NONE' | 'FRESH_PROBE' | 'STANDARD';
export type MaintenanceMode = 'MAINTENANCE' | 'EXPLORATION' | 'STANDARD';

export interface RetrievalConfiguration {
  configKey: string;
  searchOrdering: SearchOrdering;
  retrievalLane: RetrievalLane;
  requestedPageDepth: number;
  continuationMode: ContinuationMode;
  freshnessMode: FreshnessMode;
  maintenanceMode: MaintenanceMode;
  policyVersion: string;
}

export interface RetrievalConfigurationInput {
  searchOrdering?: SearchOrdering;
  retrievalLane?: RetrievalLane;
  requestedPageDepth?: number;
  continuationMode?: ContinuationMode;
  freshnessMode?: FreshnessMode;
  maintenanceMode?: MaintenanceMode;
  policyVersion?: string;
}

/**
 * Normalizes input parameters into a canonical RetrievalConfiguration object.
 */
export function normalizeRetrievalConfiguration(
  input: RetrievalConfigurationInput = {}
): Omit<RetrievalConfiguration, 'configKey'> {
  const searchOrdering: SearchOrdering = input.searchOrdering === 'DATE' ? 'DATE' : 'RELEVANCE';
  const retrievalLane: RetrievalLane = input.retrievalLane === 'CHANNEL' ? 'CHANNEL' : 'VIDEO';
  const requestedPageDepth = Math.min(3, Math.max(1, Math.floor(input.requestedPageDepth ?? 1)));
  const continuationMode: ContinuationMode =
    input.continuationMode && ['STANDARD', 'FRESH_PROBE', 'SHALLOW', 'BOUNDED_DEEP'].includes(input.continuationMode)
      ? input.continuationMode
      : requestedPageDepth === 1 ? 'SHALLOW' : requestedPageDepth > 2 ? 'BOUNDED_DEEP' : 'STANDARD';
  const freshnessMode: FreshnessMode =
    input.freshnessMode && ['NONE', 'FRESH_PROBE', 'STANDARD'].includes(input.freshnessMode)
      ? input.freshnessMode
      : searchOrdering === 'DATE' ? 'FRESH_PROBE' : 'STANDARD';
  const maintenanceMode: MaintenanceMode =
    input.maintenanceMode && ['MAINTENANCE', 'EXPLORATION', 'STANDARD'].includes(input.maintenanceMode)
      ? input.maintenanceMode
      : 'STANDARD';
  const policyVersion = input.policyVersion || CURRENT_RETRIEVAL_POLICY_VERSION;

  return {
    searchOrdering,
    retrievalLane,
    requestedPageDepth,
    continuationMode,
    freshnessMode,
    maintenanceMode,
    policyVersion
  };
}

/**
 * Deterministically computes a unique configuration key for normalized retrieval dimensions.
 */
export function createRetrievalConfigKey(input: RetrievalConfigurationInput = {}): string {
  const normalized = normalizeRetrievalConfiguration(input);
  const canonicalString = [
    `ordering:${normalized.searchOrdering}`,
    `lane:${normalized.retrievalLane}`,
    `depth:${normalized.requestedPageDepth}`,
    `continuation:${normalized.continuationMode}`,
    `freshness:${normalized.freshnessMode}`,
    `maintenance:${normalized.maintenanceMode}`,
    `version:${normalized.policyVersion}`
  ].join('|');

  return createHash('sha256')
    .update(canonicalString)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Builds a full, immutable RetrievalConfiguration object.
 */
export function buildRetrievalConfiguration(
  input: RetrievalConfigurationInput = {}
): RetrievalConfiguration {
  const normalized = normalizeRetrievalConfiguration(input);
  const configKey = createRetrievalConfigKey(input);
  return {
    configKey,
    ...normalized
  };
}

/**
 * Idempotently persists a RetrievalConfiguration into retrieval_configurations table.
 */
export async function ensureRetrievalConfigurationPersisted(
  config: RetrievalConfiguration,
  client?: any
): Promise<void> {
  const db = client || (process.env.DATABASE_URL ? await getDb() : null);
  if (!db) return;

  await db.query(
    `INSERT INTO retrieval_configurations(
       config_key, search_ordering, retrieval_lane, requested_page_depth,
       continuation_mode, freshness_mode, maintenance_mode, policy_version
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(config_key) DO NOTHING`,
    [
      config.configKey,
      config.searchOrdering,
      config.retrievalLane,
      config.requestedPageDepth,
      config.continuationMode,
      config.freshnessMode,
      config.maintenanceMode,
      config.policyVersion
    ]
  ).catch((error: unknown) => {
    console.warn('[RetrievalConfiguration] Failed to persist configuration:', error);
  });
}
