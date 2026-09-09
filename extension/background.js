import { PROVIDERS, extractForProvider, matchCookieProvider } from './lib/cookieExtractors.js';
import { createSyncCoordinator } from './lib/syncCoordinator.js';

const BRIDGE_URL = 'http://127.0.0.1:20129';
const PAIRING_KEY = 'sessionSyncPairingV2';
const STATUS_KEY = 'sessionSyncStatusV2';
const ALARM_NAME = 'omniroute-session-sync-reconcile-v2';
const PHASES = new Set(['unmapped', 'pending', 'synced', 'validated', 'login-required', 'error']);
const ACTIONS = new Set(['GET_STATUS', 'PAIR', 'MAP_PROVIDER', 'SYNC_ONE', 'SYNC_ALL', 'VALIDATE_PROVIDER', 'SAVE_FALLBACK']);
const emptyStatus = () => ({ providers: [], models: [], fallback: { name: 'browser-sessions', models: [], saved: false } });
let pairingToken = '';
let pairingEpoch = 0;
let statusEpoch = 0;
let cached = emptyStatus();
let reconcilePromise = null;

function fault(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

function cleanText(value, secrets = [], fallback = '') {
  let text = typeof value === 'string' ? value : fallback;
  for (const secret of [pairingToken, ...secrets]) {
    if (!secret) continue;
    text = text.split(secret).join('[redacted]');
    const fragments = secret.split(';').map(part => part.slice(part.indexOf('=') + 1).trim());
    for (const fragment of fragments) if (fragment.length >= 4) text = text.split(fragment).join('[redacted]');
  }
  return text.slice(0, 600);
}

function publicError(error) {
  return {
    code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'REQUEST_FAILED',
    message: cleanText(typeof error === 'string' ? error : error?.message, [], 'The extension request could not be completed.')
  };
}

function providerRow(value, secrets = []) {
  if (!value || !Object.hasOwn(PROVIDERS, value.provider)) return null;
  return {
    provider: value.provider,
    name: PROVIDERS[value.provider].name,
    connectionId: typeof value.connectionId === 'string' && value.connectionId ? value.connectionId : null,
    connections: Array.isArray(value.connections) ? value.connections.filter(connection => typeof connection?.id === 'string' && connection.id).map(connection => ({
      id: connection.id,
      name: cleanText(connection.name, secrets, connection.id),
      isActive: connection.isActive === true,
      authType: typeof connection.authType === 'string' ? connection.authType : ''
    })) : [],
    phase: PHASES.has(value.phase) ? value.phase : 'unmapped',
    message: cleanText(value.message, secrets),
    revision: Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : 0,
    ...(typeof value.lastSyncedAt === 'string' ? { lastSyncedAt: value.lastSyncedAt } : {}),
    ...(typeof value.lastValidatedAt === 'string' ? { lastValidatedAt: value.lastValidatedAt } : {})
  };
}

function statusSnapshot(value, secrets = []) {
  const providers = Array.isArray(value?.providers) ? value.providers.map(row => providerRow(row, secrets)).filter(Boolean) : [];
  const models = Array.isArray(value?.models) ? value.models.filter(model => Object.hasOwn(PROVIDERS, model?.provider) && typeof model.id === 'string' && model.id).map(model => ({
    id: model.id, provider: model.provider, label: cleanText(model.label, secrets, model.id)
  })) : [];
  const fallback = {
    name: 'browser-sessions',
    models: Array.isArray(value?.fallback?.models) ? value.fallback.models.filter(id => typeof id === 'string').slice(0, 8) : [],
    saved: value?.fallback?.saved === true
  };
  return { providers, models, fallback };
}

async function saveCache(next) {
  const safe = statusSnapshot(next);
  if (JSON.stringify(safe) !== JSON.stringify(cached)) {
    await chrome.storage.local.set({ [STATUS_KEY]: safe });
    cached = safe;
  }
}

async function forgetPairing(expectedToken) {
  if (pairingToken !== expectedToken) return;
  pairingToken = '';
  pairingEpoch++;
  cached = emptyStatus();
  await chrome.storage.local.remove([PAIRING_KEY, STATUS_KEY]);
  await coordinator.invalidateAll();
}

async function request(path, { method = 'GET', body } = {}) {
  const authenticated = path.startsWith('/api/') && path !== '/api/pair';
  const tokenForRequest = pairingToken;
  if (authenticated && !tokenForRequest) throw fault('PAIR_REQUIRED', 'Pair this browser with the local bridge first.');
  const controller = new AbortController();
  const timeoutMs = path === '/health' || path === '/api/pair' || path === '/api/needed' ? 5000 : 25000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/json' };
    if (authenticated) headers.Authorization = `Bearer ${tokenForRequest}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${BRIDGE_URL}${path}`, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error'
    });
    let result;
    try { result = await response.json(); }
    catch { throw fault('INVALID_RESPONSE', 'The local bridge returned an unreadable response.', response.status); }
    if (!response.ok || (path !== '/health' && result?.success !== true)) {
      if (authenticated && response.status === 401) await forgetPairing(tokenForRequest);
      const detail = typeof result?.error === 'string' ? result.error : result?.error?.message;
      throw fault(result?.error?.code || 'BRIDGE_REJECTED', cleanText(detail, [tokenForRequest], 'The local bridge rejected the request.'), response.status);
    }
    if (path === '/health' && (result?.service !== 'omniroute-session-sync' || result.version !== '2.0.0')) {
      throw fault('INCOMPATIBLE_BRIDGE', 'Start the session-sync v2 bridge on port 20129.');
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw fault('BRIDGE_TIMEOUT', 'The local bridge did not respond in time. Pending sessions will retry.');
    if (typeof error?.code === 'string') throw error;
    throw fault('BRIDGE_OFFLINE', 'The local bridge is unavailable. Start it, then Refresh.');
  } finally {
    clearTimeout(timeout);
  }
}

const coordinator = createSyncCoordinator({
  storage: chrome.storage.local,
  request,
  extract: provider => extractForProvider(provider, url => chrome.cookies.getAll({ url }))
});

const initialized = (async () => {
  if (typeof chrome.storage.local.setAccessLevel === 'function') {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
  const saved = await chrome.storage.local.get([PAIRING_KEY, STATUS_KEY]);
  const token = saved?.[PAIRING_KEY]?.token;
  pairingToken = typeof token === 'string' && token.length <= 4096 && !/[\r\n\0]/.test(token) ? token : '';
  cached = statusSnapshot(saved?.[STATUS_KEY]);
  await coordinator.ready;
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm || alarm.periodInMinutes !== 1) await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: 1 });
  await chrome.alarms.clear('omniroute-periodic-sync');
})();

async function reconcile() {
  await initialized;
  if (!pairingToken) return { success: true, skipped: true };
  if (!reconcilePromise) {
    reconcilePromise = coordinator.reconcile().finally(() => { reconcilePromise = null; });
  }
  return reconcilePromise;
}

async function getStatus() {
  const epoch = pairingEpoch;
  const statusVersion = statusEpoch;
  const reading = Promise.all(Object.keys(PROVIDERS).map(async provider => {
    try {
      const extracted = await extractForProvider(provider, url => chrome.cookies.getAll({ url }));
      return { provider, hasCredentials: extracted.hasCredentials === true, secret: extracted.cookieValue };
    } catch {
      return { provider, hasCredentials: false, secret: '', error: 'Unable to read this browser session.' };
    }
  }));
  let bridge = { ready: false };
  let gateway = null;
  try {
    const health = await request('/health');
    if (pairingToken) {
      gateway = await request('/api/status');
      bridge = {
        ready: health.ready === true && gateway.bridge?.ready === true,
        ...(!(health.ready === true && gateway.bridge?.ready === true) ? {
          error: cleanText(typeof gateway.bridge?.error === 'string' ? gateway.bridge.error : gateway.bridge?.error?.message, [], 'The bridge cannot reach a ready OmniRoute instance.')
        } : {})
      };
    } else {
      bridge = { ready: false, error: 'Pair this browser with the local bridge.' };
    }
  } catch (error) {
    bridge = { ready: false, error: publicError(error).message };
  }
  const extracted = await reading;
  const secrets = extracted.map(item => item.secret).filter(Boolean);
  if (gateway && epoch === pairingEpoch && statusVersion === statusEpoch && pairingToken) {
    const next = statusSnapshot(gateway, secrets);
    const providerMap = new Map(cached.providers.map(row => [row.provider, row]));
    for (const row of next.providers) providerMap.set(row.provider, row);
    await saveCache({
      providers: [...providerMap.values()],
      models: bridge.ready || next.models.length ? next.models : cached.models,
      fallback: bridge.ready || next.fallback.saved ? next.fallback : cached.fallback
    });
  }
  const local = await coordinator.getLocalStatus();
  const providers = Object.entries(PROVIDERS).map(([provider, meta]) => {
    const row = providerRow(cached.providers.find(item => item.provider === provider) || { provider }, secrets);
    const browser = extracted.find(item => item.provider === provider);
    const pending = local[provider];
    let phase = row.connectionId ? row.phase : 'unmapped';
    let message = row.message;
    if (row.connectionId && !browser.hasCredentials) {
      phase = 'login-required';
      message = browser.error || 'Sign in to this provider in the browser before syncing.';
    } else if (row.connectionId && (pending.phase === 'error' || pending.phase === 'pending' || pending.phase === 'login-required')) {
      phase = pending.phase;
      message = pending.message;
    } else if (row.connectionId && pending.phase === 'validated'
        && !(Date.parse(row.lastSyncedAt) > Date.parse(pending.lastValidatedAt))) {
      phase = 'validated';
      message = pending.message;
    } else if (row.connectionId && pending.phase === 'synced'
        && (row.phase !== 'validated' || Date.parse(pending.lastSyncedAt) > Date.parse(row.lastValidatedAt || '1970-01-01'))) {
      phase = 'synced';
      message = pending.message;
    }
    return {
      provider, name: meta.name, hasCredentials: browser.hasCredentials,
      connectionId: row.connectionId, connections: row.connections,
      phase, message: cleanText(message, secrets), revision: row.revision,
      ...(pending.lastSyncedAt || row.lastSyncedAt ? { lastSyncedAt: pending.lastSyncedAt || row.lastSyncedAt } : {}),
      ...(pending.lastValidatedAt || row.lastValidatedAt ? { lastValidatedAt: pending.lastValidatedAt || row.lastValidatedAt } : {})
    };
  });
  return {
    success: true, paired: Boolean(pairingToken),
    bridge: { ...bridge, ...(bridge.error ? { error: cleanText(bridge.error, secrets) } : {}) },
    providers, models: statusSnapshot(cached, secrets).models, fallback: cached.fallback
  };
}

async function pair(code) {
  if (typeof code !== 'string' || !code.trim() || code.length > 128) throw fault('INVALID_CODE', 'Enter the pairing code shown in the terminal.');
  await request('/health');
  const result = await request('/api/pair', { method: 'POST', body: { code: code.trim() } });
  if (typeof result.token !== 'string' || !result.token || result.token.length > 4096 || /[\r\n\0]/.test(result.token)) {
    throw fault('INVALID_RESPONSE', 'The bridge did not provide a valid pairing token.');
  }
  const next = emptyStatus();
  await chrome.storage.local.set({ [PAIRING_KEY]: { token: result.token }, [STATUS_KEY]: next });
  pairingToken = result.token;
  pairingEpoch++;
  statusEpoch++;
  cached = next;
  await coordinator.invalidateAll();
  void reconcile().catch(() => {});
  return { success: true };
}

async function mapProvider(provider, connectionId) {
  const result = await coordinator.updateMapping(provider, connectionId);
  if (result.success) {
    statusEpoch++;
    const rows = cached.providers.filter(row => row.provider !== provider);
    const previous = cached.providers.find(row => row.provider === provider) || { provider };
    const row = providerRow({ ...previous, connectionId, revision: 0, phase: connectionId ? 'pending' : 'unmapped', message: '' });
    delete row.lastSyncedAt;
    delete row.lastValidatedAt;
    rows.push(row);
    await saveCache({ ...cached, providers: rows });
  }
  return result;
}

async function saveFallback(models) {
  if (!Array.isArray(models) || models.length < 1 || models.length > 8 || new Set(models).size !== models.length
      || models.some(id => typeof id !== 'string' || !id)) throw fault('INVALID_MODELS', 'Choose 1–8 distinct browser models in fallback order.');
  const status = await request('/api/status');
  const available = new Set(statusSnapshot(status).models.map(model => model.id));
  if (models.some(id => !available.has(id))) throw fault('INVALID_MODELS', 'Choose available browser models. Official API models cannot be added here.');
  await request('/api/fallback', { method: 'POST', body: { models } });
  statusEpoch++;
  await saveCache({ ...cached, fallback: { name: 'browser-sessions', models: [...models], saved: true } });
  return { success: true };
}

async function handleMessage(message) {
  await initialized;
  switch (message.action) {
    case 'GET_STATUS': return getStatus();
    case 'PAIR': return pair(message.code);
    case 'MAP_PROVIDER': return mapProvider(message.provider, message.connectionId);
    case 'SYNC_ONE': return coordinator.syncProvider(message.provider, { force: true });
    case 'SYNC_ALL': return coordinator.reconcile({ force: true });
    case 'VALIDATE_PROVIDER': return coordinator.validateProvider(message.provider);
    case 'SAVE_FALLBACK': return saveFallback(message.models);
    default: throw fault('UNKNOWN_ACTION', 'This extension action is not supported.');
  }
}

// Register event listeners synchronously so Chrome can wake this module worker.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender?.id !== chrome.runtime.id || !ACTIONS.has(message?.action)) {
    sendResponse({ success: false, error: { code: 'INVALID_REQUEST', message: 'This extension request is not supported.' } });
    return false;
  }
  void handleMessage(message).then(sendResponse, error => sendResponse({ success: false, error: publicError(error) }));
  return true;
});

chrome.cookies.onChanged.addListener(change => {
  const provider = matchCookieProvider(change?.cookie?.domain, change?.cookie?.name);
  if (provider) void initialized.then(() => pairingToken ? coordinator.notifyCookieChange(provider) : undefined).catch(() => {});
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) void reconcile().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { void reconcile().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { void reconcile().catch(() => {}); });
void reconcile().catch(() => {});
