import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { channelLanguageSnippet, classifierLanguageInputs, resolveEnrichmentDetectedLanguages, snippetLanguage, usableVideoLanguages, withoutTranscriptLanguages, withoutVideoLanguages } from './youtube';
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
  assert.deepEqual(
    resolveEnrichmentDetectedLanguages({ defaultLanguage: 'de' }, [{ language: 'en' }], stale),
    { detectedLanguages: undefined, dissented: false }
  );
  assert.deepEqual(
    resolveEnrichmentDetectedLanguages({ defaultLanguage: 'de' }, [{ language: 'de' }], stale),
    { detectedLanguages: undefined, dissented: false }
  );
  // Invalid video tags are ignored: the channel fallback still applies.
  assert.deepEqual(
    resolveEnrichmentDetectedLanguages({ defaultLanguage: 'de' }, [{ language: '!!!' }], stale),
    { detectedLanguages: [{ language: 'de' }], dissented: false }
  );
  // Nothing usable anywhere: the stale fallback survives (pre-existing data).
  assert.deepEqual(resolveEnrichmentDetectedLanguages({}, [], stale), {
    detectedLanguages: stale,
    dissented: false,
  });
  assert.deepEqual(resolveEnrichmentDetectedLanguages({}, [], undefined), {
    detectedLanguages: undefined,
    dissented: false,
  });
});

test('transcript dissent vetoes the selection for suppression downstream', () => {
  // Channel default vs disagreeing transcript: vetoed, flagged for stripping.
  assert.deepEqual(
    resolveEnrichmentDetectedLanguages(
      { defaultLanguage: 'de' }, [], undefined, [{ language: 'fr' }]
    ),
    { detectedLanguages: undefined, dissented: true }
  );
  // Agreeing transcripts do not veto.
  assert.deepEqual(
    resolveEnrichmentDetectedLanguages(
      { defaultLanguage: 'de' }, [], undefined, [{ language: 'de' }, { language: 'und' }]
    ),
    { detectedLanguages: [{ language: 'de' }], dissented: false }
  );
  // No transcripts: unchanged behavior.
  assert.deepEqual(resolveEnrichmentDetectedLanguages({ defaultLanguage: 'de' }, [], undefined), {
    detectedLanguages: [{ language: 'de' }],
    dissented: false,
  });
});

test('fallback confidence winner decides the veto target', () => {
  const fallback = [
    { language: 'fr', confidence: 40 },
    { language: 'de', confidence: 90 },
  ];
  // Transcripts agreeing with the low-confidence entry but contradicting
  // the winner still veto: the selector would admit the winner.
  assert.deepEqual(
    resolveEnrichmentDetectedLanguages({}, [], fallback, [{ language: 'fr' }]),
    { detectedLanguages: undefined, dissented: true }
  );
  assert.deepEqual(
    resolveEnrichmentDetectedLanguages({}, [], fallback, [{ language: 'de' }]),
    { detectedLanguages: fallback, dissented: false }
  );
  // Tied winners admit nothing downstream: no selection, no veto needed.
  const tied = [
    { language: 'fr', confidence: 90 },
    { language: 'de', confidence: 90 },
  ];
  assert.deepEqual(resolveEnrichmentDetectedLanguages({}, [], tied, [{ language: 'fr' }]), {
    detectedLanguages: undefined,
    dissented: false,
  });
});

test('withoutTranscriptLanguages strips only the language key', () => {
  assert.deepEqual(withoutTranscriptLanguages([{ video_id: 'v1', text: 't', language: 'de' }]), [
    { video_id: 'v1', text: 't' },
  ]);
  assert.deepEqual(withoutTranscriptLanguages([]), []);
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
  assert.match(source, /videos:languageInputs\.videos/);
  assert.match(source, /detected_languages:languageInputs\.detected_languages/);
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

test('classifier inputs strip only enrichment-added language hints', () => {
  const videos = [{ id: 'v1', title: 't', language: 'de' }];
  const hints = [{ language: 'de' }];
  // Enrichment pass: enrichment-added hints are isolated from classification.
  assert.deepEqual(classifierLanguageInputs({ detectedLanguages: hints }, videos, true), {
    videos: [{ id: 'v1', title: 't' }],
    detected_languages: undefined,
  });
  // Provider-flagged hints are stripped on EVERY pass (metadata hydration
  // can attach them outside enrichment): the round-5 metadata hole stays shut.
  assert.deepEqual(
    classifierLanguageInputs({ detectedLanguages: hints, providerDeclaredLanguage: true }, videos, false),
    { videos: [{ id: 'v1', title: 't' }], detected_languages: undefined }
  );
  // Unflagged hints (content-analyzed or future legitimate producers) pass
  // through untouched outside enrichment.
  assert.deepEqual(classifierLanguageInputs({ detectedLanguages: hints }, videos, false), {
    videos,
    detected_languages: hints,
  });
  assert.deepEqual(classifierLanguageInputs({}, [], false), { videos: [], detected_languages: undefined });
});
