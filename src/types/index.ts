export type CountryStatus = 'CONFIRMED' | 'LIKELY' | 'UNCERTAIN' | 'REJECTED';
export type CountryMetadataStatus = 'AVAILABLE_DECLARED' | 'AVAILABLE_NOT_DECLARED' | 'UNAVAILABLE' | 'NOT_REQUESTED';
export type ChannelActivityBand = 'VERY_ACTIVE' | 'ACTIVE' | 'OCCASIONAL' | 'DORMANT' | 'UNKNOWN';
export interface DashboardOperationalSummary {
  storedChannels: number;
  activeDiscords: number;
  pendingScans: number;
  scope: { storedChannels: 'ELIGIBLE_OPERATOR_VISIBLE_CHANNELS'; operationalMetrics: 'ELIGIBLE_OPERATOR_VISIBLE_CHANNELS' };
  deployment: { environment: string; service: string; instance: string };
}

export type DiscordStatus = 'PENDING' | 'NOT_FOUND' | 'ACTIVE' | 'ACTIVE_LOW_VOLUME' | 'NON_TRADING' | 'DEAD' | 'UNCERTAIN';

export type ScanStatus = 'PENDING' | 'LOCKED' | 'ENRICHMENT_PENDING' | 'ENRICHING' | 'NEEDS_REVIEW' | 'COMPLETED' | 'FAILED' | 'FAILED_PERMANENT' | 'SKIPPED_NON_TRADING' | 'SKIPPED_EXCLUDED';

export type DiscoverySource = 'manual_search' | 'automated_query' | 'recheck';

export type TradingStatus = 'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN' | 'NEEDS_REVIEW' | 'HUMAN_REJECTED' | 'HUMAN_REJECTED';

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
  stage_a_score: number;       // 0 to 100
  consistency_ratio: number;  // 0.0 to 1.0
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
  status: 'FOUND' | 'NOT_FOUND' | 'SKIPPED' | 'ERROR' | 'REJECTED';
  details?: string;
  detectedInvite?: string;
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
  educational_authenticity: number; // 0 to 35
  freshness_activity: number;        // 0 to 25
  community_presence: number;        // 0 to 25
  low_fluff_score: number;           // 0 to 15
  reasons: string[];
}

export interface ChannelRecord {
  channel_id: string;
  channel_name: string;
  youtube_url: string;
  country: string;
  country_status: CountryStatus;
  confidence_score: number; // 0 to 100
  discord_status: DiscordStatus;
  discord_invite?: string | null;
  scan_status: ScanStatus;
  scan_attempts: number;
  discovery_source: DiscoverySource;
  first_seen: string;
  last_checked?: string | null;
  inspection_trail?: InspectionStep[];
  subscriber_count?: string;
  channel_thumbnail_url?: string;
  quality_score?: number; // 0 to 100
  quality_breakdown?: QualityScoreBreakdown;
  trading_status?: TradingStatus;
  trading_confidence_score?: number; // 0 to 100
  trading_category?: TradingCategory | string;
  trading_relevance_breakdown?: TradingRelevanceBreakdown;
  country_metadata_status?: CountryMetadataStatus;
  country_metadata_checked_at?: string | null;
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
  performance_score: number; // 0 to 100
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

export interface QueueStatus {
  searchJobs: { depth: number; isPaused: boolean };
  channelProcessing: { depth: number; isPaused: boolean };
  discordValidation: { depth: number; isPaused: boolean };
}

export interface KeyQuotaUsage {
  keyIndex: number;
  maskedKey: string;
  unitsUsed: number;
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
  precision: number;            // percentage 0 to 100
  recall: number;               // percentage 0 to 100
  f1_score: number;             // percentage 0 to 100
  discord_target_total: number;
  discord_discovered: number;
  discord_discovery_rate: number; // percentage 0 to 100
  avg_processing_time_ms: number;
  api_quota_consumed: number;
  query_performance_index: number; // 0 to 100
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
