import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { isOmniRouteServer } from '../bridge/omniroute-preload.mjs';

async function workspace(t) {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, 'omni-embedded-test-'));
  const children = [];
  async function stop(child) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await child.closed;
  }
  t.after(async () => {
    await Promise.all(children.map(stop));
    assert.equal(path.dirname(path.resolve(directory)), root);
    assert.ok(path.basename(directory).startsWith('omni-embedded-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(directory, 'dist'));
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'omniroute', type: 'module' }));
  const entry = path.join(directory, 'dist', 'server-ws.mjs');
  await fs.writeFile(entry, '');
  return { directory, entry, stop, start(env) {
    const child = spawn(process.execPath, ['--import', new URL('../bridge/omniroute-preload.mjs', import.meta.url).href, entry], {
      env: { ...process.env, NODE_OPTIONS: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    child.closed = new Promise(resolve => child.once('close', resolve));
    child.output = '';
    child.stdout.on('data', data => { child.output += data; });
    child.stderr.on('data', data => { child.output += data; });
    children.push(child);
    return child;
  } };
}

async function freePorts() {
  const servers = [http.createServer(), http.createServer()];
  await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const ports = servers.map(server => server.address().port);
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  return ports;
}

test('embedded startup targets only the real OmniRoute server entrypoint', async t => {
  const f = await workspace(t);
  assert.equal(await isOmniRouteServer(f.entry), true);
  const cli = path.join(f.directory, 'omniroute.mjs');
  await fs.writeFile(cli, '');
  assert.equal(await isOmniRouteServer(cli), false);
  assert.equal(await isOmniRouteServer(undefined), false);
  await fs.writeFile(path.join(f.directory, 'package.json'), JSON.stringify({ name: 'other-app' }));
  assert.equal(await isOmniRouteServer(f.entry), false);
});

test('embedded host restart retains pairing, account mapping and automatic sync access', { timeout: 25000 }, async t => {
  const f = await workspace(t);
  const [gatewayPort, syncPort] = await freePorts();
  const config = path.join(f.directory, 'config.json');
  const stateDir = path.join(f.directory, 'state');
  await fs.writeFile(config, JSON.stringify({ host: '127.0.0.1', port: syncPort, omnirouteBaseUrl: `http://127.0.0.1:${gatewayPort}`, allowCloudSync: false }));
  await fs.writeFile(f.entry, `
    import http from 'node:http';
    const server = http.createServer((req,res) => {
      let result={success:true};
      if(req.url==='/api/providers') result={connections:[{id:'chosen-account',provider:'chatgpt-web',name:'Synthetic',isActive:true,authType:'apikey'}]};
      if(req.url==='/api/settings') result={cloudEnabled:false};
      if(req.url==='/api/combos/builder/options') result={providers:[]};
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
    });
    server.listen(${gatewayPort},'127.0.0.1');
    // Mirrors a host that patches HTTP after its entrypoint starts. The sync
    // listener must already exist and remain unaffected by this replacement.
    http.createServer=()=>{throw new Error('Host HTTP patch must not wrap the sync listener')};
  `);
  const env = { OMNI_SYNC_CONFIG_FILE: config, OMNI_SYNC_DATA_DIR: stateDir, OMNIROUTE_MANAGEMENT_TOKEN: 'synthetic-management-only' };
  const base = `http://127.0.0.1:${syncPort}`;
  async function ready(child) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) assert.fail('Embedded host exited: ' + child.output);
      try {
        const response = await fetch(base + '/health');
        const health = await response.json();
        if (response.ok && health.alive === true) return health;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('Embedded host did not become ready: ' + child.output);
  }
  let child = f.start(env);
  let health = await ready(child);
  assert.equal(health.runtime.lifecycle, 'omniroute');
  assert.equal(health.runtime.processId, child.pid);
  let state = JSON.parse(await fs.readFile(path.join(stateDir, 'state.json'), 'utf8'));
  const origin = 'chrome-extension://' + 'a'.repeat(32);
  async function call(endpoint, body, token, browserOrigin) {
    const response = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(browserOrigin ? { Origin: browserOrigin } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  }
  const issued = await call('/api/pairing-code', {}, state.ownerToken);
  const paired = await call('/api/pair', { code: issued.code }, '', origin);
  await call('/api/mappings', { provider: 'chatgpt-web', connectionId: 'chosen-account' }, paired.token, origin);
  await call('/api/sync', { provider: 'chatgpt-web', connectionId: 'chosen-account', cookie: 'synthetic-session-before-restart', revision: 1 }, paired.token, origin);
  await f.stop(child);
  child = f.start(env);
  health = await ready(child);
  assert.equal(health.runtime.processId, child.pid);
  assert.equal(health.paired, true);
  const status = await call('/api/status', undefined, paired.token, origin);
  const provider = status.providers.find(row => row.provider === 'chatgpt-web');
  assert.equal(provider.connectionId, 'chosen-account');
  assert.equal(provider.revision, 1);
  const updated = await call('/api/sync', { provider: 'chatgpt-web', connectionId: 'chosen-account', cookie: 'synthetic-session-after-restart', revision: 2 }, paired.token, origin);
  assert.equal(updated.success, true);
  state = JSON.parse(await fs.readFile(path.join(stateDir, 'state.json'), 'utf8'));
  assert.equal(state.client.token, paired.token);
  assert.equal(state.statuses['chatgpt-web'].revision, 2);
  assert.equal(JSON.stringify(state).includes('synthetic-session'), false);
});
