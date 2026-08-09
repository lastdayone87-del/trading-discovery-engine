import { createHash } from 'node:crypto';
import type { DiscoveryActionType, ResearchCoordinates } from '../persistentResearch';

/**
 * Phase 0 is an expand-only contract. Nothing in this module has serving,
 * classification, admission, scheduling, or query-ranking authority.
 */
export const CREATOR_INTELLIGENCE_CONTRACT_VERSION = 'creator-intelligence-contract-v1';

export const CREATOR_ACTIVITY_STATUSES = [
  'ACTIVE', 'RECENTLY_ACTIVE', 'DORMANT', 'INACTIVE', 'UNKNOWN', 'CONFLICTED'
] as const;
export type CreatorActivityStatus = typeof CREATOR_ACTIVITY_STATUSES[number];

export const CREATOR_OUTCOME_MATURITIES = ['PROVISIONAL', 'ENRICHED', 'REVIEWED', 'TERMINAL'] as const;
export type CreatorOutcomeMaturity = typeof CREATOR_OUTCOME_MATURITIES[number];

export const CREATOR_OUTCOME_TYPES = [
  'NEW_VERIFIED_CREATOR',
  'KNOWN_VERIFIED_CREATOR',
  'DUPLICATE_ACCOUNT',
  'COUNTRY_REJECTED',
  'NON_TRADING',
  'UNCERTAIN',
  'NEEDS_REVIEW',
  'HUMAN_REJECTED',
  'OPERATIONALLY_UNRESOLVED'
] as const;
export type CreatorOutcomeType = typeof CREATOR_OUTCOME_TYPES[number];

export const CREATOR_IDENTITY_CONFIDENCES = ['CONFIRMED', 'PROBABLE', 'UNRESOLVED', 'DISPUTED'] as const;
export type CreatorIdentityConfidence = typeof CREATOR_IDENTITY_CONFIDENCES[number];

export const CREATOR_PROGRAM_LIFECYCLES = ['DRAFT', 'ACTIVE', 'SLEEPING', 'SATURATED', 'PAUSED', 'COMPLETE'] as const;
export type CreatorProgramLifecycle = typeof CREATOR_PROGRAM_LIFECYCLES[number];

export const CREATOR_COVERAGE_LIFECYCLES = ['ACTIVE', 'SLEEPING', 'SATURATED', 'PAUSED', 'UNREACHABLE'] as const;
export type CreatorCoverageLifecycle = typeof CREATOR_COVERAGE_LIFECYCLES[number];

export const CREATOR_FRONTIER_STATES = ['UNEXPLORED', 'PARTIALLY_OBSERVED', 'OBSERVED', 'UNKNOWN', 'SLEEPING'] as const;
export type CreatorFrontierState = typeof CREATOR_FRONTIER_STATES[number];

export interface CreatorDiscoveryCriteria {
  roles?: Array<'TRADER' | 'EDUCATOR' | 'ANALYST' | 'COMMUNITY_OPERATOR'>;
  activityRequirement?: Exclude<CreatorActivityStatus, 'CONFLICTED'>;
  requiresEducationalContent?: boolean;
  requiresCommunity?: boolean;
  minimumQualityScore?: number;
  inclusion?: string[];
  exclusion?: string[];
}

/** The durable statement of which creator population a program is seeking. */
export interface CreatorDiscoveryObjective {
  objectiveKey: string;
  version: number;
  title: string;
  statement: string;
  coordinates: ResearchCoordinates;
  criteria: CreatorDiscoveryCriteria;
  coverageDefinition: Record<string, unknown>;
  evaluationHorizonDays: number;
  createdAt: string;
  policyVersion: string;
}

export interface CreatorProgramBudget {
  providerUnits: number;
  reviewUnits: number;
  dailyProviderUnits?: number;
  dailyReviewUnits?: number;
}

/** Control-plane container only; Phase 0 grants it no runtime authority. */
export interface CreatorProgram {
  programId: string;
  programKey: string;
  objective: CreatorDiscoveryObjective;
  lifecycle: CreatorProgramLifecycle;
  budget: CreatorProgramBudget;
  servingAuthority: false;
  createdAt: string;
  updatedAt: string;
  policyVersion: string;
}

export interface CreatorActionCost {
  providerUnits: number;
  reviewUnits: number;
  computeUnits?: number;
  latencyMs?: number;
}

/**
 * Provider-neutral action contract. Existing persistent-research action types
 * are reused so later shadow projection does not create a parallel taxonomy.
 */
export interface CreatorAction {
  actionId: string;
  programId: string;
  objectiveKey: string;
  actionType: DiscoveryActionType;
  providerKey: string;
  target: string;
  coordinates: ResearchCoordinates;
  sourceFamilyIds: string[];
  parentActionId?: string;
  hypothesisId?: string;
  expectedIncrementalCreators: number;
  expectedInformationGain: number;
  expectedCoverageGain: number;
  uncertainty: number;
  expectedCost: CreatorActionCost;
  provenance: Record<string, unknown>;
  proposedAt: string;
  policyVersion: string;
  servingAuthority: false;
}

export interface CreatorIdentityReference {
  canonicalCreatorId?: string;
  sourceAccountId: string;
  sourceAccountType: 'YOUTUBE_CHANNEL' | 'EXTERNAL_ACCOUNT' | 'UNKNOWN';
  identityConfidence: CreatorIdentityConfidence;
  entityClusterKey?: string;
}

export interface CreatorActivityAssessment {
  status: CreatorActivityStatus;
  observedAt: string;
  latestContentAt?: string;
  windowDays?: number;
  evidenceSourceIds: string[];
  policyVersion: string;
}

export interface CreatorOutcomeEvidence {
  sourceEventKeys: string[];
  countryStatus?: 'CONFIRMED' | 'LIKELY' | 'UNCERTAIN' | 'REJECTED';
  tradingStatus?: 'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN' | 'NEEDS_REVIEW' | 'HUMAN_REJECTED';
  qualityScore?: number;
  communityStatus?: string;
  admissionStatus?: string;
  activity?: CreatorActivityAssessment;
}

/** Immutable, versioned observation suitable for later as-of-cutoff replay. */
export interface CreatorOutcome {
  outcomeKey: string;
  actionId: string;
  objectiveKey: string;
  creator: CreatorIdentityReference;
  outcomeType: CreatorOutcomeType;
  maturity: CreatorOutcomeMaturity;
  incremental: boolean;
  activeCreatorCredit: boolean;
  verifiedCreatorCredit: boolean;
  coverageCellKeys: string[];
  cost: CreatorActionCost;
  evidence: CreatorOutcomeEvidence;
  observedAt: string;
  effectiveAt: string;
  supersedesOutcomeKey?: string;
  policyVersion: string;
  contractVersion: typeof CREATOR_INTELLIGENCE_CONTRACT_VERSION;
}

export interface CreatorCoverageCell {
  cellKey: string;
  programId: string;
  coordinates: ResearchCoordinates;
  observedAccounts: number;
  observedCanonicalCreators: number;
  verifiedActiveCreators: number;
  estimatedUnseenCreators: number | null;
  uncertainty: number;
  marginalVerifiedYield: number;
  lifecycle: CreatorCoverageLifecycle;
  lastObservedAt?: string;
  lastProbedAt?: string;
  asOf: string;
  policyVersion: string;
}

/** A declared population segment; it describes opportunity but cannot schedule work. */
export interface CreatorCoverageTarget {
  targetKey: string;
  programId: string;
  coordinates: ResearchCoordinates;
  required: boolean;
  definition: Record<string, unknown>;
  policyVersion: string;
}

export interface CreatorFrontierSnapshot {
  frontierKey: string;
  programId: string;
  coverageTargetKey: string;
  state: CreatorFrontierState;
  observedCreatorClusters: number;
  estimatedUnexploredCoverage: number | null;
  uncertainty: number;
  reasonCodes: string[];
  asOf: string;
  policyVersion: string;
  servingAuthority: false;
}

export interface CreatorLevelMetrics {
  observedAccounts: number;
  resolvedCanonicalCreators: number;
  unresolvedIdentities: number;
  newVerifiedCreators: number;
  newVerifiedActiveCreators: number;
  knownVerifiedCreators: number;
  duplicateAccounts: number;
  countryRejected: number;
  nonTrading: number;
  uncertain: number;
  needsReview: number;
  humanRejected: number;
  operationallyUnresolved: number;
  coverageCellsImproved: number;
  providerUnits: number;
  reviewUnits: number;
  outcomeMaturity: Record<CreatorOutcomeMaturity, number>;
  asOf: string;
}

/** Compatibility reference for mapping current query runs in a later shadow phase. */
export interface LegacyQueryRunReference {
  queryRunId: string;
  queryId: number;
  query: string;
  country: string;
  retrievalLane: 'VIDEO' | 'CHANNEL';
  searchOrdering: 'RELEVANCE' | 'DATE';
  source: 'automated_query';
}

export interface CreatorShadowProjectionInput {
  program: CreatorProgram;
  action: CreatorAction;
  legacyQueryRun?: LegacyQueryRunReference;
  sourceEventKeys: string[];
  cutoffAt: string;
  projectionVersion: string;
}

export interface CreatorReplayEnvelope<T> {
  contractVersion: typeof CREATOR_INTELLIGENCE_CONTRACT_VERSION;
  subjectType: 'OBJECTIVE' | 'PROGRAM' | 'ACTION' | 'OUTCOME' | 'COVERAGE' | 'METRICS';
  subjectKey: string;
  asOf: string;
  policyVersion: string;
  payload: T;
  checksum: string;
}

const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).filter(([, nested]) => nested !== undefined).sort(([a], [b]) => a.localeCompare(b)))
  : item);

export function creatorIntelligenceChecksum(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export function createCreatorReplayEnvelope<T>(input: Omit<CreatorReplayEnvelope<T>, 'contractVersion' | 'checksum'>): CreatorReplayEnvelope<T> {
  assertNonEmpty(input.subjectKey, 'subjectKey');
  assertNonEmpty(input.policyVersion, 'policyVersion');
  assertIsoDate(input.asOf, 'asOf');
  const unsigned = { ...input, contractVersion: CREATOR_INTELLIGENCE_CONTRACT_VERSION } as const;
  return { ...unsigned, checksum: creatorIntelligenceChecksum(unsigned) };
}

export function validateCreatorDiscoveryObjective(objective: CreatorDiscoveryObjective): void {
  assertNonEmpty(objective.objectiveKey, 'objectiveKey');
  assertNonEmpty(objective.title, 'title');
  assertNonEmpty(objective.statement, 'statement');
  assertNonEmpty(objective.policyVersion, 'policyVersion');
  if (!Number.isInteger(objective.version) || objective.version < 1) throw new Error('Objective version must be a positive integer.');
  if (!Number.isInteger(objective.evaluationHorizonDays) || objective.evaluationHorizonDays < 1) throw new Error('Evaluation horizon must be a positive number of days.');
  if (!Object.keys(objective.coordinates).length) throw new Error('Creator discovery coordinates are required.');
  assertIsoDate(objective.createdAt, 'createdAt');
  if (objective.criteria.minimumQualityScore !== undefined && (!Number.isFinite(objective.criteria.minimumQualityScore) || objective.criteria.minimumQualityScore < 0 || objective.criteria.minimumQualityScore > 100)) throw new Error('Minimum quality score must be between zero and 100.');
}

export function validateCreatorProgram(program: CreatorProgram): void {
  assertNonEmpty(program.programId, 'programId');
  assertNonEmpty(program.programKey, 'programKey');
  assertNonEmpty(program.policyVersion, 'policyVersion');
  validateCreatorDiscoveryObjective(program.objective);
  assertNonNegative(program.budget.providerUnits, 'providerUnits');
  assertNonNegative(program.budget.reviewUnits, 'reviewUnits');
  if (program.budget.dailyProviderUnits !== undefined) assertNonNegative(program.budget.dailyProviderUnits, 'dailyProviderUnits');
  if (program.budget.dailyReviewUnits !== undefined) assertNonNegative(program.budget.dailyReviewUnits, 'dailyReviewUnits');
  if (program.servingAuthority !== false) throw new Error('Phase 0 Creator Programs cannot have serving authority.');
  assertIsoDate(program.createdAt, 'createdAt');
  assertIsoDate(program.updatedAt, 'updatedAt');
}

export function validateCreatorAction(action: CreatorAction): void {
  for (const [value, name] of [[action.actionId, 'actionId'], [action.programId, 'programId'], [action.objectiveKey, 'objectiveKey'], [action.providerKey, 'providerKey'], [action.target, 'target'], [action.policyVersion, 'policyVersion']] as const) assertNonEmpty(value, name);
  if (!action.sourceFamilyIds.length) throw new Error('Creator Actions require source-family provenance.');
  for (const [value, name] of [[action.expectedIncrementalCreators, 'expectedIncrementalCreators'], [action.expectedInformationGain, 'expectedInformationGain'], [action.expectedCoverageGain, 'expectedCoverageGain'], [action.uncertainty, 'uncertainty']] as const) assertNonNegative(value, name);
  validateCost(action.expectedCost);
  if (action.servingAuthority !== false) throw new Error('Phase 0 Creator Actions cannot have serving authority.');
  assertIsoDate(action.proposedAt, 'proposedAt');
}

export function validateCreatorOutcome(outcome: CreatorOutcome): void {
  for (const [value, name] of [[outcome.outcomeKey, 'outcomeKey'], [outcome.actionId, 'actionId'], [outcome.objectiveKey, 'objectiveKey'], [outcome.creator.sourceAccountId, 'sourceAccountId'], [outcome.policyVersion, 'policyVersion']] as const) assertNonEmpty(value, name);
  if (outcome.contractVersion !== CREATOR_INTELLIGENCE_CONTRACT_VERSION) throw new Error('Unsupported Creator Intelligence contract version.');
  if (outcome.creator.identityConfidence === 'CONFIRMED' && !outcome.creator.canonicalCreatorId) throw new Error('Confirmed creator identity requires a canonical creator ID.');
  if (outcome.verifiedCreatorCredit && !outcome.creator.canonicalCreatorId) throw new Error('Verified creator credit requires a canonical creator identity.');
  if (outcome.verifiedCreatorCredit && !['NEW_VERIFIED_CREATOR', 'KNOWN_VERIFIED_CREATOR'].includes(outcome.outcomeType)) throw new Error('Verified creator credit requires a verified creator outcome.');
  if (outcome.activeCreatorCredit && (!outcome.verifiedCreatorCredit || outcome.evidence.activity?.status !== 'ACTIVE')) throw new Error('Active creator credit requires verified creator credit and ACTIVE evidence.');
  if (outcome.maturity !== 'TERMINAL' && outcome.outcomeType === 'HUMAN_REJECTED') throw new Error('Human-rejected outcomes must be terminal.');
  validateCost(outcome.cost);
  assertIsoDate(outcome.observedAt, 'observedAt');
  assertIsoDate(outcome.effectiveAt, 'effectiveAt');
}

function validateCost(cost: CreatorActionCost): void {
  assertNonNegative(cost.providerUnits, 'providerUnits');
  assertNonNegative(cost.reviewUnits, 'reviewUnits');
  if (cost.computeUnits !== undefined) assertNonNegative(cost.computeUnits, 'computeUnits');
  if (cost.latencyMs !== undefined) assertNonNegative(cost.latencyMs, 'latencyMs');
}

function assertNonEmpty(value: string, name: string): void {
  if (!value?.trim()) throw new Error(`${name} is required.`);
}

function assertNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative.`);
}

function assertIsoDate(value: string, name: string): void {
  if (!value || !Number.isFinite(new Date(value).getTime())) throw new Error(`${name} must be a valid timestamp.`);
}
