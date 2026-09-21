const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PostgresStore } = require('./store');

const connectionString = process.env.TEST_DATABASE_URL;
const testOptions = { skip: !connectionString };

function suffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

test('PostgreSQL migrations preserve JSONB and policy data', testOptions, async () => {
  const store = new PostgresStore(connectionString);
  try {
    await store.ready;
    const value = suffix();
    const device = await store.create('devices', { rustdeskId: `pg-${value}`, name: 'PostgreSQL 测试设备', tags: ['integration'], metadata: { verified: true } });
    const rule = await store.create('rules', { name: `测试规则-${value}`, action: 'connect', effect: 'force_relay', deviceId: device.id });
    const target = await store.getPolicyTarget(device.rustdeskId);
    assert.deepEqual(target.device.tags, ['integration']);
    assert.equal(target.device.metadata.verified, true);
    assert.equal((await store.listPolicyRules()).some((item) => item.id === rule.id), true);
  } finally {
    await store.close();
  }
});

test('PostgreSQL migrations are idempotent across sequential store starts', testOptions, async () => {
  const first = new PostgresStore(connectionString);
  try {
    await first.ready;
  } finally {
    await first.close();
  }
  const second = new PostgresStore(connectionString);
  try {
    await second.ready;
    const expected = fs.readdirSync(path.join(__dirname, 'migrations')).filter((name) => name.endsWith('.sql')).length;
    const result = await second.pool.query('SELECT COUNT(*)::int AS count FROM schema_migrations');
    assert.equal(result.rows[0].count, expected);
  } finally {
    await second.close();
  }
});

test('PostgreSQL preserves device uniqueness under concurrent writes', testOptions, async () => {
  const store = new PostgresStore(connectionString);
  try {
    await store.ready;
    const rustdeskId = `pg-race-${suffix()}`;
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => store.create('devices', { rustdeskId, name: '并发设备' })));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === '23505').length, 19);
    const rows = await store.pool.query('SELECT COUNT(*)::int AS count FROM devices WHERE rustdesk_id = $1', [rustdeskId]);
    assert.equal(rows.rows[0].count, 1);
  } finally {
    await store.close();
  }
});

test('PostgreSQL persists one event and Relay session for concurrent event delivery', testOptions, async () => {
  const store = new PostgresStore(connectionString);
  try {
    await store.ready;
    const value = suffix();
    const event = { eventId: `event-${value}`, eventType: 'relay_start', targetRustdeskId: `target-${value}`, sessionKey: `session-${value}`, sourceIp: '127.0.0.1', details: { relayAddress: '127.0.0.1:21117' } };
    const results = await Promise.all(Array.from({ length: 20 }, () => store.recordCommunicationEvent(event)));
    assert.equal(results.filter((result) => !result.duplicate).length, 1);
    await Promise.all(Array.from({ length: 20 }, () => store.projectRelaySession(event)));
    const [events, sessions] = await Promise.all([
      store.pool.query('SELECT COUNT(*)::int AS count FROM communication_events WHERE event_id = $1', [event.eventId]),
      store.pool.query('SELECT COUNT(*)::int AS count FROM sessions WHERE session_key = $1', [event.sessionKey]),
    ]);
    assert.equal(events.rows[0].count, 1);
    assert.equal(sessions.rows[0].count, 1);
  } finally {
    await store.close();
  }
});
