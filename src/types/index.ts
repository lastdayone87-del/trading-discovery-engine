export type CountryStatus = 'CONFIRMED' | 'LIKELY' | 'UNCERTAIN' | 'REJECTED';
export type CountryMetadataStatus = 'AVAILABLE_DECLARED' | 'AVAILABLE_NOT_DECLARED' | 'UNAVAILABLE' | 'NOT_REQUESTED';
export type PublicAboutStatus = 'NOT_ATTEMPTED' | 'ATTEMPTED_SUCCEEDED' | 'ATTEMPTED_FAILED' | 'ATTEMPTED_EMPTY';
export type ChannelActivityBand = 'VERY_ACTIVE' | 'ACTIVE' | 'OCCASIONAL' | 'DORMANT' | 'UNKNOWN';
export interface DashboardOperationalSummary {
  storedChannels: number;
  activeDiscords: number;
  pendingScans: number;
  pendingReviews: number;
  scope: { storedChannels: 'ALL_STORED_CHANNELS'; operationalMetrics: 'ALL_STORED_CHANNELS'; pendingReviews: 'DURABLE_REVIEW_QUEUE' };
  deployment: { environment: string; service: string; instance: string };
}

export type DiscordStatus = 'PENDING' | 'NOT_FOUND' | 'ACTIVE' | 'ACTIVE_LOW_VOLUME' | 'NON_TRADING' | 'DEAD' | 'UNCERTAIN';
export type DiscordDiscoveryStatus = 'NOT_DISCOVERED' | 'DISCOVERED_VALIDATION_FAILED' | 'VALIDATED';
export type DiscordResolutionStatus='NOT_ATTEMPTED'|'RESOLVED'|'UNRESOLVED';
export type DiscordLivenessStatus='NOT_CHECKED'|'ACTIVE'|'INVALID_OBSERVED'|'DEAD'|'UNCERTAIN';
export type DiscordRelevanceStatus='NOT_CHECKED'|'TRADING_RELEVANT'|'NON_TRADING'|'UNCERTAIN';
export type DiscordValidationStatus='NOT_STARTED'|'RETRY_PENDING'|'SUCCEEDED'|'FAILED_OPERATIONAL'|'COMPLETED';

export type ScanStatus = 'PENDING' | 'LOCKED' | 'ENRICHMENT_PENDING' | 'ENRICHING' | 'PROVIDER_DEFERRED' | 'NEEDS_REVIEW' | 'COMPLETED' | 'FAILED' | 'FAILED_PERMANENT' | 'SKIPPED_NON_TRADING' | 'SKIPPED_EXCLUDED' | 'SKIPPED_LOW_AUDIENCE';

export type DiscoverySource = 'manual_search' | 'automated_query' | 'recheck';

export type TradingStatus = 'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN' | 'NEEDS_REVIEW' | 'HUMAN_REJECTED';

export type ReviewState = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED';
export interface ReviewQueueItem {
  channelId: string; channelName: string; youtubeUrl: string; country: string;
  state: ReviewState; reviewVersion: number; evidenceSnapshot: Record<string, unknown>;
  pendingSince?: string; decidedAt?: string; tradingStatus: TradingStatus;
  scanStatus: ScanStatus; qualityScore?: number; discordStatus: DiscordStatus;
  history?: Array<{id:string;decision:'APPROVE'|'REJECT'|'FORCE_RESCAN';previous_status:ReviewState;resulting_status:ReviewState;reviewer:string;decided_at:string;reason:string;notes?:string;review_version:number;evidence_snapshot:Record<string,unknown>}>;
}

export type TradingCategory =
  | 'Futures'
  | 'Forex'
  | 'Options'
  | 'Crypto'
  | 'Stocks'
  | 'Order Flow'
  | 'ICT / Smart Money'
  | 'Market Structure'
  | 'Swing Trading'
  | 'Scalping'
  | 'Investing'
  | 'Macro'
  | 'Prop Firm'
  | 'General Finance'
  | 'General Trading';

export interface TradingClassificationResult {
  status: TradingStatus;
  confidenceScore: number;
  category: TradingCategory | string;
  breakdown: TradingRelevanceBreakdown;
}

export interface RawChannelInput {
  channel_id?: string;
  channel_name: string;
  description: string;
  video_titles?: string[];
  video_descriptions?: string[];
  country?: string;
  external_links?: string[];
  location_tag?: string;
  discord_invite?: string | null;
}

export interface TradingRelevanceBreakdown {
  stage_a_score: number;
  consistency_ratio: number;
  ai_reviewed: boolean;
  fast_heuristic_status?: 'FAST_ACCEPT' | 'FAST_REJECT' | 'UNCERTAIN';
  classification_method?: 'FAST_HEURISTIC_ACCEPT' | 'FAST_HEURISTIC_REJECT' | 'AI_SEMANTIC_CLASSIFIER';
  ai_prompt_payload?: string;
  ai_raw_response?: string;
  ai_model?: string;
  reasoning: string[];
}

export interface InspectionStep {
  step: 'COUNTRY_VALIDATION' | 'BIO' | 'EXTERNAL_LINKS' | 'PINNED_COMMENT' | 'VIDEO_DESCRIPTIONS' | 'SOCIAL_BIO' | 'CUSTOM_DOMAINS';
  title: string;
  status: 'FOUND' | 'NOT_FOUND' | 'SKIPPED' | 'PARTIAL' | 'ERROR' | 'REJECTED';
  details?: string;
  detectedInvite?: string;
  detectedInvites?: string[];
  inviteLocation?: string;
  timestamp: string;
}

export type QueryCollection = 'PROVEN' | 'EXPERIMENTAL' | 'REJECTED';

export type QueryIntent =
  | 'beginner'
  | 'strategy'
  | 'news'
  | 'education'
  | 'indicators'
  | 'psychology'
  | 'futures'
  | 'forex'
  | 'crypto'
  | 'stocks'
  | 'options'
  | 'market_analysis'
  | 'premarket_prep'
  | 'live_trading'
  | 'educational'
  | 'weekly_reviews'
  | 'trading_journals'
  | 'session_analysis'
  | 'strategy_breakdowns'
  | 'prop_firm';

export interface QualityScoreBreakdown {
  educational_authenticity: number;
  freshness_activity: number;
  community_presence: number;
  low_fluff_score: number;
  reasons: string[];
}

export interface ChannelRecord {
  channel_id: string;
  channel_name: string;
  youtube_url: string;
  country: string | null;
  country_status: CountryStatus;
  confidence_score: number;
  discord_status: DiscordStatus;
  discord_invite?: string | null;
  discord_discovery_status?: DiscordDiscoveryStatus;
  discord_candidate_locator?: string | null;
  discord_candidate_id?: string | null;
  discord_candidate_raw_locator?: string | null;
  discord_candidate_type?: string | null;
  discord_resolution_status?: DiscordResolutionStatus;
  discord_liveness_status?: DiscordLivenessStatus;
  discord_relevance_status?: DiscordRelevanceStatus;
  discord_validation_status?: DiscordValidationStatus;
  discord_candidates?: Array<{candidate_id:string;raw_locator:string;normalized_locator:string;locator_type:string;source_surface?:string;source_url?:string;source_observations?:Array<{sourceSurface?:string;sourceUrl?:string;rawLocator?:string}>;candidate_status:string;validation_status:string;liveness_status:string;relevance_status:string;retryable:boolean;attempt_count:number;last_checked?:string;failure_reason?:string;selected:boolean}>;
  post_approval_job_status?: 'PENDING'|'PROCESSING'|'COMPLETED'|'FAILED';
  post_approval_job_error?: string;
  post_approval_job_attempts?: number;
  post_approval_job_max_attempts?: number;
  post_approval_job_run_after?: string | null;
  community_retry_job_status?: 'PENDING'|'PROCESSING'|'COMPLETED'|'FAILED';
  community_retry_job_attempts?: number;
  community_retry_job_max_attempts?: number;
  community_retry_job_run_after?: string | null;
  community_retry_job_error?: string;
  community_retry_job_execution_count?: number;
  community_retry_job_deferral_count?: number;
  /**
   * Attempt rows with affirmative evidence that acquisition actually ran:
   * COMPLETED rows, or FAILED rows whose error is neither a capacity
   * deferral nor a stale-worker recovery. A bare claim (PROCESSING),
   * deferral, or pre-dispatch stale failure is never counted here.
   */
  community_retry_job_executed_count?: number;
  community_retry_job_last_execution_at?: string | null;
  community_retry_job_last_execution_status?: string;
  community_retry_job_retry_reason?: 'NO_SURFACE' | 'BROWSER_RUNTIME_UNAVAILABLE' | 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE' | 'UPSTREAM_REQUIRED_ACQUISITION_FAILURE' | string;
  community_retry_job_retry_code?: string;
  community_retry_job_reconciliation_status?: 'NONE' | 'RECONCILIATION_REQUIRED';
  community_retry_job_reconciliation_code?: 'STALE_RETRY' | string;
  community_retry_job_reconciliation_reason?: string;
  scan_status: ScanStatus;
  scan_attempts: number;
  discovery_source: DiscoverySource;
  first_seen: string;
  last_checked?: string | null;
  inspection_trail?: InspectionStep[];
  subscriber_count?: string;
  channel_thumbnail_url?: string;
  quality_score?: number;
  quality_breakdown?: QualityScoreBreakdown;
  trading_status?: TradingStatus;
  trading_confidence_score?: number;
  trading_category?: TradingCategory | string;
  trading_relevance_breakdown?: TradingRelevanceBreakdown;
  country_metadata_status?: CountryMetadataStatus;
  country_metadata_checked_at?: string | null;
  public_about_status?: PublicAboutStatus;
  public_about_checked_at?: string | null;
  public_about_attempts?: number;
  latest_upload_at?: string | null;
  uploads_last_30_days?: number;
  uploads_last_90_days?: number;
  uploads_last_365_days?: number;
  activity_band?: ChannelActivityBand;
  activity_score?: number;
  activity_observed_at?: string | null;
}

export interface QueryRecord {
  id: number;
  query: string;
  country: string;
  collection: QueryCollection;
  intent: QueryIntent;
  times_executed: number;
  last_executed?: string | null;
  total_channels_found: number;
  unique_channels_found: number;
  quality_channels_found: number;
  community_channels_found: number;
  avg_quality_score: number;
  performance_score: number;
  created_at: string;
  status: 'ACTIVE' | 'ARCHIVED';
  ucb_score?: number;
  knowledge_tiers?: Array<1 | 2 | 3>;
  generation_mode?: 'EXPLORATION' | 'EXPLOITATION' | 'COLD_START' | 'LEGACY';
  generation_reason?: string;
  discovery_objective?: string;
  primary_term?: string;
  generation_metadata?: Record<string, unknown>;
}

export interface QueryExecutionLog {
  id: number;
  query_id?: number;
  query: string;
  country: string;
  executed_at: string;
  channels_discovered: number;
  unique_new_channels: number;
  quality_creators_discovered: number;
  communities_discovered: number;
  cycle_quality_score: number;
  logs?: string[];
}

export interface ExtractedTermRecord {
  id: number;
  country: string;
  term: string;
  category: 'terminology' | 'instrument' | 'phrase' | 'format';
  source_channel_id?: string;
  occurrences: number;
  first_extracted: string;
  last_extracted: string;
  trust_tier?: 2 | 3;
  validation_count?: number;
}

export interface CanonicalTradingTerm {
  id: number;
  canonical_term: string;
  normalized_term: string;
  aliases: Array<{ alias: string; type: string; language: string; script: string }>;
  country: string;
  language: string;
  script: string;
  term_type: 'TERMINOLOGY' | 'INSTRUMENT' | 'PHRASE' | 'FORMAT' | 'BRAND';
  trust_tier: 1 | 2 | 3 | 4;
  search_eligible: boolean;
  classification_eligible: boolean;
  country_evidence_eligible: boolean;
  lifecycle_status: 'CANDIDATE' | 'OBSERVED' | 'MULTI_CREATOR_VALIDATED' | 'SEARCH_TRIAL' | 'PROVEN_SEARCH_TERM' | 'DEMOTED';
  distinct_creator_count: number;
  executions: number;
  new_creators: number;
  decayed_yield_score: number;
  retrieval_lanes: Record<string, number>;
  lifecycle_history: Array<{ type: string; from?: string; to: string; reason: string; at: string }>;
  created_at: string;
  first_observed_at?: string;
  last_observed_at?: string;
}

export interface CountryVocabulary {
  country: string;
  languages: string[];
  native_trading_terminology: string[];
  popular_instruments: string[];
  local_market_phrases: string[];
  common_content_format_names: string[];
}

export interface ExcludedCountry {
  country_name: string;
  reason: string;
}

export interface CommunityRetryAdmissionDiagnostics {
  duePending: number;
  dueBrowserBlocked: number;
  dueReconciliationBlocked: number;
  dueClaimable: number;
  processing: number;
  staleProcessing: number;
  oldestDueAt: string | null;
  oldestProcessingAt: string | null;
}

export interface QueueStatus {
  searchJobs: { depth: number; isPaused: boolean };
  channelProcessing: { depth: number; isPaused: boolean };
  discordValidation: { depth: number; isPaused: boolean };
  communityRetry: CommunityRetryAdmissionDiagnostics;
  pendingWork: Array<{ id: string; type: string; waitingReason: string; retryAt: string | null; priority: number; ageMs: number; lastProviderError: string | null }>;
}

export interface KeyQuotaUsage {
  keyIndex: number;
  maskedKey: string;
  unitsUsed: number;
  remaining: number;
  limit: number;
  isActive: boolean;
  status: 'Active' | 'Cooling Down' | 'Daily Quota Exhausted' | 'Unavailable';
  retryAt: string | null;
}

export interface QuotaInfo {
  unitsUsed: number;
  dailyLimit: number;
  lastReset: string;
  totalKeys?: number;
  keyUsage?: KeyQuotaUsage[];
}

export interface SearchJob {
  id: string;
  query: string;
  country: string;
  source: DiscoverySource;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  attempts: number;
  createdAt: string;
}

export interface BenchmarkSample {
  channel_id: string;
  channel_name: string;
  country: string;
  ground_truth_trading: 'TRADING_CONFIRMED' | 'NON_TRADING';
  ground_truth_discord: 'ACTIVE' | 'NOT_FOUND';
  ground_truth_category: string;
  sample_description: string;
  sample_video_titles: string[];
}

export interface RegressionRunMetrics {
  total_tested: number;
  classified_trading: number;
  classified_non_trading: number;
  true_positives: number;
  true_negatives: number;
  false_positives: number;
  false_negatives: number;
  precision: number;
  recall: number;
  f1_score: number;
  discord_target_total: number;
  discord_discovered: number;
  discord_discovery_rate: number;
  avg_processing_time_ms: number;
  api_quota_consumed: number;
  query_performance_index: number;
}

export interface RegressionRunRecord {
  id: number;
  run_timestamp: string;
  run_label: string;
  metrics: RegressionRunMetrics;
  sample_results: Array<{
    channel_id: string;
    channel_name: string;
    country: string;
    ground_truth_trading: 'TRADING_CONFIRMED' | 'NON_TRADING';
    predicted_trading: 'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN' | 'NEEDS_REVIEW' | 'HUMAN_REJECTED';
    ground_truth_discord: 'ACTIVE' | 'NOT_FOUND';
    predicted_discord: string;
    is_correct_trading: boolean;
    is_correct_discord: boolean;
    processing_time_ms: number;
  }>;
}

export interface RegressionDiffReport {
  baseline_label: string;
  current_label: string;
  baseline_timestamp: string;
  current_timestamp: string;
  precision_delta: number;
  recall_delta: number;
  f1_delta: number;
  discord_rate_delta: number;
  latency_delta_ms: number;
  quota_delta: number;
  query_index_delta: number;
  has_regression_alert: boolean;
  regression_alerts: string[];
}
