import { getDb } from '../server/db';
import { getAdmissionMode } from '../server/channelAdmission/store';
import { parseAdmissionReviewAction, resolveAdmissionReview } from '../server/channelAdmission';

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const direct = process.argv.find(value => value.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function listReviewCandidates(limit: number): Promise<void> {
  const db = await getDb();
  const result = await db.query(
    `SELECT channel_id,channel_name,youtube_url,reason_codes,attempts,evidence_hash,created_at,
            jsonb_array_length(COALESCE(evidence_snapshot->'videos','[]'::jsonb)) AS video_count,
            semantic_output->>'mainSubject' AS main_subject,
            semantic_output->>'main_subject' AS main_subject_snake,
            semantic_output->>'tradingFocus' AS trading_focus,
            semantic_output->>'trading_focus' AS trading_focus_snake
       FROM semantic_admission_candidates
      WHERE status='NEEDS_REVIEW'
      ORDER BY created_at
      LIMIT $1`,
    [limit],
  );
  for (const row of result.rows) {
    console.log(JSON.stringify({
      channelId: row.channel_id,
      channelName: row.channel_name,
      youtubeUrl: row.youtube_url,
      reasonCodes: row.reason_codes || [],
      attempts: Number(row.attempts || 0),
      evidenceHash: row.evidence_hash || null,
      videoCount: Number(row.video_count || 0),
      mainSubject: row.main_subject || row.main_subject_snake || null,
      tradingFocus: Number(row.trading_focus ?? row.trading_focus_snake ?? 0),
      createdAt: row.created_at,
    }));
  }
  console.error(`[admission-review] ${result.rows.length} NEEDS_REVIEW candidate(s) shown (limit ${limit}).`);
}

async function main(): Promise<void> {
  if (argFlag('help')) {
    console.error('Usage: npx tsx scripts/reviewAdmissionCandidates.ts [--limit=100]');
    console.error('       npx tsx scripts/reviewAdmissionCandidates.ts --admit --channel-id=UC... --reviewer=name --reason="..."');
    console.error('       npx tsx scripts/reviewAdmissionCandidates.ts --reject --channel-id=UC... --reviewer=name --reason="..."');
    console.error('       npx tsx scripts/reviewAdmissionCandidates.ts --requeue --channel-id=UC... --reviewer=name --reason="..."');
    return;
  }
  const action = parseAdmissionReviewAction({
    admit: argFlag('admit'),
    reject: argFlag('reject'),
    requeue: argFlag('requeue'),
  });
  if (!action) {
    const limit = Math.max(1, Math.min(500, Math.floor(Number(argValue('limit') || 100))));
    if (!Number.isFinite(limit)) throw new Error('INVALID_LIMIT');
    await listReviewCandidates(limit);
    return;
  }
  if (action === 'REQUEUE' && (await getAdmissionMode()) !== 'ACTIVE') {
    throw new Error('ADMISSION_MODE_OFF_FOR_REQUEUE');
  }
  const channelId = String(argValue('channel-id') || '').trim();
  const reviewer = String(argValue('reviewer') || '').trim();
  const reason = String(argValue('reason') || '').trim();
  if (!channelId || !reviewer || !reason) throw new Error('CHANNEL_ID_REVIEWER_REASON_REQUIRED');
  const result = await resolveAdmissionReview({ channelId, action, reviewer, reason });
  console.log(JSON.stringify({
    event: 'admission_review_resolved',
    channelId,
    action,
    reviewer,
    reason,
    status: result.status,
    timestamp: new Date().toISOString(),
  }));
}

main()
  .catch(error => {
    console.error('Admission review failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const db = await getDb();
      await db.end();
    } catch {
      // The command already reported its outcome; pool shutdown is best-effort.
    }
  });
