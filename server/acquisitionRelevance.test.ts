import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrlRelevance } from './acquisitionRelevance';

describe('acquisition relevance tiering (fail-open, recall-safe)', () => {
  it('fails open on missing/errored input', () => {
    assert.equal(classifyUrlRelevance({ url: '', source: '', contextMatches: false }).tier, 'ELIGIBLE');
  });

  it('never blocks affiliate/broker/tracking/short-link/social/link-hub/community', () => {
    const neverBlock = [
      'https://tradeify.co/?ref=RDF',
      'https://apextraderfunding.com/member/aff/go/test',
      'https://tradingview.com/?aff_id=1',
      'https://bit.ly/btc-discord',
      'https://linktr.ee/somehandle',
      'https://x.com/someprofile',
      'https://www.instagram.com/someprofile',
      'https://whop.com/some-product',
      'https://noticetrades.substack.com/',
      'https://github.com/some/repo',
      'https://open.spotify.com/show/abc',
      'https://example.com/community',
      'https://example.com/join',
      'https://example.com/members/signup',
    ];
    for (const url of neverBlock) {
      const decision = classifyUrlRelevance({ url, source: 'VIDEO_1_DESCRIPTION', contextMatches: false });
      assert.notEqual(decision.tier, 'BLOCK', url);
    }
  });

  it('keeps App Store eligible (2 FOUND rows prove render may matter)', () => {
    const decision = classifyUrlRelevance({
      url: 'https://apps.apple.com/in/app/classplus/id1324522260',
      source: 'VIDEO_1_DESCRIPTION',
      contextMatches: false,
    });
    assert.notEqual(decision.tier, 'BLOCK');
  });

  it('demotes news/article path (never blocks: 3 FOUND sites need page proof)', () => {
    const decision = classifyUrlRelevance({
      url: 'https://example.com/news/some-article',
      source: 'VIDEO_1_DESCRIPTION',
      contextMatches: false,
    });
    assert.equal(decision.tier, 'DEMOTE');
  });

  it('blocks utility scheduling detail only under strict conjunction', () => {
    const blocked = classifyUrlRelevance({
      url: 'https://calendly.com/someuser/book-meeting',
      source: 'VIDEO_1_DESCRIPTION',
      contextMatches: false,
    });
    assert.equal(blocked.tier, 'BLOCK');
    // Trusted source never blocks.
    const trusted = classifyUrlRelevance({
      url: 'https://calendly.com/someuser/book-meeting',
      source: 'CHANNEL_LINKS',
      contextMatches: false,
    });
    assert.notEqual(trusted.tier, 'BLOCK');
    // Community hint never blocks.
    const hinted = classifyUrlRelevance({
      url: 'https://calendly.com/someuser/book-meeting?x=discord',
      source: 'VIDEO_1_DESCRIPTION',
      contextMatches: false,
    });
    assert.notEqual(hinted.tier, 'BLOCK');
  });

  it('community hint / context / creator-canonical never block', () => {
    assert.notEqual(
      classifyUrlRelevance({ url: 'https://forms.gle/abc123', source: 'VIDEO_1_DESCRIPTION', contextMatches: true }).tier,
      'BLOCK',
    );
  });
});
