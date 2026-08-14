from pathlib import Path


def require(text: str, needle: str, label: str) -> None:
    if needle not in text:
        raise SystemExit(f"missing expected pattern: {label}")


# queueManager: make quota-gated operational workers exclusive consumers and
# reserve the bounded configured key-pool worst case for official API work.
p = Path("server/queueManager.ts")
s = p.read_text()
require(s, "  getDailyYouTubeQuotaBudget,\n  appendDiscordCheckAttempts,", "db import anchor")
s = s.replace(
    "  getDailyYouTubeQuotaBudget,\n  appendDiscordCheckAttempts,",
    "  getDailyYouTubeQuotaBudget,\n  getYouTubeKeyPool,\n  appendDiscordCheckAttempts,",
    1,
)

post_unrestricted = "if (!qStatus.channelProcessing.isPaused && (!claimableOverride || claimableOverride.includes('POST_APPROVAL_ENRICH'))) claimableTypes.push('POST_APPROVAL_ENRICH');"
force_unrestricted = "if (!qStatus.channelProcessing.isPaused && (!claimableOverride || claimableOverride.includes('FORCE_REVIEW_RESCAN'))) claimableTypes.push('FORCE_REVIEW_RESCAN');"
require(s, post_unrestricted, "post approval unrestricted claim")
require(s, force_unrestricted, "force rescan unrestricted claim")
s = s.replace(
    post_unrestricted,
    "if (!qStatus.channelProcessing.isPaused && claimableOverride?.includes('POST_APPROVAL_ENRICH')) claimableTypes.push('POST_APPROVAL_ENRICH');",
    1,
)
s = s.replace(
    force_unrestricted,
    "if (!qStatus.channelProcessing.isPaused && claimableOverride?.includes('FORCE_REVIEW_RESCAN')) claimableTypes.push('FORCE_REVIEW_RESCAN');",
    1,
)

enrichment_old = """      const enrichmentQuotaUnits=enrichmentStage>=2?202:101;
      const quotaReserved = await tryReserveQuota({
        operationType: 'ENRICH_CHANNEL', operationId: job.id, allocation: 'ENRICHMENT',
        units: enrichmentQuotaUnits, dailyBudget, allocationPercent: enrichmentPercent
      });"""
enrichment_new = """      const enrichmentQuotaUnits=enrichmentStage>=2?202:101;
      const enrichmentReservationUnits=enrichmentQuotaUnits*Math.max(1,getYouTubeKeyPool().length);
      const quotaReserved = await tryReserveQuota({
        operationType: 'ENRICH_CHANNEL', operationId: job.id, allocation: 'ENRICHMENT',
        units: enrichmentReservationUnits, dailyBudget, allocationPercent: enrichmentPercent
      });"""
require(s, enrichment_old, "enrichment reservation")
s = s.replace(enrichment_old, enrichment_new, 1)

autonomous_old = """      providerQuotaUnits=100;
      const budget=getDailyYouTubeQuotaBudget();
      const percent=Number(await getAppSetting('discovery_autonomous_quota_percent','70'));
      if(!await tryReserveQuota({operationType:'AUTONOMOUS_QUERY_PAGE',operationId:autonomousOperationId,allocation:'AUTONOMOUS',units:providerQuotaUnits,dailyBudget:budget,allocationPercent:percent}))"""
autonomous_new = """      providerQuotaUnits=100;
      const providerReservationUnits=providerQuotaUnits*Math.max(1,getYouTubeKeyPool().length);
      const budget=getDailyYouTubeQuotaBudget();
      const percent=Number(await getAppSetting('discovery_autonomous_quota_percent','70'));
      if(!await tryReserveQuota({operationType:'AUTONOMOUS_QUERY_PAGE',operationId:autonomousOperationId,allocation:'AUTONOMOUS',units:providerReservationUnits,dailyBudget:budget,allocationPercent:percent}))"""
require(s, autonomous_old, "autonomous reservation")
s = s.replace(autonomous_old, autonomous_new, 1)
p.write_text(s)

# Provider2 incident recovery: only explicit retryable upstream failures receive
# attempt-free infrastructure retry treatment.
p = Path("server/operationalMaintenanceWorkers.ts")
s = p.read_text()
require(s, "const retryable = result.retryable !== false;", "recovery retryability")
s = s.replace("const retryable = result.retryable !== false;", "const retryable = result.retryable === true;", 1)
p.write_text(s)

# Queue monitor: remove retired YouTube.js/hybrid telemetry and expose only the
# official YouTube Data API enrichment health/costs.
p = Path("src/components/QueueMonitor.tsx")
s = p.read_text()
require(s, "  return operation === 'hybrid-enrichment-channel-details'\n    || operation === 'channel-details'", "hybrid operation filter")
s = s.replace(
    "  return operation === 'hybrid-enrichment-channel-details'\n    || operation === 'channel-details'",
    "  return operation === 'channel-details'",
    1,
)
old_block = """    const youtubeJsRows = providerRows.filter(row => row.provider.toLowerCase() === 'youtube_js' && row.operation.includes('channel-enrichment'));
    const officialRows = providerRows.filter(row => row.provider.toLowerCase() === 'youtube' && isOfficialEnrichmentOperation(row.operation));
    const hybridOfficialRows = officialRows.filter(row => row.operation === 'hybrid-enrichment-channel-details');
    const displayedRows = [...youtubeJsRows, ...officialRows];

    const sum = (rows: ProviderMetricRow[], key: keyof ProviderMetricRow) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
    const youtubeJsCalls = sum(youtubeJsRows, 'calls');
    const youtubeJsSuccesses = sum(youtubeJsRows, 'successes');
    const youtubeJsErrors = sum(youtubeJsRows, 'errors') + sum(youtubeJsRows, 'timeouts');
    const officialActualCost = sum(officialRows, 'actual_cost');
    const officialReservedCost = sum(officialRows, 'reserved_cost');
    const hybridOfficialActualCost = sum(hybridOfficialRows, 'actual_cost');
    const baseAcquisitions = youtubeJsRows.filter(row => row.operation === 'channel-enrichment');
    const baseSuccesses = sum(baseAcquisitions, 'successes');
    const averageOfficialUnits = baseSuccesses > 0 ? hybridOfficialActualCost / baseSuccesses : null;
    const weightedLatency = youtubeJsCalls > 0
      ? youtubeJsRows.reduce((total, row) => total + Number(row.average_latency_ms || 0) * Number(row.calls || 0), 0) / youtubeJsCalls
      : 0;"""
new_block = """    const officialRows = providerRows.filter(row => row.provider.toLowerCase() === 'youtube' && isOfficialEnrichmentOperation(row.operation));
    const displayedRows = officialRows;

    const sum = (rows: ProviderMetricRow[], key: keyof ProviderMetricRow) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
    const officialCalls = sum(officialRows, 'calls');
    const officialSuccesses = sum(officialRows, 'successes');
    const officialErrors = sum(officialRows, 'errors') + sum(officialRows, 'timeouts');
    const officialActualCost = sum(officialRows, 'actual_cost');
    const officialReservedCost = sum(officialRows, 'reserved_cost');
    const baseAcquisitions = officialRows.filter(row => row.operation === 'channel-uploads');
    const baseSuccesses = sum(baseAcquisitions, 'successes');
    const averageOfficialUnits = baseSuccesses > 0 ? officialActualCost / baseSuccesses : null;
    const weightedLatency = officialCalls > 0
      ? officialRows.reduce((total, row) => total + Number(row.average_latency_ms || 0) * Number(row.calls || 0), 0) / officialCalls
      : 0;"""
require(s, old_block, "QueueMonitor provider aggregation block")
s = s.replace(old_block, new_block, 1)
s = s.replace("youtubeJsCalls", "officialCalls")
s = s.replace("youtubeJsSuccesses", "officialSuccesses")
s = s.replace("youtubeJsErrors", "officialErrors")
s = s.replace("youtubeJsLatencyMs", "officialLatencyMs")
s = s.replace("YouTube.js", "YouTube Data API")
s = s.replace("hybrid enrichment", "official enrichment")
s = s.replace("Hybrid enrichment", "Official enrichment")
s = s.replace("near 1 official unit", "101 units for stage 1 and 202 units for stage 2")
s = s.replace("~1 official unit", "101/202 official units by stage")
for retired in ("youtube_js", "hybrid-enrichment-channel-details", "YouTube.js"):
    if retired in s:
        raise SystemExit(f"retired QueueMonitor telemetry still present: {retired}")
p.write_text(s)

# Focused contracts.
p = Path("server/operationalMaintenanceWorkers.test.ts")
s = p.read_text()
require(s, r"assert.match(workers, /const retryable = result\.retryable !== false/);", "retry contract")
s = s.replace(
    r"assert.match(workers, /const retryable = result\.retryable !== false/);",
    r"assert.match(workers, /const retryable = result\.retryable === true/);",
    1,
)
p.write_text(s)

p = Path("server/provider2Removal.contract.test.ts")
s = p.read_text()
if "const queueMonitor" not in s:
    anchor = "const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');"
    require(s, anchor, "provider2 contract youtube anchor")
    s = s.replace(anchor, anchor + "\nconst queueMonitor = readFileSync(new URL('../src/components/QueueMonitor.tsx', import.meta.url), 'utf8');", 1)
if "operational rechecks cannot bypass their dedicated quota-gated workers" not in s:
    s += r'''

test('operational rechecks cannot bypass their dedicated quota-gated workers', () => {
  assert.match(queueManager, /claimableOverride\?\.includes\('POST_APPROVAL_ENRICH'\)/);
  assert.match(queueManager, /claimableOverride\?\.includes\('FORCE_REVIEW_RESCAN'\)/);
  assert.doesNotMatch(queueManager, /!claimableOverride \|\| claimableOverride\.includes\('POST_APPROVAL_ENRICH'\)/);
  assert.doesNotMatch(queueManager, /!claimableOverride \|\| claimableOverride\.includes\('FORCE_REVIEW_RESCAN'\)/);
});

test('official enrichment and autonomous admission reserve the configured key-pool worst case', () => {
  assert.match(queueManager, /getYouTubeKeyPool/);
  assert.match(queueManager, /enrichmentReservationUnits=enrichmentQuotaUnits\*Math\.max\(1,getYouTubeKeyPool\(\)\.length\)/);
  assert.match(queueManager, /units: enrichmentReservationUnits/);
  assert.match(queueManager, /providerReservationUnits=providerQuotaUnits\*Math\.max\(1,getYouTubeKeyPool\(\)\.length\)/);
  assert.match(queueManager, /units:providerReservationUnits/);
});

test('queue monitor reports only official Data API enrichment health', () => {
  assert.doesNotMatch(queueMonitor, /youtube_js|YouTube\.js|hybrid-enrichment-channel-details/);
  assert.match(queueMonitor, /YouTube Data API/);
  assert.match(queueMonitor, /channel-uploads/);
});
'''
p.write_text(s)
