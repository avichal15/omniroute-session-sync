import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createSyncCoordinator, COORDINATOR_STORAGE_KEY } from '../extension/lib/syncCoordinator.js';

const CHAT = 'chatgpt-web';
const GEMINI = 'gemini-web';
const copy = value => structuredClone(value);
const fingerprint = value => createHash('sha256').update(value).digest('hex');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  for (let pass = 0; pass < 500; pass++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Coordinator did not settle');
}

function fixture() {
  const data = {};
  const timers = new Map();
  const writes = [];
  const extracted = [];
  const credentials = new Map([[CHAT, 'chat-session-one'], [GEMINI, '__Secure-1PSID=gemini-one']]);
  const rows = new Map([CHAT, GEMINI].map(provider => [provider, {
    provider, connectionId: `${provider}-connection`, revision: 0, phase: 'unmapped',
    connections: [{ id: `${provider}-connection`, name: provider, isActive: true, authType: 'apikey' }]
  }]));
  let time = 1000;
  let nextTimer = 0;
  let failWrites = 0;
  let holdWrite = null;
  let active = 0;
  let maxActive = 0;
  let validation = true;
  let validationPhase = '';
  let validationMessage = '';
  let storageFailure = false;
  let stale = false;
  let gatewayUnavailable = false;
  const storage = {
    async get(key) { return { [key]: copy(data[key]) }; },
    async set(values) {
      if (storageFailure) throw new Error('storage unavailable');
      Object.assign(data, copy(values));
    }
  };
  async function request(path, options = {}) {
    if (path === '/api/needed') {
      if (gatewayUnavailable) throw Object.assign(new Error('Gateway unavailable'), { code: 'GATEWAY_UNAVAILABLE' });
      return { success: true, providers: copy([...rows.values()]) };
    }
    const body = options.body;
    if (path === '/api/mappings') {
      rows.get(body.provider).connectionId = body.connectionId;
      rows.get(body.provider).revision = 0;
      rows.get(body.provider).phase = 'unmapped';
      return { success: true };
    }
    if (path === '/api/validate') return { success: true, valid: validation,
      phase: validationPhase || (validation ? 'validated' : 'login-required'), message: validationMessage };
    assert.equal(path, '/api/sync');
    writes.push(copy(body));
    active++;
    maxActive = Math.max(active, maxActive);
    try {
      if (holdWrite) { const hold = holdWrite; holdWrite = null; await hold.promise; }
      if (failWrites-- > 0) throw Object.assign(new Error('Write was rejected'), { code: 'WRITE_FAILED' });
      if (stale) {
        stale = false;
        rows.get(body.provider).revision = body.revision + 10;
        return { success: true, stale: true, skipped: true, revision: body.revision + 10 };
      }
      rows.get(body.provider).revision = body.revision;
      rows.get(body.provider).phase = 'synced';
      return { success: true, revision: body.revision, phase: 'synced' };
    } finally { active--; }
  }
  function coordinator() {
    return createSyncCoordinator({
      storage, request, now: () => time,
      hash: async value => fingerprint(value),
      extract: async provider => {
        extracted.push(provider);
        const cookieValue = credentials.get(provider) || '';
        return { hasCredentials: Boolean(cookieValue), cookieValue };
      },
      setTimer: (callback, delay) => {
        const id = ++nextTimer;
        timers.set(id, { callback, due: time + delay });
        return id;
      },
      clearTimer: id => timers.delete(id)
    });
  }
  return {
    data, rows, writes, credentials, extracted, coordinator,
    fail: count => { failWrites = count; },
    hold: value => { holdWrite = value; },
    rejectStorage: value => { storageFailure = value; },
    rejectValidation: () => { validation = false; },
    validationResult: (phase, message) => { validation = false; validationPhase = phase; validationMessage = message; },
    staleNext: () => { stale = true; },
    gatewayUnavailable: value => { gatewayUnavailable = value; },
    maxActive: () => maxActive,
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= time) { timers.delete(id); timer.callback(); }
    }
  };
}

test('independent provider debounce preserves both cookie changes', async () => {
  const f = fixture();
  const sync = f.coordinator();
  await Promise.all([sync.notifyCookieChange(CHAT), sync.notifyCookieChange(GEMINI)]);
  f.advance(2999);
  assert.equal(f.writes.length, 0);
  f.advance(1);
  await until(() => f.writes.length === 2 && Object.values(f.data[COORDINATOR_STORAGE_KEY].providers).filter(p => p.ack).length === 2);
  assert.deepEqual(new Set(f.writes.map(write => write.provider)), new Set([CHAT, GEMINI]));
  assert.equal(f.data[COORDINATOR_STORAGE_KEY].providers[CHAT].ack.fingerprint, fingerprint('chat-session-one'));
  assert.equal(JSON.stringify(f.data).includes('chat-session-one'), false);
  assert.equal(JSON.stringify(f.data).includes('gemini-one'), false);
  sync.dispose();
});

test('failed writes remain pending and retry the same cookie without a false acknowledgment', async () => {
  const f = fixture();
  const sync = f.coordinator();
  f.fail(1);
  assert.equal((await sync.syncProvider(CHAT)).success, false);
  assert.equal(f.data[COORDINATOR_STORAGE_KEY].providers[CHAT].pending, true);
  assert.equal(f.data[COORDINATOR_STORAGE_KEY].providers[CHAT].ack, null);
  assert.equal((await sync.syncProvider(CHAT)).success, true);
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[0].cookie, f.writes[1].cookie);
  assert.ok(f.writes[1].revision > f.writes[0].revision);
  assert.equal(f.data[COORDINATOR_STORAGE_KEY].providers[CHAT].pending, false);
  sync.dispose();
});

test('a retry reads the current browser cookie rather than retaining a failed payload', async () => {
  const f = fixture();
  const sync = f.coordinator();
  f.fail(1);
  await sync.syncProvider(CHAT);
  f.credentials.set(CHAT, 'rotated-session');
  await sync.syncProvider(CHAT);
  assert.deepEqual(f.writes.map(write => write.cookie), ['chat-session-one', 'rotated-session']);
  assert.equal(f.data[COORDINATOR_STORAGE_KEY].providers[CHAT].ack.fingerprint, fingerprint('rotated-session'));
  sync.dispose();
});

test('missing credentials never overwrite a mapped connection', async () => {
  const f = fixture();
  const sync = f.coordinator();
  f.credentials.set(CHAT, '');
  const result = await sync.syncProvider(CHAT, { force: true });
  assert.equal(result.skipped, true);
  assert.equal(result.phase, 'login-required');
  assert.equal(f.writes.length, 0);
  assert.equal(f.rows.get(CHAT).connectionId, `${CHAT}-connection`);
  assert.equal((await sync.getLocalStatus())[CHAT].phase, 'login-required');
  sync.dispose();
});

test('worker restart recovers durable pending work and reads fresh credentials', async () => {
  const f = fixture();
  const first = f.coordinator();
  await first.notifyCookieChange(CHAT);
  assert.equal(f.data[COORDINATOR_STORAGE_KEY].providers[CHAT].pending, true);
  first.dispose();
  f.credentials.set(CHAT, 'session-after-restart');
  const restarted = f.coordinator();
  await restarted.reconcile();
  assert.equal(f.writes.find(write => write.provider === CHAT).cookie, 'session-after-restart');
  assert.equal(f.data[COORDINATOR_STORAGE_KEY].providers[CHAT].pending, false);
  assert.equal(JSON.stringify(f.data).includes('session-after-restart'), false);
  restarted.dispose();
});

test('gateway outage leaves the browser session queued for retry', async () => {
  const f = fixture();
  const sync = f.coordinator();
  f.gatewayUnavailable(true);
  const unavailable = await sync.syncProvider(CHAT);
  assert.equal(unavailable.success, false);
  assert.equal(unavailable.phase, 'pending');
  assert.equal(f.writes.length, 0);
  assert.equal((await sync.getLocalStatus())[CHAT].pending, true);
  f.gatewayUnavailable(false);
  assert.equal((await sync.syncProvider(CHAT)).success, true);
  sync.dispose();
});

test('acknowledgments survive restart but an unavailable gateway row keeps retry state', async () => {
  const f = fixture();
  const first = f.coordinator();
  await first.syncProvider(CHAT);
  first.dispose();
  const restarted = f.coordinator();
  assert.equal((await restarted.syncProvider(CHAT)).skipped, true);
  assert.equal(f.writes.length, 1);
  f.rows.delete(CHAT);
  const result = await restarted.syncProvider(CHAT);
  assert.equal(result.success, false);
  assert.equal(f.data[COORDINATOR_STORAGE_KEY].providers[CHAT].pending, true);
  assert.equal(f.data[COORDINATOR_STORAGE_KEY].providers[CHAT].ack.fingerprint, fingerprint('chat-session-one'));
  restarted.dispose();
});

test('matching fingerprint skips only while connection and gateway revision also match', async () => {
  const f = fixture();
  const sync = f.coordinator();
  await sync.syncProvider(CHAT);
  assert.equal((await sync.syncProvider(CHAT)).skipped, true);
  assert.equal(f.writes.length, 1);
  f.rows.get(CHAT).connectionId = 'different-connection';
  f.rows.get(CHAT).connections.push({ id: 'different-connection', name: 'Second', isActive: true, authType: 'apikey' });
  await sync.syncProvider(CHAT);
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[1].connectionId, 'different-connection');
  f.rows.get(CHAT).revision += 7;
  await sync.syncProvider(CHAT);
  assert.equal(f.writes.length, 3);
  assert.ok(f.writes[2].revision > f.writes[1].revision + 7);
  sync.dispose();
});

test('cookie changes during a write queue a fresh pass with no concurrent provider writes', async () => {
  const f = fixture();
  const sync = f.coordinator();
  const hold = deferred();
  f.hold(hold);
  const running = sync.syncProvider(CHAT);
  await until(() => f.writes.length === 1);
  f.credentials.set(CHAT, 'rotated-during-write');
  await sync.notifyCookieChange(CHAT);
  f.advance(3000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes.length, 1);
  hold.resolve();
  await running;
  await until(() => f.writes.length === 2 && !f.data[COORDINATOR_STORAGE_KEY].providers[CHAT].pending);
  assert.equal(f.maxActive(), 1);
  assert.equal(f.writes[1].cookie, 'rotated-during-write');
  assert.equal(f.data[COORDINATOR_STORAGE_KEY].providers[CHAT].ack.fingerprint, fingerprint('rotated-during-write'));
  sync.dispose();
});

test('stale success cannot acknowledge the attempted cookie and is retried above the server revision', async () => {
  const f = fixture();
  const sync = f.coordinator();
  f.staleNext();
  const stale = await sync.syncProvider(CHAT);
  assert.equal(stale.success, false);
  assert.equal(f.data[COORDINATOR_STORAGE_KEY].providers[CHAT].ack, null);
  assert.equal(f.data[COORDINATOR_STORAGE_KEY].providers[CHAT].pending, true);
  const serverRevision = f.rows.get(CHAT).revision;
  await sync.syncProvider(CHAT);
  assert.ok(f.writes[1].revision > serverRevision);
  sync.dispose();
});

test('sync all reports attempted failures while leaving unmapped providers unsynced', async () => {
  const f = fixture();
  const sync = f.coordinator();
  f.rows.get(GEMINI).connectionId = null;
  f.fail(1);
  const result = await sync.reconcile({ force: true });
  assert.equal(result.success, false);
  assert.equal(result.synced, 0);
  assert.equal(result.results.find(item => item.provider === GEMINI).phase, 'unmapped');
  assert.equal(f.writes.length, 1);
  assert.equal(JSON.stringify(result).includes('chat-session-one'), false);
  sync.dispose();
});

test('pairing invalidation prevents an old in-flight response from restoring its acknowledgment', async () => {
  const f = fixture();
  const sync = f.coordinator();
  const hold = deferred();
  f.hold(hold);
  const running = sync.syncProvider(CHAT);
  await until(() => f.writes.length === 1);
  await sync.invalidateAll();
  hold.resolve();
  await running;
  assert.equal(f.data[COORDINATOR_STORAGE_KEY].providers[CHAT].ack, null);
  assert.equal(f.data[COORDINATOR_STORAGE_KEY].providers[CHAT].pending, true);
  sync.dispose();
});

test('mapping changes clear acknowledgments and reject unsupported connection types', async () => {
  const f = fixture();
  const sync = f.coordinator();
  await sync.syncProvider(CHAT);
  await sync.updateMapping(CHAT, null);
  assert.equal(f.data[COORDINATOR_STORAGE_KEY].providers[CHAT].ack, null);
  assert.equal(f.rows.get(CHAT).connectionId, null);
  f.rows.get(CHAT).connectionId = `${CHAT}-connection`;
  f.rows.get(CHAT).connections[0].authType = 'oauth';
  assert.equal((await sync.syncProvider(CHAT)).success, false);
  assert.equal(f.writes.length, 1);
  sync.dispose();
});

test('storage failure stops a write before credentials leave the browser', async () => {
  const f = fixture();
  const sync = f.coordinator();
  await sync.ready;
  f.rejectStorage(true);
  assert.equal((await sync.syncProvider(CHAT)).success, false);
  assert.equal(f.writes.length, 0);
  sync.dispose();
});

test('a completed validation with valid false is a failure for the popup', async () => {
  const f = fixture();
  const sync = f.coordinator();
  f.rejectValidation();
  const result = await sync.validateProvider(CHAT);
  assert.equal(result.success, false);
  assert.equal(result.phase, 'login-required');
  assert.equal((await sync.getLocalStatus())[CHAT].phase, 'login-required');
  sync.dispose();
});

test('unsupported validation preserves synced status without claiming validation or requiring login', async () => {
  const f = fixture();
  const sync = f.coordinator();
  f.validationResult('synced', 'This provider does not support a connection test.');
  const result = await sync.validateProvider(CHAT);
  assert.equal(result.success, false);
  assert.equal(result.valid, false);
  assert.equal(result.phase, 'synced');
  assert.equal(result.error.message, 'This provider does not support a connection test.');
  assert.equal((await sync.getLocalStatus())[CHAT].phase, 'synced');
  sync.dispose();
});

test('transient validation failure preserves error status and its retry message', async () => {
  const f = fixture();
  const sync = f.coordinator();
  f.validationResult('error', 'Provider timed out. Try testing again.');
  const result = await sync.validateProvider(CHAT);
  assert.equal(result.success, false);
  assert.equal(result.phase, 'error');
  assert.equal(result.error.message, 'Provider timed out. Try testing again.');
  const status = (await sync.getLocalStatus())[CHAT];
  assert.equal(status.phase, 'error');
  assert.equal(status.message, 'Provider timed out. Try testing again.');
  sync.dispose();
});

test('worker popup contract stays secret-free, retains offline mappings, and reports validation failures', () => {
  const workerUrl = new URL('../extension/background.js', import.meta.url).href;
  // A separate process guarantees every fetch and cookie read stays inside this fixture.
  const script = `
    import assert from 'node:assert/strict';
    const stored = {};
    const listeners = {};
    const calls = [];
    let accessLevel;
    let token = '';
    let offline = false;
    let expired = false;
    let rejectWrite = false;
    let validation = false;
    let rows = [];
    let fallback = { name: 'browser-sessions', models: [], saved: false };
    const event = name => ({ addListener(callback) { listeners[name] = callback; } });
    globalThis.chrome = {
      storage: { local: {
        async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(stored[key])])); },
        async set(value) { Object.assign(stored, structuredClone(value)); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]; },
        async setAccessLevel(value) { accessLevel = value.accessLevel; }
      } },
      runtime: { id: 'fixture-extension', onMessage: event('message'), onStartup: event('startup'), onInstalled: event('installed') },
      cookies: {
        async getAll({ url }) { return url.includes('chatgpt.com') ? [{ name: '__Secure-next-auth.session-token', value: 'synthetic-cookie-only' }] : []; },
        onChanged: event('cookie')
      },
      alarms: { async get() {}, async create() {}, async clear() {}, onAlarm: event('alarm') }
    };
    globalThis.fetch = async (url, options = {}) => {
      assert.ok(url.startsWith('http://127.0.0.1:20129/'));
      const path = new URL(url).pathname;
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ path, body });
      const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
      if (path === '/health') return reply({ service: 'omniroute-session-sync', version: '2.0.0', alive: true, ready: true, gatewayReady: true, paired: Boolean(token) });
      if (path === '/api/pair') { assert.equal(body.code, 'once'); token = 'synthetic-private-pairing-token'; rows = []; return reply({ success: true, token }); }
      assert.equal(options.headers.Authorization, 'Bearer ' + token);
      if (expired) return reply({ success: false, error: { code: 'UNAUTHORIZED', message: 'Expired ' + token } }, 401);
      if (path === '/api/needed') return reply({ success: true, providers: rows });
      if (path === '/api/status') return reply({ success: true, paired: true, bridge: { ready: !offline, ...(offline ? { error: 'Offline' } : {}) },
        providers: offline ? [] : rows,
        models: offline ? [] : [{ id: 'chatgpt-web/model-one', provider: 'chatgpt-web', label: 'Browser model' }, { id: 'official-model', provider: 'openai', label: 'Official' }],
        fallback: offline ? { name: 'browser-sessions', models: [], saved: false } : fallback });
      if (path === '/api/sync') {
        assert.equal(body.cookie, 'synthetic-cookie-only');
        assert.equal(typeof body.force, 'boolean');
        if (rejectWrite) return reply({ success: false, error: { code: 'WRITE_REJECTED', message: 'Write rejected' } }, 503);
        rows[0].revision = body.revision;
        rows[0].phase = 'synced';
        return reply({ success: true, phase: 'synced', revision: body.revision });
      }
      if (path === '/api/validate') return reply({ success: true, valid: validation, phase: validation ? 'validated' : 'login-required' });
      if (path === '/api/fallback') { fallback = { name: 'browser-sessions', models: body.models, saved: true }; return reply({ success: true }); }
      assert.fail('Unexpected fixture request: ' + path);
    };
    await import(${JSON.stringify(workerUrl)});
    const send = message => new Promise(resolve => assert.equal(listeners.message(message, { id: 'fixture-extension' }, resolve), true));
    let status = await send({ action: 'GET_STATUS' });
    assert.equal(accessLevel, 'TRUSTED_CONTEXTS');
    assert.equal(status.paired, false);
    assert.equal(status.providers.length, 6);
    assert.equal(JSON.stringify(status).includes('synthetic-cookie-only'), false);
    assert.deepEqual(await send({ action: 'PAIR', code: 'once' }), { success: true });
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    rows = [{ provider: 'chatgpt-web', connectionId: 'mapped', revision: 0, phase: 'unmapped', connections: [{ id: 'mapped', name: 'Profile', isActive: true, authType: 'apikey' }] }];
    status = await send({ action: 'GET_STATUS' });
    assert.equal(status.models.length, 1);
    assert.equal((await send({ action: 'SYNC_ONE', provider: 'chatgpt-web' })).success, true);
    assert.equal((await send({ action: 'VALIDATE_PROVIDER', provider: 'chatgpt-web' })).success, false);
    status = await send({ action: 'GET_STATUS' });
    assert.equal(status.providers[0].phase, 'login-required');
    assert.equal(JSON.stringify(status).includes('synthetic-cookie-only'), false);
    assert.equal(JSON.stringify(status).includes(token), false);
    assert.equal(JSON.stringify(stored.sessionSyncCoordinatorV2).includes('synthetic-cookie-only'), false);
    rejectWrite = true;
    assert.equal((await send({ action: 'SYNC_ALL' })).success, false);
    rejectWrite = false;
    assert.equal((await send({ action: 'SAVE_FALLBACK', models: ['official-model'] })).success, false);
    assert.equal((await send({ action: 'SAVE_FALLBACK', models: ['chatgpt-web/model-one'] })).success, true);
    offline = true;
    status = await send({ action: 'GET_STATUS' });
      assert.equal(status.bridge.ready, true);
      assert.equal(status.bridge.gatewayReady, false);
    assert.equal(status.providers[0].connectionId, 'mapped');
    assert.equal(status.models.length, 1);
    assert.equal(status.fallback.saved, true);
    expired = true;
    status = await send({ action: 'GET_STATUS' });
    assert.equal(status.paired, false);
    assert.equal(JSON.stringify(status).includes(token), false);
    assert.equal(stored.sessionSyncPairingV2, undefined);
    console.log('Worker fixture passed');
  `;
  assert.match(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 }), /Worker fixture passed/);
});
