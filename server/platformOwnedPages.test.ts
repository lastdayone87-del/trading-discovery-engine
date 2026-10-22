import assert from 'node:assert/strict';
import test from 'node:test';
import { isPlatformOwnedCommunityUrl } from '../src/utils/platformOwnedPages';

test('Whop corporate pages and asset URLs are platform-owned', () => {
  const urls = [
    'https://whop.com/careers',
    'https://whop.com/login?next=%2F&newUserNext=%2Fstart%3Fnew_user%3D1',
    'https://newsroom.whop.com/whop-economic-intelligence/price',
    'https://whop.com/_web/assets/gha-39651352868-1/translations/en/checkout-planid-3e0f42-6337b6e753.json',
    'https://whop.com/_web/assets/gha-39651309620-1/translations/en/app-404897-ad4dae54ee.json',
    'https://whop.com/_next/static/chunks/app.js',
    'https://whop.com/assets/app.css',
    'https://whop.com/discover/creator.json',
  ];

  for (const url of urls) {
    assert.equal(isPlatformOwnedCommunityUrl('WHOP', url), true, url);
  }
});

test('Whop creator pages remain creator-specific', () => {
  const urls = [
    'https://whop.com/creator',
    'https://www.whop.com/creator',
    'https://whop.com/discover/creator-slug',
    'https://whop.com/marketplace/creator-slug',
    'https://whop.com/discover/assets',
    'https://whop.com/marketplace/assets',
  ];

  for (const url of urls) {
    assert.equal(isPlatformOwnedCommunityUrl('WHOP', url), false, url);
  }
});

test('the Skool Games community is not a reserved platform page', () => {
  assert.equal(isPlatformOwnedCommunityUrl('SKOOL', 'https://www.skool.com/games'), false);
  assert.equal(isPlatformOwnedCommunityUrl('SKOOL', 'https://skool.com/games/about'), false);
});

test('other platform tenant communities are not reclassified by Whop asset rules', () => {
  assert.equal(isPlatformOwnedCommunityUrl('SKOOL', 'https://trading.skool.com/atlas'), false);
  assert.equal(isPlatformOwnedCommunityUrl('CIRCLE', 'https://community.circle.so/c/creator'), false);
  assert.equal(isPlatformOwnedCommunityUrl('PATREON', 'https://www.patreon.com/creator'), false);
});
