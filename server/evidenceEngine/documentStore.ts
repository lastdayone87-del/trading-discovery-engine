import { getDb } from '../db';
import { detectLanguage } from '../languageDetection';
import type { EvidenceDocumentObservation } from './documentTypes';

export interface EvidenceDocumentLanguage {
  language: string | null;
  script: string | null;
}

/**
 * Resolve the language/script persisted for one evidence document. Provider
 * metadata always wins; otherwise the deterministic detector fills the gap.
 * The country hint is essential for Kanji-only Japanese surfaces, which are
 * otherwise indistinguishable from Chinese.
 */
export function resolveEvidenceDocumentLanguage(
  document: { language?: string | null; script?: string | null; normalizedText?: string | null },
  countryHint?: string | null,
): EvidenceDocumentLanguage {
  const detected = (!document.language || document.language === 'und')
    ? detectLanguage(document.normalizedText || '', { countryHint })
    : { language: document.language, script: document.script || null };
  return {
    language: detected.language && detected.language !== 'und' ? detected.language : null,
    script: document.script || detected.script || null,
  };
}

/**
 * Persist evidence documents. Language/script are provider-supplied when
 * present; otherwise the shared deterministic detector fills them so the
 * evidence plane is not permanently `und`/NULL. Detection never changes the
 * document's identity or its classification.
 */
export async function persistEvidenceDocuments(
  documents: EvidenceDocumentObservation[],
  options: { countryHint?: string | null } = {},
) {
  if (!documents.length) return { attempted: 0, inserted: 0 };
  const db = await getDb(), client = await db.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const d of documents) {
      const { language, script } = resolveEvidenceDocumentLanguage(d, options.countryHint);
      const result = await client.query(
        `INSERT INTO evidence_documents(document_key,subject_entity_id,channel_id,document_type,provider,provider_native_id,canonical_locator,source_family_id,source_entity_id,language,script,content_type,published_at,observed_at,normalized_text,text_checksum,raw_payload_checksum,provenance,schema_version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT(document_key) DO NOTHING RETURNING id`,
        [
          d.documentKey, d.subjectEntityId, d.channelId, d.documentType, d.provider,
          d.providerNativeId || null, JSON.stringify(d.canonicalLocator), d.sourceFamilyId,
          d.sourceEntityId || null, language, script, d.contentType || null,
          d.publishedAt || null, d.observedAt, d.normalizedText, d.textChecksum,
          d.rawPayloadChecksum, JSON.stringify(d.provenance), d.schemaVersion,
        ]
      );
      inserted += result.rowCount || 0;
    }
    await client.query('COMMIT');
    return { attempted: documents.length, inserted };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listEvidenceDocuments(input: {
  channelId?: string;
  subjectEntityId?: string;
  limit?: number;
  offset?: number;
  cutoff?: string;
  /** Exact document keys from the diagnostic's Creator Focus snapshot. */
  documentKeys?: string[];
} = {}) {
  const db = await getDb(), limit = Math.min(250, Math.max(1, input.limit || 100)), offset = Math.max(0, input.offset || 0);
  const documentKeys = input.documentKeys?.length ? input.documentKeys.slice(0, 250) : null;
  const result = await db.query(
    `SELECT * FROM evidence_documents
      WHERE ($1::text IS NULL OR channel_id=$1)
        AND ($2::uuid IS NULL OR subject_entity_id=$2)
        AND ($3::timestamptz IS NULL OR observed_at<=$3)
        AND ($4::text[] IS NULL OR document_key=ANY($4))
      ORDER BY observed_at DESC,id LIMIT $5 OFFSET $6`,
    [input.channelId || null, input.subjectEntityId || null, input.cutoff || null, documentKeys, limit, offset]
  );
  return result.rows;
}
