/**
 * Offline replay of observed YouTube provider calls against the shadow-only
 * 9,000-unit/day per-key cap.
 *
 * Pure computation: no database, no network, no provider keys (key_fp values
 * are already non-reversible fingerprints). For every SUCCESS call the
 * reservation is modeled from `occurred_at - latency_ms` until completion or
 * lease TTL expiry (whichever is first), grouped by the America/Los_Angeles
 * quota day, and the same classifier used by the live shadow hooks decides
 * what a hard cap WOULD have deferred or rejected. The official settlement
 * remains on the completion day. Settled usage of blocked calls is not added
 * (hard enforcement would not have executed them).
 *
 * Usage:
 *   npx tsx scripts/quota_shadow_replay.ts \
 *     --csv /tmp/opencode/evidence/quota_calls_1016_1018.csv \
 *     --out /tmp/opencode/evidence/quota_shadow_replay
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { SHADOW_CAP_UNITS, SHADOW_LEASE_TTL_MS, simulateShadowReplay, type ShadowReplayCall } from '../server/quotaKeyCapShadow';

interface Args {
  csv: string;
  out: string;
  cap: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { csv: '', out: '/tmp/opencode/evidence/quota_shadow_replay', cap: SHADOW_CAP_UNITS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--csv' && value) { args.csv = value; i += 1; }
    else if (flag === '--out' && value) { args.out = value; i += 1; }
    else if (flag === '--cap' && value) { args.cap = Number(value); i += 1; }
  }
  if (!args.csv) throw new Error('usage: --csv <path> [--out <prefix>] [--cap <units>]');
  if (!Number.isInteger(args.cap) || args.cap <= 0) throw new Error('--cap must be a positive integer');
  return args;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function numeric(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function maskKey(fingerprint: string): string {
  return fingerprint ? `${fingerprint.slice(0, 8)}…` : '(missing)';
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const rows = parseCsv(readFileSync(args.csv, 'utf8'));
  const header = rows.shift() ?? [];
  const index = new Map(header.map((column, position) => [column.trim(), position]));
  for (const column of ['occurred_at', 'status', 'reserved_cost', 'actual_cost', 'latency_ms', 'key_fp', 'request_id']) {
    if (!index.has(column)) throw new Error(`CSV is missing column: ${column}`);
  }
  const at = (row: string[], column: string): string => row[index.get(column)!] ?? '';

  const stats = {
    totalRows: rows.length,
    statusCounts: {} as Record<string, number>,
    excluded: { nonSuccess: 0, missingKey: 0, nonPositiveUsage: 0, invalidTimestamp: 0 },
    duplicateRequestIds: 0,
    reservedNotEqualActual: 0,
    latencyZero: 0,
    latencyAboveLeaseTtl: 0,
    maxLatencyMs: 0,
    windowStart: '',
    windowEnd: '',
  };
  const seenRequestIds = new Set<string>();
  const calls: ShadowReplayCall[] = [];

  for (const row of rows) {
    const status = at(row, 'status') || '(empty)';
    stats.statusCounts[status] = (stats.statusCounts[status] ?? 0) + 1;
    const occurredAtMs = Date.parse(at(row, 'occurred_at'));
    const latencyMs = numeric(at(row, 'latency_ms'));
    const reservedCost = numeric(at(row, 'reserved_cost'));
    const actualCost = numeric(at(row, 'actual_cost'));
    const keyFp = at(row, 'key_fp').trim();
    const requestId = at(row, 'request_id').trim();
    if (!Number.isFinite(occurredAtMs)) { stats.excluded.invalidTimestamp += 1; continue; }
    const timestamp = at(row, 'occurred_at');
    if (!stats.windowStart || timestamp < stats.windowStart) stats.windowStart = timestamp;
    if (!stats.windowEnd || timestamp > stats.windowEnd) stats.windowEnd = timestamp;
    if (requestId) {
      if (seenRequestIds.has(requestId)) stats.duplicateRequestIds += 1;
      else seenRequestIds.add(requestId);
    }
    if (status !== 'SUCCESS') { stats.excluded.nonSuccess += 1; continue; }
    if (!keyFp) { stats.excluded.missingKey += 1; continue; }
    if (!(actualCost > 0) || !(reservedCost > 0)) { stats.excluded.nonPositiveUsage += 1; continue; }
    const latency = Number.isFinite(latencyMs) && latencyMs > 0 ? latencyMs : 0;
    if (latency === 0) stats.latencyZero += 1;
    if (latency > SHADOW_LEASE_TTL_MS) stats.latencyAboveLeaseTtl += 1;
    stats.maxLatencyMs = Math.max(stats.maxLatencyMs, latency);
    if (reservedCost !== actualCost) stats.reservedNotEqualActual += 1;
    calls.push({
      occurredAtMs,
      // Preserve the observed start. The simulator expires the lease at the
      // TTL independently, rather than shifting the request start forward.
      latencyMs: latency,
      keyFingerprint: keyFp,
      reservedUnits: reservedCost,
      settledUnits: actualCost,
    });
  }

  const withLeases = simulateShadowReplay(calls, { capUnits: args.cap });
  const settledOnly = simulateShadowReplay(calls, { capUnits: args.cap, settledOnly: true });

  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    source: args.csv,
    capUnits: args.cap,
    quotaDay: 'America/Los_Angeles',
    boundaryRule:
      `projected + request <= cap admitted; crossing from below = WOULD_DEFER; projected >= cap = WOULD_REJECT (${args.cap} admitted / ${args.cap + 1} blocked)`,
    stats,
    simulations: { withInFlightLeases: withLeases, settledOnly },
  };
  writeFileSync(`${args.out}.json`, `${JSON.stringify(report, null, 2)}\n`);

  const lines: string[] = [];
  lines.push(`# Quota cap shadow replay — ${args.cap.toLocaleString('en-US')} units/key/day`);
  lines.push('');
  lines.push(`Generated: ${generatedAt}`);
  lines.push(`Source: \`${args.csv}\` (${stats.totalRows} rows)`);
  lines.push(`Window: ${stats.windowStart} → ${stats.windowEnd}`);
  lines.push(`Cap: ${args.cap} units/key/day; quota day: America/Los_Angeles`);
  lines.push(`Boundary: ${report.boundaryRule}`);
  lines.push(`Replayed calls: ${calls.length} (SUCCESS rows with key fingerprint and positive usage)`);
  lines.push('');
  lines.push('## Projected blocks with in-flight leases');
  lines.push('');
  lines.push('| day | key | allowed | would-defer | would-reject | settled units | peak in-flight |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const [dayKey, dayTotals] of Object.entries(withLeases.byDay)) {
    for (const [fingerprint, keyTotals] of Object.entries(dayTotals.byKey)) {
      lines.push(
        `| ${dayKey} | ${maskKey(fingerprint)} | ${keyTotals.allowed} | ${keyTotals.wouldDefer} | ${keyTotals.wouldReject} | ${keyTotals.settledUnits} | ${keyTotals.peakInFlight} |`
      );
    }
  }
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(`- With in-flight leases: allowed ${withLeases.totalAllowed}, would-defer ${withLeases.totalWouldDefer}, would-reject ${withLeases.totalWouldReject}, peak in-flight ${withLeases.peakInFlight}`);
  lines.push(`- Settled-only comparison: allowed ${settledOnly.totalAllowed}, would-defer ${settledOnly.totalWouldDefer}, would-reject ${settledOnly.totalWouldReject}`);
  lines.push(`- Concurrency effect (projected blocks only visible with leases): ${withLeases.totalWouldDefer + withLeases.totalWouldReject - settledOnly.totalWouldDefer - settledOnly.totalWouldReject}`);
  lines.push('');
  lines.push('## Accounting gaps and assumptions');
  lines.push('');
  lines.push(`- Excluded rows: non-SUCCESS ${stats.excluded.nonSuccess}, missing key fingerprint ${stats.excluded.missingKey}, non-positive usage ${stats.excluded.nonPositiveUsage}, invalid timestamp ${stats.excluded.invalidTimestamp}`);
  lines.push(`- Duplicate request_ids across rows: ${stats.duplicateRequestIds}`);
  lines.push(`- reserved_cost ≠ actual_cost rows: ${stats.reservedNotEqualActual}`);
  lines.push(`- latency_ms = 0 rows: ${stats.latencyZero}; latency above lease TTL (${SHADOW_LEASE_TTL_MS} ms): ${stats.latencyAboveLeaseTtl}; max latency ${stats.maxLatencyMs} ms`);
  lines.push('- Blocked calls are modeled as not executed (hard enforcement semantics): their settled units are not added.');
  lines.push('- Live shadow hook nuance: charges without a matching exact-unit lease settle as no-ops (documented gap); this replay uses exact reserved/actual costs per row.');
  writeFileSync(`${args.out}.md`, `${lines.join('\n')}\n`);

  console.log(JSON.stringify({
    source: args.csv,
    capUnits: args.cap,
    replayedCalls: calls.length,
    stats,
    totals: {
      withLeases: { allowed: withLeases.totalAllowed, defer: withLeases.totalWouldDefer, reject: withLeases.totalWouldReject },
      settledOnly: { allowed: settledOnly.totalAllowed, defer: settledOnly.totalWouldDefer, reject: settledOnly.totalWouldReject },
    },
    out: { json: `${args.out}.json`, markdown: `${args.out}.md` },
  }, null, 2));
}

main();
