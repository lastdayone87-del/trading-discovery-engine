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

  it('utility/form/single-purpose shapes demote (never block: destination uncertain)', () => {
    // Scheduling can be creator mentorship workflow; forms can be community
    // applications; amzn.to destinations are opaque (trading book/resource
    // possible). Low yield is not determinism → DEMOTE, never BLOCK.
    for (const url of [
      'https://calendly.com/someuser/book-meeting',
      'https://forms.gle/Mt45c2qhAvgaUTyG8',
      'https://amzn.to/3ovQMLW',
    ]) {
      const decision = classifyUrlRelevance({ url, source: 'VIDEO_1_DESCRIPTION', contextMatches: false });
      assert.equal(decision.tier, 'DEMOTE', url);
    }
    // Trusted source never even demotes via these rules (guards fail open).
    const trusted = classifyUrlRelevance({
      url: 'https://calendly.com/someuser/book-meeting',
      source: 'CHANNEL_LINKS',
      contextMatches: false,
    });
    assert.notEqual(trusted.tier, 'BLOCK');
    // Community hint never demotes/blocks.
    const hinted = classifyUrlRelevance({
      url: 'https://calendly.com/someuser/book-meeting?x=discord',
      source: 'VIDEO_1_DESCRIPTION',
      contextMatches: false,
    });
    assert.equal(hinted.tier, 'ELIGIBLE');
  });

  it('BLOCK tier is reserved: no semantic rule emits it on representative corpus', () => {
    const corpus = [
      'https://tradeify.co/?ref=RDF',
      'https://bit.ly/btc-discord',
      'https://linktr.ee/somehandle',
      'https://x.com/someprofile',
      'https://apps.apple.com/in/app/classplus/id1324522260',
      'https://example.com/news/some-article',
      'https://calendly.com/someuser/book-meeting',
      'https://forms.gle/abc123',
      'https://amzn.to/3ovQMLW',
      'https://example.com/community',
      'https://noticetrades.substack.com/',
      'https://github.com/some/repo',
    ];
    for (const url of corpus) {
      assert.notEqual(
        classifyUrlRelevance({ url, source: 'VIDEO_1_DESCRIPTION', contextMatches: false }).tier,
        'BLOCK',
        url,
      );
    }
  });

  it('community hint / context / creator-canonical never block', () => {
    assert.notEqual(
      classifyUrlRelevance({ url: 'https://forms.gle/abc123', source: 'VIDEO_1_DESCRIPTION', contextMatches: true }).tier,
      'BLOCK',
    );
  });

  it('adversarial: subdomain-login, fragment, asset, wrapper, source guards fail open', () => {
    // login. subdomain is not a path wall.
    assert.notEqual(
      classifyUrlRelevance({ url: 'https://login.example.com/register', source: 'VIDEO_1_DESCRIPTION', contextMatches: false }).tier,
      'BLOCK',
    );
    // Fragment-only login never blocks (spotify #login FOUND precedent).
    assert.notEqual(
      classifyUrlRelevance({ url: 'https://open.spotify.com/show/abc#login', source: 'VIDEO_1_DESCRIPTION', contextMatches: false }).tier,
      'BLOCK',
    );
    // Wrapper (redirect chain) needs acquisition, never blocked.
    assert.notEqual(
      classifyUrlRelevance({ url: 'https://forms.gle/abc', source: 'VIDEO_1_DESCRIPTION', contextMatches: false, wrapperUrl: 'https://youtube.com/redirect?q=x' }).tier,
      'BLOCK',
    );
    // Non-low-trust source never blocks even on utility shape.
    assert.notEqual(
      classifyUrlRelevance({ url: 'https://calendly.com/u/book', source: 'CHANNEL_LINKS', contextMatches: false }).tier,
      'BLOCK',
    );
    // Creator-canonical never blocks.
    assert.notEqual(
      classifyUrlRelevance({
        url: 'https://mycreator.com/book', source: 'VIDEO_1_DESCRIPTION', contextMatches: false,
        creatorCanonicalHosts: new Set(['mycreator.com']),
      }).tier,
      'BLOCK',
    );
    // Invalid/asset handled by admission boundary, not relevance BLOCK.
    const invalid = classifyUrlRelevance({ url: 'https://g/', source: 'VIDEO_1_DESCRIPTION', contextMatches: false });
    assert.equal(invalid.tier, 'ELIGIBLE');
  });
});
