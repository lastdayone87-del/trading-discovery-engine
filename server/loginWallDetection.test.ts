import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isConfirmedLoginWall, isConfirmedPaywall } from './loginWallDetection';

const LOGIN_HTML =
  '<html><body><form action="/login"><input name="user"><input type="password" name="pass"></form></body></html>';

describe('confirmed login-wall detection (redirect + content, never URL-only)', () => {
  it('confirms redirect-to-login with markers', () => {
    assert.equal(
      isConfirmedLoginWall({
        requestedUrl: 'https://www.instagram.com/someprofile',
        finalUrl: 'https://www.instagram.com/accounts/login/?next=/someprofile',
        html: LOGIN_HTML,
        httpStatus: 200,
        hasCandidates: false,
      }),
      true,
    );
  });

  it('rejects without redirect (requested == final)', () => {
    assert.equal(
      isConfirmedLoginWall({
        requestedUrl: 'https://example.com/login',
        finalUrl: 'https://example.com/login',
        html: LOGIN_HTML,
        httpStatus: 200,
      }),
      false,
    );
  });

  it('rejects without content markers', () => {
    assert.equal(
      isConfirmedLoginWall({
        requestedUrl: 'https://example.com/page',
        finalUrl: 'https://example.com/login?next=/page',
        html: '<html><body>hello</body></html>',
        httpStatus: 200,
      }),
      false,
    );
  });

  it('rejects 429/403/5xx (retryable, never confirmed login)', () => {
    for (const httpStatus of [429, 401, 403, 500]) {
      assert.equal(
        isConfirmedLoginWall({
          requestedUrl: 'https://example.com/page',
          finalUrl: 'https://example.com/login?next=/page',
          html: LOGIN_HTML,
          httpStatus,
        }),
        false,
      );
    }
  });

  it('rejects FOUND rows and asset paths', () => {
    assert.equal(
      isConfirmedLoginWall({
        requestedUrl: 'https://example.com/page',
        finalUrl: 'https://example.com/login',
        html: LOGIN_HTML,
        httpStatus: 200,
        hasCandidates: true,
      }),
      false,
    );
    assert.equal(
      isConfirmedLoginWall({
        requestedUrl: 'https://sso.example.com/login/style.css',
        finalUrl: 'https://sso.example.com/login/style.css',
        html: LOGIN_HTML,
        httpStatus: 200,
      }),
      false,
    );
  });

  it('fails open on missing input', () => {
    assert.equal(isConfirmedLoginWall({}), false);
  });
});

describe('confirmed paywall detection (markers + payment, never status-only)', () => {
  const PAYWALL_HTML =
    '<html><body><div class="paywall">subscribe to continue</div><p>subscription required, billing</p></body></html>';
  it('confirms paywall with markers + payment keywords', () => {
    assert.equal(
      isConfirmedPaywall({ finalUrl: 'https://example.com/article/123', html: PAYWALL_HTML }),
      true,
    );
  });
  it('rejects marker without payment, FOUND rows, assets, missing input', () => {
    assert.equal(
      isConfirmedPaywall({ finalUrl: 'https://example.com/a', html: '<div class="paywall">hello</div>' }),
      false,
    );
    assert.equal(
      isConfirmedPaywall({ finalUrl: 'https://example.com/a', html: PAYWALL_HTML, hasCandidates: true }),
      false,
    );
    assert.equal(isConfirmedPaywall({}), false);
  });
  it('single 403/429 never confirms paywall by itself', () => {
    // Status is not an input to paywall confirmation at all: content proves it.
    assert.equal(
      isConfirmedPaywall({ finalUrl: 'https://example.com/a', html: '<html>forbidden</html>' }),
      false,
    );
  });
});
