const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const ONLINE_WINDOW_MS = 2 * 60 * 1000;

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function online(lastSeenAt) {
  return Boolean(lastSeenAt && Date.now() - Date.parse(lastSeenAt) <= ONLINE_WINDOW_MS);
}

function normalizeDevice(device) {
  const status = device.status || (device.disabled ? 'disabled' : 'approved');
  return { ...device, status, online: online(device.lastSeenAt) };
}

class MemoryStore {
  constructor() {
    this.data = {
      departments: [],
      roles: [{ id: 'role_admin', name: '管理员', permissions: ['*'], createdAt: now() }],
      users: [],
      groups: [],
      relays: [],
      devices: [],
      sessions: [],
      events: [],
      rules: [],
      adminSessions: [],
      ruleVersions: [],
      audit: [],
    };
    this.ready = Promise.resolve();
  }

  list(type) {
    const values = this.data[type] || [];
    return Promise.resolve(type === 'devices' ? values.map(normalizeDevice) : values.map((value) => ({ ...value })));
  }

  get(type, resourceId) {
    const value = (this.data[type] || []).find((item) => item.id === resourceId);
    return Promise.resolve(value ? (type === 'devices' ? normalizeDevice(value) : { ...value }) : null);
  }

  getByRustdeskId(rustdeskId) {
    const value = this.data.devices.find((item) => item.rustdeskId === rustdeskId);
    return Promise.resolve(value ? normalizeDevice(value) : null);
  }

  getUserByUsername(username) {
    const value = this.data.users.find((item) => item.username === username);
    return Promise.resolve(value ? { ...value } : null);
  }

  getUserById(userId) {
    const value = this.data.users.find((item) => item.id === userId);
    return Promise.resolve(value ? { ...value } : null);
  }

  saveAdminSession(session) {
    this.data.adminSessions = this.data.adminSessions.filter((item) => item.id !== session.id);
    this.data.adminSessions.push({ ...session });
    return Promise.resolve();
  }

  getAdminSession(sessionId) {
    const value = this.data.adminSessions.find((item) => item.id === sessionId && Number(item.expiresAt) > Date.now());
    return Promise.resolve(value ? { ...value } : null);
  }

  deleteAdminSession(sessionId) {
    this.data.adminSessions = this.data.adminSessions.filter((item) => item.id !== sessionId);
    return Promise.resolve();
  }

  cleanupRetention({ auditDays, eventDays, sessionDays }) {
    const cutoff = (days) => Date.now() - days * 24 * 60 * 60 * 1000;
    const before = { audit: this.data.audit.length, events: this.data.events.length, sessions: this.data.sessions.length };
    this.data.audit = this.data.audit.filter((item) => Date.parse(item.createdAt) >= cutoff(auditDays));
    this.data.events = this.data.events.filter((item) => Date.parse(item.createdAt) >= cutoff(eventDays));
    this.data.sessions = this.data.sessions.filter((item) => !item.endedAt || Date.parse(item.endedAt) >= cutoff(sessionDays));
    return Promise.resolve({ audit: before.audit - this.data.audit.length, events: before.events - this.data.events.length, sessions: before.sessions - this.data.sessions.length });
  }

  saveRuleVersion(rule, actor) {
    const versions = this.data.ruleVersions.filter((item) => item.ruleId === rule.id);
    this.data.ruleVersions.push({ id: id('rulever'), ruleId: rule.id, version: versions.length + 1, snapshot: { ...rule }, actor, createdAt: now() });
    return Promise.resolve();
  }

  listRuleVersions(ruleId) {
    return Promise.resolve(this.data.ruleVersions.filter((item) => item.ruleId === ruleId).sort((a, b) => b.version - a.version).map((item) => ({ ...item })));
  }

  getPolicyTarget(rustdeskId) {
    const device = this.data.devices.find((item) => item.rustdeskId === rustdeskId);
    if (!device) return Promise.resolve(null);
    const owner = device.ownerId ? this.data.users.find((item) => item.id === device.ownerId) : null;
    const department = owner && owner.departmentId ? this.data.departments.find((item) => item.id === owner.departmentId) : null;
    return Promise.resolve({ device: normalizeDevice(device), ownerDisabled: Boolean(owner && owner.disabled), departmentDisabled: Boolean(department && department.disabled) });
  }

  listPolicyRules() {
    return Promise.resolve(this.data.rules.filter((rule) => rule.enabled !== false).sort((a, b) => a.priority - b.priority).map((rule) => ({ ...rule })));
  }

  create(type, input) {
    const prefixes = { departments: 'dep', roles: 'role', users: 'usr', groups: 'grp', relays: 'rly', devices: 'dev', sessions: 'ses', rules: 'rule' };
    const value = { ...input, id: input.id || id(prefixes[type]), createdAt: now() };
    if (type === 'departments') value.disabled = Boolean(value.disabled);
    if (type === 'devices') {
      value.status = value.status || (value.disabled ? 'disabled' : 'approved');
      value.disabled = value.status === 'disabled' || Boolean(value.disabled);
      value.updatedAt = value.createdAt;
      value.tags = Array.isArray(value.tags) ? value.tags : [];
    }
    if (type === 'users' && this.data.users.some((item) => item.username === value.username)) throw new Error('用户名已存在');
    this.data[type].push(value);
    return Promise.resolve(type === 'devices' ? normalizeDevice(value) : { ...value });
  }

  update(type, resourceId, patch) {
    const value = (this.data[type] || []).find((item) => item.id === resourceId);
    if (!value) return Promise.resolve(null);
    if (type === 'devices' && patch.status) patch.disabled = patch.status === 'disabled';
    Object.assign(value, patch, type === 'devices' ? { updatedAt: now() } : {});
    return Promise.resolve(type === 'devices' ? normalizeDevice(value) : { ...value });
  }

  heartbeat(resourceId, payload = {}) {
    const value = this.data.devices.find((item) => item.id === resourceId || item.rustdeskId === resourceId);
    if (!value) return Promise.resolve(null);
    Object.assign(value, payload, { lastSeenAt: now(), updatedAt: now() });
    return Promise.resolve(normalizeDevice(value));
  }

  ensurePendingDevice(rustdeskId, name = rustdeskId) {
    const existing = this.data.devices.find((item) => item.rustdeskId === rustdeskId);
    return existing ? Promise.resolve(normalizeDevice(existing)) : this.create('devices', { rustdeskId, name, status: 'pending', disabled: false });
  }

  audit(entry) {
    this.data.audit.unshift({ id: id('audit'), createdAt: now(), ...entry });
    this.data.audit = this.data.audit.slice(0, 500);
    return Promise.resolve();
  }

  recordCommunicationEvent(event) {
    if (this.data.events.some((item) => item.eventId === event.eventId)) return Promise.resolve({ duplicate: true });
    this.data.events.unshift({ ...event, createdAt: now() });
    this.data.events = this.data.events.slice(0, 2000);
    return Promise.resolve({ duplicate: false });
  }

  projectRelaySession(event) {
    if (!event.sessionKey) return Promise.resolve(null);
    const existing = this.data.sessions.find((item) => item.sessionKey === event.sessionKey);
    if (event.eventType === 'relay_start' && !existing) {
      const details = typeof event.details === 'object' && event.details ? event.details : { message: String(event.details || '') };
      return this.create('sessions', { deviceId: event.deviceId || null, peerRustdeskId: event.targetRustdeskId, sessionKey: event.sessionKey, relayAddress: details.relayAddress || null, transport: 'relay', status: 'active', sourceIp: event.sourceIp || null, metadata: details });
    }
    if (event.eventType === 'relay_end' && existing && !existing.endedAt) {
      const details = typeof event.details === 'object' && event.details ? event.details : { message: String(event.details || '') };
      return this.update('sessions', existing.id, { endedAt: now(), status: 'ended', metadata: { ...existing.metadata, ...details } });
    }
    return Promise.resolve(existing || null);
  }

  summary() {
    return Promise.all(['users', 'devices', 'groups', 'relays', 'sessions', 'audit'].map((type) => this.list(type))).then(([users, devices, groups, relays, sessions, audit]) => ({
      users: users.length,
      devices: devices.length,
      onlineDevices: devices.filter((device) => device.online).length,
      groups: groups.length,
      relays: relays.filter((relay) => relay.enabled).length,
      activeSessions: sessions.filter((session) => !session.endedAt).length,
      auditEvents: audit.length,
      communicationEvents: this.data.events.length,
    }));
  }

  close() {
    return Promise.resolve();
  }
}

function mapRow(row) {
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    result[camel] = value;
  }
  return result;
}

class PostgresStore {
  constructor(connectionString) {
    let Pool;
    try {
      ({ Pool } = require('pg'));
    } catch {
      throw new Error('使用 PostgreSQL 需要安装 pg 依赖：npm install');
    }
    this.pool = new Pool({ connectionString });
    this.pool.on('error', (error) => console.error(`PostgreSQL 连接池错误: ${error.message}`));
    this.ready = this.runMigrations();
  }

  async runMigrations() {
    await this.pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const applied = new Set((await this.pool.query('SELECT version FROM schema_migrations')).rows.map((row) => row.version));
    const migrations = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
    for (const version of migrations) {
      if (applied.has(version)) continue;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, version), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async query(sql, values = []) {
    const result = await this.pool.query(sql, values);
    return result.rows.map(mapRow);
  }

  async list(type) {
    const tables = { departments: 'departments', roles: 'roles', users: 'managed_users', groups: 'device_groups', relays: 'relays', devices: 'devices', sessions: 'sessions', events: 'communication_events', rules: 'policy_rules', audit: 'audit_logs' };
    const rows = await this.query(`SELECT * FROM ${tables[type]} ORDER BY created_at DESC`);
    return type === 'devices' ? rows.map(normalizeDevice) : rows;
  }

  async get(type, resourceId) {
    const tables = { departments: 'departments', roles: 'roles', users: 'managed_users', groups: 'device_groups', relays: 'relays', devices: 'devices', sessions: 'sessions', audit: 'audit_logs' };
    const rows = await this.query(`SELECT * FROM ${tables[type]} WHERE id = $1`, [resourceId]);
    if (!rows[0]) return null;
    return type === 'devices' ? normalizeDevice(rows[0]) : rows[0];
  }

  async getByRustdeskId(rustdeskId) {
    const rows = await this.query('SELECT * FROM devices WHERE rustdesk_id = $1', [rustdeskId]);
    return rows[0] ? normalizeDevice(rows[0]) : null;
  }

  async getUserByUsername(username) {
    const rows = await this.query('SELECT u.*, r.permissions FROM managed_users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.username = $1', [username]);
    return rows[0] || null;
  }

  async getUserById(userId) {
    const rows = await this.query('SELECT u.*, r.permissions FROM managed_users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = $1', [userId]);
    return rows[0] || null;
  }

  async saveAdminSession(session) {
    await this.pool.query('INSERT INTO admin_sessions (id, user_id, csrf_token, expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET csrf_token = EXCLUDED.csrf_token, expires_at = EXCLUDED.expires_at', [session.id, session.user.id, session.csrfToken, new Date(session.expiresAt)]);
  }

  async getAdminSession(sessionId) {
    const rows = await this.query('SELECT s.id AS session_id, s.csrf_token, s.expires_at, u.id AS user_id, u.username, u.display_name, u.disabled, r.permissions FROM admin_sessions s JOIN managed_users u ON u.id = s.user_id LEFT JOIN roles r ON r.id = u.role_id WHERE s.id = $1 AND s.expires_at > NOW()', [sessionId]);
    return rows[0] ? { id: rows[0].sessionId, csrfToken: rows[0].csrfToken, expiresAt: new Date(rows[0].expiresAt).getTime(), user: { id: rows[0].userId, username: rows[0].username, displayName: rows[0].displayName, permissions: rows[0].permissions || [], disabled: rows[0].disabled } } : null;
  }

  async deleteAdminSession(sessionId) {
    await this.pool.query('DELETE FROM admin_sessions WHERE id = $1', [sessionId]);
  }

  async cleanupRetention({ auditDays, eventDays, sessionDays }) {
    const result = await this.pool.query('WITH a AS (DELETE FROM audit_logs WHERE created_at < NOW() - ($1::text || \' days\')::interval RETURNING 1), e AS (DELETE FROM communication_events WHERE created_at < NOW() - ($2::text || \' days\')::interval RETURNING 1), s AS (DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < NOW() - ($3::text || \' days\')::interval RETURNING 1), x AS (DELETE FROM admin_sessions WHERE expires_at < NOW() RETURNING 1) SELECT (SELECT count(*) FROM a) AS audit, (SELECT count(*) FROM e) AS events, (SELECT count(*) FROM s) AS sessions, (SELECT count(*) FROM x) AS expired_sessions', [auditDays, eventDays, sessionDays]);
    return Object.fromEntries(Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)]));
  }

  async saveRuleVersion(rule, actor) {
    await this.pool.query('INSERT INTO policy_rule_versions (rule_id, version, snapshot, actor) SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3 FROM policy_rule_versions WHERE rule_id = $1', [rule.id, JSON.stringify(rule), actor]);
  }

  async listRuleVersions(ruleId) {
    return this.query('SELECT * FROM policy_rule_versions WHERE rule_id = $1 ORDER BY version DESC', [ruleId]);
  }

  async getPolicyTarget(rustdeskId) {
    const rows = await this.query('SELECT d.*, u.disabled AS owner_disabled, dep.disabled AS department_disabled FROM devices d LEFT JOIN managed_users u ON u.id = d.owner_id LEFT JOIN departments dep ON dep.id = u.department_id WHERE d.rustdesk_id = $1', [rustdeskId]);
    if (!rows[0]) return null;
    return { device: normalizeDevice(rows[0]), ownerDisabled: Boolean(rows[0].ownerDisabled), departmentDisabled: Boolean(rows[0].departmentDisabled) };
  }

  async listPolicyRules() {
    return this.query('SELECT * FROM policy_rules WHERE enabled ORDER BY priority ASC, created_at ASC');
  }

  async create(type, input) {
    const value = { ...input, id: input.id || id({ departments: 'dep', roles: 'role', users: 'usr', groups: 'grp', relays: 'rly', devices: 'dev', sessions: 'ses', rules: 'rule' }[type]) };
    const queries = {
      departments: ['INSERT INTO departments (id, name, description, disabled) VALUES ($1, $2, $3, $4) RETURNING *', [value.id, value.name, value.description || '', Boolean(value.disabled)]],
      roles: ['INSERT INTO roles (id, name, permissions) VALUES ($1, $2, $3) RETURNING *', [value.id, value.name, JSON.stringify(value.permissions || [])]],
      users: ['INSERT INTO managed_users (id, username, display_name, department_id, role_id, disabled, password_hash) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', [value.id, value.username, value.displayName, value.departmentId || null, value.roleId || null, Boolean(value.disabled), value.passwordHash || null]],
      groups: ['INSERT INTO device_groups (id, name, description) VALUES ($1, $2, $3) RETURNING *', [value.id, value.name, value.description || '']],
      relays: ['INSERT INTO relays (id, name, address, enabled) VALUES ($1, $2, $3, $4) RETURNING *', [value.id, value.name, value.address, value.enabled !== false]],
      devices: ['INSERT INTO devices (id, rustdesk_id, name, hostname, platform, owner_id, group_id, relay_id, disabled, status, last_seen_at, metadata, tags) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *', [value.id, value.rustdeskId, value.name, value.hostname || '', value.platform || '', value.ownerId || null, value.groupId || null, value.relayId || null, value.status === 'disabled' || Boolean(value.disabled), value.status || (value.disabled ? 'disabled' : 'approved'), value.lastSeenAt || null, JSON.stringify(value.metadata || {}), JSON.stringify(value.tags || [])]],
      sessions: ['INSERT INTO sessions (id, device_id, peer_rustdesk_id, started_at, ended_at, relay_address, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [value.id, value.deviceId || null, value.peerRustdeskId, value.startedAt || now(), value.endedAt || null, value.relayAddress || null, JSON.stringify(value.metadata || {})]],
      rules: ['INSERT INTO policy_rules (id, name, action, effect, device_id, group_id, tag, enabled, priority, description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [value.id, value.name, value.action, value.effect, value.deviceId || null, value.groupId || null, value.tag || null, value.enabled !== false, Number.isInteger(value.priority) ? value.priority : 100, value.description || '']],
    };
    const [sql, values] = queries[type];
    const rows = await this.query(sql, values);
    return type === 'devices' ? normalizeDevice(rows[0]) : rows[0];
  }

  async update(type, resourceId, patch) {
    if (type === 'devices' && patch.status) patch = { ...patch, disabled: patch.status === 'disabled' };
    const fields = { departments: ['name', 'description', 'disabled'], users: ['display_name', 'department_id', 'role_id', 'disabled', 'password_hash'], groups: ['name', 'description'], relays: ['name', 'address', 'enabled'], devices: ['name', 'hostname', 'platform', 'owner_id', 'group_id', 'relay_id', 'disabled', 'status', 'metadata', 'tags'], rules: ['name', 'action', 'effect', 'device_id', 'group_id', 'tag', 'enabled', 'priority', 'description'] }[type];
    if (!fields) return this.get(type, resourceId);
    const entries = fields.filter((field) => Object.hasOwn(patch, field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())));
    if (!entries.length) return this.get(type, resourceId);
    const values = entries.map((field) => {
      const value = patch[field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())];
      return field === 'metadata' || field === 'tags' ? JSON.stringify(value || (field === 'tags' ? [] : {})) : value;
    });
    const assignments = entries.map((field, index) => `${field} = $${index + 2}`);
    if (type === 'devices') assignments.push('updated_at = NOW()');
    const table = { departments: 'departments', users: 'managed_users', groups: 'device_groups', relays: 'relays', devices: 'devices', rules: 'policy_rules' }[type];
    const rows = await this.query(`UPDATE ${table} SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`, [resourceId, ...values]);
    return rows[0] ? (type === 'devices' ? normalizeDevice(rows[0]) : rows[0]) : null;
  }

  async heartbeat(resourceId, payload = {}) {
    const fields = ['hostname', 'platform', 'metadata'].filter((field) => Object.hasOwn(payload, field));
    const values = fields.map((field) => payload[field]);
    const assignments = ['last_seen_at = NOW()', 'updated_at = NOW()', ...fields.map((field, index) => `${field} = $${index + 2}`)];
    const rows = await this.query(`UPDATE devices SET ${assignments.join(', ')} WHERE id = $1 OR rustdesk_id = $1 RETURNING *`, [resourceId, ...values]);
    return rows[0] ? normalizeDevice(rows[0]) : null;
  }

  async ensurePendingDevice(rustdeskId, name = rustdeskId) {
    const rows = await this.query("INSERT INTO devices (id, rustdesk_id, name, status, disabled) VALUES ($1, $2, $3, 'pending', FALSE) ON CONFLICT (rustdesk_id) DO UPDATE SET rustdesk_id = EXCLUDED.rustdesk_id RETURNING *", [id('dev'), rustdeskId, name]);
    return normalizeDevice(rows[0]);
  }

  async audit(entry) {
    await this.pool.query('INSERT INTO audit_logs (actor, action, resource_type, resource_id, details) VALUES ($1,$2,$3,$4,$5)', [entry.actor, entry.action, entry.resourceType, entry.resourceId || null, JSON.stringify(entry.details || {})]);
  }

  async recordCommunicationEvent(event) {
    const result = await this.pool.query('INSERT INTO communication_events (event_id, event_type, device_id, target_rustdesk_id, session_key, source_ip, details) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (event_id) DO NOTHING RETURNING event_id', [event.eventId, event.eventType, event.deviceId || null, event.targetRustdeskId, event.sessionKey || null, event.sourceIp || null, JSON.stringify(event.details || {})]);
    return { duplicate: result.rowCount === 0 };
  }

  async projectRelaySession(event) {
    if (!event.sessionKey) return null;
    if (event.eventType === 'relay_start') {
      const rows = await this.query("INSERT INTO sessions (id, device_id, peer_rustdesk_id, session_key, relay_address, transport, status, source_ip, metadata) VALUES ($1,$2,$3,$4,$5,'relay','active',$6,$7) ON CONFLICT (session_key) DO UPDATE SET session_key = EXCLUDED.session_key RETURNING *", [id('ses'), event.deviceId || null, event.targetRustdeskId, event.sessionKey, event.details.relayAddress || null, event.sourceIp || null, JSON.stringify(event.details || {})]);
      return rows[0];
    }
    if (event.eventType === 'relay_end') {
      const rows = await this.query("UPDATE sessions SET ended_at = COALESCE(ended_at, NOW()), status = 'ended', metadata = metadata || $2::jsonb WHERE session_key = $1 RETURNING *", [event.sessionKey, JSON.stringify(event.details || {})]);
      return rows[0] || null;
    }
    return null;
  }

  async summary() {
    const rows = await this.query("SELECT (SELECT COUNT(*) FROM managed_users) AS users, (SELECT COUNT(*) FROM devices) AS devices, (SELECT COUNT(*) FROM devices WHERE last_seen_at > NOW() - INTERVAL '2 minutes') AS online_devices, (SELECT COUNT(*) FROM device_groups) AS groups, (SELECT COUNT(*) FROM relays WHERE enabled) AS relays, (SELECT COUNT(*) FROM sessions WHERE ended_at IS NULL) AS active_sessions, (SELECT COUNT(*) FROM audit_logs) AS audit_events, (SELECT COUNT(*) FROM communication_events) AS communication_events");
    return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)]));
  }

  close() {
    return this.pool.end();
  }
}

function createStore() {
  const connectionString = process.env.DATABASE_URL || '';
  if (connectionString.startsWith('postgres://') || connectionString.startsWith('postgresql://')) return new PostgresStore(connectionString);
  if (process.env.NODE_ENV === 'production' && process.env.ADMIN_ALLOW_MEMORY_STORE !== 'Y') throw new Error('生产环境必须设置 PostgreSQL DATABASE_URL');
  return new MemoryStore();
}

module.exports = { createStore, MemoryStore, PostgresStore, ONLINE_WINDOW_MS, online };
