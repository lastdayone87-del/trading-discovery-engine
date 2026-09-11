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

test('validator never throws in production: unlabeled slots warn and stay independent', () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    assert.doesNotThrow(() => validateSemanticOrgLabels({ NODE_ENV: 'production', GROQ_API_KEY: 'k1', GEMINI_API_KEY: 'a', GEMINI_API_KEY_2: 'b' } as any));
  } finally {
    console.warn = original;
  }
  assert.ok(warnings.some(message => message.includes('GROQ_ORG_ID') && message.includes('GEMINI_ORG_ID')), 'warning must name the unlabeled slot vars');
});

test('validator stays silent when every route is labeled', () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    validateSemanticOrgLabels({
      NODE_ENV: 'production',
      GROQ_API_KEY: 'k1', GROQ_ORG_ID: 'a',
      GEMINI_API_KEY: 'x', GEMINI_ORG_ID: 'p',
      GEMINI_API_KEY_2: 'y', GEMINI_ORG_ID_2: 'q',
    } as any);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 0);
});

test('startup wires the semantic org-label advisory check', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('validateSemanticOrgLabels();'), 'boot must surface unlabeled slot visibility');
});

test('env example documents slot-independence with optional shared labels', async () => {
  const { readFileSync } = await import('node:fs');
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const statement of [
    'OPTIONAL for Groq',
    'each key slot is an independent',
    'Production boots without labels',
    'does NOT require GROQ_ORG_ID',
    'Identical labels mean',
    'Only set the SAME label on slots whose keys truly belong to',
  ]) {
    assert.ok(example.includes(statement), `.env.example must state: ${statement}`);
  }
  assert.ok(
    !/refuses to boot/.test(example),
    'docs must not claim production refuses to boot over labels'
  );
});
