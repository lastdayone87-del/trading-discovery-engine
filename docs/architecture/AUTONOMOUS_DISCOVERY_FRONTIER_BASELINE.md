# Autonomous Discovery Frontier Baseline Architecture

## Overview
This document records the baseline invariants and contracts of the autonomous YouTube discovery engine prior to introducing Autonomous Discovery Frontier Intelligence (Checkpoint 1 / Phases 0–1).

## Production Invariants & System Contracts

### 1. Autonomous Country Rotation
- The discovery scheduler persists country iteration state (`qi_current_country_index` app setting).
- Cycle executions rotate sequentially across eligible countries in `country_vocabularies` that are not excluded via `excluded_countries` or discovery scope settings (`GLOBAL` or `SELECTED_COUNTRIES`).

### 2. Query Cooldown & Reusability
- Queries in `query_library` are gated by a hard cooldown period (default: 360 minutes / 6 hours, configured via `query_intelligence_query_cooldown_minutes`).
- A query cannot be scheduled if `last_executed`, `reserved_until`, or `next_eligible_at` falls within the active cooldown window.

### 3. UCB1 Multi-Armed Bandit Query Selection
- Queries are selected per country using a Multi-Armed Bandit (UCB1) formula balancing exploitation of `PROVEN` queries and exploration of `EXPERIMENTAL` queries.
- Exploitation vs exploration balance is controlled by `query_intelligence_exploration_ratio` (default 0.4).
- Overused primary terms are capped (`query_intelligence_primary_term_max_uses`, default 2), and intent rotation prevents repeating the most recent search intent.

### 4. Novelty & Performance Scoring
- Query performance score (0-100) is evaluated after each execution based on distinct channel yield, new creator ratio, quality creators found, and trading confirmation.
- High-performing experimental queries are promoted to `PROVEN`, while poor or contaminated queries are demoted to `REJECTED` or quarantined for reformulation.

### 5. Quota Accounting & Capacity Allocation
- YouTube Data API quota is paced against a Pacific quota-day reset (midnight US Pacific Time / UTC-8 or UTC-7 daylight savings).
- Each search query run reserves 100 quota units.
- Autonomous capacity is paced dynamically via `calculateDiscoveryCapacity` based on remaining daily budget, current queue depth, and paced autonomous quota percentage.

### 6. Search Ordering & Dual-Lane Discovery
- Search ordering operates in two lanes: `RELEVANCE` (control and fallback) and `DATE` (recency/activity discovery).
- Retrieval lanes are divided between `VIDEO` (primary default) and `CHANNEL` lanes.
- `DATE` ordering is strictly applied to `VIDEO` runs only and never to `CHANNEL` runs.

### 7. Pagination Bounds
- Page depth during search execution is strictly bounded. Adaptive pagination limits search result fetching to avoid unnecessary quota drain while preserving productive depth.

### 8. Provider Rotation, Failover, & 429 Backoff
- YouTube API provider key rotation is managed via active key pools and failover semantics.
- 429 rate limit errors trigger per-provider cooldowns and pool backoff without corrupting query performance metrics or durable queue state.

## Frontier Intelligence Evolution (Expand-Only)
The hierarchy introduced in this program is:
`Discovery Surface → Neighborhood → Hypothesis → Retrieval Action → Observation → Frontier Update`

Checkpoint 1 adds a minimal deterministic identity for discovery neighborhoods and links query runs as retrieval actions inside neighborhoods without altering any scheduling, execution, or ranking decisions.
