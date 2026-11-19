import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticFieldDocuments } from './semanticDocumentRefs';

test('the corpus path enforces the same 1,200-character document cap as field-built prompts', () => {
  const long = 'a'.repeat(2_000);
  const documents = semanticFieldDocuments({
    channel_name: 'Example',
    description: 'Example bio',
    evidence_corpus: [{
      id: 'bio',
      field: 'channel_bio',
      text: long,
      sourceFamilyId: 'about',
    }],
  });
  assert.equal(documents.length, 1);
  assert.equal(documents[0].text.length, 1_200);
});
