const state = { services: [], consoleService: null, devices: [], csrfToken: '', rules: [] };
const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function request(url, options) {
  const headers = { ...(options && options.headers), ...(state.csrfToken ? { 'x-csrf-token': state.csrfToken } : {}) };
  const response = await fetch(url, { ...options, headers });
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function showLogin(error = '') {
  $('#login-screen').hidden = false;
  $('#login-error').textContent = error;
  $('#login-error').hidden = !error;
}

async function loadAuthConfig() {
  try {
    const config = await request('/api/auth/config');
    if (config.oauth && config.oauth.enabled) {
      $('#oauth-container').hidden = false;
      const name = config.oauth.providerName || 'Authelia';
      $('#oauth-btn-text').textContent = `通过 ${name} 登录`;
      $('#login-subtitle').textContent = `使用 ${name} 单点登录或本地管理员账号访问控制面。`;
    } else {
      $('#oauth-container').hidden = true;
      $('#login-subtitle').textContent = '使用本地管理员账号访问控制面。';
    }
  } catch {
    // ignore
  }
}

async function initialize() {
  await loadAuthConfig();

  const params = new URLSearchParams(window.location.search);
  const oauthError = params.get('oauth_error');
  if (oauthError) {
    const errorMap = {
      user_disabled: '该账号已被停用，请联系管理员。',
      user_not_found: '该用户未在控制面登记，请联系管理员分配账号。',
      invalid_state: '单点登录校验失效或已超时，请重试。',
      oauth_disabled: '未启用 OAuth 单点登录。',
      rate_limited: '单点登录尝试过于频繁，请稍后再试。',
    };
    const msg = errorMap[oauthError] || `单点登录失败: ${oauthError}`;
    window.history.replaceState({}, document.title, window.location.pathname);
    showLogin(msg);
    return;
  }

  try {
    const session = await request('/api/auth/me');
    state.csrfToken = session.csrfToken;
    $('#current-user').textContent = session.user.displayName || session.user.username;
    $('#login-screen').hidden = true;
    refresh();
  } catch { showLogin(); }
}

function serviceCard(service) {
  const log = (service.log || []).slice(-5).map((line) => `[${line.stream}] ${line.text}`).join('\n');
  return `<article class="service-card"><div class="service-top"><div><h4 class="service-name">${service.name}</h4><div class="service-sub">${service.label}</div></div><span class="status ${service.running ? 'on' : ''}">${service.running ? 'RUNNING' : 'STOPPED'}</span></div><div class="service-meta"><div><span class="meta-label">监听端口</span><span class="meta-value">${service.port}</span></div><div><span class="meta-label">进程 / 控制台</span><span class="meta-value">${service.pid || '-'} / ${service.consolePort}</span></div></div><div class="actions"><button data-action="start" data-service="${service.name}" ${service.running ? 'disabled' : ''}>启动</button><button data-action="stop" data-service="${service.name}" class="secondary" ${!service.running ? 'disabled' : ''}>停止</button><button data-action="restart" data-service="${service.name}" class="secondary">重启</button><button data-console="${service.name}" class="ghost">控制台</button></div><pre class="log">${escapeHtml(log)}</pre></article>`;
}

function render(data) {
  state.services = data.services;
  const running = data.services.filter((service) => service.running).length;
  const available = data.services.filter((service) => service.binaryAvailable).length;
  $('#running-count').textContent = `${running} / 2`;
  $('#service-status').textContent = running === 2 ? '通信面运行正常' : running ? '通信面部分运行' : '通信面未启动';
  $('#service-detail').textContent = `${running}/2 运行 · ${available}/2 二进制可用`;
  $('#service-status-dot').className = `status-dot ${running === 2 ? 'good' : 'warn'}`;
  $('#hero-status').textContent = running === 2 ? '所有通信服务正在运行' : available ? '通信服务等待启动' : '尚未发现通信服务二进制';
  $('#service-grid').innerHTML = data.services.map(serviceCard).join('');
  const config = data.config;
  $('#config-grid').innerHTML = [
    ['服务端源码', config.serverRoot], ['运行目录', config.runtimeRoot], ['Relay 地址', config.relayAddress],
    ['hbbs / UDP', `${config.ports.hbbs} / ${config.ports.hbbs}`], ['hbbr / TCP', config.ports.hbbr],
    ['数据库', config.database.exists ? `${config.database.path} (${config.database.size} B)` : `${config.database.path}（尚未创建）`],
  ].map(([label, value]) => `<div class="config-item"><span>${label}</span><code>${escapeHtml(value)}</code></div>`).join('');
  $('#last-sync').textContent = `最近同步 ${new Date().toLocaleTimeString()}`;
  document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', serviceAction));
  document.querySelectorAll('[data-console]').forEach((button) => button.addEventListener('click', () => openConsole(button.dataset.console)));
}

function deviceCard(device) {
  const status = String(device.status || 'approved').toUpperCase();
  const approval = device.status === 'pending' ? `<button data-device-approval="${device.id}" data-status="approved">批准</button><button class="secondary" data-device-approval="${device.id}" data-status="rejected">拒绝</button>` : '';
  return `<article class="device-card"><div class="service-top"><div><h4 class="service-name">${escapeHtml(device.name)}</h4><div class="service-sub">${escapeHtml(device.rustdeskId)} · ${escapeHtml(device.platform || '未知平台')}</div></div><span class="status ${device.status === 'approved' && device.online ? 'on' : ''}">${status}</span></div><div class="device-meta"><span>${escapeHtml(device.hostname || '未设置主机名')}</span><span>最后在线：${device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '从未'}</span></div><div class="actions">${approval}<button data-device-config="${device.id}" ${device.status !== 'approved' ? 'disabled' : ''}>客户端配置</button><button class="secondary" data-device-disable="${device.id}" data-disabled="${device.disabled}">${device.disabled ? '启用设备' : '禁用设备'}</button></div></article>`;
}

async function refreshDevices() {
  const result = await request('/api/admin/devices');
  state.devices = result.items;
  $('#device-grid').innerHTML = state.devices.length ? state.devices.map(deviceCard).join('') : '<div class="empty">还没有登记设备，先添加一台客户端资产。</div>';
  $('#online-devices').textContent = state.devices.filter((device) => device.online).length;
  $('#device-total').textContent = `资产总数 ${state.devices.length}`;
  const pending = state.devices.filter((device) => device.status === 'pending').length;
  $('#approval-status').textContent = pending ? `${pending} 台设备待审批` : '审批队列为空';
  $('#approval-detail').textContent = pending ? '请确认资产归属后处理' : '新发现设备会在这里出现';
  $('#approval-status-dot').className = `status-dot ${pending ? 'warn' : 'good'}`;
  $('#simulate-device').innerHTML = state.devices.map((device) => `<option value="${escapeHtml(device.rustdeskId)}">${escapeHtml(device.name)} (${escapeHtml(device.rustdeskId)})</option>`).join('') || '<option value="">没有可模拟设备</option>';
  document.querySelectorAll('[data-device-config]').forEach((button) => button.addEventListener('click', showDeviceConfig));
  document.querySelectorAll('[data-device-disable]').forEach((button) => button.addEventListener('click', toggleDevice));
  document.querySelectorAll('[data-device-approval]').forEach((button) => button.addEventListener('click', updateApproval));
}

function activityItem(title, detail, action = '') {
  return `<div class="activity-item"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>${action}</div>`;
}

async function refreshGovernance() {
  const [users, departments, groups, relays, rules] = await Promise.all(['users', 'departments', 'groups', 'relays', 'rules'].map((type) => request(`/api/admin/${type}`)));
  state.rules = rules.items;
  $('#org-summary').innerHTML = [
    ['用户', users.items.length], ['部门', departments.items.length], ['设备组', groups.items.length], ['启用 Relay', relays.items.filter((relay) => relay.enabled).length],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('');
  $('#rule-list').innerHTML = state.rules.length ? state.rules.map((rule) => `<article class="rule-item"><div><strong>${escapeHtml(rule.name)}</strong><span>${escapeHtml(rule.action)} · ${escapeHtml(rule.effect)} · 优先级 ${rule.priority}</span></div><button class="ghost" data-rule-versions="${rule.id}">版本</button></article>`).join('') : '<div class="empty">还没有策略规则。</div>';
  document.querySelectorAll('[data-rule-versions]').forEach((button) => button.addEventListener('click', showRuleVersions));
}

async function showRuleVersions(event) {
  try {
    const result = await request(`/api/admin/rules/${event.currentTarget.dataset.ruleVersions}/versions`);
    $('#notice').textContent = result.items.length ? result.items.map((version) => `v${version.version} · ${version.actor} · ${new Date(version.createdAt).toLocaleString()}`).join('\n') : '没有历史版本';
    $('#notice').hidden = false;
  } catch (error) { $('#notice').textContent = error.message; $('#notice').hidden = false; }
}

async function refreshActivity() {
  const [sessions, events, audit] = await Promise.all(['sessions?limit=20', 'events?limit=20', 'audit?limit=20'].map((path) => request(`/api/admin/${path}`)));
  $('#session-list').innerHTML = sessions.items.length ? sessions.items.map((session) => activityItem(`${session.peerRustdeskId} · ${session.status}`, `${session.transport || 'relay'} · ${session.sessionKey || '-'} · ${session.endedAt ? '已结束' : '活跃'}`, session.status === 'active' && session.transport === 'relay' ? `<button data-terminate-session="${session.id}" class="secondary">断开</button>` : '')).join('') : '<div class="empty">没有 Relay 会话。</div>';
  $('#event-list').innerHTML = events.items.length ? events.items.map((event) => activityItem(event.eventType, `${event.targetRustdeskId} · ${new Date(event.createdAt).toLocaleString()}`)).join('') : '<div class="empty">没有通信事件。</div>';
  $('#audit-list').innerHTML = audit.items.length ? audit.items.map((entry) => activityItem(`${entry.actor} · ${entry.action}`, `${entry.resourceType} · ${new Date(entry.createdAt).toLocaleString()}`)).join('') : '<div class="empty">没有审计记录。</div>';
  document.querySelectorAll('[data-terminate-session]').forEach((button) => button.addEventListener('click', terminateSession));
}

async function terminateSession(event) {
  try { await request(`/api/admin/sessions/${event.currentTarget.dataset.terminateSession}/terminate`, { method: 'POST' }); await refreshActivity(); }
  catch (error) { $('#notice').textContent = error.message; $('#notice').hidden = false; }
}

async function showDeviceConfig(event) {
  try { const config = await request(`/api/devices/${event.currentTarget.dataset.deviceConfig}/config`); $('#notice').textContent = `${config.deviceId} 配置已生成：\n${config.ini}`; $('#notice').hidden = false; }
  catch (error) { $('#notice').textContent = error.message; $('#notice').hidden = false; }
}

async function toggleDevice(event) {
  const button = event.currentTarget;
  try { await request(`/api/admin/devices/${button.dataset.deviceDisable}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disabled: button.dataset.disabled !== 'true' }) }); await refreshDevices(); }
  catch (error) { $('#notice').textContent = error.message; $('#notice').hidden = false; }
}

async function updateApproval(event) {
  const button = event.currentTarget;
  try { await request(`/api/admin/devices/${button.dataset.deviceApproval}/approval`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: button.dataset.status }) }); await refreshDevices(); }
  catch (error) { $('#notice').textContent = error.message; $('#notice').hidden = false; }
}

async function refresh() {
  try {
    const [health, overview, summary] = await Promise.all([request('/healthz'), request('/api/overview'), request('/api/admin/summary')]);
    render(overview);
    $('#active-sessions').textContent = summary.activeSessions;
    $('#control-plane-status').textContent = health.status === 'ok' ? '控制面运行正常' : '控制面需要检查';
    $('#control-plane-detail').textContent = health.status === 'ok' ? '认证与数据存储已就绪' : '查看服务日志获取详情';
    $('#control-plane-dot').className = `status-dot ${health.status === 'ok' ? 'good' : 'warn'}`;
    await Promise.all([refreshDevices(), refreshGovernance(), refreshActivity()]);
    $('#notice').hidden = true;
  } catch (error) { $('#notice').textContent = error.message; $('#notice').hidden = false; }
}

async function serviceAction(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try { await request(`/api/services/${button.dataset.service}/${button.dataset.action}`, { method: 'POST' }); await refresh(); }
  catch (error) { $('#notice').textContent = error.message; $('#notice').hidden = false; }
  finally { button.disabled = false; }
}

function openConsole(service) {
  state.consoleService = service;
  $('#console-title').textContent = `${service} 控制台`;
  $('#console-output').textContent = '等待命令...';
  $('#command-input').value = '';
  $('#console-modal').hidden = false;
  $('#command-input').focus();
}

async function sendCommand() {
  const input = $('#command-input');
  $('#send-command').disabled = true;
  try { const result = await request(`/api/services/${state.consoleService}/console`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: input.value }) }); $('#console-output').textContent = result.output || '(服务未返回内容)'; }
  catch (error) { $('#console-output').textContent = error.message; }
  finally { $('#send-command').disabled = false; }
}

$('#refresh').addEventListener('click', refresh);
$('#hero-register-device').addEventListener('click', () => { $('#device-modal').hidden = false; $('#device-form').elements.rustdeskId.focus(); });
$('#hero-review-pending').addEventListener('click', () => { document.querySelector('#fleet').scrollIntoView({ behavior: 'smooth' }); });
$('#close-console').addEventListener('click', () => { $('#console-modal').hidden = true; });
$('#send-command').addEventListener('click', sendCommand);
$('#command-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') sendCommand(); });
$('#new-device').addEventListener('click', () => { $('#device-modal').hidden = false; $('#device-form').elements.rustdeskId.focus(); });
$('#close-device').addEventListener('click', () => { $('#device-modal').hidden = true; });
$('#device-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  try {
    await request('/api/admin/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    form?.reset?.();
    $('#device-modal').hidden = true;
    await refresh();
  } catch (error) { $('#notice').textContent = error.message; $('#notice').hidden = false; }
});
$('#new-rule').addEventListener('click', () => { $('#rule-modal').hidden = false; $('#rule-form').elements.name.focus(); });
$('#close-rule').addEventListener('click', () => { $('#rule-modal').hidden = true; });
$('#rule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  body.priority = Number(body.priority);
  if (!body.tag) delete body.tag;
  try {
    await request('/api/admin/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    form?.reset?.();
    $('#rule-modal').hidden = true;
    await refreshGovernance();
  } catch (error) { $('#notice').textContent = error.message; $('#notice').hidden = false; }
});
$('#simulate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  try {
    const result = await request('/api/admin/policy/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: $('#simulate-device').value, action: body.action }) });
    $('#simulate-output').textContent = JSON.stringify(result, null, 2);
  } catch (error) { $('#simulate-output').textContent = error.message; }
});
$('#refresh-activity').addEventListener('click', refreshActivity);
$('#export-audit').addEventListener('click', () => { window.location.assign('/api/admin/audit/export'); });
$('#run-retention').addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  btn.disabled = true;
  try {
    const result = await request('/api/admin/retention/run', { method: 'POST' });
    $('#notice').textContent = `保留清理完成：${JSON.stringify(result)}`;
    $('#notice').hidden = false;
    await refreshActivity();
  } catch (error) { $('#notice').textContent = error.message; $('#notice').hidden = false; }
  finally { btn.disabled = false; }
});
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  try {
    const session = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    state.csrfToken = session.csrfToken;
    $('#current-user').textContent = session.user.displayName || session.user.username;
    $('#login-screen').hidden = true;
    form?.reset?.();
    refresh();
  } catch (error) { showLogin(error.message); }
});
$('#logout').addEventListener('click', async () => {
  try { await request('/api/auth/logout', { method: 'POST' }); } finally { state.csrfToken = ''; showLogin(); }
});
initialize();
