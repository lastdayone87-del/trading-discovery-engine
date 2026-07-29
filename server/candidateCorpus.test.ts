import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contentHash, extractCandidateSpans, OFFSET_SCHEME, retentionDisposition, sliceCodePoints } from './candidateCorpus';

test('phase 8 migration is additive, shadow-only, source-bound and immutable',()=>{
  const sql=readFileSync(new URL('./db/migrations/023_immutable_candidate_corpus.sql',import.meta.url),'utf8');
  assert.doesNotMatch(sql,/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE)\b/i);
  for(const table of ['corpus_source_artifacts','corpus_documents','corpus_extraction_runs','corpus_candidate_occurrences','corpus_qualification_decisions','corpus_controls'])assert.match(sql,new RegExp(table));
  assert.match(sql,/UNICODE_CODE_POINT_V1/);assert.match(sql,/paused BOOLEAN NOT NULL DEFAULT true/);assert.match(sql,/daily_compute_documents INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql,/corpus_occurrences_immutable/);assert.match(sql,/No row grants Phase F or search eligibility/);
});

test('Unicode scalar offsets round trip multilingual and astral spans',()=>{
  const text='📈 stratégie d’action 日本 株式';const spans=extractCandidateSpans(text);assert.equal(OFFSET_SCHEME,'UNICODE_CODE_POINT_V1');
  assert.ok(spans.length>0);for(const span of spans)assert.equal(sliceCodePoints(text.normalize('NFC'),span.startOffset,span.endOffset),span.literal);
  assert.ok(spans.some(s=>s.literal==='stratégie d’action'));assert.ok(spans.some(s=>s.literal==='日本 株式'));
});

test('extraction and content identities are deterministic and bounded to 1-5 grams',()=>{
  const text='order flow futures trading';assert.deepEqual(extractCandidateSpans(text),extractCandidateSpans(text));
  assert.equal(contentHash('e\u0301'),contentHash('é'));assert.ok(extractCandidateSpans(text).every(s=>s.ngramSize>=1&&s.ngramSize<=5));
});

test('retention status is deterministic without erasing immutable lineage',()=>{
  assert.equal(retentionDisposition({now:'2026-01-02T00:00:00Z',expiresAt:'2026-01-01T00:00:00Z',deletedAt:null}),'EXPIRED');
  assert.equal(retentionDisposition({now:'2026-01-01T00:00:00Z',expiresAt:null,deletedAt:'2025-01-01T00:00:00Z'}),'DELETED');
});
