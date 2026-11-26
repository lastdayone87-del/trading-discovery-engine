import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldFollowDestination } from './destinationPolicy';
import {
  MULTILINGUAL_CONTROL_HINTS,
  MULTILINGUAL_PATH_HINTS,
  hasMultilingualStrongCommunityEvidence,
} from './multilingualCommunityLexicon';

const localizedJoin = [
  'Beitreten', // German
  'Rejoindre', // French
  'Adhérer', // French
  'Lid worden', // Dutch
  'Deltag', // Danish
  'Bli med', // Norwegian
  'Gå med', // Swedish
  'انضم', // Arabic
  '加入', // Chinese
  'Páirt a ghlacadh', // Irish
  'Matmaachen', // Luxembourgish
  'Comunidad', // Spanish
  'Unisciti', // Italian
  'コミュニティ', // Japanese
];

test('localized join/community CTAs open a cross-origin community destination', () => {
  for (const phrase of localizedJoin) {
    const decision = shouldFollowDestination({
      url: 'https://hub.example/x',
      currentUrl: 'https://creator.example/',
      anchorText: phrase,
    });
    assert.equal(decision.eligible, true, phrase);
    assert.equal(decision.reason, 'community-evidence', phrase);
  }
});

test('ordinary words do not become community evidence through substrings', () => {
  for (const phrase of ['remember', 'football club', 'chatgpt', 'groupon', 'privacy policy', 'market access']) {
    assert.equal(hasMultilingualStrongCommunityEvidence(phrase), false, phrase);
  }
  assert.equal(hasMultilingualStrongCommunityEvidence('members'), true);
  assert.equal(hasMultilingualStrongCommunityEvidence('joining'), true);
});

test('hyphenated multilingual paths still match the lexicon', () => {
  const decision = shouldFollowDestination({
    url: 'https://hub.example/trading-room',
    currentUrl: 'https://creator.example/',
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.reason, 'community-evidence');
});

test('generic access terms no longer open an unknown host alone', () => {
  for (const phrase of ['acceso', 'accès', 'zugang', 'access']) {
    const decision = shouldFollowDestination({
      url: 'https://hub.example/x',
      currentUrl: 'https://creator.example/',
      anchorText: phrase,
    });
    assert.equal(decision.eligible, false, phrase);
  }
});

test('paid community wording still qualifies with a platform/server context', () => {
  for (const phrase of ['paid server', 'premium platform', 'members area server']) {
    const decision = shouldFollowDestination({
      url: 'https://hub.example/x',
      currentUrl: 'https://creator.example/',
      anchorText: phrase,
    });
    assert.equal(decision.eligible, true, phrase);
  }
});

test('localized weak navigation labels do not open an unknown host alone', () => {
  for (const phrase of ['Kontakt', 'Liens', '关于', 'Teagmháil', 'Kontakt']) {
    const decision = shouldFollowDestination({
      url: 'https://hub.example/x',
      currentUrl: 'https://creator.example/',
      anchorText: phrase,
    });
    assert.equal(decision.eligible, false, phrase);
    assert.equal(decision.reason, 'no-community-evidence', phrase);
  }
});

test('lexicon is exposed to rendered control and static path matching', () => {
  for (const phrase of localizedJoin) {
    assert.equal(hasMultilingualStrongCommunityEvidence(phrase), true, phrase);
    assert.equal(MULTILINGUAL_CONTROL_HINTS.test(phrase), true, phrase);
    assert.ok(MULTILINGUAL_PATH_HINTS.includes(phrase.toLowerCase()), phrase);
  }
});
