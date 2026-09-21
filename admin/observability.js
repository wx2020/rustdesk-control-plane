class Metrics {
  constructor() {
    this.counters = new Map();
    this.policyDurations = { count: 0, sum: 0 };
  }

  increment(name, labels = {}) {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    const key = `${name}|${entries.map(([label, value]) => `${label}=${value}`).join(',')}`;
    const metric = this.counters.get(key) || { name, entries, value: 0 };
    metric.value += 1;
    this.counters.set(key, metric);
  }

  observePolicy(durationMs) {
    this.policyDurations.count += 1;
    this.policyDurations.sum += durationMs / 1000;
  }

  render(summary) {
    const lines = [
      '# HELP rustdesk_control_plane_policy_check_duration_seconds Time spent evaluating policy checks.',
      '# TYPE rustdesk_control_plane_policy_check_duration_seconds summary',
      `rustdesk_control_plane_policy_check_duration_seconds_count ${this.policyDurations.count}`,
      `rustdesk_control_plane_policy_check_duration_seconds_sum ${this.policyDurations.sum.toFixed(6)}`,
      '# HELP rustdesk_control_plane_active_sessions Active Relay sessions.',
      '# TYPE rustdesk_control_plane_active_sessions gauge',
      `rustdesk_control_plane_active_sessions ${summary.activeSessions}`,
      '# HELP rustdesk_control_plane_communication_events Communication events persisted.',
      '# TYPE rustdesk_control_plane_communication_events gauge',
      `rustdesk_control_plane_communication_events ${summary.communicationEvents || 0}`,
    ];
    for (const metric of this.counters.values()) {
      const labels = metric.entries.length ? `{${metric.entries.map(([label, value]) => `${label}="${String(value).replace(/\\|"|\n/g, '\\$&')}"`).join(',')}}` : '';
      lines.push(`${metric.name}${labels} ${metric.value}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

class FixedWindowLimiter {
  constructor() {
    this.entries = new Map();
  }

  allow(scope, key, limit, windowMs) {
    const now = Date.now();
    const entryKey = `${scope}:${key}`;
    const current = this.entries.get(entryKey);
    if (!current || current.resetAt <= now) {
      this.entries.set(entryKey, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfter: 0 };
    }
    current.count += 1;
    return { allowed: current.count <= limit, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
  }
}

function redact(value) {
  return String(value)
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/\b(CONTROL_PLANE_TOKEN|ADMIN_PASSWORD|DATABASE_URL|password|token)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function remoteAddress(req) {
  if (process.env.ADMIN_TRUST_PROXY === 'Y') {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

module.exports = { FixedWindowLimiter, Metrics, redact, remoteAddress };
