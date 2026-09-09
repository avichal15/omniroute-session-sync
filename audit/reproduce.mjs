/**
 * Audit reproductions. These assertions confirm defects in the audited source;
 * a passing run is NOT a claim that the application is correct.
 * Uses synthetic cookies, in-memory SQLite, mocked Chrome APIs and HTTP handlers.
 * Never opens a browser, binds a port, or opens the user's OmniRoute database.
 * Run from any directory: node --test C:/omni/audit/reproduce.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const omniRoot = process.env.OMNIROUTE_INSTALL_DIR || path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'omniroute');
const Database = require(`${omniRoot}/node_modules/better-sqlite3`);
const syntheticSecret = '0123456789abcdef'.repeat(4);
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const stripModule = text => text.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const quietConsole = { log() {}, error() {}, warn() {} };

function dbFixture({ secret = syntheticSecret, envText = null } = {}) {
  const source = stripModule(read('bridge/dbUpdater.mjs'))
    .replace(/^const require = .*;\r?\n/gm, '')
    .replace(/^const Database = require\(.*\);\r?\n/gm, '');
  const ctx = vm.createContext({
    ...crypto, Buffer, console: quietConsole,
    process: { env: secret ? { STORAGE_ENCRYPTION_KEY: secret } : {} },
    fs: {
      existsSync: () => envText !== null,
      readFileSync: () => { assert.notEqual(envText, null); return envText; },
    },
    Database: function MemoryOnlyDatabase(dbPath) {
      assert.equal(dbPath, ':memory:', 'Audit must never open an on-disk database');
      return new Database(':memory:');
    },
  });
  vm.runInContext(source, ctx, { filename: 'bridge/dbUpdater.mjs' });
  const api = vm.runInContext('({initDb, encrypt, decrypt, getMonitoredProviders, updateProviderCookie})', ctx);
  const { db, hasKey } = api.initDb({ dbPath: ':memory:', envPath: 'synthetic.env' });
  db.exec(`CREATE TABLE provider_connections (
    id TEXT PRIMARY KEY, provider TEXT, auth_type TEXT DEFAULT 'apikey',
    is_active INTEGER DEFAULT 1, test_status TEXT DEFAULT 'expired',
    last_tested TEXT, updated_at TEXT, api_key TEXT,
    last_error TEXT, last_error_at TEXT, error_code TEXT
  )`);
  const insert = (id, provider, value, active = 1) => db.prepare(
    'INSERT INTO provider_connections (id, provider, api_key, is_active) VALUES (?, ?, ?, ?)'
  ).run(id, provider, api.encrypt(value), active);
  return { ...api, db, hasKey, insert };
}

function serverFixture(api) {
  let handler;
  const source = stripModule(read('bridge/server.mjs'))
    .replace(/^const __filename = .*;\r?\n/gm, '')
    .replace(/^const __dirname = .*;\r?\n/gm, '');
  vm.runInNewContext(source, {
    ...api, URL, path, __dirname: path.join(root, 'bridge'), console: quietConsole,
    fs: { readFileSync: () => JSON.stringify({ port: 0, host: '127.0.0.1', logLimit: 100 }) },
    http: { createServer(fn) { handler = fn; return { listen(_port, _host, callback) { callback(); } }; } },
  }, { filename: 'bridge/server.mjs' });
  return async function request(method, url, payload, headers = {}) {
    const req = new EventEmitter();
    Object.assign(req, { method, url, headers: { host: '127.0.0.1', ...headers } });
    const response = { headers: {}, status: null, body: null };
    const res = {
      setHeader(name, value) { response.headers[name] = value; },
      writeHead(status) { response.status = status; },
      end(body) { response.body = body ? JSON.parse(body) : null; },
    };
    await handler(req, res);
    if (payload !== undefined) req.emit('data', typeof payload === 'string' ? payload : JSON.stringify(payload));
    req.emit('end');
    return response;
  };
}

function extensionFixture({ jar = {}, fetchImpl } = {}) {
  const timers = new Map();
  const requests = [];
  const storageWrites = [];
  let serial = 0;
  let cookieListener;
  const ctx = vm.createContext({
    console: quietConsole, AbortController,
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    chrome: {
      cookies: {
        getAll: async ({ url }) => jar[url] || [],
        onChanged: { addListener(fn) { cookieListener = fn; } },
      },
      alarms: { get(_name, callback) { callback({}); }, onAlarm: { addListener() {} } },
      runtime: { onMessage: { addListener() {} } },
      storage: { local: { async set(value) { storageWrites.push(value); } } },
    },
    async fetch(url, options) {
      requests.push({ url, options });
      return fetchImpl ? fetchImpl(url, options) : { ok: true, json: async () => ({ success: true }) };
    },
  });
  vm.runInContext(read('extension/background.js'), ctx, { filename: 'extension/background.js' });
  const api = vm.runInContext('({extractDeepSeek, extractChatGPT, syncAllProviders, syncProvider})', ctx);
  return { ...api, ctx, timers, requests, storageWrites, cookieListener };
}

test('baseline: encrypted cookies round-trip with installed OmniRoute encryption', () => {
  const fixture = dbFixture();
  try {
    const upstreamSource = stripModule(fs.readFileSync(`${omniRoot}/bin/cli/encryption.mjs`, 'utf8'));
    const ctx = vm.createContext({ ...crypto, Buffer, process: { env: { STORAGE_ENCRYPTION_KEY: syntheticSecret } } });
    vm.runInContext(upstreamSource, ctx);
    const upstream = vm.runInContext('({encryptCredential, decryptCredential})', ctx);
    assert.equal(upstream.decryptCredential(fixture.encrypt('synthetic-cookie')), 'synthetic-cookie');
    assert.equal(fixture.decrypt(upstream.encryptCredential('synthetic-cookie')), 'synthetic-cookie');
  } finally { fixture.db.close(); }
});

test('reproduced: unauthenticated foreign-origin text/plain POST overwrites a non-web provider', async () => {
  const fixture = dbFixture();
  try {
    fixture.insert('api-account', 'openai', 'synthetic-original-api-key');
    const request = serverFixture(fixture);
    const response = await request('POST', '/api/sync', { provider: 'openai', cookie: 'synthetic-replacement' },
      { origin: 'https://untrusted.example', 'content-type': 'text/plain' });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(fixture.decrypt(fixture.db.prepare('SELECT api_key FROM provider_connections').get().api_key), 'synthetic-replacement');
  } finally { fixture.db.close(); }
});

test('reproduced: provider-level update overwrites multiple accounts including a disabled account', () => {
  const fixture = dbFixture();
  try {
    fixture.insert('account-a', 'zai-web', 'synthetic-account-a');
    fixture.insert('account-b', 'zai-web', 'synthetic-account-b', 0);
    const result = fixture.updateProviderCookie('zai-web', 'synthetic-new-browser-cookie');
    assert.equal(result.updatedConnections.length, 2);
    const rows = fixture.db.prepare('SELECT api_key, test_status FROM provider_connections').all();
    assert.ok(rows.every(row => fixture.decrypt(row.api_key) === 'synthetic-new-browser-cookie' && row.test_status === 'active'));
  } finally { fixture.db.close(); }
});

test('reproduced: test-sync script replaces both existing credentials with a simulated token', async () => {
  const fixture = dbFixture();
  try {
    fixture.insert('account-a', 'zai-web', 'synthetic-original-a');
    fixture.insert('account-b', 'zai-web', 'synthetic-original-b');
    await vm.runInNewContext(`(async () => { ${stripModule(read('scripts/test-sync.mjs'))} })()`, {
      ...fixture, console: quietConsole,
    });
    const rows = fixture.db.prepare('SELECT api_key FROM provider_connections').all();
    assert.ok(rows.every(row => fixture.decrypt(row.api_key).startsWith('token=test_simulated_token_')));
  } finally { fixture.db.close(); }
});

test('reproduced: test-sync catches database failures without a failing exit status', async () => {
  const messages = [];
  const fakeProcess = {};
  await vm.runInNewContext(`(async () => { ${stripModule(read('scripts/test-sync.mjs'))} })()`, {
    updateProviderCookie() { throw new Error('synthetic database failure'); },
    process: fakeProcess,
    console: { log() {}, error(...args) { messages.push(args.join(' ')); } },
  });
  assert.ok(messages.some(message => message.includes('[FAIL]')));
  assert.equal(fakeProcess.exitCode, undefined);
});

test('reproduced: missing or quoted encryption key silently stores plaintext', () => {
  for (const envText of [null, `STORAGE_ENCRYPTION_KEY="${syntheticSecret}"`]) {
    const fixture = dbFixture({ secret: null, envText });
    try {
      assert.equal(fixture.hasKey, false);
      fixture.insert('account', 'zai-web', 'synthetic-original');
      fixture.updateProviderCookie('zai-web', 'synthetic-cookie');
      assert.equal(fixture.db.prepare('SELECT api_key FROM provider_connections').get().api_key, 'synthetic-cookie');
    } finally { fixture.db.close(); }
  }
});

test('reproduced: non-hex environment key is truncated and incompatible with the full key', () => {
  const fullSecret = 'abcdSyntheticKeyWithNonHexCharacters123';
  const writer = dbFixture({ secret: null, envText: `STORAGE_ENCRYPTION_KEY=${fullSecret}` });
  const reader = dbFixture({ secret: fullSecret });
  try {
    assert.equal(writer.hasKey, true);
    assert.equal(reader.decrypt(writer.encrypt('synthetic-cookie')), null);
  } finally { writer.db.close(); reader.db.close(); }
});

test('reproduced: missing provider is reported as successful by single and bulk HTTP handlers', async () => {
  const fixture = dbFixture();
  try {
    const request = serverFixture(fixture);
    const single = await request('POST', '/api/sync', { provider: 'zai-web', cookie: 'synthetic-cookie' });
    assert.equal(single.body.success, true);
    assert.equal(single.body.result.success, false);
    const bulk = await request('POST', '/api/sync/bulk', { updates: [{ provider: 'zai-web', cookie: 'synthetic-cookie' }] });
    assert.equal(bulk.body.success, true);
    assert.equal(bulk.body.results[0].success, true);
    assert.equal(bulk.body.results[0].result.success, false);
    assert.equal(fixture.db.prepare('SELECT count(*) AS total FROM provider_connections').get().total, 0);
  } finally { fixture.db.close(); }
});

test('reproduced: failed bulk sync poisons dedup cache and records a successful-sync timestamp', async () => {
  const fixture = extensionFixture({
    jar: { 'https://chat.z.ai': [{ name: 'token', value: 'synthetic-cookie' }] },
    fetchImpl: async url => {
      if (url.endsWith('/health')) return { ok: true };
      throw new Error('synthetic network failure');
    },
  });
  const bulk = await fixture.syncAllProviders();
  assert.equal(bulk.success, false);
  assert.equal(fixture.storageWrites.length, 1);
  const requestsBeforeRetry = fixture.requests.length;
  const retry = await fixture.syncProvider('zai-web');
  assert.equal(retry.success, true);
  assert.equal(retry.skipped, true);
  assert.equal(fixture.requests.length, requestsBeforeRetry);
});

test('reproduced: cookie events from different providers cancel each other', async () => {
  const fixture = extensionFixture();
  const synced = [];
  fixture.ctx.synced = synced;
  vm.runInContext('syncProvider = async provider => { synced.push(provider); };', fixture.ctx);
  fixture.cookieListener({ cookie: { domain: '.chatgpt.com', name: '__Secure-next-auth.session-token' } });
  fixture.cookieListener({ cookie: { domain: '.z.ai', name: 'token' } });
  assert.equal(fixture.timers.size, 1);
  for (const timer of fixture.timers.values()) await timer.fn();
  assert.deepEqual(synced, ['zai-web']);
});

test('reproduced: DeepSeek analytics-only cookie jar is treated as an active credential', async () => {
  const fixture = extensionFixture({ jar: { 'https://chat.deepseek.com': [{ name: '_ga', value: 'synthetic-analytics' }] } });
  const extracted = await fixture.extractDeepSeek();
  assert.equal(extracted.hasCredentials, true);
  assert.equal(extracted.cookieValue, '_ga=synthetic-analytics');
});

test('reproduced: ChatGPT session with four chunks loses the fourth chunk', async () => {
  const fixture = extensionFixture({ jar: { 'https://chatgpt.com': ['A', 'B', 'C', 'D'].map((value, i) => ({
    name: `__Secure-next-auth.session-token.${i}`, value,
  })) } });
  const extracted = await fixture.extractChatGPT();
  assert.equal(extracted.hasCredentials, true);
  assert.equal(extracted.cookieValue, 'ABC');
});

test('reproduced: status returns short credentials in full', async () => {
  const fixture = dbFixture();
  try {
    fixture.insert('account', 'zai-web', 'short-synthetic-token');
    const response = await serverFixture(fixture)('GET', '/api/status');
    assert.equal(response.body.providers[0].keyPreview, 'short-synthetic-token');
  } finally { fixture.db.close(); }
});

test('reproduced: malformed Host escapes the async request handler as a rejection', async () => {
  const fixture = dbFixture();
  try {
    await assert.rejects(serverFixture(fixture)('GET', '/health', undefined, { host: '[' }), /Invalid URL/);
  } finally { fixture.db.close(); }
});

test('reproduced: database initialization failure still returns healthy status', async () => {
  const request = serverFixture({ initDb() { throw new Error('synthetic database unavailable'); } });
  const response = await request('GET', '/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'online');
});
