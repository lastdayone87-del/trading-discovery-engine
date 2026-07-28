# Conflict Resolution Notes

## autonomousDiscovery.ts
Two fundamentally different implementations:

### HEAD (PR branch) - "Producer" pattern
- Imports: getSchedulerState, releaseSchedulerLock, scheduleAutonomousQueryRuns, setAppSetting, updateSchedulerState from db
- Imports: selectNextQueryForCountry from queryIntelligence
- Imports: calculateDiscoveryCapacity from discoverySchedulerPolicy
- Reports extra fields: queuedCount, queueDepth, remainingAutonomousQuota
- DiscoveryConfig type defined
- `runAutonomousDiscoveryCycle` produces batches of durable work (schedules query runs, no direct YouTube calls)
- Uses scheduleAutonomousQueryRuns to create queue jobs
- Scheduler uses setTimeout + recursive schedule() with dynamic intervals

### main branch - "Full Execution" pattern  
- Imports: getChannelById, getAllChannels, getRecentQueryExecutionLogs, addQueryExecutionLog, upsertChannel, getAppSetting, setAppSetting, getSchedulerState, acquireSchedulerLock, releaseSchedulerLock, updateSchedulerState, recoverStaleJobs from db
- Imports: searchYouTubeChannels from youtube
- Imports: processDiscoveredChannel, ProcessDiscoveredChannelOutcome from queueManager (duplicate import line)
- Imports: selectNextQueryForCountry, calculateCreatorQualityScore, extractVocabularyFromCreator, evaluateQueryPerformance from queryIntelligence
- `runAutonomousDiscoveryCycle` does full execution: YouTube search, channel processing, quality scoring
- Has try/catch/finally with addQueryExecutionLog for audit trail
- Scheduler uses setInterval with stale job recovery

### Resolution Strategy
The HEAD branch represents the newer architecture (quota-aware producer pattern from PR #9). We need to keep BOTH:
- The HEAD's producer pattern as the primary `runAutonomousDiscoveryCycle`
- Merge in the new imports that don't conflict (getChannelById, getAllChannels, getRecentQueryExecutionLogs, upsertChannel, recoverStaleJobs, searchYouTubeChannels)
- Keep HEAD's scheduler (setTimeout recursive) but add the stale job recovery from main
- For getAutonomousDiscoveryStatus, keep HEAD's Promise.all version (more efficient)
