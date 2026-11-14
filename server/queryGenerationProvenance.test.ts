import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatQueryGenerationTooltip,
  parseQueryGenerationProvenance,
  queryGenerationLabel,
} from '../src/queryGenerationProvenance';

test('Query Library labels distinguish AI, autocomplete and creator provenance', () => {
  const base = {
    provider: 'groq',
    model: 'llama',
    promptVersion: 'native-query-v1',
    batchId: 'batch-1',
    country: 'France',
    language: 'fr',
    persona: null,
    scenario: null,
    prefix: null,
    generatedAt: '2026-11-13T00:00:00.000Z',
  };
  assert.equal(queryGenerationLabel(parseQueryGenerationProvenance({ ...base, source: 'LLM', mode: 'OPEN_WORLD' })!), 'AI · Open-world');
  assert.equal(queryGenerationLabel(parseQueryGenerationProvenance({ ...base, source: 'LLM', mode: 'GROUNDED' })!), 'AI · Grounded');
  assert.equal(queryGenerationLabel(parseQueryGenerationProvenance({ ...base, source: 'AUTOCOMPLETE', mode: 'REAL_SIGNAL' })!), 'Autocomplete · Real-signal');
  assert.equal(queryGenerationLabel(parseQueryGenerationProvenance({ ...base, source: 'CREATOR_CORPUS', mode: 'REAL_SIGNAL' })!), 'Creator · Real-signal');
});

test('malformed provenance never renders as a false AI label', () => {
  assert.equal(parseQueryGenerationProvenance(null), null);
  assert.equal(parseQueryGenerationProvenance({ source: 'UNKNOWN', mode: 'OPEN_WORLD' }), null);
  assert.equal(parseQueryGenerationProvenance({ source: 'LLM', mode: 'OPEN_WORLD', country: 'France' }), null);
});

test('tooltip preserves country, language, model and prompt provenance', () => {
  const provenance = parseQueryGenerationProvenance({
    source: 'LLM',
    mode: 'OPEN_WORLD',
    provider: 'groq',
    model: 'llama-3.3',
    promptVersion: 'native-query-v1',
    batchId: 'batch-1',
    country: 'France',
    language: 'fr',
    generatedAt: '2026-11-13T00:00:00.000Z',
  })!;
  const tooltip = formatQueryGenerationTooltip(provenance);
  assert.match(tooltip, /Provider: groq/);
  assert.match(tooltip, /Model: llama-3\.3/);
  assert.match(tooltip, /Country: France/);
  assert.match(tooltip, /Language: fr/);
  assert.match(tooltip, /Prompt: native-query-v1/);
});
