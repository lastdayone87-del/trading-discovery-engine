import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { channelLanguageSnippet, resolveEnrichmentDetectedLanguages, snippetLanguage, usableVideoLanguages, withoutVideoLanguages } from './youtube';
import { selectExplicitTerminologyLanguageContext } from './terminologyLanguageContext';

test('snippetLanguage prefers per-video audio language, then default language', () => {
  assert.equal(snippetLanguage({ defaultAudioLanguage: 'de-DE', defaultLanguage: 'en' }), 'de-DE');
  assert.equal(snippetLanguage({ defaultLanguage: 'fr' }), 'fr');
  assert.equal(snippetLanguage({}), undefined);
  assert.equal(snippetLanguage(null), undefined);
  assert.equal(snippetLanguage(undefined), undefined);
  assert.equal(snippetLanguage({ defaultLanguage: '' }), undefined);
  assert.equal(snippetLanguage({ defaultLanguage: '   ' }), undefined);
  assert.equal(snippetLanguage({ defaultLanguage: 42 }), undefined);
});

test('provider-shaped video unanimity supplies context; conflict stays unknown', () => {
  // Unanimous video languages (undated/unknown entries carry no vote).
  assert.deepEqual(
    selectExplicitTerminologyLanguageContext({ videos: [{ language: 'de' }, { language: 'de-DE' }] }),
    { language: 'de' }
  );
  // Conflicting video languages never resolve: fail closed, never guessed.
  assert.equal(
    selectExplicitTerminologyLanguageContext({ videos: [{ language: 'de' }, { language: 'en' }] }),
    undefined
  );
  assert.equal(selectExplicitTerminologyLanguageContext({ videos: [] }), undefined);
  assert.equal(selectExplicitTerminologyLanguageContext({}), undefined);
});

test('channel-level detected language applies only as a single fallback signal', () => {
  assert.deepEqual(
    selectExplicitTerminologyLanguageContext({ detectedLanguages: [{ language: 'de' }] }),
    { language: 'de' }
  );
  // Invalid provider tags are dropped, never fabricated into a language.
  // (Note: 'xx-!!' normalizes to the shape-valid code 'xx' by the pre-existing
  // normalizer — out of scope here; provider tags are BCP 47 in practice.)
  assert.equal(selectExplicitTerminologyLanguageContext({ detectedLanguages: [{ language: '!!!' }] }), undefined);
  assert.equal(selectExplicitTerminologyLanguageContext({ detectedLanguages: [{ language: '' }] }), undefined);
});

test('snippetLanguage returns the first valid tag, never an invalid audio tag', () => {
  // An invalid audio tag must not suppress a valid default.
  assert.equal(snippetLanguage({ defaultAudioLanguage: '!!!', defaultLanguage: 'de' }), 'de');
  assert.equal(snippetLanguage({ defaultAudioLanguage: '', defaultLanguage: 'fr-FR' }), 'fr-FR');
  // A valid audio tag keeps precedence (region preserved for explicitLocale).
  assert.equal(snippetLanguage({ defaultAudioLanguage: 'de-DE', defaultLanguage: 'en' }), 'de-DE');
  assert.equal(snippetLanguage({ defaultLanguage: '!!!' }), undefined);
});

test('usableVideoLanguages counts only normalizable tags', () => {
  assert.deepEqual(usableVideoLanguages([{ language: 'de' }, { language: '!!!' }, {}]), ['de']);
  assert.deepEqual(usableVideoLanguages([{ language: '!!!' }]), []);
  assert.deepEqual(usableVideoLanguages([]), []);
});

test('stale fallbacks never override usable video languages', () => {
  const stale = [{ language: 'fr' }];
  // Usable videos suppress every fallback — even conflicting ones, so the
  // selector fail-closes instead of applying the stale context.
  assert.equal(
    resolveEnrichmentDetectedLanguages({ defaultLanguage: 'de' }, [{ language: 'en' }], stale),
    undefined
  );
  assert.equal(
    resolveEnrichmentDetectedLanguages({ defaultLanguage: 'de' }, [{ language: 'de' }], stale),
    undefined
  );
  // Invalid video tags are ignored: the channel fallback still applies.
  assert.deepEqual(
    resolveEnrichmentDetectedLanguages({ defaultLanguage: 'de' }, [{ language: '!!!' }], stale),
    [{ language: 'de' }]
  );
  // Nothing usable anywhere: the stale fallback survives (pre-existing data).
  assert.deepEqual(resolveEnrichmentDetectedLanguages({}, [], stale), stale);
  assert.equal(resolveEnrichmentDetectedLanguages({}, [], undefined), undefined);
});

test('withoutVideoLanguages strips only the language key for classifier inputs', () => {
  const videos = [
    { id: 'v1', title: 't', description: 'd', language: 'de' },
    { id: 'v2', title: 't2' },
  ];
  assert.deepEqual(withoutVideoLanguages(videos), [
    { id: 'v1', title: 't', description: 'd' },
    { id: 'v2', title: 't2' },
  ]);
  // Inputs are not mutated.
  assert.equal(videos[0].language, 'de');
});

test('trading-classifier inputs carry no provider language hints', () => {
  const source = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
  assert.match(source, /videos:withoutVideoLanguages\(structuredVideos\)/);
  assert.match(source, /detected_languages:undefined/);
});

test('channel language prefers snippet default, then brandingSettings default', () => {
  assert.deepEqual(channelLanguageSnippet({ snippet: { defaultLanguage: 'de' } }), {
    defaultAudioLanguage: undefined,
    defaultLanguage: 'de',
  });
  assert.deepEqual(
    channelLanguageSnippet({ snippet: {}, brandingSettings: { channel: { defaultLanguage: 'fr' } } }),
    { defaultAudioLanguage: undefined, defaultLanguage: 'fr' }
  );
  // Snippet wins on conflict; nothing is inferred from country.
  assert.deepEqual(
    channelLanguageSnippet({
      snippet: { defaultLanguage: 'de' },
      brandingSettings: { channel: { defaultLanguage: 'fr' } },
    }),
    { defaultAudioLanguage: undefined, defaultLanguage: 'de' }
  );
  assert.deepEqual(channelLanguageSnippet({}), { defaultAudioLanguage: undefined, defaultLanguage: undefined });
  assert.deepEqual(channelLanguageSnippet(null), { defaultAudioLanguage: undefined, defaultLanguage: undefined });
});

test('channel language validates snippet before branding fallback', () => {
  // Invalid snippet default must not suppress a valid branding default.
  assert.deepEqual(
    channelLanguageSnippet({
      snippet: { defaultLanguage: '!!!' },
      brandingSettings: { channel: { defaultLanguage: 'fr' } },
    }),
    { defaultAudioLanguage: undefined, defaultLanguage: 'fr' }
  );
  assert.deepEqual(
    channelLanguageSnippet({
      snippet: { defaultLanguage: '!!!' },
      brandingSettings: { channel: { defaultLanguage: '!!!' } },
    }),
    { defaultAudioLanguage: undefined, defaultLanguage: '!!!' }
  );
});
