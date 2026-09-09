import { PROVIDERS, validCredential } from './cookieExtractors.js';

export const COORDINATOR_STORAGE_KEY = 'sessionSyncCoordinatorV2';
const PHASES = new Set(['unmapped', 'pending', 'synced', 'validated', 'login-required', 'error']);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const revisionOf = value => positiveInteger(value) ? value : 0;
const fault = (code, message) => Object.assign(new Error(message), { code });

function safeError(error, secret = '') {
  let message = typeof error?.message === 'string' ? error.message : 'The local bridge request failed.';
  if (secret) message = message.split(secret).join('[redacted]');
  const fragments = secret.split(';').map(part => part.slice(part.indexOf('=') + 1).trim());
  for (const fragment of fragments) if (fragment.length >= 4) message = message.split(fragment).join('[redacted]');
  return {
    code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'REQUEST_FAILED',
    message: message.slice(0, 400)
  };
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function restoredEntry(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const ack = value.ack && /^[a-f0-9]{64}$/.test(value.ack.fingerprint)
    && typeof value.ack.connectionId === 'string' && value.ack.connectionId
    && positiveInteger(value.ack.revision)
    ? { fingerprint: value.ack.fingerprint, connectionId: value.ack.connectionId, revision: value.ack.revision } : null;
  return {
    pending: value.pending === true,
    phase: PHASES.has(value.phase) ? value.phase : 'unmapped',
    revision: Math.max(revisionOf(value.revision), ack?.revision || 0),
    ack,
    // Persisted messages are ours; raw extraction and bridge payloads are never stored.
    message: typeof value.message === 'string' ? value.message.slice(0, 400) : '',
    ...(typeof value.lastSyncedAt === 'string' ? { lastSyncedAt: value.lastSyncedAt } : {}),
    ...(typeof value.lastValidatedAt === 'string' ? { lastValidatedAt: value.lastValidatedAt } : {})
  };
}

export function createSyncCoordinator({
  storage, request, extract, now = Date.now, hash = sha256,
  setTimer = setTimeout, clearTimer = clearTimeout, debounceMs = 3000
}) {
  const ids = Object.keys(PROVIDERS);
  const entries = Object.fromEntries(ids.map(id => [id, restoredEntry()]));
  const runtime = new Map(ids.map(id => [id, {
    timer: null, syncPromise: null, tail: Promise.resolve(), requested: false,
    force: false, version: 0, epoch: 0
  }]));
  let storageTail = Promise.resolve();
  let disposed = false;
  const ready = (async () => {
    const saved = await storage.get(COORDINATOR_STORAGE_KEY);
    const previous = saved?.[COORDINATOR_STORAGE_KEY]?.providers;
    for (const id of ids) entries[id] = restoredEntry(previous?.[id]);
  })();
  void ready.catch(() => {});

  function checkProvider(provider) {
    if (!Object.hasOwn(PROVIDERS, provider)) throw fault('UNSUPPORTED_PROVIDER', 'Choose a supported browser provider.');
  }

  function persist() {
    const snapshot = JSON.parse(JSON.stringify({ version: 2, providers: entries }));
    const write = storageTail.then(() => storage.set({ [COORDINATOR_STORAGE_KEY]: snapshot }));
    storageTail = write.catch(() => {});
    return write.catch(() => { throw fault('STORAGE_FAILED', 'Unable to save extension state. Sync will retry after storage is available.'); });
  }

  function serial(provider, operation) {
    const local = runtime.get(provider);
    const result = local.tail.then(operation);
    local.tail = result.catch(() => {});
    return result;
  }

  async function bridge(path, options) {
    const result = await request(path, options);
    if (!result?.success) throw fault(result?.error?.code || 'REQUEST_FAILED',
      typeof result?.error === 'string' ? result.error : result?.error?.message || 'The local bridge rejected the request.');
    return result;
  }

  async function neededRow(provider) {
    const status = await bridge('/api/needed');
    return Array.isArray(status.providers) ? status.providers.find(row => row.provider === provider) : null;
  }

  function activeMapping(row) {
    return typeof row?.connectionId === 'string' && Array.isArray(row.connections)
      && row.connections.some(connection => connection.id === row.connectionId && connection.isActive === true && connection.authType === 'apikey');
  }

  function canceled(provider) {
    return { provider, success: false, attempted: false, skipped: false, phase: 'pending',
      error: { code: 'PAIRING_CHANGED', message: 'Pairing changed. This provider will be reconciled again.' } };
  }

  async function pass(provider, force, version, epoch) {
    const entry = entries[provider];
    const local = runtime.get(provider);
    let cookie = '';
    let assigningAck = false;
    try {
      entry.pending = true;
      entry.phase = 'pending';
      entry.message = 'Waiting for the bridge to accept this session.';
      await persist();
      const row = await neededRow(provider);
      if (local.epoch !== epoch) return canceled(provider);
      if (!row) throw fault('STATUS_UNAVAILABLE', 'This provider status is unavailable. Pending sync will retry when the gateway is ready.');
      if (!row.connectionId) {
        entry.pending = local.version !== version;
        entry.phase = 'unmapped';
        entry.message = 'Choose an active OmniRoute connection.';
        entry.ack = null;
        await persist();
        return { provider, success: true, skipped: true, attempted: false, phase: 'unmapped' };
      }
      if (!activeMapping(row)) throw fault('INVALID_MAPPING', 'The mapped connection is disabled or unsupported. Choose an active browser connection.');
      let extracted;
      try { extracted = await extract(provider); }
      catch { throw fault('EXTRACTION_FAILED', 'Unable to read this browser session. Try again after the browser is ready.'); }
      cookie = typeof extracted?.cookieValue === 'string' ? extracted.cookieValue : '';
      if (!extracted?.hasCredentials || !validCredential(provider, cookie)) {
        entry.pending = local.version !== version;
        entry.phase = 'login-required';
        entry.message = 'Sign in to this provider in the browser before syncing.';
        await persist();
        return { provider, success: false, skipped: true, attempted: false, phase: 'login-required',
          error: { code: 'LOGIN_REQUIRED', message: entry.message } };
      }
      const fingerprint = await hash(cookie);
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw fault('HASH_FAILED', 'Unable to fingerprint this browser session.');
      if (local.epoch !== epoch) return canceled(provider);
      const serverRevision = revisionOf(row.revision);
      if (!force && entry.ack?.fingerprint === fingerprint && entry.ack.connectionId === row.connectionId
          && entry.ack.revision === serverRevision) {
        entry.pending = local.version !== version || local.requested;
        entry.phase = entry.pending ? 'pending' : PHASES.has(row.phase) ? row.phase : 'synced';
        entry.message = entry.pending ? 'A newer browser change is waiting.' : 'The acknowledged session is unchanged.';
        await persist();
        return { provider, success: true, skipped: true, attempted: false, phase: entry.phase, revision: serverRevision };
      }
      const revision = Math.max(Math.floor(now()), entry.revision + 1, serverRevision + 1);
      if (!positiveInteger(revision)) throw fault('REVISION_OVERFLOW', 'Unable to allocate a safe session revision.');
      entry.revision = revision;
      await persist();
      if (local.epoch !== epoch) return canceled(provider);
      const result = await bridge('/api/sync', { method: 'POST', body: {
        provider, connectionId: row.connectionId, cookie, revision, force: Boolean(force)
      } });
      if (local.epoch !== epoch) return canceled(provider);
      const acknowledgedRevision = revisionOf(result.revision) || revision;
      entry.revision = Math.max(entry.revision, acknowledgedRevision);
      if (result.stale) throw fault('STALE_REVISION', 'The bridge has a newer update. This session remains pending for retry.');
      assigningAck = true;
      entry.ack = { fingerprint, connectionId: row.connectionId, revision: acknowledgedRevision };
      entry.pending = local.version !== version || local.requested;
      entry.phase = entry.pending ? 'pending' : PHASES.has(result.phase) ? result.phase : 'synced';
      entry.message = entry.pending ? 'A newer browser change is waiting.' : 'Session synced. Test the connection to verify access.';
      entry.lastSyncedAt = new Date(now()).toISOString();
      await persist();
      return { provider, success: true, attempted: true, skipped: Boolean(result.skipped), phase: entry.phase, revision: acknowledgedRevision };
    } catch (error) {
      if (local.epoch !== epoch) return canceled(provider);
      if (assigningAck) entry.ack = null;
      const safe = safeError(error, cookie);
      entry.pending = true;
      entry.phase = 'error';
      entry.message = safe.message;
      try { await persist(); } catch { /* Keep the in-memory retry marker if storage is temporarily unavailable. */ }
      return { provider, success: false, attempted: true, skipped: false, phase: 'error', error: safe };
    }
  }

  async function syncProvider(provider, { force = false } = {}) {
    checkProvider(provider);
    await ready;
    if (disposed) return canceled(provider);
    const local = runtime.get(provider);
    if (local.timer !== null) { clearTimer(local.timer); local.timer = null; }
    local.requested = true;
    local.force ||= force;
    if (local.syncPromise) return local.syncPromise;
    const work = serial(provider, async () => {
      let result;
      do {
        local.requested = false;
        const nextForce = local.force;
        local.force = false;
        result = await pass(provider, nextForce, local.version, local.epoch);
      } while (!disposed && local.requested && local.timer === null);
      return result;
    });
    const completion = work.finally(() => { if (local.syncPromise === completion) local.syncPromise = null; });
    local.syncPromise = completion;
    return completion;
  }

  async function notifyCookieChange(provider) {
    checkProvider(provider);
    await ready;
    if (disposed) return;
    const local = runtime.get(provider);
    local.version++;
    local.requested = true;
    entries[provider].pending = true;
    entries[provider].phase = 'pending';
    entries[provider].message = 'Browser session changed. Waiting to sync.';
    await persist();
    if (local.timer !== null) clearTimer(local.timer);
    local.timer = setTimer(() => {
      local.timer = null;
      void syncProvider(provider).catch(() => {});
    }, debounceMs);
  }

  async function reconcile({ force = false } = {}) {
    await ready;
    const results = await Promise.all(ids.map(provider => syncProvider(provider, { force })));
    const failures = results.filter(result => !result.success && !result.skipped);
    return {
      success: failures.length === 0,
      synced: results.filter(result => result.success && !result.skipped && result.attempted).length,
      skipped: results.filter(result => result.skipped).length,
      results,
      ...(failures.length ? { error: { code: 'SYNC_FAILED', message: `${failures.length} provider sync request(s) failed. Check each provider status.` } } : {})
    };
  }

  async function invalidateAll() {
    await ready;
    for (const provider of ids) {
      const local = runtime.get(provider);
      local.epoch++;
      local.version++;
      local.requested = false;
      local.force = false;
      if (local.timer !== null) { clearTimer(local.timer); local.timer = null; }
      Object.assign(entries[provider], { ack: null, pending: true, phase: 'pending', message: 'Pairing changed. Waiting to reconcile mappings.' });
      delete entries[provider].lastSyncedAt;
      delete entries[provider].lastValidatedAt;
    }
    await persist();
  }

  async function updateMapping(provider, connectionId) {
    checkProvider(provider);
    if (connectionId !== null && (typeof connectionId !== 'string' || !connectionId)) throw fault('INVALID_MAPPING', 'Choose a connection or clear the mapping.');
    await ready;
    return serial(provider, async () => {
      const entry = entries[provider];
      try {
        if (connectionId !== null) {
          const row = await neededRow(provider);
          if (!activeMapping({ ...row, connectionId })) throw fault('INVALID_MAPPING', 'Choose an active browser connection.');
        }
        await bridge('/api/mappings', { method: 'POST', body: { provider, connectionId } });
        const local = runtime.get(provider);
        local.epoch++;
        local.version++;
        entry.ack = null;
        entry.pending = connectionId !== null;
        entry.phase = connectionId === null ? 'unmapped' : 'pending';
        entry.message = connectionId === null ? 'Choose an active OmniRoute connection.' : 'Connection mapped. Waiting to sync.';
        delete entry.lastSyncedAt;
        delete entry.lastValidatedAt;
        await persist();
        if (connectionId !== null) await notifyCookieChange(provider);
        return { success: true };
      } catch (error) {
        return { success: false, error: safeError(error) };
      }
    });
  }

  async function validateProvider(provider) {
    checkProvider(provider);
    await ready;
    return serial(provider, async () => {
      const entry = entries[provider];
      const local = runtime.get(provider);
      const epoch = local.epoch;
      const version = local.version;
      const wasPending = entry.pending;
      try {
        const row = await neededRow(provider);
        if (!activeMapping(row)) throw fault('INVALID_MAPPING', 'Choose an active browser connection before testing.');
        entry.phase = 'pending';
        entry.message = 'Testing the saved connection.';
        await persist();
        const result = await bridge('/api/validate', { method: 'POST', body: { provider } });
        if (local.epoch !== epoch) return canceled(provider);
        const valid = result.valid === true;
        const completedPhase = valid ? 'validated' : PHASES.has(result.phase) && result.phase !== 'validated' ? result.phase : 'error';
        const defaults = {
          validated: 'The connection test passed.',
          synced: 'This provider does not support a connection test. The session remains synced.',
          'login-required': 'The session is no longer valid. Sign in again, then sync and test.',
          error: 'The connection test could not be completed. Try testing again.'
        };
        const suppliedMessage = typeof result.message === 'string' && result.message.trim()
          ? result.message : result.error?.message;
        entry.pending = wasPending || local.version !== version;
        entry.phase = local.version !== version ? 'pending' : completedPhase;
        entry.message = safeError({ message: suppliedMessage || defaults[completedPhase] || 'The connection test did not validate this session.' }).message;
        if (valid) entry.lastValidatedAt = new Date(now()).toISOString();
        await persist();
        return { success: valid, valid, phase: entry.phase,
          ...(!valid ? { error: {
            code: completedPhase === 'synced' ? 'VALIDATION_UNSUPPORTED' : completedPhase === 'login-required' ? 'LOGIN_REQUIRED' : 'VALIDATION_FAILED',
            message: entry.message
          } } : {}) };
      } catch (error) {
        if (local.epoch !== epoch) return canceled(provider);
        const safe = safeError(error);
        entry.phase = 'error';
        entry.message = safe.message;
        try { await persist(); } catch { /* The error still reaches the popup. */ }
        return { success: false, error: safe, phase: 'error' };
      }
    });
  }

  async function getLocalStatus() {
    await ready;
    return Object.fromEntries(ids.map(provider => {
      const { phase, pending, message, lastSyncedAt, lastValidatedAt } = entries[provider];
      return [provider, { phase, pending, message, lastSyncedAt, lastValidatedAt }];
    }));
  }

  function dispose() {
    disposed = true;
    for (const local of runtime.values()) if (local.timer !== null) clearTimer(local.timer);
  }

  return { ready, syncProvider, notifyCookieChange, reconcile, invalidateAll, updateMapping, validateProvider, getLocalStatus, dispose };
}
