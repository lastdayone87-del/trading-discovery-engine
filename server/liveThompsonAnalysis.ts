/**
 * Pure analysis primitives for the live Thompson evaluation. These implement
 * the counting rules stated in docs/LIVE_THOMPSON_EVAL_V1.md so the primary
 * outcome is computed code, not prose: first-seen ownership decides which
 * arm may claim an invite, and arm totals are always scoped to one exact
 * experiment identity. No database access; all inputs are plain data.
 */

export interface InviteFind {
  inviteCode: string;
  channelId: string;
  experimentId: string | null;
  arm: 'THOMPSON' | 'CONTROL' | string;
  quotaUnits: number;
  validatedAt: string;
  runId: string;
}

export interface AttributedInvite extends InviteFind {
  firstSeen: boolean;
}

/**
 * First-ownership attribution: for each distinct invite code (compared
 * case-insensitively after trimming), exactly one find wins — the earliest
 * validatedAt, tie-broken deterministically by channelId. Later finds of the
 * same code (same arm retries, cross-arm rediscovery, duplicates) are marked
 * firstSeen=false and MUST NOT count toward any arm. This is what prevents
 * retries or duplicate candidates from double-counting a unique invite.
 */
export function attributeFirstOwnedInvites(finds: InviteFind[]): AttributedInvite[] {
  const byCode = new Map<string, InviteFind[]>();
  for (const find of finds) {
    const key = find.inviteCode.trim().toLowerCase();
    const group = byCode.get(key);
    if (group) group.push(find);
    else byCode.set(key, [find]);
  }
  const out: AttributedInvite[] = [];
  for (const group of byCode.values()) {
    const ordered = [...group].sort(
      (a, b) =>
        new Date(a.validatedAt).getTime() - new Date(b.validatedAt).getTime() ||
        (a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0)
    );
    ordered.forEach((find, index) => out.push({ ...find, firstSeen: index === 0 }));
  }
  return out;
}

export interface ArmOutcomeSummary {
  experimentId: string;
  arm: string;
  invites: number;
  quotaUnits: number;
  runs: number;
}

/**
 * Per-arm outcome totals scoped to ONE exact experiment identity. Rows from
 * any other experiment (benchmark identities, other live experiments, or
 * legacy unlabeled traffic) are excluded and can never leak into the
 * comparison. Only first-seen finds count toward invites; quota sums cover
 * exactly the counted rows' runs... (quota is summed per distinct run within
 * the arm).
 */
export function summarizeArmOutcomes(
  rows: Array<{
    experimentId: string | null;
    arm: string;
    inviteCode: string;
    channelId: string;
    quotaUnits: number;
    validatedAt: string;
    runId: string;
  }>,
  experimentId: string
): ArmOutcomeSummary[] {
  const scoped = rows.filter(row => row.experimentId === experimentId);
  const attributed = attributeFirstOwnedInvites(
    scoped.map(row => ({ ...row, experimentId: row.experimentId as string }))
  ).filter(row => row.firstSeen);
  const byArm = new Map<string, { invites: number; quota: number; runs: Map<string, number> }>();
  for (const row of attributed) {
    const entry = byArm.get(row.arm) || { invites: 0, quota: 0, runs: new Map<string, number>() };
    entry.invites += 1;
    // Quota is counted once per distinct run (first occurrence wins), never
    // once per invite, so multi-invite runs cannot inflate the denominator.
    if (!entry.runs.has(row.runId)) {
      entry.runs.set(row.runId, Number.isFinite(row.quotaUnits) ? row.quotaUnits : 0);
    }
    byArm.set(row.arm, entry);
  }
  for (const entry of byArm.values()) {
    entry.quota = [...entry.runs.values()].reduce((a, b) => a + b, 0);
  }
  return [...byArm.entries()]
    .map(([arm, entry]) => ({
      experimentId,
      arm,
      invites: entry.invites,
      quotaUnits: entry.quota,
      runs: entry.runs.size,
    }))
    .sort((a, b) => (a.arm < b.arm ? -1 : 1));
}
