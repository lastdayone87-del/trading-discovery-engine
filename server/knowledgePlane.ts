import { createHash, randomUUID } from 'node:crypto';
import { getDb } from './db';

export const KNOWLEDGE_SCHEMA_VERSION = 'governed-knowledge-v1';
export type KnowledgeLane = 'CLASSIFICATION' | 'DISCOVERY' | 'SEMANTICS' | 'LANGUAGE' | 'TERMINOLOGY';

export interface KnowledgeSurface {
  surfaceId: string;
  text: string;
  normalized: string;
  language: string;
  script: string;
  locale: string;
  sense: 'PRIMARY' | 'ALIAS' | 'TRANSLATION' | 'TRANSLITERATION';
}
export interface GovernedConcept {
  conceptId: string;
  conceptVersion: number;
  conceptClass: string;
  meaning: string;
  surfaces: KnowledgeSurface[];
  provenance: Array<{ evidenceId: string; sourceType: string; sourceEntityId: string; observedAt: string; checksum: string }>;
  policy: { lanes: KnowledgeLane[]; countries: string[]; locales: string[]; status: 'APPROVED' | 'RETIRED' };
}
export interface KnowledgeArtifact {
  schemaVersion: typeof KNOWLEDGE_SCHEMA_VERSION;
  publicationId: string;
  publicationVersion: number;
  scope: { country: string; locale: string; lane: KnowledgeLane };
  policyVersion: string;
  createdAt: string;
  concepts: GovernedConcept[];
  checksum: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function knowledgeChecksum(value: Omit<KnowledgeArtifact, 'checksum'>): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function sortedConcept(concept: GovernedConcept): GovernedConcept {
  return { ...concept, policy: { ...concept.policy, lanes: [...new Set(concept.policy.lanes)].sort() as KnowledgeLane[], countries: [...new Set(concept.policy.countries)].sort(), locales: [...new Set(concept.policy.locales)].sort() }, surfaces: [...concept.surfaces].sort((a, b) => a.surfaceId.localeCompare(b.surfaceId)), provenance: [...concept.provenance].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)) };
}
export function buildKnowledgeArtifact(input: Omit<KnowledgeArtifact, 'schemaVersion' | 'checksum' | 'concepts'> & { concepts: GovernedConcept[] }): KnowledgeArtifact {
  if (!input.publicationId || input.publicationVersion < 1 || !input.policyVersion) throw new Error('INVALID_KNOWLEDGE_PUBLICATION');
  const concepts = input.concepts.map(sortedConcept).sort((a, b) => a.conceptId.localeCompare(b.conceptId));
  for (const concept of concepts) {
    if (concept.conceptVersion < 1 || concept.policy.status !== 'APPROVED' || !concept.policy.lanes.includes(input.scope.lane)) throw new Error('CONCEPT_NOT_ELIGIBLE_FOR_SCOPE');
    if (!concept.provenance.length || !concept.surfaces.length || concept.provenance.some(p => !p.evidenceId || !p.sourceEntityId || !/^[a-f0-9]{64}$/i.test(p.checksum))) throw new Error('INCOMPLETE_CONCEPT_PROVENANCE');
  }
  const unsigned = { ...input, concepts, schemaVersion: KNOWLEDGE_SCHEMA_VERSION } as Omit<KnowledgeArtifact, 'checksum'>;
  return { ...unsigned, checksum: knowledgeChecksum(unsigned) };
}
export function verifyKnowledgeArtifact(artifact: KnowledgeArtifact): boolean {
  const { checksum, ...unsigned } = artifact;
  return artifact.schemaVersion === KNOWLEDGE_SCHEMA_VERSION && /^[a-f0-9]{64}$/i.test(checksum) && knowledgeChecksum(unsigned) === checksum;
}
export function classifierFeatures(artifact: KnowledgeArtifact) {
  if (!verifyKnowledgeArtifact(artifact) || artifact.scope.lane !== 'CLASSIFICATION') throw new Error('INVALID_CLASSIFICATION_KNOWLEDGE_PIN');
  return artifact.concepts.flatMap(concept => concept.surfaces.map(surface => ({ conceptId: concept.conceptId, conceptVersion: concept.conceptVersion, conceptClass: concept.conceptClass, surfaceId: surface.surfaceId, surface: surface.text, normalized: surface.normalized, language: surface.language, script: surface.script, publicationId: artifact.publicationId, publicationVersion: artifact.publicationVersion, publicationChecksum: artifact.checksum, policyVersion: artifact.policyVersion })));
}
export function discoveryAtoms(artifact: KnowledgeArtifact) {
  if (!verifyKnowledgeArtifact(artifact) || artifact.scope.lane !== 'DISCOVERY') throw new Error('INVALID_DISCOVERY_KNOWLEDGE_PIN');
  return artifact.concepts.flatMap(concept => concept.surfaces.map(surface => ({ conceptId: concept.conceptId, conceptVersion: concept.conceptVersion, surfaceId: surface.surfaceId, surface: surface.text, language: surface.language, script: surface.script, locale: surface.locale, publicationId: artifact.publicationId, publicationVersion: artifact.publicationVersion, publicationChecksum: artifact.checksum, policyVersion: artifact.policyVersion })));
}

/** Atomically moves a scope pointer to a reviewed immutable publication. Rollback uses the same CAS operation. */
export async function activateKnowledgePublication(input: { publicationId: string; scope: KnowledgeArtifact['scope']; expectedPointerVersion: number; actor: string; reason: string; idempotencyKey: string; action?: 'PUBLISH' | 'ROLLBACK' }) {
  if (!input.actor || !input.reason || !input.idempotencyKey) throw new Error('KNOWLEDGE_GOVERNANCE_FIELDS_REQUIRED');
  const scopeKey = `${input.scope.country}\u001f${input.scope.locale}\u001f${input.scope.lane}`;
  const db = await getDb(), client = await db.connect();
  try { await client.query('BEGIN');
    const prior = await client.query('SELECT * FROM knowledge_publication_events WHERE idempotency_key=$1', [input.idempotencyKey]); if (prior.rowCount) { await client.query('COMMIT'); return prior.rows[0]; }
    const publication = await client.query(`SELECT * FROM knowledge_publications WHERE id=$1 AND status='APPROVED' AND country=$2 AND locale=$3 AND lane=$4 FOR SHARE`, [input.publicationId, input.scope.country, input.scope.locale, input.scope.lane]);
    if (!publication.rowCount) throw new Error('KNOWLEDGE_PUBLICATION_NOT_SERVABLE');
    const pointer = await client.query('SELECT * FROM active_knowledge_pointers WHERE scope_key=$1 FOR UPDATE', [scopeKey]); const current = pointer.rows[0], version = current?.pointer_version ?? 0;
    if (version !== input.expectedPointerVersion) throw new Error('KNOWLEDGE_POINTER_CONFLICT');
    await client.query(`INSERT INTO active_knowledge_pointers(scope_key,country,locale,lane,publication_id,pointer_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(scope_key) DO UPDATE SET publication_id=excluded.publication_id,pointer_version=excluded.pointer_version,updated_at=now()`, [scopeKey, input.scope.country, input.scope.locale, input.scope.lane, input.publicationId, version + 1]);
    const event = await client.query(`INSERT INTO knowledge_publication_events(id,idempotency_key,scope_key,from_publication_id,to_publication_id,from_pointer_version,to_pointer_version,action,checksum,actor,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [randomUUID(), input.idempotencyKey, scopeKey, current?.publication_id ?? null, input.publicationId, version, version + 1, input.action ?? 'PUBLISH', publication.rows[0].checksum, input.actor, input.reason]);
    await client.query('COMMIT'); return event.rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
