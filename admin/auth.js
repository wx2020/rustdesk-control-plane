const crypto = require('node:crypto');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function passwordHash(password, salt = crypto.randomBytes(16).toString('base64url')) {
  const digest = crypto.scryptSync(password, salt, 64).toString('base64url');
  return `scrypt$${salt}$${digest}`;
}

function verifyPassword(password, encoded) {
  const [algorithm, salt, digest] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !digest) return false;
  const actual = Buffer.from(passwordHash(password, salt).split('$')[2], 'base64url');
  const expected = Buffer.from(digest, 'base64url');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function cookieValue(req, name) {
  const entry = (req.headers.cookie || '').split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}

class AuthService {
  constructor(store) {
    this.store = store;
    this.ready = this.bootstrap();
  }

  async bootstrap() {
    await this.store.ready;
    const password = process.env.ADMIN_PASSWORD;
    if (!password) throw new Error('必须设置 ADMIN_PASSWORD 以启用管理后台认证');
    const username = process.env.ADMIN_USERNAME || 'admin';
    const existing = await this.store.getUserByUsername(username);
    if (existing) return;
    await this.store.create('users', {
      username,
      displayName: process.env.ADMIN_DISPLAY_NAME || '系统管理员',
      roleId: 'role_admin',
      passwordHash: passwordHash(password),
    });
  }

  async login(username, password) {
    await this.ready;
    const user = await this.store.getUserByUsername(username);
    if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) return null;
    const role = user.roleId ? await this.store.get('roles', user.roleId) : null;
    const sessionId = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const session = { id: sessionId, csrfToken, user: { id: user.id, username: user.username, displayName: user.displayName, permissions: role ? role.permissions || [] : [] }, expiresAt: Date.now() + SESSION_TTL_MS };
    await this.store.saveAdminSession(session);
    return session;
  }

  async session(req) {
    const sessionId = cookieValue(req, 'rd_admin_session');
    if (!sessionId) return this.proxySession(req);
    const session = await this.store.getAdminSession(sessionId);
    return session && !session.user.disabled ? session : null;
  }

  async proxySession(req) {
    if (process.env.ADMIN_PROXY_AUTH_TRUST !== 'Y' || process.env.ADMIN_TRUST_PROXY !== 'Y') return null;
    const header = (process.env.ADMIN_PROXY_USER_HEADER || 'x-forwarded-user').toLowerCase();
    const username = req.headers[header];
    if (typeof username !== 'string' || !username) return null;
    const user = await this.store.getUserByUsername(username);
    if (!user || user.disabled) return null;
    const role = user.roleId ? await this.store.get('roles', user.roleId) : null;
    return { id: `proxy:${username}`, csrfToken: req.headers['x-csrf-token'] || '', proxy: true, user: { id: user.id, username: user.username, displayName: user.displayName, permissions: role ? role.permissions || [] : user.permissions || [] } };
  }

  async logout(req) {
    const sessionId = cookieValue(req, 'rd_admin_session');
    if (sessionId) await this.store.deleteAdminSession(sessionId);
  }

  async authorize(req, permission, write = false) {
    const session = await this.session(req);
    if (!session) return { error: '需要登录', status: 401 };
    if (!session.user.permissions.includes('*') && !session.user.permissions.includes(permission)) return { error: '没有执行此操作的权限', status: 403 };
    if (write && !session.proxy && req.headers['x-csrf-token'] !== session.csrfToken) return { error: 'CSRF 校验失败', status: 403 };
    return { session };
  }
}

function sessionCookie(sessionId, secure) {
  return `rd_admin_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
}

function expiredCookie(secure) {
  return `rd_admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

module.exports = { AuthService, sessionCookie, expiredCookie };
