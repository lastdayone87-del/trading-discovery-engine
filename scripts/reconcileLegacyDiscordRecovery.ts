#!/usr/bin/env node
/**
 * Read-only reconciliation for the frozen legacy Discord recovery artifacts
 * (2026-10-19). Recovery EXECUTION is intentionally unavailable here: it is
 * gated on deployment + acceptance per the P3 recovery policy. This tool
 * freezes/verifies the artifacts, reconciles the 488/485/491 snapshot counts,
 * classifies every manifest row, verifies named-target ownership invariants,
 * and emits a per-row action plan for the later controlled run.
 *
 * Usage:
 *   node --import tsx scripts/reconcileLegacyDiscordRecovery.ts \
 *     [--manifest path] [--rows path] [--out path] [--plan-out path]
 *
 * Any `--execute` argument is rejected: no database writes, no claim, no
 * reassignment. Output is evidence + plan only.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

type Row = Record<string, string>;

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { record.push(field); field = ''; continue; }
    if (char === '\n') { record.push(field); rows.push(record); record = []; field = ''; continue; }
    if (char === '\r') continue;
    field += char;
  }
  if (field !== '' || record.length) { record.push(field); rows.push(record); }
  const [header, ...data] = rows.filter(row => row.some(cell => cell.trim() !== ''));
  if (!header) return [];
  return data.map(row => Object.fromEntries(header.map((name, index) => [name, row[index] ?? ''])));
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const argValue = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const NAMED_TARGETS = [
  { label: 'Team Profits FX', code: '4BETBs6ST4', channelId: 'UCi5BAat0lR27YYiNtvQZMJQ', expectedSite: 'myurls.co' },
  { label: 'Jason Raynor', code: 'Ct7ykpvSYZ', channelId: 'UCUIQIySa8H3UC1gqysvOz2w', expectedSite: 'whop.com/hypebrothertrades' },
];
const GUARDED_INVITES = [
  { label: 'APJ withheld invite', code: 'cjCY8FrQts', expectedOwnerId: 'UC0MuDzKHWxLpVDviqi3FLEw', policy: 'FOUND_WITHHELD' },
  { label: 'Linktree platform-shared invite', code: 'MEc9UX99S4', expectedOwnerId: 'UC-vGMbd-jPqGpsuaObDHvmA', policy: 'quarantined/platform-shared; owner preserved' },
];
const PLATFORM_SHARED_OWNER = 'UC-vGMbd-jPqGpsuaObDHvmA';
const CANONICAL_CODE = /^[A-Za-z0-9_-]{2,128}$/;

async function main() {
  if (process.argv.includes('--execute')) {
    throw new Error(
      'Recovery execution is disabled by design. P3 recovery runs only after deployment + acceptance, '
      + 'through normal admission with owners preserved. This tool is read-only.',
    );
  }
  const manifestPath = argValue('--manifest', '/tmp/opencode/legacy_recovery_manifest_20261019.csv');
  const rowsPath = argValue('--rows', '/tmp/opencode/legacy_recovery_rows_20261019.csv');
  const outPath = argValue('--out', '/tmp/opencode/legacy_reconciliation_report_20261019.json');
  const planPath = argValue('--plan-out', '/tmp/opencode/legacy_recovery_plan_20261019.csv');

  const manifestText = readFileSync(manifestPath, 'utf8');
  const rowsText = readFileSync(rowsPath, 'utf8');
  const manifest = parseCsv(manifestText);
  const rows = parseCsv(rowsText);

  const bySite = new Map<string, Row[]>();
  for (const item of manifest) {
    const list = bySite.get(item.site_identity) || [];
    list.push(item);
    bySite.set(item.site_identity, list);
  }
  const rowSites = new Set(rows.map(row => row.site_identity));
  const manifestCodes = new Set(manifest.map(item => item.code.toLowerCase()).filter(Boolean));

  // Freeze verification: the frozen snapshot must be internally consistent.
  const missingFromRows = [...bySite.keys()].filter(site => !rowSites.has(site));
  const missingFromManifest = [...rowSites].filter(site => !bySite.has(site));
  const invalidCodes = manifest.filter(item => !CANONICAL_CODE.test(item.code || ''));
  // `code_count` counts manifest observations (a code can be observed from
  // multiple source URLs); `codes` lists distinct codes. Both invariants are
  // checked separately. Repeated site+code pairs are legitimate observations
  // only when classification/owner agree; any conflict is real corruption.
  const observationCountMismatches = rows.filter(row => {
    const manifestForSite = bySite.get(row.site_identity) || [];
    return Number(row.code_count || manifestForSite.length) !== manifestForSite.length;
  });
  const distinctCodeMismatches = rows.filter(row => {
    const rowCodes = new Set((row.codes || '').split('|').filter(Boolean).map(code => code.toLowerCase()));
    const manifestCodesForSite = new Set((bySite.get(row.site_identity) || []).map(item => item.code.toLowerCase()));
    return rowCodes.size !== manifestCodesForSite.size
      || [...rowCodes].some(code => !manifestCodesForSite.has(code));
  });
  const pairs = new Map<string, Row[]>();
  for (const item of manifest) {
    const key = `${item.site_identity}\u0000${item.code.toLowerCase()}`;
    const list = pairs.get(key) || [];
    list.push(item);
    pairs.set(key, list);
  }
  const repeatedObservationPairs = [...pairs.values()].filter(list => list.length > 1).length;
  const conflictingPairs = [...pairs.entries()].filter(([, list]) =>
    new Set(list.map(item => item.classification)).size > 1
    || new Set(list.map(item => item.registry_owner)).size > 1);
  const duplicateSites = rows.length - new Set(rows.map(row => row.site_identity)).size;

  // Classification buckets (frozen manifest semantics).
  const classification = (name: string) => manifest.filter(item => item.classification === name);
  const sameOwnerMissing = classification('REGISTERED_SAME_OWNER_MISSING_CODE');
  const sameOwnerHasCode = classification('REGISTERED_SAME_OWNER_HAS_CODE');
  const otherOwner = classification('REGISTERED_OTHER_OWNER');
  const cacheOnly = classification('CACHE_ONLY');
  const platformSharedRows = manifest.filter(item => item.registry_owner === PLATFORM_SHARED_OWNER);
  const withheldRows = manifest.filter(item => GUARDED_INVITES.some(guard => guard.code.toLowerCase() === item.code.toLowerCase() && guard.policy === 'FOUND_WITHHELD'));

  // Per-row action plan: never reassign, never execute here. Codes that fail
  // the P1 canonical alphabet are rejected before any ownership logic: they
  // are extraction artifacts (arrow suffixes, `https:`, markdown fragments),
  // not invites.
  const actionFor = (item: Row): string => {
    const code = (item.code || '').toLowerCase();
    if (!CANONICAL_CODE.test(item.code || '')) return 'rejected_invalid_code';
    if (GUARDED_INVITES.some(guard => guard.code.toLowerCase() === code && guard.policy === 'FOUND_WITHHELD')) return 'blocked_withheld_policy';
    if (item.registry_owner === PLATFORM_SHARED_OWNER) return 'blocked_platform_shared';
    if (item.classification === 'REGISTERED_OTHER_OWNER') return 'blocked_other_owner';
    if (item.classification === 'REGISTERED_SAME_OWNER_HAS_CODE') return 'skip_already_has_code';
    if (item.classification === 'REGISTERED_SAME_OWNER_MISSING_CODE') return 'safe_same_owner_recover_candidate';
    if (item.classification === 'CACHE_ONLY') return 'manual_review_cache_only';
    return 'unresolved';
  };
  const actionCounts: Record<string, number> = {};
  for (const item of manifest) {
    const action = actionFor(item);
    actionCounts[action] = (actionCounts[action] || 0) + 1;
  }

  // Snapshot reconciliation: 488/485/491 were live query counts taken at
  // different moments; only the 491-row snapshot is frozen in the artifact.
  // The deltas are consistent with live-table drift between queries, but that
  // is an inference, not a reproducible predicate, so it is labeled as such.
  const snapshotCounts = [488, 485, 491];
  const frozenRows = rows.length;
  const snapshotReconciliation = {
    observed_earlier_counts: snapshotCounts.filter(count => count !== frozenRows),
    frozen_count: frozenRows,
    frozen_distinct_sites: rowSites.size,
    frozen_distinct_codes: manifestCodes.size,
    delta_from_488: frozenRows - 488,
    delta_from_485: frozenRows - 485,
    reconstructed: false,
    note:
      'The 488/485 counts were live-table queries taken before the frozen CSV export; their exact '
      + 'predicates were not persisted. The 491-row artifact is the frozen authority. The +3/+6 deltas '
      + 'are consistent with live cache-row drift between query times (new observations/upserts), not '
      + 'with row loss: every frozen manifest row maps to a frozen site and every site maps back.',
  };

  const namedTargets = NAMED_TARGETS.map(target => {
    const hits = manifest.filter(item => item.code.toLowerCase() === target.code.toLowerCase());
    const actions = [...new Set(hits.map(actionFor))];
    return {
      label: target.label,
      code: target.code,
      channel_id: target.channelId,
      expected_site: target.expectedSite,
      hits: hits.map(item => ({
        site_identity: item.site_identity,
        classification: item.classification,
        registry_owner: item.registry_owner || null,
        owner_name: item.owner_name || null,
        action: actionFor(item),
        linked_creators: item.linked_creators || null,
      })),
      recovery_path: actions.every(action => action === 'safe_same_owner_recover_candidate')
        ? 'same_owner_recovery'
        : actions.every(action => action === 'manual_review_cache_only')
          ? 'normal_admission_on_recrawl'
          : 'blocked_or_invalid',
    };
  });

  const guardedInvites = GUARDED_INVITES.map(guard => {
    const hits = manifest.filter(item => item.code.toLowerCase() === guard.code.toLowerCase());
    const owners = [...new Set(hits.map(item => item.registry_owner).filter(Boolean))];
    return {
      label: guard.label,
      code: guard.code,
      policy: guard.policy,
      expected_owner_id: guard.expectedOwnerId,
      observed_owner_ids: owners,
      owner_unchanged: owners.every(owner => owner === guard.expectedOwnerId),
      actions: [...new Set(hits.map(actionFor))],
    };
  });

  const planHeader = 'site_identity,code,classification,registry_owner,owner_name,action,reason';
  const plan = manifest.map(item => {
    const action = actionFor(item);
    const reason = action === 'safe_same_owner_recover_candidate'
      ? 'registered owner already owns this code; same-owner recovery through normal admission only'
      : action === 'manual_review_cache_only'
        ? 'unregistered cache-only code; normal admission on recrawl decides (never auto-claimed)'
        : action === 'rejected_invalid_code'
          ? 'code fails the canonical invite alphabet after P1 extraction hardening; never recover'
        : action === 'blocked_other_owner'
          ? 'code owned by another creator; no reassignment'
          : action === 'blocked_platform_shared'
            ? 'platform-shared invite; owner preserved and quarantined'
            : action === 'blocked_withheld_policy'
              ? 'product policy withholds this invite; do not recover'
              : action === 'skip_already_has_code'
                ? 'owner already has a validated code; duplicate/no-op'
                : 'insufficient frozen evidence; manual review';
    return [item.site_identity, item.code, item.classification, item.registry_owner, item.owner_name, action, reason]
      .map(value => `"${String(value ?? '').replace(/"/g, '""')}"`)
      .join(',');
  });

  const report = {
    generated_at: new Date().toISOString(),
    execution: { mode: 'READ_ONLY', recovery_executed: false, reason: 'requires deployment + acceptance; do not deploy per current instruction' },
    artifacts: {
      manifest: { path: manifestPath, sha256: sha256(manifestText), rows: manifest.length, distinct_sites: bySite.size, distinct_codes: manifestCodes.size },
      rows: { path: rowsPath, sha256: sha256(rowsText), rows: rows.length, distinct_sites: rowSites.size, codes_per_row_total: manifest.length },
    },
    freeze_integrity: {
      missing_from_rows: missingFromRows.length,
      missing_from_manifest: missingFromManifest.length,
      invalid_codes: {
        count: invalidCodes.length,
        rows: invalidCodes.map(item => ({
          site_identity: item.site_identity,
          code: item.code,
          classification: item.classification,
          registry_owner: item.registry_owner || null,
        })),
        note: 'Legacy extraction artifacts (arrow suffix, bare `https:`, markdown fragment). Rejected by the P1 canonical alphabet; never recover.',
      },
      observation_count_mismatches: observationCountMismatches.length,
      distinct_code_mismatches: distinctCodeMismatches.length,
      repeated_observation_pairs: repeatedObservationPairs,
      conflicting_observation_pairs: conflictingPairs.length,
      duplicate_sites: duplicateSites,
      consistent:
        missingFromRows.length === 0
        && missingFromManifest.length === 0
        && observationCountMismatches.length === 0
        && distinctCodeMismatches.length === 0
        && conflictingPairs.length === 0
        && duplicateSites === 0,
    },
    snapshot_reconciliation: snapshotReconciliation,
    recovery_buckets: {
      safe_same_owner_recover_candidates: actionCounts.safe_same_owner_recover_candidate || 0,
      skip_already_has_code: sameOwnerHasCode.length,
      blocked_other_owner: otherOwner.length,
      rejected_invalid_code: actionCounts.rejected_invalid_code || 0,
      manual_review_cache_only: cacheOnly.length,
      platform_shared_rows: platformSharedRows.length,
      withheld_policy_rows: withheldRows.length,
      rejected_rows: actionCounts.rejected_invalid_code || 0,
      unresolved_rows: actionCounts.unresolved || 0,
      action_counts: actionCounts,
    },
    named_targets: namedTargets,
    guarded_invites: guardedInvites,
    invariants: {
      no_cross_creator_reassignment: true,
      apj_withheld: guardedInvites.find(item => item.code === 'cjCY8FrQts')?.actions.includes('blocked_withheld_policy') === true,
      linktree_owner_preserved: guardedInvites.find(item => item.code === 'MEc9UX99S4')?.owner_unchanged === true,
      team_profits_present: namedTargets.find(item => item.code === '4BETBs6ST4')?.hits.length === 1,
      jason_raynor_present: namedTargets.find(item => item.code === 'Ct7ykpvSYZ')?.hits.length === 1,
      team_profits_path: namedTargets.find(item => item.code === '4BETBs6ST4')?.recovery_path,
      jason_raynor_path: namedTargets.find(item => item.code === 'Ct7ykpvSYZ')?.recovery_path,
    },
    plan_path: planPath,
  };

  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(planPath, `${planHeader}\n${plan.join('\n')}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(`reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
