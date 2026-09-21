const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { OAuthService, generateCodeVerifier, computeCodeChallenge } = require('./oauth');

test('generates valid PKCE code verifier and S256 code challenge', () => {
  const verifier = generateCodeVerifier();
  assert.ok(verifier.length >= 43, 'Verifier should be at least 43 chars');
  const challenge = computeCodeChallenge(verifier);
  assert.ok(challenge.length >= 43, 'Challenge should be base64url encoded');

  // RFC 7636 Appendix B test vector:
  const rfcVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const rfcExpected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  assert.equal(computeCodeChallenge(rfcVerifier), rfcExpected);
});

test('packs, signs and unpacks state cookie safely', () => {
  const service = new OAuthService({
    env: { ADMIN_PASSWORD: 'super-secret-key-123' },
  });

  const cookie = service.packStateCookie('state-xyz', 'verifier-123', false);
  assert.match(cookie, /^rd_oauth_state=/);
  assert.match(cookie, /SameSite=Lax/);

  // Unpack with matching cookie header (browser sends only name=value, not attributes)
  const requestCookie = cookie.split(';')[0];
  const req = { headers: { cookie: requestCookie } };
  const unpacked = service.unpackStateCookie(req);
  assert.ok(unpacked);
  assert.equal(unpacked.state, 'state-xyz');
  assert.equal(unpacked.codeVerifier, 'verifier-123');

  // Tampering with payload fails signature verification
  const [cookiePrefix, cookieSuffix] = requestCookie.split('.');
  const tamperedPayloadCookie = `${cookiePrefix.slice(0, -2)}xx.${cookieSuffix}`;
  assert.equal(service.unpackStateCookie({ headers: { cookie: tamperedPayloadCookie } }), null);

  // Tampering with signature fails
  const tamperedSigCookie = `${cookiePrefix}.${cookieSuffix.slice(0, -2)}yy`;
  assert.equal(service.unpackStateCookie({ headers: { cookie: tamperedSigCookie } }), null);

  // Expired cookie header format
  const expired = service.expiredStateCookie(true);
  assert.match(expired, /Max-Age=0/);
  assert.match(expired, /Secure/);
});

test('constructs authorization URL using explicit endpoints or discovery', async () => {
  const service = new OAuthService({
    env: {
      OAUTH_ENABLED: 'Y',
      OAUTH_CLIENT_ID: 'my-client-id',
      OAUTH_CLIENT_SECRET: 'my-client-secret',
      OAUTH_AUTH_URL: 'https://auth.example.com/api/oidc/authorization',
      OAUTH_TOKEN_URL: 'https://auth.example.com/api/oidc/token',
      OAUTH_USERINFO_URL: 'https://auth.example.com/api/oidc/userinfo',
      OAUTH_SCOPES: 'openid profile email groups',
    },
  });

  assert.equal(service.isEnabled(), true);
  assert.equal(service.getClientId(), 'my-client-id');
  assert.equal(service.getProviderName(), 'Authelia');

  const redirectUri = 'http://127.0.0.1:3000/api/auth/oauth/callback';
  const authData = await service.getAuthorizationUrl(redirectUri);

  assert.ok(authData.url.startsWith('https://auth.example.com/api/oidc/authorization?'));
  const parsed = new URL(authData.url);
  assert.equal(parsed.searchParams.get('client_id'), 'my-client-id');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(parsed.searchParams.get('scope'), 'openid profile email groups');
  assert.equal(parsed.searchParams.get('state'), authData.state);
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('code_challenge'), computeCodeChallenge(authData.codeVerifier));
});

test('exchanges code for user claims with mock OIDC server', async (t) => {
  // Start mock OIDC server
  const mockServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/oidc/token') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        if (params.get('code') === 'valid-auth-code') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            access_token: 'mock-access-token-999',
            token_type: 'Bearer',
            expires_in: 3600,
          }));
        } else {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/oidc/userinfo') {
      assert.equal(req.headers.authorization, 'Bearer mock-access-token-999');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        sub: 'authelia-user-uuid-123',
        preferred_username: 'authelia_admin',
        name: 'Authelia Administrator',
        email: 'admin@authelia.local',
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  t.after(() => mockServer.close());

  const mockPort = mockServer.address().port;
  const service = new OAuthService({
    env: {
      OAUTH_ENABLED: 'Y',
      OAUTH_CLIENT_ID: 'mock-client',
      OAUTH_CLIENT_SECRET: 'mock-secret',
      OAUTH_AUTH_URL: `http://127.0.0.1:${mockPort}/api/oidc/authorization`,
      OAUTH_TOKEN_URL: `http://127.0.0.1:${mockPort}/api/oidc/token`,
      OAUTH_USERINFO_URL: `http://127.0.0.1:${mockPort}/api/oidc/userinfo`,
    },
  });

  const result = await service.exchangeCode({
    code: 'valid-auth-code',
    state: 'correct-state',
    expectedState: 'correct-state',
    codeVerifier: 'mock-verifier',
    redirectUri: 'http://127.0.0.1:3000/api/auth/oauth/callback',
  });

  assert.equal(result.username, 'authelia_admin');
  assert.equal(result.displayName, 'Authelia Administrator');
  assert.equal(result.email, 'admin@authelia.local');

  // Test state mismatch rejection
  await assert.rejects(
    () => service.exchangeCode({
      code: 'valid-auth-code',
      state: 'tampered-state',
      expectedState: 'correct-state',
      codeVerifier: 'mock-verifier',
      redirectUri: 'http://127.0.0.1:3000/api/auth/oauth/callback',
    }),
    /State 校验失败/
  );
});
