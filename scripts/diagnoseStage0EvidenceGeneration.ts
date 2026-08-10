import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

const OPERATOR_VISIBLE_CHANNEL_SQL = `country_status <> 'REJECTED'
  AND scan_status <> 'SKIPPED_EXCLUDED'
  AND trading_status <> 'NON_TRADING'
  AND NOT EXISTS (
    SELECT 1 FROM excluded_countries excluded
    WHERE lower(regexp_replace(trim(excluded.country_name), '\\s+', ' ', 'g')) =
      lower(regexp_replace(trim(channels.country), '\\s+', ' ', 'g'))
  )`;

const asJson = <T>(value: T | string | null | undefined, fallback: T): T => {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
};

const inc = (target: Record<string, number>, key: string) => {
  target[key] = (target[key] || 0) + 1;
};

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    const result = await db.query(`
      WITH visible AS (
        SELECT channel_id, channel_name, country, discovery_source, trading_status,
               COALESCE(trading_confidence_score,0)::float AS trading_confidence_score,
               COALESCE(trading_category,'General Trading') AS trading_category
          FROM channels
         WHERE ${OPERATOR_VISIBLE_CHANNEL_SQL}
      ), latest_focus AS (
        SELECT DISTINCT ON (f.channel_id)
               f.channel_id, f.classification_diagnostic_id, f.observed_at AS focus_observed_at
          FROM creator_focus_classification_snapshots f
          JOIN visible v ON v.channel_id=f.channel_id
         ORDER BY f.channel_id, f.observed_at DESC, f.id DESC
      ), latest_coverage AS (
        SELECT DISTINCT ON (c.channel_id)
               c.channel_id, c.provider_availability, c.acquisition_failures,
               c.completeness_disposition, c.reason_codes, c.observed_at AS coverage_observed_at,
               c.classification_diagnostic_id AS coverage_diagnostic_id
          FROM evidence_coverage_snapshots c
          JOIN visible v ON v.channel_id=c.channel_id
         ORDER BY c.channel_id, c.observed_at DESC, c.id DESC
      )
      SELECT v.*, lf.classification_diagnostic_id, lf.focus_observed_at,
             d.normalized_input, d.evidence_items, d.created_at AS diagnostic_created_at,
             lc.provider_availability, lc.acquisition_failures,
             lc.completeness_disposition, lc.reason_codes AS coverage_reason_codes,
             lc.coverage_observed_at, lc.coverage_diagnostic_id
        FROM visible v
        LEFT JOIN latest_focus lf ON lf.channel_id=v.channel_id
        LEFT JOIN production_classification_diagnostics d ON d.id=lf.classification_diagnostic_id
        LEFT JOIN latest_coverage lc ON lc.channel_id=v.channel_id
       ORDER BY v.channel_id`);

    const providerStatusCounts: Record<string, number> = {};
    const geminiOutcomeCounts: Record<string, number> = {};
    const evidenceCountHistogram: Record<string, number> = {};
    const rows = result.rows.map((row: any) => {
      const evidence = asJson<any[]>(row.evidence_items, []);
      const providers = asJson<any[]>(row.provider_availability, []);
      const raw = asJson<any>(row.normalized_input, {});
      const gemini = providers.find(provider => provider?.provider === 'gemini_semantic') || null;
      for (const provider of providers) {
        inc(providerStatusCounts, `${provider.provider}:${provider.availability}:${provider.outcome}`);
      }
      inc(geminiOutcomeCounts, gemini ? `${gemini.availability}:${gemini.outcome}` : 'MISSING_PROVIDER_REPORT');
      inc(evidenceCountHistogram, String(evidence.length));
      const negative = evidence.filter(item => item?.polarity === 'NEGATIVE');
      const positive = evidence.filter(item => item?.polarity === 'POSITIVE' && item?.category !== 'SEMANTIC_ABSTENTION');
      const abstention = evidence.filter(item => item?.category === 'SEMANTIC_ABSTENTION');
      return {
        channelId: String(row.channel_id),
        channelName: String(row.channel_name || ''),
        tradingStatus: String(row.trading_status || ''),
        productionScore: Number(row.trading_confidence_score) || 0,
        tradingCategory: String(row.trading_category || 'General Trading'),
        country: String(row.country || 'UNKNOWN'),
        discoverySource: String(row.discovery_source || 'UNKNOWN'),
        classificationDiagnosticId: row.classification_diagnostic_id || null,
        coverageDiagnosticId: row.coverage_diagnostic_id || null,
        evidenceItemCount: evidence.length,
        positiveEvidenceItemCount: positive.length,
        negativeEvidenceItemCount: negative.length,
        semanticAbstentionCount: abstention.length,
        geminiProvider: gemini,
        coverageDisposition: row.completeness_disposition || null,
        coverageReasonCodes: asJson<any[]>(row.coverage_reason_codes, []),
        acquisitionFailures: asJson<any[]>(row.acquisition_failures, []),
        compactInput: {
          channelName: raw.channel_name || row.channel_name || '',
          description: String(raw.description || '').slice(0, 320),
          videoTitles: Array.isArray(raw.video_titles) ? raw.video_titles.slice(0, 6) : Array.isArray(raw.videos) ? raw.videos.slice(0, 6).map((video: any) => video?.title).filter(Boolean) : [],
          playlistNames: Array.isArray(raw.playlists) ? raw.playlists.slice(0, 4).map((playlist: any) => playlist?.name).filter(Boolean) : []
        },
        negativeEvidence: negative.map(item => ({ source:item.source, category:item.category, fact:item.fact, rawMatches:item.rawMatches, taxonomyLabel:item?.provenance?.semantic?.taxonomyLabel || null })),
        positiveEvidence: positive.slice(0, 8).map(item => ({ source:item.source, category:item.category, fact:item.fact, rawMatches:item.rawMatches, taxonomyLabel:item?.provenance?.semantic?.taxonomyLabel || null }))
      };
    });

    await db.query('ROLLBACK');

    const zeroEvidence = rows.filter(row => row.evidenceItemCount === 0);
    const zeroEvidenceGemini = zeroEvidence.reduce<Record<string, number>>((counts, row) => {
      const key = row.geminiProvider ? `${row.geminiProvider.availability}:${row.geminiProvider.outcome}` : 'MISSING_PROVIDER_REPORT';
      inc(counts, key); return counts;
    }, {});
    const report = {
      reportType: 'STAGE0_EVIDENCE_GENERATION_DIAGNOSIS',
      readOnly: true,
      servingAuthority: false,
      automaticPromotion: false,
      providerCallsPerformed: false,
      totals: {
        operatorVisibleChannels: rows.length,
        zeroEvidenceChannels: zeroEvidence.length,
        channelsWithNegativeEvidence: rows.filter(row => row.negativeEvidenceItemCount > 0).length,
        channelsWithSemanticAbstention: rows.filter(row => row.semanticAbstentionCount > 0).length,
        evidenceCountHistogram,
        geminiOutcomeCounts,
        zeroEvidenceGeminiOutcomeCounts: zeroEvidenceGemini,
        providerStatusCounts
      },
      zeroEvidenceChannels: zeroEvidence,
      rows
    };

    const outputDir = path.join(process.cwd(), 'stage0-output');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'stage0-evidence-generation-diagnosis.json');
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify(report.totals, null, 2) + '\n');
    process.stdout.write(`Wrote ${outputPath}\n`);
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
