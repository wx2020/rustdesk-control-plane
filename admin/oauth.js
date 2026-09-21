const crypto = require('node:crypto');

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function base64url(buffer) {
  return buffer.toString('base64url');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

function generateCodeVerifier() {
  return base64url(crypto.randomBytes(32));
}

function computeCodeChallenge(verifier) {
  return base64url(sha256(Buffer.from(verifier, 'utf8')));
}

function signState(state, secret) {
  return crypto.createHmac('sha256', secret).update(state).digest('base64url');
}

function verifyStateSignature(state, signature, secret) {
  const expected = signState(state, secret);
  const actualBuf = Buffer.from(signature, 'base64url');
  const expectedBuf = Buffer.from(expected, 'base64url');
  return actualBuf.length === expectedBuf.length && crypto.timingSafeEqual(actualBuf, expectedBuf);
}

class OAuthService {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.cachedDiscovery = null;
    this.discoveryExpiresAt = 0;
    this.signingSecret = this.env.ADMIN_PASSWORD || crypto.randomBytes(32).toString('base64url');
  }

  isEnabled() {
    const val = (this.env.OAUTH_ENABLED || '').trim().toLowerCase();
    return val === 'y' || val === 'true' || val === '1';
  }

  getProviderName() {
    return this.env.OAUTH_PROVIDER_NAME || 'Authelia';
  }

  getClientId() {
    return this.env.OAUTH_CLIENT_ID || '';
  }

  getClientSecret() {
    return this.env.OAUTH_CLIENT_SECRET || '';
  }

  getScopes() {
    return this.env.OAUTH_SCOPES || 'openid profile email';
  }

  isAutoCreateUser() {
    const val = (this.env.OAUTH_AUTO_CREATE_USER ?? 'Y').trim().toLowerCase();
    return val === 'y' || val === 'true' || val === '1';
  }

  getDefaultRoleId() {
    return this.env.OAUTH_DEFAULT_ROLE_ID || 'role_admin';
  }

  getPublicConfig() {
    return {
      enabled: this.isEnabled(),
      providerName: this.getProviderName(),
      loginUrl: '/api/auth/oauth/login',
    };
  }

  async discover() {
    if (this.cachedDiscovery && Date.now() < this.discoveryExpiresAt) {
      return this.cachedDiscovery;
    }

    const explicitAuth = this.env.OAUTH_AUTH_URL;
    const explicitToken = this.env.OAUTH_TOKEN_URL;
    const explicitUserinfo = this.env.OAUTH_USERINFO_URL;

    if (explicitAuth && explicitToken) {
      this.cachedDiscovery = {
        authorization_endpoint: explicitAuth,
        token_endpoint: explicitToken,
        userinfo_endpoint: explicitUserinfo || '',
      };
      return this.cachedDiscovery;
    }

    const issuer = (this.env.OAUTH_ISSUER || '').replace(/\/+$/, '');
    const discoveryUrl = this.env.OAUTH_DISCOVERY_URL || (issuer ? `${issuer}/.well-known/openid-configuration` : '');

    if (!discoveryUrl) {
      throw new Error('未配置 OAUTH_ISSUER 或 OAUTH_DISCOVERY_URL，且未显式指定 OAUTH_AUTH_URL / OAUTH_TOKEN_URL');
    }

    const res = await fetch(discoveryUrl, {
      headers: { accept: 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`OIDC 发现失败 (${discoveryUrl}): HTTP ${res.status}`);
    }

    const config = await res.json();
    this.cachedDiscovery = {
      authorization_endpoint: explicitAuth || config.authorization_endpoint,
      token_endpoint: explicitToken || config.token_endpoint,
      userinfo_endpoint: explicitUserinfo || config.userinfo_endpoint || '',
    };
    // Cache for 1 hour
    this.discoveryExpiresAt = Date.now() + 3600 * 1000;
    return this.cachedDiscovery;
  }

  async getAuthorizationUrl(redirectUri) {
    const endpoints = await this.discover();
    const state = base64url(crypto.randomBytes(24));
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = computeCodeChallenge(codeVerifier);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.getClientId(),
      redirect_uri: redirectUri,
      scope: this.getScopes(),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    const separator = endpoints.authorization_endpoint.includes('?') ? '&' : '?';
    const url = `${endpoints.authorization_endpoint}${separator}${params.toString()}`;

    return {
      url,
      state,
      codeVerifier,
    };
  }

  packStateCookie(state, codeVerifier, secure) {
    const payload = JSON.stringify({
      state,
      codeVerifier,
      exp: Date.now() + OAUTH_STATE_TTL_MS,
    });
    const encodedPayload = Buffer.from(payload, 'utf8').toString('base64url');
    const signature = signState(encodedPayload, this.signingSecret);
    const value = `${encodedPayload}.${signature}`;
    return `rd_oauth_state=${encodeURIComponent(value)}; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_STATE_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
  }

  unpackStateCookie(req) {
    const cookieHeader = req.headers.cookie || '';
    const entry = cookieHeader.split(';').map((v) => v.trim()).find((v) => v.startsWith('rd_oauth_state='));
    if (!entry) return null;
    const raw = decodeURIComponent(entry.slice('rd_oauth_state='.length));
    const parts = raw.split('.');
    if (parts.length !== 2) return null;
    const [encodedPayload, signature] = parts;
    if (!verifyStateSignature(encodedPayload, signature, this.signingSecret)) {
      return null;
    }
    try {
      const data = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
      if (typeof data.exp !== 'number' || Date.now() > data.exp) {
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  expiredStateCookie(secure) {
    return `rd_oauth_state=; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  async exchangeCode({ code, state, expectedState, codeVerifier, redirectUri }) {
    if (!code || !state || !expectedState) {
      throw new Error('缺少授权码或 State 参数');
    }

    const stateBuf = Buffer.from(state, 'utf8');
    const expectedBuf = Buffer.from(expectedState, 'utf8');
    if (stateBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(stateBuf, expectedBuf)) {
      throw new Error('State 校验失败');
    }

    const endpoints = await this.discover();
    const clientId = this.getClientId();
    const clientSecret = this.getClientSecret();

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });
    if (clientSecret) {
      body.set('client_secret', clientSecret);
    }

    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (clientId && clientSecret) {
      const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
      headers.authorization = `Basic ${basic}`;
    }

    const tokenRes = await fetch(endpoints.token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`换取 Token 失败 (HTTP ${tokenRes.status}): ${errText}`);
    }

    const tokens = await tokenRes.json();
    if (!tokens.access_token && !tokens.id_token) {
      throw new Error('Token 响应中未包含 access_token 或 id_token');
    }

    let claims = {};
    if (endpoints.userinfo_endpoint && tokens.access_token) {
      try {
        const userinfoRes = await fetch(endpoints.userinfo_endpoint, {
          headers: {
            authorization: `Bearer ${tokens.access_token}`,
            accept: 'application/json',
          },
        });
        if (userinfoRes.ok) {
          claims = await userinfoRes.json();
        }
      } catch {
        // Fall back to id_token claims if userinfo endpoint fails
      }
    }

    // If claims are still empty, try parsing payload from id_token (JWT)
    if (Object.keys(claims).length === 0 && tokens.id_token) {
      try {
        const segments = tokens.id_token.split('.');
        if (segments.length >= 2) {
          claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
        }
      } catch {
        // ignore parse error
      }
    }

    const username = (
      claims.preferred_username ||
      claims.email ||
      claims.sub ||
      claims.name ||
      ''
    ).trim();

    if (!username) {
      throw new Error('无法从身份提供商获取有效用户名 (preferred_username / email / sub 为空)');
    }

    const displayName = (claims.name || claims.preferred_username || claims.email || username).trim();
    const email = (claims.email || '').trim();

    return {
      username,
      displayName,
      email,
      claims,
    };
  }
}

module.exports = {
  OAuthService,
  generateCodeVerifier,
  computeCodeChallenge,
};

