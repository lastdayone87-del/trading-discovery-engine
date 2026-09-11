import test from 'node:test';
import assert from 'node:assert/strict';
import { missingGeminiOrgLabels } from './evidenceEngine/providers/GeminiSemanticProvider';
import { missingGroqOrgLabels } from './evidenceEngine/providers/GroqSemanticProvider';
import { validateSemanticOrgLabels } from './semanticOrgLabels';

test('missing labels list every unlabeled configured slot', () => {
  assert.deepEqual(
    missingGroqOrgLabels({ GROQ_API_KEY: 'k1', GROQ_API_KEY_2: 'k2', GROQ_ORG_ID_2: 'b' } as any),
    ['GROQ_ORG_ID']
  );
  assert.deepEqual(missingGroqOrgLabels({ GROQ_API_KEY: 'k1', GROQ_ORG_ID: 'a' } as any), []);
  assert.deepEqual(missingGroqOrgLabels({} as any), []);
  assert.deepEqual(
    missingGeminiOrgLabels({ GEMINI_API_KEY: 'k1', GEMINI_API_KEY_3: 'k3' } as any),
    ['GEMINI_ORG_ID', 'GEMINI_ORG_ID_3']
  );
  assert.deepEqual(
    missingGeminiOrgLabels({ GEMINI_API_KEY: 'k1', GEMINI_ORG_ID: 'p', GEMINI_API_KEY_2: 'k2', GEMINI_ORG_ID_2: 'p' } as any),
    []
  );
});

test('validator passes outside production regardless of labels', () => {
  assert.doesNotThrow(() => validateSemanticOrgLabels({ NODE_ENV: 'test', GROQ_API_KEY: 'k1' } as any));
  assert.doesNotThrow(() => validateSemanticOrgLabels({} as any));
});

test('validator throws in production listing every missing label', () => {
  assert.throws(
    () => validateSemanticOrgLabels({ NODE_ENV: 'production', GROQ_API_KEY: 'k1', GEMINI_API_KEY: 'a', GEMINI_API_KEY_2: 'b', GEMINI_ORG_ID_2: 'p' } as any),
    /GROQ_ORG_ID.*GEMINI_ORG_ID[^_]/,
    'must name the missing slot vars'
  );
});

test('validator passes in production when every route is labeled', () => {
  assert.doesNotThrow(() => validateSemanticOrgLabels({
    NODE_ENV: 'production',
    GROQ_API_KEY: 'k1', GROQ_ORG_ID: 'a',
    GEMINI_API_KEY: 'x', GEMINI_ORG_ID: 'p',
    GEMINI_API_KEY_2: 'y', GEMINI_ORG_ID_2: 'q',
  } as any));
});

test('startup wires the semantic org-label guardrail first', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('validateSemanticOrgLabels();'), 'boot must enforce explicit org labels');
});
