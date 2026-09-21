const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createStore } = require('./store');
const { AuthService, sessionCookie, expiredCookie } = require('./auth');
const { OAuthService } = require('./oauth');
const { FixedWindowLimiter, Metrics, redact, remoteAddress } = require('./observability');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_ROOT = __dirname;
const SERVER_ROOT = path.resolve(process.env.RUSTDESK_SERVER_DIR || path.join(ROOT, 'vendor/rustdesk-server'));
const RUNTIME_ROOT = path.resolve(process.env.RUSTDESK_RUNTIME_DIR || path.join(ROOT, 'data'));
const PORT = numberFromEnv('ADMIN_PORT', 3000);
const HOST = process.env.ADMIN_HOST || '127.0.0.1';
const HBBS_PORT = numberFromEnv('HBBS_PORT', 21116);
const HBBR_PORT = numberFromEnv('HBBR_PORT', 21117);
const RELAY_ADDRESS = process.env.RELAY_ADDRESS || `127.0.0.1:${HBBR_PORT}`;
const ID_SERVER_ADDRESS = process.env.ID_SERVER_ADDRESS || `127.0.0.1:${HBBS_PORT}`;

const serviceDefinitions = {
  hbbs: {
    label: 'ID / Rendezvous',
    binaryEnv: 'HBBS_BIN',
    candidates: [
      path.join(SERVER_ROOT, 'target/release/hbbs'),
      path.join(SERVER_ROOT, 'target/debug/hbbs'),
    ],
    args: ['-p', String(HBBS_PORT), '-r', RELAY_ADDRESS],
    consolePort: HBBS_PORT - 1,
  },
  hbbr: {
    label: 'Relay',
    binaryEnv: 'HBBR_BIN',
    candidates: [
      path.join(SERVER_ROOT, 'target/release/hbbr'),
      path.join(SERVER_ROOT, 'target/debug/hbbr'),
    ],
    args: ['-p', String(HBBR_PORT)],
    consolePort: HBBR_PORT,
  },
};

const processes = new Map();
const logs = new Map();
const store = createStore();
const auth = new AuthService(store);
const oauth = new OAuthService();
const metrics = new Metrics();
const limiter = new FixedWindowLimiter();
let retentionTimer;

function numberFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function validateSecurityConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  if (!isLoopbackHost(HOST) && process.env.ADMIN_COOKIE_SECURE !== 'Y') throw new Error('非 loopback 管理后台必须设置 ADMIN_COOKIE_SECURE=Y 并使用 HTTPS 反向代理');
  if (process.env.CONTROL_PLANE_URL && !controlPlaneToken()) throw new Error('设置 CONTROL_PLANE_URL 时必须设置 CONTROL_PLANE_TOKEN');
  if (process.env.ADMIN_PROXY_AUTH_TRUST === 'Y' && process.env.ADMIN_TRUST_PROXY !== 'Y') throw new Error('启用代理身份认证时必须设置 ADMIN_TRUST_PROXY=Y，并确保仅可信代理可访问后台');
}

function tokenMatches(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && require('node:crypto').timingSafeEqual(left, right);
}

async function runRetentionCleanup() {
  const result = await store.cleanupRetention({ auditDays: numberFromEnv('AUDIT_RETENTION_DAYS', 365), eventDays: numberFromEnv('EVENT_RETENTION_DAYS', 90), sessionDays: numberFromEnv('SESSION_RETENTION_DAYS', 180) });
  metrics.increment('rustdesk_control_plane_retention_runs_total');
  if (Object.values(result).some(Boolean)) console.log(`保留清理: ${JSON.stringify(result)}`);
  return result;
}

function ensureRuntime() {
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
}

function resolveBinary(name) {
  const definition = serviceDefinitions[name];
  const configured = process.env[definition.binaryEnv];
  const candidates = configured ? [configured, ...definition.candidates] : definition.candidates;
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  return found ? path.resolve(found) : null;
}

function serviceState(name) {
  const definition = serviceDefinitions[name];
  const child = processes.get(name);
  const binary = resolveBinary(name);
  return {
    name,
    label: definition.label,
    running: Boolean(child && child.exitCode === null),
    pid: child && child.exitCode === null ? child.pid : null,
    binary,
    binaryAvailable: Boolean(binary),
    port: name === 'hbbs' ? HBBS_PORT : HBBR_PORT,
    consolePort: definition.consolePort,
    log: logs.get(name) || [],
  };
}

function appendLog(name, stream, chunk) {
  const lines = (logs.get(name) || []).concat(
    chunk.toString().split(/\r?\n/).filter(Boolean).map((line) => ({
      stream,
      text: redact(line),
      at: new Date().toISOString(),
    })),
  );
  logs.set(name, lines.slice(-120));
}

function startService(name) {
  const definition = serviceDefinitions[name];
  const current = processes.get(name);
  if (current && current.exitCode === null) {
    return { ok: true, message: `${name} 已在运行`, state: serviceState(name) };
  }

  const binary = resolveBinary(name);
  if (!binary) {
    const error = `${name} 二进制不存在。请先运行 npm run build:server，或设置 ${definition.binaryEnv}。`;
    return { ok: false, status: 503, error };
  }

  ensureRuntime();
  const child = spawn(binary, definition.args, {
    cwd: RUNTIME_ROOT,
    env: {
      ...process.env,
      DB_URL: process.env.DB_URL || path.join(RUNTIME_ROOT, 'db_v2.sqlite3'),
      RUST_LOG: process.env.RUST_LOG || 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processes.set(name, child);
  logs.set(name, []);
  child.stdout.on('data', (chunk) => appendLog(name, 'stdout', chunk));
  child.stderr.on('data', (chunk) => appendLog(name, 'stderr', chunk));
  child.on('error', (error) => appendLog(name, 'system', `进程启动失败: ${error.message}`));
  child.on('exit', (code, signal) => {
    appendLog(name, 'system', `进程已退出 code=${code ?? '-'} signal=${signal ?? '-'}`);
  });
  return { ok: true, message: `${name} 启动请求已发送`, state: serviceState(name) };
}

async function stopService(name) {
  const child = processes.get(name);
  if (!child || child.exitCode !== null) {
    return { ok: true, message: `${name} 未运行`, state: serviceState(name) };
  }
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return { ok: true, message: `${name} 停止请求已发送`, state: serviceState(name) };
}

async function restartService(name) {
  await stopService(name);
  return startService(name);
}

function readConfig() {
  const dbPath = process.env.DB_URL || path.join(RUNTIME_ROOT, 'db_v2.sqlite3');
  let database = { path: dbPath, exists: false, size: 0 };
  try {
    const stat = fs.statSync(dbPath);
    database = { path: dbPath, exists: true, size: stat.size, modifiedAt: stat.mtime.toISOString() };
  } catch {}
  return {
    serverRoot: SERVER_ROOT,
    runtimeRoot: RUNTIME_ROOT,
    ports: { hbbs: HBBS_PORT, hbbr: HBBR_PORT, hbbsConsole: HBBS_PORT - 1, hbbrConsole: HBBR_PORT },
    relayAddress: RELAY_ADDRESS,
    idServerAddress: ID_SERVER_ADDRESS,
    publicKey: readPublicKey(),
    database,
    sourceRepositories: [
      { name: 'rustdesk-server', path: path.join(ROOT, 'vendor/rustdesk-server'), role: '官方 hbbs / hbbr / rustdesk-utils' },
      { name: 'rustdesk-server-demo', path: path.join(ROOT, 'vendor/rustdesk-server-demo'), role: '极简服务端示例' },
      { name: 'rustdesk', path: path.join(ROOT, 'vendor/rustdesk'), role: '客户端、通信协议、网络连接实现' },
    ],
  };
}

function readPublicKey() {
  const configured = process.env.RUSTDESK_PUBLIC_KEY || process.env.KEY_PUBLIC;
  if (configured) return configured.trim();
  const keyPath = path.join(RUNTIME_ROOT, 'id_ed25519.pub');
  try { return fs.readFileSync(keyPath, 'utf8').trim(); } catch { return ''; }
}

const resourceTypes = {
  departments: 'departments',
  roles: 'roles',
  users: 'users',
  groups: 'groups',
  relays: 'relays',
  devices: 'devices',
  sessions: 'sessions',
  events: 'events',
  rules: 'rules',
  audit: 'audit',
};

function controlPlaneToken() {
  return process.env.CONTROL_PLANE_TOKEN || '';
}

function controlPlaneTokens() {
  return [process.env.CONTROL_PLANE_TOKEN, process.env.CONTROL_PLANE_TOKEN_NEXT].filter(Boolean);
}

function unknownDevicePolicy() {
  const value = (process.env.UNKNOWN_DEVICE_POLICY || 'pending').toLowerCase();
  return ['deny', 'pending', 'allow'].includes(value) ? value : 'pending';
}

function isApproved(device) {
  return Boolean(device && device.status === 'approved' && !device.disabled);
}

const requiredFields = {
  departments: ['name'],
  roles: ['name'],
  users: ['username', 'displayName'],
  groups: ['name'],
  relays: ['name', 'address'],
  devices: ['rustdeskId', 'name'],
  sessions: ['peerRustdeskId'],
  rules: ['name', 'action', 'effect'],
};

const POLICY_VERSION = 'device-owner-department-v1';

function policyDecision(target, action, rules) {
  if (!target) return { allowed: false, reason: 'device_unknown' };
  if (target.device.status !== 'approved' || target.device.disabled) return { allowed: false, reason: `device_${target.device.status}` };
  if (target.ownerDisabled) return { allowed: false, reason: 'owner_disabled' };
  if (target.departmentDisabled) return { allowed: false, reason: 'department_disabled' };
  const rule = rules.find((candidate) => candidate.action === action && (
    candidate.deviceId === target.device.id ||
    (candidate.groupId && candidate.groupId === target.device.groupId) ||
    (candidate.tag && Array.isArray(target.device.tags) && target.device.tags.includes(candidate.tag))
  ));
  if (!rule) return { allowed: true, reason: 'approved' };
  if (rule.effect === 'deny') return { allowed: false, reason: 'policy_denied', ruleId: rule.id, ruleName: rule.name };
  return { allowed: true, reason: rule.effect === 'force_relay' ? 'policy_force_relay' : 'policy_allowed', forceRelay: rule.effect === 'force_relay', ruleId: rule.id, ruleName: rule.name };
}

async function policyResponse(res, body, targetId, action) {
  const startedAt = performance.now();
  const [target, rules] = await Promise.all([store.getPolicyTarget(targetId), store.listPolicyRules()]);
  const decision = policyDecision(target, action, rules);
  metrics.observePolicy(performance.now() - startedAt);
  metrics.increment('rustdesk_control_plane_policy_checks_total', { action, result: decision.allowed ? 'allowed' : 'denied', reason: decision.reason });
  if (!decision.allowed) {
    await store.audit({ actor: 'hbbs', action: 'policy_denied', resourceType: 'device', resourceId: target ? target.device.id : null, details: { targetId, action, reason: decision.reason, policyVersion: POLICY_VERSION, sourceIp: body.sourceIp || body.source_ip } });
  }
  return json(res, 200, { ...decision, status: target ? target.device.status : 'unknown', policyVersion: POLICY_VERSION });
}

async function clientConfig(device) {
  const assignedRelay = device.relayId ? await store.get('relays', device.relayId) : null;
  const relay = assignedRelay ? assignedRelay.address : RELAY_ADDRESS;
  return {
    deviceId: device.rustdeskId,
    idServer: ID_SERVER_ADDRESS,
    relayServer: relay,
    publicKey: readPublicKey(),
    editable: isApproved(device),
    ini: [
      `id-server=${ID_SERVER_ADDRESS}`,
      relay ? `relay-server=${relay}` : '',
      readPublicKey() ? `key=${readPublicKey()}` : '',
    ].filter(Boolean).join('\n'),
  };
}

async function managementApi(req, res, url) {
  await store.ready;
  if (url.pathname === '/api/policy/check' && req.method === 'POST') {
    const token = req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '') : '';
    if (!controlPlaneTokens().some((candidate) => tokenMatches(token, candidate))) return json(res, 401, { error: '策略接口认证失败' });
    const body = await parseBody(req);
    const targetId = body.targetId || body.target_id;
    let device = await store.getByRustdeskId(targetId);
    if (body.action === 'register') {
      if (!device) {
        const policy = unknownDevicePolicy();
        if (policy === 'deny') {
          await store.audit({ actor: 'hbbs', action: 'policy_denied', resourceType: 'device', resourceId: null, details: { targetId, action: 'register', reason: 'unknown_device_denied', policyVersion: POLICY_VERSION, sourceIp: body.sourceIp || body.source_ip } });
          return json(res, 200, { allowed: false, status: 'unknown', reason: 'unknown_device_denied', policyVersion: POLICY_VERSION });
        }
        device = policy === 'allow' ? await store.create('devices', { rustdeskId: targetId, name: targetId, status: 'approved' }) : await store.ensurePendingDevice(targetId);
        await store.audit({ actor: 'hbbs', action: 'device_discovered', resourceType: 'device', resourceId: device.id, details: { sourceIp: body.sourceIp || body.source_ip, policy } });
        return json(res, 200, { allowed: true, status: device.status, reason: policy === 'allow' ? 'registration_allowed' : 'registration_pending', policyVersion: POLICY_VERSION });
      }
      const allowed = device.status === 'approved' || device.status === 'pending';
      if (!allowed) await store.audit({ actor: 'hbbs', action: 'policy_denied', resourceType: 'device', resourceId: device.id, details: { targetId, action: 'register', reason: `device_${device.status}`, policyVersion: POLICY_VERSION, sourceIp: body.sourceIp || body.source_ip } });
      return json(res, 200, { allowed, status: device.status, reason: allowed ? 'registration_allowed' : `device_${device.status}`, policyVersion: POLICY_VERSION });
    }
    return policyResponse(res, body, targetId, body.action || 'connect');
  }
  if (url.pathname === '/api/policy/events' && req.method === 'POST') {
    const token = req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '') : '';
    if (!controlPlaneTokens().some((candidate) => tokenMatches(token, candidate))) return json(res, 401, { error: '策略接口认证失败' });
    const body = await parseBody(req);
    const targetId = body.targetId || body.target_id;
    const eventId = body.eventId || body.event_id;
    const eventType = body.eventType || body.event_type;
    const sessionKey = body.sessionKey || body.session_key;
    if (!eventId || !eventType || !targetId) return json(res, 400, { error: '事件必须包含 eventId、eventType 和 targetId' });
    const device = await store.getByRustdeskId(targetId);
    if (device) await store.heartbeat(device.id);
    else if (eventType === 'device_register') await store.ensurePendingDevice(targetId);
    const trackedDevice = device || await store.getByRustdeskId(targetId);
    const details = body.details && typeof body.details === 'object' && !Array.isArray(body.details) ? body.details : { message: String(body.details || '') };
    const event = { eventId, eventType, targetRustdeskId: targetId, deviceId: trackedDevice ? trackedDevice.id : null, sessionKey, sourceIp: body.sourceIp || body.source_ip, details };
    const recorded = await store.recordCommunicationEvent(event);
    if (!recorded.duplicate) await store.projectRelaySession(event);
    metrics.increment('rustdesk_control_plane_events_total', { event_type: eventType, result: recorded.duplicate ? 'duplicate' : 'persisted' });
    await store.audit({ actor: 'hbbs', action: eventType, resourceType: 'device', resourceId: event.deviceId, details: { eventId, sessionKey, sourceIp: event.sourceIp, duplicate: recorded.duplicate } });
    return json(res, 202, { accepted: true, duplicate: recorded.duplicate });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/summary') return json(res, 200, await store.summary());

  if (req.method === 'POST' && url.pathname === '/api/admin/policy/simulate') {
    const body = await parseBody(req);
    const action = body.action || 'connect';
    if (!['register', 'connect', 'relay', 'force_relay'].includes(action)) return json(res, 400, { error: '无效的策略动作' });
    const [target, rules] = await Promise.all([store.getPolicyTarget(body.targetId), store.listPolicyRules()]);
    return json(res, 200, { ...policyDecision(target, action, rules), status: target ? target.device.status : 'unknown', policyVersion: POLICY_VERSION });
  }

  const versionMatch = url.pathname.match(/^\/api\/admin\/rules\/([^/]+)\/versions(?:\/(\d+)\/restore)?$/);
  if (versionMatch && req.method === 'GET') return json(res, 200, { items: await store.listRuleVersions(versionMatch[1]) });
  if (versionMatch && req.method === 'POST' && versionMatch[2]) {
    const versions = await store.listRuleVersions(versionMatch[1]);
    const selected = versions.find((version) => version.version === Number(versionMatch[2]));
    if (!selected) return json(res, 404, { error: '规则版本不存在' });
    const actor = (await auth.session(req)).user.username;
    const rule = await store.update('rules', versionMatch[1], selected.snapshot);
    if (!rule) return json(res, 404, { error: '规则不存在' });
    await store.saveRuleVersion(rule, actor);
    await store.audit({ actor, action: 'policy_rule_restored', resourceType: 'rule', resourceId: rule.id, details: { restoredVersion: selected.version } });
    return json(res, 200, rule);
  }

  const terminateMatch = url.pathname.match(/^\/api\/admin\/sessions\/([^/]+)\/terminate$/);
  if (req.method === 'POST' && terminateMatch) {
    const session = await store.get('sessions', terminateMatch[1]);
    if (!session) return json(res, 404, { error: '会话不存在' });
    if (session.transport !== 'relay' || session.status !== 'active' || !session.sessionKey) return json(res, 409, { error: '只有活跃 Relay 会话可强制断开' });
    try {
      const output = await sendConsole('hbbr', `disconnect ${session.sessionKey}`);
      await store.audit({ actor: (await auth.session(req)).user.username, action: 'relay_terminate_requested', resourceType: 'session', resourceId: session.id, details: { sessionKey: session.sessionKey, output } });
      return json(res, 202, { accepted: true, output });
    } catch (error) {
      return json(res, 502, { error: `中继控制台不可用: ${error.message}` });
    }
  }

  const configMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/config$/);
  if (req.method === 'GET' && configMatch) {
    const device = await store.get('devices', configMatch[1]);
    return device ? json(res, 200, await clientConfig(device)) : json(res, 404, { error: '设备不存在' });
  }

  const heartbeatMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/heartbeat$/);
  if (req.method === 'POST' && heartbeatMatch) {
    const body = await parseBody(req);
    const device = await store.heartbeat(heartbeatMatch[1], { hostname: body.hostname, platform: body.platform, metadata: body.metadata });
    if (!device) return json(res, 404, { error: '设备不存在' });
    await store.audit({ actor: 'device', action: 'heartbeat', resourceType: 'device', resourceId: device.id, details: { rustdeskId: device.rustdeskId } });
    return json(res, 200, device);
  }

  const collectionMatch = url.pathname.match(/^\/api\/admin\/(departments|roles|users|groups|relays|devices|sessions|events|rules|audit)$/);
  if (collectionMatch) {
    const type = resourceTypes[collectionMatch[1]];
    if (req.method === 'GET') {
      let items = await store.list(type);
      if (url.searchParams.has('deviceId')) items = items.filter((item) => item.deviceId === url.searchParams.get('deviceId'));
      if (url.searchParams.has('sessionKey')) items = items.filter((item) => item.sessionKey === url.searchParams.get('sessionKey'));
      if (url.searchParams.has('eventType')) items = items.filter((item) => item.eventType === url.searchParams.get('eventType'));
      if (url.searchParams.has('status')) items = items.filter((item) => item.status === url.searchParams.get('status'));
      const limit = Math.min(numberFromEnv('ADMIN_QUERY_LIMIT', 200), Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100);
      return json(res, 200, { items: items.slice(0, limit) });
    }
    if (req.method === 'POST' && type !== 'audit') {
      const body = await parseBody(req);
      const missing = (requiredFields[type] || []).filter((field) => typeof body[field] !== 'string' || !body[field].trim());
      if (missing.length) return json(res, 400, { error: `缺少字段: ${missing.join(', ')}` });
      if (type === 'devices' && body.status && !['pending', 'approved', 'rejected', 'disabled'].includes(body.status)) return json(res, 400, { error: '无效的设备状态' });
      if (type === 'rules' && (!['register', 'connect', 'relay', 'force_relay'].includes(body.action) || !['allow', 'deny', 'force_relay'].includes(body.effect))) return json(res, 400, { error: '无效的策略规则' });
      try {
        const value = await store.create(type, body);
        const actor = (await auth.session(req)).user.username;
        if (type === 'rules') await store.saveRuleVersion(value, actor);
        await store.audit({ actor, action: 'create', resourceType: type, resourceId: value.id, details: { name: value.name || value.rustdeskId || value.username } });
        return json(res, 201, value);
      } catch (error) {
        return json(res, 409, { error: error.code === '23505' ? '资源已存在' : error.message });
      }
    }
  }

  const resourceMatch = url.pathname.match(/^\/api\/admin\/(departments|users|groups|relays|devices|rules)\/([^/]+)$/);
  if (req.method === 'PATCH' && resourceMatch) {
    const type = resourceTypes[resourceMatch[1]];
    const body = await parseBody(req);
    if (type === 'devices' && Object.hasOwn(body, 'disabled') && !Object.hasOwn(body, 'status')) body.status = body.disabled ? 'disabled' : 'approved';
    const value = await store.update(type, resourceMatch[2], body);
    if (!value) return json(res, 404, { error: '资源不存在' });
    const actor = (await auth.session(req)).user.username;
    if (type === 'rules') await store.saveRuleVersion(value, actor);
    await store.audit({ actor, action: 'update', resourceType: type, resourceId: value.id, details: body });
    return json(res, 200, value);
  }

  const approvalMatch = url.pathname.match(/^\/api\/admin\/devices\/([^/]+)\/approval$/);
  if (req.method === 'POST' && approvalMatch) {
    const body = await parseBody(req);
    if (!['approved', 'rejected', 'disabled'].includes(body.status)) return json(res, 400, { error: '无效的审批状态' });
    const value = await store.update('devices', approvalMatch[1], { status: body.status });
    if (!value) return json(res, 404, { error: '设备不存在' });
    await store.audit({ actor: (await auth.session(req)).user.username, action: `device_${body.status}`, resourceType: 'device', resourceId: value.id, details: { rustdeskId: value.rustdeskId } });
    return json(res, 200, value);
  }

  return null;
}

function sendConsole(name, command) {
  return new Promise((resolve, reject) => {
    const port = serviceDefinitions[name].consolePort;
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('连接服务控制台超时'));
    }, 2000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(command));
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('close', () => { clearTimeout(timer); resolve(response.trim()); });
  });
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function text(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function redirect(res, location, cookies = []) {
  const headers = {
    location,
    'cache-control': 'no-store',
  };
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(302, headers);
  res.end();
}

function resolveRedirectUri(req) {
  if (process.env.OAUTH_REDIRECT_URI) return process.env.OAUTH_REDIRECT_URI;
  const proto = req.headers['x-forwarded-proto'] || (secureCookie(req) ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || `${HOST}:${PORT}`;
  return `${proto}://${host}/api/auth/oauth/callback`;
}

function csvValue(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function permissionFor(urlPath) {
  if (urlPath === '/api/admin/retention/run') return 'services.manage';
  if (urlPath.includes('/policy/') || urlPath.includes('/rules')) return 'policies.manage';
  if (urlPath.startsWith('/api/services/') || urlPath === '/api/overview' || urlPath === '/api/config') return 'services.manage';
  if (urlPath.includes('/users') || urlPath.includes('/roles') || urlPath.includes('/departments')) return 'users.manage';
  if (urlPath.includes('/relays')) return 'relays.manage';
  if (urlPath.includes('/sessions') || urlPath.includes('/events') || urlPath.includes('/audit')) return 'audit.read';
  return 'devices.manage';
}

function secureCookie(req) {
  return process.env.ADMIN_COOKIE_SECURE === 'Y' || req.headers['x-forwarded-proto'] === 'https';
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024) req.destroy();
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('请求 JSON 无效')); }
    });
    req.on('error', reject);
  });
}

function safeFilePath(urlPath) {
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  const publicRoot = path.resolve(path.join(ADMIN_ROOT, 'public'));
  const filePath = path.resolve(path.join(publicRoot, requested));
  return filePath === publicRoot || filePath.startsWith(`${publicRoot}${path.sep}`) ? filePath : null;
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/healthz') {
    try {
      await Promise.all([store.ready, auth.ready]);
      return json(res, 200, { status: 'ok' });
    } catch (error) {
      return json(res, 503, { status: 'unavailable', error: redact(error.message) });
    }
  }
  if (req.method === 'GET' && url.pathname === '/metrics') {
    const metricsToken = process.env.METRICS_TOKEN || '';
    if (tokenMatches(req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '') : '', metricsToken)) return text(res, 200, metrics.render(await store.summary()));
    const check = await auth.authorize(req, 'services.manage');
    if (check.error) return json(res, check.status, { error: check.error });
    return text(res, 200, metrics.render(await store.summary()));
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const rateLimit = limiter.allow('login', remoteAddress(req), numberFromEnv('ADMIN_LOGIN_RATE_LIMIT', 10), 60_000);
    if (!rateLimit.allowed) {
      metrics.increment('rustdesk_control_plane_rate_limited_total', { scope: 'login' });
      return json(res, 429, { error: '登录请求过于频繁' }, { 'retry-after': rateLimit.retryAfter });
    }
    try {
      const body = await parseBody(req);
      const session = await auth.login(body.username || '', body.password || '');
      if (!session) {
        metrics.increment('rustdesk_control_plane_auth_attempts_total', { result: 'failed' });
        return json(res, 401, { error: '用户名或密码错误' });
      }
      metrics.increment('rustdesk_control_plane_auth_attempts_total', { result: 'succeeded' });
      await store.audit({ actor: session.user.username, action: 'login', resourceType: 'auth', resourceId: session.user.id, details: {} });
      return json(res, 200, { user: session.user, csrfToken: session.csrfToken }, { 'set-cookie': sessionCookie(session.id, secureCookie(req)) });
    } catch (error) {
      return json(res, 503, { error: error.message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const session = await auth.session(req);
    return session ? json(res, 200, { user: session.user, csrfToken: session.csrfToken }) : json(res, 401, { error: '需要登录' });
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/config') {
    return json(res, 200, {
      oauth: oauth.getPublicConfig(),
      proxyAuth: Boolean(process.env.ADMIN_PROXY_AUTH_TRUST === 'Y' && process.env.ADMIN_TRUST_PROXY === 'Y'),
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/oauth/login') {
    if (!oauth.isEnabled()) {
      return json(res, 404, { error: '未启用 OAuth 单点登录' });
    }
    const rateLimit = limiter.allow('oauth_login', remoteAddress(req), numberFromEnv('ADMIN_LOGIN_RATE_LIMIT', 10), 60_000);
    if (!rateLimit.allowed) {
      metrics.increment('rustdesk_control_plane_rate_limited_total', { scope: 'oauth_login' });
      return redirect(res, '/?oauth_error=rate_limited');
    }
    try {
      const redirectUri = resolveRedirectUri(req);
      const { url: authUrl, state, codeVerifier } = await oauth.getAuthorizationUrl(redirectUri);
      const cookie = oauth.packStateCookie(state, codeVerifier, secureCookie(req));
      return redirect(res, authUrl, [cookie]);
    } catch (error) {
      return redirect(res, `/?oauth_error=${encodeURIComponent(error.message)}`);
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/oauth/callback') {
    if (!oauth.isEnabled()) {
      return redirect(res, '/?oauth_error=oauth_disabled');
    }
    const errorParam = url.searchParams.get('error_description') || url.searchParams.get('error');
    if (errorParam) {
      return redirect(res, `/?oauth_error=${encodeURIComponent(errorParam)}`);
    }
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    const cookieData = oauth.unpackStateCookie(req);
    if (!cookieData || !state || cookieData.state !== state) {
      return redirect(res, '/?oauth_error=invalid_state', [oauth.expiredStateCookie(secureCookie(req))]);
    }
    try {
      const redirectUri = resolveRedirectUri(req);
      const profile = await oauth.exchangeCode({
        code,
        state,
        expectedState: cookieData.state,
        codeVerifier: cookieData.codeVerifier,
        redirectUri,
      });

      let user = await store.getUserByUsername(profile.username);
      if (!user) {
        if (!oauth.isAutoCreateUser()) {
          return redirect(res, '/?oauth_error=user_not_found', [oauth.expiredStateCookie(secureCookie(req))]);
        }
        user = await store.create('users', {
          username: profile.username,
          displayName: profile.displayName,
          roleId: oauth.getDefaultRoleId(),
          disabled: false,
        });
        await store.audit({
          actor: profile.username,
          action: 'oauth_user_provisioned',
          resourceType: 'user',
          resourceId: user.id,
          details: { provider: oauth.getProviderName(), email: profile.email },
        });
      }

      if (user.disabled) {
        return redirect(res, '/?oauth_error=user_disabled', [oauth.expiredStateCookie(secureCookie(req))]);
      }

      const role = user.roleId ? await store.get('roles', user.roleId) : null;
      const sessionId = crypto.randomBytes(32).toString('base64url');
      const csrfToken = crypto.randomBytes(24).toString('base64url');
      const session = {
        id: sessionId,
        csrfToken,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          permissions: role ? role.permissions || [] : user.permissions || [],
        },
        expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      };
      await store.saveAdminSession(session);
      await store.audit({
        actor: user.username,
        action: 'oauth_login',
        resourceType: 'auth',
        resourceId: user.id,
        details: { provider: oauth.getProviderName() },
      });

      metrics.increment('rustdesk_control_plane_auth_attempts_total', { result: 'succeeded' });
      return redirect(res, '/', [
        sessionCookie(session.id, secureCookie(req)),
        oauth.expiredStateCookie(secureCookie(req)),
      ]);
    } catch (error) {
      metrics.increment('rustdesk_control_plane_auth_attempts_total', { result: 'failed' });
      return redirect(res, `/?oauth_error=${encodeURIComponent(error.message)}`, [oauth.expiredStateCookie(secureCookie(req))]);
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const check = await auth.authorize(req, 'services.manage', true);
    if (check.error) return json(res, check.status, { error: check.error });
    await auth.logout(req);
    return json(res, 204, {}, { 'set-cookie': expiredCookie(secureCookie(req)) });
  }

  if (url.pathname.startsWith('/api/policy/')) {
    const rateLimit = limiter.allow('policy', remoteAddress(req), numberFromEnv('CONTROL_PLANE_RATE_LIMIT', 600), 60_000);
    if (!rateLimit.allowed) {
      metrics.increment('rustdesk_control_plane_rate_limited_total', { scope: 'policy' });
      return json(res, 429, { error: '策略请求过于频繁' }, { 'retry-after': rateLimit.retryAfter });
    }
    const result = await managementApi(req, res, url);
    return result === null ? json(res, 404, { error: '策略接口不存在' }) : result;
  }

  const write = req.method !== 'GET' && req.method !== 'HEAD';
  const check = await auth.authorize(req, permissionFor(url.pathname), write);
  if (check.error) return json(res, check.status, { error: check.error });
  if (req.method === 'GET' && url.pathname === '/api/overview') {
    return json(res, 200, { services: Object.keys(serviceDefinitions).map(serviceState), config: readConfig() });
  }
  if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, readConfig());

  if (req.method === 'GET' && url.pathname === '/api/admin/audit/export') {
    const items = await store.list('audit');
    const rows = [['created_at', 'actor', 'action', 'resource_type', 'resource_id', 'details'], ...items.map((item) => [item.createdAt, item.actor, item.action, item.resourceType, item.resourceId, JSON.stringify(item.details || {})])];
    return text(res, 200, `${rows.map((row) => row.map(csvValue).join(',')).join('\n')}\n`, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="rustdesk-audit.csv"' });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/retention/run') {
    const actor = (await auth.session(req)).user.username;
    const result = await runRetentionCleanup();
    await store.audit({ actor, action: 'retention_cleanup', resourceType: 'system', resourceId: null, details: result });
    return json(res, 200, result);
  }

  if (url.pathname.startsWith('/api/admin/') || url.pathname.match(/^\/api\/devices\/[^/]+\/(config|heartbeat)$/)) {
    const result = await managementApi(req, res, url);
    if (result !== null) return result;
    return json(res, 404, { error: '管理接口不存在' });
  }

  const serviceMatch = url.pathname.match(/^\/api\/services\/(hbbs|hbbr)\/(start|stop|restart)$/);
  if (req.method === 'POST' && serviceMatch) {
    const [, name, action] = serviceMatch;
    const result = action === 'start' ? startService(name) : action === 'stop' ? await stopService(name) : await restartService(name);
    return json(res, result.status || (result.ok ? 200 : 500), result);
  }

  const consoleMatch = url.pathname.match(/^\/api\/services\/(hbbs|hbbr)\/console$/);
  if (req.method === 'POST' && consoleMatch) {
    const [, name] = consoleMatch;
    try {
      const body = await parseBody(req);
      const command = typeof body.command === 'string' ? body.command.trim() : '';
      if (!command || command.length > 256 || /[\r\n]/.test(command)) return json(res, 400, { error: '只允许一条不含换行的控制台命令' });
      const output = await sendConsole(name, command);
      return json(res, 200, { ok: true, output });
    } catch (error) {
      return json(res, 502, { error: error.message });
    }
  }
  return json(res, 404, { error: '接口不存在' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz' || url.pathname === '/metrics') {
    try { return await handleApi(req, res, url); }
    catch (error) {
      console.error(`管理 API 请求失败: ${redact(error.message)}`);
      return json(res, 503, { error: '控制面暂时不可用' });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '方法不允许' });
  const filePath = safeFilePath(url.pathname);
  if (!filePath) return json(res, 403, { error: '禁止访问' });
  fs.readFile(filePath, (error, data) => {
    if (error) return json(res, 404, { error: '页面不存在' });
    const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
    res.writeHead(200, { 'content-type': contentTypes[path.extname(filePath)] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  });
});

server.on('close', () => { if (retentionTimer) clearInterval(retentionTimer); store.close().catch((error) => console.error(`关闭 PostgreSQL 连接池失败: ${error.message}`)); });

if (require.main === module) {
  ensureRuntime();
  try {
    validateSecurityConfig();
  } catch (error) {
    console.error(`管理后台无法启动: ${redact(error.message)}`);
    process.exitCode = 1;
    return;
  }
  auth.ready.then(() => {
    if (process.env.RETENTION_CLEANUP_ENABLED !== 'N') {
      runRetentionCleanup().catch((error) => console.error(`保留清理失败: ${redact(error.message)}`));
      retentionTimer = setInterval(() => runRetentionCleanup().catch((error) => console.error(`保留清理失败: ${redact(error.message)}`)), numberFromEnv('RETENTION_CLEANUP_INTERVAL_HOURS', 24) * 60 * 60 * 1000);
    }
    server.listen(PORT, HOST, () => console.log(`RustDesk 管理后台: http://${HOST}:${PORT}`));
  }).catch((error) => {
    console.error(`管理后台无法启动: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { server, serviceDefinitions, serviceState, readConfig, startService, stopService, sendConsole, auth, oauth, runRetentionCleanup };
