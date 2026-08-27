(function installOrgXWidgetState(global) {
  'use strict';

  if (global.OrgXWidgetState) return;

  var TERMINAL = ['done', 'complete', 'completed', 'approved', 'shipped', 'resolved', 'success'];
  var BLOCKED = ['blocked', 'at_risk', 'waiting', 'paused', 'needs_input', 'needs_review'];
  var ACTIVE = ['running', 'active', 'executing', 'in_progress', 'working'];
  var QUEUED = ['queued', 'pending', 'not_started', 'todo', 'backlog', 'draft'];

  function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  function first(record, keys) {
    if (!record || typeof record !== 'object') return null;
    for (var i = 0; i < keys.length; i += 1) {
      var value = text(record[keys[i]]);
      if (value) return value;
    }
    return null;
  }

  function timestamp(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number' && isFinite(value)) {
      return value < 100000000000 ? value * 1000 : value;
    }
    if (typeof value !== 'string' || !value.trim()) return null;
    var parsed = Date.parse(value);
    return isFinite(parsed) ? parsed : null;
  }

  function observedAt(value) {
    if (!value || typeof value !== 'object') return null;
    var fields = [
      'observed_at', 'observedAt', 'updated_at', 'updatedAt', 'last_synced_at',
      'lastSyncedAt', 'refreshed_at', 'refreshedAt', 'generated_at', 'generatedAt',
      'last_heartbeat_at', 'lastHeartbeatAt', 'heartbeat_at', 'heartbeatAt', 'completed_at', 'completedAt',
      'created_at', 'createdAt'
    ];
    var direct = null;
    for (var i = 0; i < fields.length; i += 1) {
      var candidate = timestamp(value[fields[i]]);
      if (candidate !== null && (direct === null || candidate > direct)) direct = candidate;
    }
    if (direct !== null) return direct;
    var nested = value.structuredContent || value.result || value.output || value.toolOutput;
    if (nested && nested !== value) return observedAt(nested);
    return null;
  }

  function normalize(value) {
    var slug = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (TERMINAL.indexOf(slug) !== -1) return 'completed';
    if (BLOCKED.indexOf(slug) !== -1) return 'blocked';
    if (ACTIVE.indexOf(slug) !== -1) return 'in_progress';
    if (QUEUED.indexOf(slug) !== -1) return 'queued';
    if (['failed', 'error', 'cancelled', 'canceled'].indexOf(slug) !== -1) return 'failed';
    if (['stalled', 'stale', 'outdated'].indexOf(slug) !== -1) return 'stale';
    return slug || 'unknown';
  }

  function ageMs(record, now) {
    var at = observedAt(record);
    return at === null ? null : Math.max(0, (now || Date.now()) - at);
  }

  function hasExecutionEvidence(record) {
    return !!first(record, [
      'run_id', 'runId', 'execution_id', 'executionId', 'job_id', 'jobId',
      'receipt_id', 'receiptId', 'execution_url', 'executionUrl', 'live_url', 'liveUrl'
    ]);
  }

  function derive(record, options) {
    var value = record && typeof record === 'object' ? record : {};
    var now = options && options.now ? options.now : Date.now();
    var staleAfterMs = options && options.staleAfterMs ? options.staleAfterMs : 120000;
    var base = normalize(first(value, ['status', 'state', 'phase', 'execution_status', 'executionState']));
    var age = ageMs(value, now);
      var heartbeatAge = ageMs({
      last_heartbeat_at: first(value, ['last_heartbeat_at', 'lastHeartbeatAt', 'heartbeat_at', 'heartbeatAt'])
      }, now);
    var state = base;

    if (base === 'in_progress') {
      // A running label without a current heartbeat or execution evidence is
      // a handoff, not proof of live work. Keep it visible, but honest.
      if (heartbeatAge !== null && heartbeatAge > staleAfterMs) state = 'stale';
      else if (heartbeatAge === null && age !== null && age > staleAfterMs) state = 'stale';
      else if (heartbeatAge === null && !hasExecutionEvidence(value)) state = 'starting';
      else state = 'in_progress';
    }
    if (base === 'unknown' && hasExecutionEvidence(value)) state = 'starting';

    var labels = {
      starting: 'Starting',
      in_progress: 'In progress',
      queued: 'Queued',
      completed: 'Completed',
      blocked: 'Blocked',
      stale: 'Needs refresh',
      failed: 'Failed',
      unknown: 'Awaiting state'
    };
    var descriptions = {
      starting: 'Dispatch accepted. Waiting for the execution receipt.',
      in_progress: 'A current heartbeat confirms work is moving.',
      queued: 'Accepted and waiting for an execution slot.',
      completed: 'The execution finished and its result is available.',
      blocked: 'Work is paused until the listed blocker is resolved.',
      stale: 'The last state is older than the live window. Open the current run before acting.',
      failed: 'Execution ended without a successful result.',
      unknown: 'OrgX has not returned a reliable execution state yet.'
    };
    return {
      state: state,
      label: labels[state] || 'Awaiting state',
      description: descriptions[state] || descriptions.unknown,
      observedAt: observedAt(value),
      ageMs: age,
      hasExecutionEvidence: hasExecutionEvidence(value),
      isFresh: age === null || age <= staleAfterMs,
      isTerminal: state === 'completed' || state === 'failed',
      staleAfterMs: staleAfterMs
    };
  }

  function formatAge(value, now) {
    var at = typeof value === 'object' ? observedAt(value) : timestamp(value);
    if (at === null) return 'Sync time unavailable';
    var seconds = Math.max(0, Math.round(((now || Date.now()) - at) / 1000));
    if (seconds < 3) return 'Updated just now';
    if (seconds < 60) return 'Updated ' + seconds + 's ago';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return 'Updated ' + minutes + 'm ago';
    var hours = Math.round(minutes / 60);
    return 'Updated ' + hours + 'h ago';
  }

  global.OrgXWidgetState = Object.freeze({
    normalize: normalize,
    observedAt: observedAt,
    derive: derive,
    formatAge: formatAge,
    hasExecutionEvidence: hasExecutionEvidence
  });
})(window);
