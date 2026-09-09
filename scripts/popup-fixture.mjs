import http from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Synthetic popup fixture. Never loads the worker, bridge, cookies, or extension storage. */
function installSyntheticRuntime() {
  const STORAGE_KEY = 'omni-popup-synthetic-fixture-v2';
  const workerMode = new URLSearchParams(location.search).get('worker');
  const providerNames = {
    'chatgpt-web': 'ChatGPT Web', 'gemini-web': 'Gemini Web', 'zai-web': 'Z.ai Web',
    'qwen-web': 'Qwen Web', 'grok-web': 'Grok Web', 'deepseek-web': 'DeepSeek Web'
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  const initial = () => ({
    success: true,
    paired: false,
    bridge: { ready: true },
    providers: Object.entries(providerNames).map(([provider, name]) => ({
      provider, name, hasCredentials: true, connectionId: null, phase: 'unmapped',
      connections: [
        { id: `${provider}-personal`, name: 'Personal — synthetic profile', isActive: true, authType: 'apikey' },
        { id: `${provider}-work`, name: 'Work — synthetic profile', isActive: true, authType: 'apikey' },
        { id: `${provider}-disabled`, name: 'Disabled — synthetic profile', isActive: false, authType: 'apikey' },
        { id: `${provider}-unsupported`, name: 'Unsupported — synthetic profile', isActive: true, authType: 'oauth' }
      ]
    })),
    models: [
      ...Object.entries(providerNames).map(([provider, name]) => ({ id: `${provider}/synthetic-model`, provider, label: `${name} synthetic model` })),
      { id: 'chatgpt-web/synthetic-model-with-a-long-identifier-to-check-wrapping', provider: 'chatgpt-web', label: 'ChatGPT synthetic long model label to check wrapping' },
      { id: 'gemini-web/synthetic-secondary-model', provider: 'gemini-web', label: 'Gemini synthetic secondary model' },
      { id: 'openai/synthetic-official-model', provider: 'openai', label: 'Official API — must be excluded' }
    ],
    fallback: { name: 'browser-sessions', models: [], saved: false }
  });
  let status;
  try { status = JSON.parse(sessionStorage.getItem(STORAGE_KEY)) || initial(); }
  catch { status = initial(); }
  const calls = [];
  const failures = new Map();
  const persist = () => sessionStorage.setItem(STORAGE_KEY, JSON.stringify(status));
  const responseError = (code, message) => ({ success: false, error: { code, message } });

  function respond(message) {
    calls.push(clone(message));
    if (workerMode === 'legacy') return message.action === 'GET_STATUS'
      ? { success: true, extracted: {}, bridge: { success: true } }
      : { success: false, error: 'Unknown action' };
    if (workerMode === 'unknown-pair' && message.action === 'PAIR') return { success: false, error: 'Unknown action' };
    if (message.action === 'GET_STATUS') return clone(status);
    const provider = status.providers.find(row => row.provider === message.provider);
    const failure = failures.get(message.action);
    if (failure) {
      failures.delete(message.action);
      if (provider) { provider.phase = failure.phase || 'error'; provider.message = failure.message; }
      persist();
      return responseError(failure.code, failure.message);
    }
    if (message.action === 'PAIR') {
      if (message.code !== 'FIXTURE-123') return responseError('INVALID_CODE', 'Synthetic pairing code is FIXTURE-123.');
      status.paired = true;
      persist();
      return { success: true };
    }
    if (!status.paired) return responseError('PAIR_REQUIRED', 'Pair the synthetic fixture first.');
    if (message.action === 'MAP_PROVIDER') {
      if (!provider) return responseError('INVALID_PROVIDER', 'Unknown synthetic provider.');
      const connection = provider.connections.find(row => row.id === message.connectionId);
      if (message.connectionId !== null && (!connection?.isActive || connection.authType !== 'apikey')) {
        return responseError('INVALID_MAPPING', 'Choose an active synthetic browser connection.');
      }
      provider.connectionId = message.connectionId;
      provider.phase = 'unmapped';
      provider.message = 'Synthetic connection mapping saved.';
      persist();
      return { success: true };
    }
    if (message.action === 'SYNC_ONE' || message.action === 'VALIDATE_PROVIDER') {
      if (!provider?.connectionId) return responseError('INVALID_MAPPING', 'Map a synthetic connection first.');
      const validating = message.action === 'VALIDATE_PROVIDER';
      provider.phase = validating ? 'validated' : 'synced';
      provider.message = validating ? 'Synthetic connection test passed.' : 'Synthetic session synced.';
      provider[validating ? 'lastValidatedAt' : 'lastSyncedAt'] = new Date().toISOString();
      persist();
      return { success: true };
    }
    if (message.action === 'SYNC_ALL') {
      for (const row of status.providers) if (row.connectionId) { row.phase = 'synced'; row.message = 'Synthetic session synced.'; }
      persist();
      return { success: true };
    }
    if (message.action === 'SAVE_FALLBACK') {
      const allowed = new Set(status.models.filter(model => Object.hasOwn(providerNames, model.provider)).map(model => model.id));
      const models = message.models;
      if (!Array.isArray(models) || models.length < 1 || models.length > 8 || new Set(models).size !== models.length || models.some(id => !allowed.has(id))) {
        return responseError('INVALID_MODELS', 'Choose 1–8 synthetic browser models; official API models are excluded.');
      }
      status.fallback = { name: 'browser-sessions', models: [...models], saved: true };
      persist();
      return { success: true };
    }
    return responseError('UNKNOWN_ACTION', 'Unsupported synthetic fixture action.');
  }

  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) { setTimeout(() => callback(respond(message)), 20); }
    }
  };
  globalThis.omniPopupFixture = Object.freeze({
    synthetic: true,
    snapshot: () => clone(status),
    calls: () => clone(calls),
    queueError(action, error) { failures.set(action, clone(error)); },
    reset() { status = initial(); failures.clear(); calls.length = 0; persist(); }
  });
}

const fixtureSource = `(${installSyntheticRuntime.toString()})();`;
const extensionRoot = new URL('../extension/', import.meta.url);

export function startPopupFixture(port = 20139) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'");
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    try {
      if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (pathname === '/fixture.js') {
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.end(fixtureSource);
        return;
      }
      const file = pathname === '/' || pathname === '/popup.html' ? 'popup.html'
        : pathname === '/popup.css' ? 'popup.css' : pathname === '/popup.js' ? 'popup.js' : null;
      if (!file) { response.writeHead(404).end('Synthetic fixture serves popup files only.'); return; }
      let source = await readFile(new URL(file, extensionRoot), 'utf8');
      if (file === 'popup.html') {
        source = source.replace('<body>', '<body><aside id="fixtureBanner" style="padding:8px;margin-bottom:12px;border:1px solid #f5c56e;color:#f5c56e;font-size:11px">SYNTHETIC FIXTURE · no real sessions or connections<br>Pairing code: FIXTURE-123</aside>')
          .replace('<script src="popup.js"></script>', '<script src="/fixture.js"></script><script src="popup.js"></script>')
          .replace('href="http://localhost:20128"', 'href="#fixture-only"')
          .replace('<title>OmniRoute Session Sync</title>', '<title>OmniRoute Popup — Synthetic Fixture</title>');
      }
      response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
      response.end(source);
    } catch {
      response.writeHead(500).end('Unable to serve the synthetic popup fixture.');
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Synthetic popup fixture: http://127.0.0.1:${server.address().port}/`);
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  startPopupFixture(Number(process.env.POPUP_FIXTURE_PORT || 20139));
}
