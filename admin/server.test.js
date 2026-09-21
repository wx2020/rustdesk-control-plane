const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.ADMIN_USERNAME = 'test-admin';
process.env.ADMIN_ALLOW_MEMORY_STORE = 'Y';
const { serviceDefinitions, readConfig, server } = require('./server');

let credentials = {};

async function api(path, options) {
  const headers = { ...(options && options.headers), ...(credentials.cookie ? { cookie: credentials.cookie, 'x-csrf-token': credentials.csrfToken } : {}) };
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { ...options, headers });
  return { status: response.status, body: await response.json() };
}

async function login() {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  credentials = { cookie: response.headers.get('set-cookie').split(';')[0], csrfToken: body.csrfToken };
}

test('exposes the two official communication services', () => {
  assert.deepEqual(Object.keys(serviceDefinitions), ['hbbs', 'hbbr']);
  assert.equal(serviceDefinitions.hbbs.consolePort, 21115);
  assert.equal(serviceDefinitions.hbbr.consolePort, 21117);
});

test('keeps the client-facing relay defaults aligned with official ports', () => {
  const config = readConfig();
  assert.equal(config.ports.hbbs, 21116);
  assert.equal(config.ports.hbbr, 21117);
  assert.equal(config.relayAddress, '127.0.0.1:21117');
  assert.equal(config.sourceRepositories.length, 3);
});

test('registers devices, records heartbeats, and generates client configuration', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await login();

  const created = await api('/api/admin/devices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rustdeskId: '123456789', name: '测试工作站', platform: 'Linux' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.online, false);

  const heartbeat = await api(`/api/devices/${created.body.id}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostname: 'test-host' }),
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.body.online, true);
  assert.equal(heartbeat.body.hostname, 'test-host');

  const config = await api(`/api/devices/${created.body.id}/config`);
  assert.equal(config.status, 200);
  assert.equal(config.body.deviceId, '123456789');
  assert.match(config.body.ini, /id-server=127\.0\.0\.1:21116/);
});

test('protects management APIs with an authenticated CSRF session', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  credentials = {};
  const anonymous = await api('/api/admin/devices');
  assert.equal(anonymous.status, 401);
  await login();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: credentials.cookie },
    body: JSON.stringify({ rustdeskId: 'csrf-device', name: 'CSRF 测试设备' }),
  });
  assert.equal(response.status, 403);
});

test('rejects incorrect administrator credentials', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: 'incorrect-password' }),
  });
  assert.equal(response.status, 401);
});

test('exposes authenticated health and Prometheus metrics safely', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await login();
  const health = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  const metrics = await fetch(`http://127.0.0.1:${server.address().port}/metrics`, { headers: { cookie: credentials.cookie } });
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /rustdesk_control_plane_active_sessions/);
});

test('exposes fail-closed policy decisions for the patched servers', async () => {
  const previousToken = process.env.CONTROL_PLANE_TOKEN;
  process.env.CONTROL_PLANE_TOKEN = 'test-policy-token';
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await login();
    const created = await api('/api/admin/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rustdeskId: 'policy-device', name: '策略设备' }),
    });
    const denied = await api('/api/policy/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-policy-token' },
      body: JSON.stringify({ targetId: created.body.rustdeskId, action: 'connect', sourceIp: '127.0.0.1' }),
    });
    assert.equal(denied.body.allowed, true);
    await api(`/api/admin/devices/${created.body.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    const allowed = await api('/api/policy/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-policy-token' },
      body: JSON.stringify({ targetId: created.body.rustdeskId, action: 'connect', sourceIp: '127.0.0.1' }),
    });
    assert.equal(allowed.body.allowed, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousToken === undefined) delete process.env.CONTROL_PLANE_TOKEN;
    else process.env.CONTROL_PLANE_TOKEN = previousToken;
  }
});

test('holds unknown devices pending until an administrator approves them', async (t) => {
  const previousToken = process.env.CONTROL_PLANE_TOKEN;
  process.env.CONTROL_PLANE_TOKEN = 'test-policy-token';
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  try {
    await login();
    const register = await api('/api/policy/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-policy-token' },
      body: JSON.stringify({ targetId: 'unknown-device', action: 'register', sourceIp: '127.0.0.1' }),
    });
    assert.equal(register.body.allowed, true);
    assert.equal(register.body.status, 'pending');
    const connect = await api('/api/policy/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-policy-token' },
      body: JSON.stringify({ targetId: 'unknown-device', action: 'connect', sourceIp: '127.0.0.1' }),
    });
    assert.equal(connect.body.allowed, false);
    const devices = await api('/api/admin/devices');
    const device = devices.body.items.find((item) => item.rustdeskId === 'unknown-device');
    assert.equal(device.status, 'pending');
    const approval = await api(`/api/admin/devices/${device.id}/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    assert.equal(approval.body.status, 'approved');
    const approved = await api('/api/policy/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-policy-token' },
      body: JSON.stringify({ targetId: 'unknown-device', action: 'connect', sourceIp: '127.0.0.1' }),
    });
    assert.equal(approved.body.allowed, true);
  } finally {
    if (previousToken === undefined) delete process.env.CONTROL_PLANE_TOKEN;
    else process.env.CONTROL_PLANE_TOKEN = previousToken;
  }
});

test('denies approved devices when their owner or department is disabled', async (t) => {
  const previousToken = process.env.CONTROL_PLANE_TOKEN;
  process.env.CONTROL_PLANE_TOKEN = 'test-policy-token';
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  try {
    await login();
    const department = await api('/api/admin/departments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '策略部门' }) });
    const owner = await api('/api/admin/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'device-owner', displayName: '设备负责人', departmentId: department.body.id }) });
    const device = await api('/api/admin/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rustdeskId: 'owned-device', name: '负责人设备', ownerId: owner.body.id }) });
    const check = (action = 'connect') => api('/api/policy/check', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-policy-token' }, body: JSON.stringify({ targetId: 'owned-device', action, sourceIp: '127.0.0.1' }) });
    assert.equal((await check()).body.allowed, true);
    await api(`/api/admin/users/${owner.body.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disabled: true }) });
    const ownerDenied = await check();
    assert.deepEqual({ allowed: ownerDenied.body.allowed, reason: ownerDenied.body.reason }, { allowed: false, reason: 'owner_disabled' });
    await api(`/api/admin/users/${owner.body.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disabled: false }) });
    await api(`/api/admin/departments/${department.body.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disabled: true }) });
    const departmentDenied = await check('relay');
    assert.deepEqual({ allowed: departmentDenied.body.allowed, reason: departmentDenied.body.reason }, { allowed: false, reason: 'department_disabled' });
    assert.equal(departmentDenied.body.policyVersion, 'device-owner-department-v1');
    assert.equal(device.status, 201);
  } finally {
    if (previousToken === undefined) delete process.env.CONTROL_PLANE_TOKEN;
    else process.env.CONTROL_PLANE_TOKEN = previousToken;
  }
});

test('persists idempotent communication events and relay session lifecycles', async (t) => {
  const previousToken = process.env.CONTROL_PLANE_TOKEN;
  process.env.CONTROL_PLANE_TOKEN = 'test-policy-token';
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  try {
    await login();
    await api('/api/admin/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rustdeskId: 'relay-device', name: 'Relay 设备' }) });
    const event = (eventId, eventType) => api('/api/policy/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-policy-token' },
      body: JSON.stringify({ eventId, eventType, targetId: 'relay-device', sessionKey: 'relay-uuid', sourceIp: '127.0.0.1', details: { relayAddress: 'relay.example:21117' } }),
    });
    assert.equal((await event('relay-uuid:relay_start', 'relay_start')).body.duplicate, false);
    assert.equal((await event('relay-uuid:relay_start', 'relay_start')).body.duplicate, true);
    const active = await api('/api/admin/sessions');
    assert.equal(active.body.items.filter((item) => item.sessionKey === 'relay-uuid').length, 1);
    assert.equal(active.body.items.find((item) => item.sessionKey === 'relay-uuid').status, 'active');
    assert.equal((await event('relay-uuid:relay_end', 'relay_end')).body.duplicate, false);
    const ended = await api('/api/admin/sessions');
    assert.equal(ended.body.items.find((item) => item.sessionKey === 'relay-uuid').status, 'ended');
    const events = await api('/api/admin/events');
    assert.equal(events.body.items.filter((item) => item.sessionKey === 'relay-uuid').length, 2);
  } finally {
    if (previousToken === undefined) delete process.env.CONTROL_PLANE_TOKEN;
    else process.env.CONTROL_PLANE_TOKEN = previousToken;
  }
});

test('simulates target policy rules without bypassing device controls', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await login();
  const device = await api('/api/admin/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rustdeskId: 'tagged-device', name: '标签设备', tags: ['finance'] }) });
  const rule = await api('/api/admin/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '财务设备强制中继', action: 'connect', effect: 'force_relay', tag: 'finance', priority: 10 }) });
  assert.equal(rule.status, 201);
  const simulation = await api('/api/admin/policy/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: 'tagged-device', action: 'connect' }) });
  assert.deepEqual({ allowed: simulation.body.allowed, forceRelay: simulation.body.forceRelay, ruleId: simulation.body.ruleId }, { allowed: true, forceRelay: true, ruleId: rule.body.id });
  await api(`/api/admin/devices/${device.body.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disabled: true }) });
  const disabled = await api('/api/admin/policy/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: 'tagged-device', action: 'connect' }) });
  assert.equal(disabled.body.reason, 'device_disabled');
});

test('prioritizes deny rules and exposes force Relay policy checks', async (t) => {
  const previousToken = process.env.CONTROL_PLANE_TOKEN;
  process.env.CONTROL_PLANE_TOKEN = 'test-policy-token';
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  try {
    await login();
    const group = await api('/api/admin/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '受限分组' }) });
    await api('/api/admin/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rustdeskId: 'grouped-device', name: '分组设备', groupId: group.body.id }) });
    await api('/api/admin/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '分组拒绝', action: 'relay', effect: 'deny', groupId: group.body.id, priority: 1 }) });
    await api('/api/admin/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '分组允许', action: 'relay', effect: 'allow', groupId: group.body.id, priority: 10 }) });
    const denied = await api('/api/policy/check', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-policy-token' }, body: JSON.stringify({ targetId: 'grouped-device', action: 'relay', sourceIp: '127.0.0.1' }) });
    assert.deepEqual({ allowed: denied.body.allowed, reason: denied.body.reason }, { allowed: false, reason: 'policy_denied' });
    const force = await api('/api/admin/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '强制中继', action: 'connect', effect: 'force_relay', deviceId: (await api('/api/admin/devices')).body.items.find((item) => item.rustdeskId === 'grouped-device').id, priority: 1 }) });
    const forced = await api('/api/policy/check', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-policy-token' }, body: JSON.stringify({ targetId: 'grouped-device', action: 'connect', sourceIp: '127.0.0.1' }) });
    assert.equal(force.status, 201);
    assert.equal(forced.body.forceRelay, true);
  } finally {
    if (previousToken === undefined) delete process.env.CONTROL_PLANE_TOKEN;
    else process.env.CONTROL_PLANE_TOKEN = previousToken;
  }
});

test('persists sessions, supports rule rollback, retention, and metrics tokens', async (t) => {
  const previousMetricsToken = process.env.METRICS_TOKEN;
  const previousLoginRateLimit = process.env.ADMIN_LOGIN_RATE_LIMIT;
  process.env.METRICS_TOKEN = 'metrics-test-token';
  process.env.ADMIN_LOGIN_RATE_LIMIT = '100';
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  try {
    await login();
    const rule = await api('/api/admin/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '可回滚规则', action: 'connect', effect: 'allow', priority: 10 }) });
    await api(`/api/admin/rules/${rule.body.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ effect: 'deny' }) });
    const versions = await api(`/api/admin/rules/${rule.body.id}/versions`);
    assert.equal(versions.body.items.length, 2);
    const restored = await api(`/api/admin/rules/${rule.body.id}/versions/1/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(restored.body.effect, 'allow');
    const metrics = await fetch(`http://127.0.0.1:${server.address().port}/metrics`, { headers: { authorization: 'Bearer metrics-test-token' } });
    assert.equal(metrics.status, 200);
  } finally {
    if (previousMetricsToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = previousMetricsToken;
    if (previousLoginRateLimit === undefined) delete process.env.ADMIN_LOGIN_RATE_LIMIT;
    else process.env.ADMIN_LOGIN_RATE_LIMIT = previousLoginRateLimit;
  }
});

test('accepts a rolling policy token and exports audited cleanup operations', async (t) => {
  const previousToken = process.env.CONTROL_PLANE_TOKEN;
  const previousNextToken = process.env.CONTROL_PLANE_TOKEN_NEXT;
  const previousLoginRateLimit = process.env.ADMIN_LOGIN_RATE_LIMIT;
  process.env.CONTROL_PLANE_TOKEN = 'policy-current';
  process.env.CONTROL_PLANE_TOKEN_NEXT = 'policy-next';
  process.env.ADMIN_LOGIN_RATE_LIMIT = '100';
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  try {
    await login();
    const device = await api('/api/admin/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rustdeskId: 'rolling-device', name: '轮换设备' }) });
    const policy = await fetch(`http://127.0.0.1:${server.address().port}/api/policy/check`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer policy-next' }, body: JSON.stringify({ targetId: device.body.rustdeskId, action: 'connect', sourceIp: '127.0.0.1' }) });
    assert.equal(policy.status, 200);
    const cleanup = await api('/api/admin/retention/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(cleanup.status, 200);
    const exported = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/audit/export`, { headers: { cookie: credentials.cookie } });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type'), /^text\/csv/);
    assert.match(await exported.text(), /retention_cleanup/);
  } finally {
    if (previousToken === undefined) delete process.env.CONTROL_PLANE_TOKEN;
    else process.env.CONTROL_PLANE_TOKEN = previousToken;
    if (previousNextToken === undefined) delete process.env.CONTROL_PLANE_TOKEN_NEXT;
    else process.env.CONTROL_PLANE_TOKEN_NEXT = previousNextToken;
    if (previousLoginRateLimit === undefined) delete process.env.ADMIN_LOGIN_RATE_LIMIT;
    else process.env.ADMIN_LOGIN_RATE_LIMIT = previousLoginRateLimit;
  }
});

test('handles OAuth discovery, login redirection, and callback authentication', async (t) => {
  const mockAuthelia = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/oidc/token') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'auth-test-token', id_token: 'mock.id.token' }));
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/oidc/userinfo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        sub: 'authelia-sub-001',
        preferred_username: 'authelia_sso_user',
        name: 'Authelia SSO User',
        email: 'sso@example.com',
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => mockAuthelia.listen(0, '127.0.0.1', resolve));
  t.after(() => mockAuthelia.close());
  const autheliaPort = mockAuthelia.address().port;

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const configBefore = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/config`);
  assert.equal(configBefore.status, 200);
  const cfgJson = await configBefore.json();
  assert.equal(cfgJson.oauth.enabled, false);

  const disabledLogin = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/oauth/login`, { redirect: 'manual' });
  assert.equal(disabledLogin.status, 404);

  process.env.OAUTH_ENABLED = 'Y';
  process.env.OAUTH_CLIENT_ID = 'test-client';
  process.env.OAUTH_CLIENT_SECRET = 'test-secret';
  process.env.OAUTH_AUTH_URL = `http://127.0.0.1:${autheliaPort}/api/oidc/authorization`;
  process.env.OAUTH_TOKEN_URL = `http://127.0.0.1:${autheliaPort}/api/oidc/token`;
  process.env.OAUTH_USERINFO_URL = `http://127.0.0.1:${autheliaPort}/api/oidc/userinfo`;

  try {
    const configAfter = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/config`);
    const cfgAfterJson = await configAfter.json();
    assert.equal(cfgAfterJson.oauth.enabled, true);
    assert.equal(cfgAfterJson.oauth.providerName, 'Authelia');

    const loginRes = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/oauth/login`, { redirect: 'manual' });
    assert.equal(loginRes.status, 302);
    const location = loginRes.headers.get('location');
    assert.ok(location.startsWith(`http://127.0.0.1:${autheliaPort}/api/oidc/authorization?`));
    const stateCookieHeader = loginRes.headers.get('set-cookie');
    assert.match(stateCookieHeader, /rd_oauth_state=/);

    const parsedLoc = new URL(location);
    const state = parsedLoc.searchParams.get('state');
    assert.ok(state);

    const badStateRes = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/oauth/callback?code=mock-code&state=wrong-state`, {
      redirect: 'manual',
      headers: { cookie: stateCookieHeader.split(';')[0] },
    });
    assert.equal(badStateRes.status, 302);
    assert.match(badStateRes.headers.get('location'), /\/\?oauth_error=invalid_state/);

    const successRes = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/oauth/callback?code=mock-code&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: stateCookieHeader.split(';')[0] },
    });
    assert.equal(successRes.status, 302);
    assert.equal(successRes.headers.get('location'), '/');

    const cookies = successRes.headers.get('set-cookie');
    assert.match(cookies, /rd_admin_session=/);
    const sessionCookiePart = cookies.split(',').find((c) => c.includes('rd_admin_session=')).trim().split(';')[0];

    const meRes = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/me`, {
      headers: { cookie: sessionCookiePart },
    });
    assert.equal(meRes.status, 200);
    const meJson = await meRes.json();
    assert.equal(meJson.user.username, 'authelia_sso_user');
    assert.equal(meJson.user.displayName, 'Authelia SSO User');
  } finally {
    delete process.env.OAUTH_ENABLED;
    delete process.env.OAUTH_CLIENT_ID;
    delete process.env.OAUTH_CLIENT_SECRET;
    delete process.env.OAUTH_AUTH_URL;
    delete process.env.OAUTH_TOKEN_URL;
    delete process.env.OAUTH_USERINFO_URL;
  }
});

