import assert from 'node:assert/strict';
import test from 'node:test';
import { contentLanguagePacks } from './multilingualTerminology';
import { getLayeredKnowledgeContext } from './knowledgePacks';
import type { RawChannelInput } from './types';

/**
 * Explicit capability boundary (Phase 4/6 follow-up): normalization may admit
 * Vietnamese/Tagalog/Urdu/Bengali/Nepali codes into routing, but no
 * classification packs exist for them yet, so contentLanguagePacks filters
 * them out. This test locks that boundary in place — adding a pack for any
 * of these languages must update this test with measured precision/recall,
 * never silently.
 */
for (const language of ['vi', 'tl', 'ur', 'bn', 'ne']) {
  test(`unrouted language '${language}' yields no language-specific pack yet`, () => {
    const input = {
      channel_name: 'Test channel',
      description: 'Test description',
      detected_languages: [{ language, script: 'Latn', confidence: 90, field: 'description' }],
    } as unknown as RawChannelInput;
    const packs = contentLanguagePacks(input, getLayeredKnowledgeContext('Germany'));
    assert.ok(
      packs.every(pack => pack.languageCode !== language),
      `expected no '${language}' pack (none exists yet)`,
    );
  });
}

test("routed language 'no' yields its Norwegian pack", async () => {
  const { contentLanguagePacks } = await import('./multilingualTerminology');
  const { getLayeredKnowledgeContext } = await import('./knowledgePacks');
  const input = {
    channel_name: 'Test channel',
    description: 'lær trading med teknisk analyse og risikostyring',
    detected_languages: [{ language: 'no', script: 'Latn', confidence: 90, field: 'description' }],
  } as unknown as Parameters<typeof contentLanguagePacks>[0];
  const codes = contentLanguagePacks(input, getLayeredKnowledgeContext('Norway')).map(pack => pack.languageCode);
  assert.ok(codes.includes('no'), 'Norwegian content must resolve its pack');
});
