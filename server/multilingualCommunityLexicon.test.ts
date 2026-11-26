import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldFollowDestination } from './destinationPolicy';
import { communityNavigationScore } from './inspector';
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
    url: 'https://hub.example/comunidad-privada',
    currentUrl: 'https://creator.example/',
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.reason, 'community-evidence');
});

test('invite labels and concatenated slugs open unknown hosts', () => {
  const label = shouldFollowDestination({
    url: 'https://hub.example/x',
    currentUrl: 'https://creator.example/',
    anchorText: 'Get an invite',
  });
  assert.equal(label.eligible, true, 'invite');
  for (const slug of ['vipintraders', 'comunidadprivada', 'communaut%C3%A9-priv%C3%A9e']) {
    const decision = shouldFollowDestination({
      url: `https://unknown.example/${slug}`,
      currentUrl: 'https://creator.example/',
    });
    assert.equal(decision.eligible, true, slug);
  }
});

test('IDN hostnames and relative paths are matched without query text', () => {
  const idn = new URL('https://communauté.example/page').toString();
  const decision = shouldFollowDestination({
    url: idn,
    currentUrl: 'https://creator.example/',
  });
  assert.equal(decision.eligible, true);
  assert.equal(communityNavigationScore('/page?next=discord', ''), 0);
  assert.ok(communityNavigationScore('/community', '') > 0);
});

test('ambiguous host labels do not qualify a host on their own', () => {
  for (const host of ['circle.example', 'join.example', 'signal.example']) {
    const decision = shouldFollowDestination({
      url: `https://${host}/page`,
      currentUrl: 'https://creator.example/',
    });
    assert.equal(decision.eligible, false, host);
  }
});

test('ordinary URL substrings are not community evidence', () => {
  for (const slug of ['remember', 'groupon', 'privateer']) {
    const decision = shouldFollowDestination({
      url: `https://unknown.example/${slug}`,
      currentUrl: 'https://creator.example/',
    });
    assert.equal(decision.eligible, false, slug);
  }
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

test('rendered control regex keeps the Unicode flag and token boundaries', () => {
  assert.ok(MULTILINGUAL_CONTROL_HINTS.flags.includes('u'));
  assert.equal(MULTILINGUAL_CONTROL_HINTS.test('ChatGPT'), false);
  assert.equal(MULTILINGUAL_CONTROL_HINTS.test('Remember'), false);
  assert.equal(MULTILINGUAL_CONTROL_HINTS.test('members'), true);
});

test('lexicon is exposed to rendered control and static path matching', () => {
  for (const phrase of localizedJoin) {
    assert.equal(hasMultilingualStrongCommunityEvidence(phrase), true, phrase);
    assert.equal(MULTILINGUAL_CONTROL_HINTS.test(phrase), true, phrase);
    assert.ok(MULTILINGUAL_PATH_HINTS.includes(phrase.toLowerCase()), phrase);
  }
});
