import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runSupervisor, supervisorRunning } from '../scripts/integrated-runtime.mjs';
import { startIntegrated } from '../scripts/start-integrated.mjs';
import { startupVbs } from '../scripts/embedded-install-lib.mjs';

async function until(check, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(25); }
  assert.fail('Timed out waiting for the synthetic startup condition');
}
async function fixture(t, source) {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, 'omni-supervisor-test-'));
  const controller = new AbortController(); let running;
  t.after(async () => {
    controller.abort();
    try { if (running) await running; }
    finally {
      assert.equal(path.dirname(path.resolve(directory)), root);
      assert.ok(path.basename(directory).startsWith('omni-supervisor-test-'));
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
  const reservePort = async () => {
    const reserve = net.createServer();
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    return port;
  };
  const gatewayPort = await reservePort();
  const bridgePort = await reservePort();
  await fs.mkdir(path.join(directory, 'bridge'));
  await fs.writeFile(path.join(directory, 'bridge', 'config.json'), JSON.stringify({ host: '127.0.0.1', port: bridgePort, omnirouteBaseUrl: `http://127.0.0.1:${gatewayPort}` }));
  const hook = path.join(directory, 'hook.mjs'); await fs.writeFile(hook, '');
  const envFile = path.join(directory, '.env'); await fs.writeFile(envFile, 'NODE_OPTIONS=\n');
  const cliPath = path.join(directory, 'cli.mjs');
  const attempts = path.join(directory, 'attempts.jsonl');
  const bridgeAttempts = path.join(directory, 'bridge-attempts.jsonl');
  const bridgePath = path.join(directory, 'bridge', 'server.mjs');
  await fs.writeFile(bridgePath, `import fs from 'node:fs';import http from 'node:http';
    fs.appendFileSync(${JSON.stringify(bridgeAttempts)},JSON.stringify({pid:process.pid,at:Date.now()})+'\\n');
    http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({service:'omniroute-session-sync',version:'2.0.0',alive:true,ready:false,runtime:{lifecycle:'standalone',processId:process.pid}}));
    }).listen(${bridgePort},'127.0.0.1');`);
  const startup = `import fs from 'node:fs';import http from 'node:http';
    const attempts=${JSON.stringify(attempts)};const port=${gatewayPort};
    fs.appendFileSync(attempts,JSON.stringify({pid:process.pid,at:Date.now()})+'\\n');
    const count=fs.readFileSync(attempts,'utf8').trim().split('\\n').length;
    ${source}`;
  await fs.writeFile(cliPath, startup);
  await fs.writeFile(path.join(directory, 'installation.json'), JSON.stringify({ version: 1, nodePath: process.execPath,
    cliPath, bridgePath, projectDir: directory, omniInstallDir: directory, envFile, preload: pathToFileURL(hook).href, serveArgs: ['serve', '--no-open'] }));
  const readAttempts = async () => (await fs.readFile(attempts, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const readBridgeAttempts = async () => (await fs.readFile(bridgeAttempts, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const status = async () => JSON.parse(await fs.readFile(path.join(directory, 'startup-status.json'), 'utf8').catch(() => 'null'));
  const bridgeHealth = async () => fetch(`http://127.0.0.1:${bridgePort}/health`).then(response => response.json());
  return { directory, gatewayPort, bridgePort, readAttempts, readBridgeAttempts, bridgeHealth, status, start() {
    running = runSupervisor({ directory, signal: controller.signal, pollMs: 40, retryMs: 50 });
    running.catch(error => t.diagnostic('Supervisor fixture error: ' + error.stack));
    return running;
  } };
}
const healthyServer = `http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({status:'healthy'}));
}).listen(port,'127.0.0.1');`;

test('supervisor recovers from startup failure and a later crash without storing console credentials', { timeout: 12000 }, async t => {
  const sentinel = 'synthetic-cookie-must-never-be-logged';
  const f = await fixture(t, `console.error('cookie=${sentinel}');if(count===1){console.error('ERR_MODULE_NOT_FOUND');process.exit(23);}${healthyServer}`);
  const savedPairing = JSON.stringify({ client: { token: 'synthetic-pairing' }, mappings: { 'chatgpt-web': 'synthetic-account' } });
  await fs.writeFile(path.join(f.directory, 'state.json'), savedPairing);
  f.start();
  await until(async () => (await f.status())?.ready);
  const firstReady = await f.readAttempts();
  assert.equal(firstReady.length, 2);
  assert.equal((await f.readBridgeAttempts()).length, 1);
  process.kill(firstReady[1].pid);
  await until(async () => (await f.readAttempts()).length === 3 && (await f.status())?.ready);
  assert.equal((await f.readBridgeAttempts()).length, 1);
  assert.equal(await fs.readFile(path.join(f.directory, 'state.json'), 'utf8'), savedPairing);
  const log = await fs.readFile(path.join(f.directory, 'startup.log'), 'utf8');
  assert.ok(log.includes('gateway-exited'));
  assert.ok(log.includes('23'));
  assert.ok(log.includes('ERR_MODULE_NOT_FOUND'));
  assert.ok(!log.includes(sentinel));
  assert.ok(!log.includes('synthetic-pairing'));
});

test('a second supervisor cannot start another CLI while the first gateway initializes', { timeout: 10000 }, async t => {
  const f = await fixture(t, `setTimeout(()=>{${healthyServer}},250);`);
  f.start();
  await until(() => supervisorRunning(f.directory));
  assert.equal((await runSupervisor({ directory: f.directory })).alreadyRunning, true);
  await until(async () => (await f.status())?.ready);
  assert.equal((await f.readAttempts()).length, 1);
});

test('an occupied but unhealthy port is not reported ready or overwritten', { timeout: 10000 }, async t => {
  const f = await fixture(t, healthyServer);
  const occupied = http.createServer((req, res) => { res.writeHead(503); res.end('{}'); });
  await new Promise(resolve => occupied.listen(f.gatewayPort, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { occupied.closeAllConnections(); occupied.close(resolve); }));
  f.start();
  await until(() => supervisorRunning(f.directory));
  await assert.rejects(startIntegrated({ directory: f.directory, timeoutMs: 180, pollMs: 20 }), /still starting|needs attention/);
  assert.deepEqual(await f.readAttempts(), []);
  assert.equal(occupied.listening, true);
});

test('bridge remains reachable while the gateway restarts', { timeout: 10000 }, async t => {
  const f = await fixture(t, healthyServer);
  f.start();
  await until(async () => (await f.status())?.ready);
  const [gateway] = await f.readAttempts();
  process.kill(gateway.pid);
  const health = await f.bridgeHealth();
  assert.equal(health.alive, true);
  assert.equal((await f.status())?.bridgeAlive, true);
  await until(async () => (await f.readAttempts()).length === 2 && (await f.status())?.ready);
});

test('Windows startup pins the saved data directory and waits for the recovery service', () => {
  const source = startupVbs('C:\\Program Files\\nodejs\\node.exe', 'C:\\omni\\scripts\\start-integrated.mjs', {
    directory: 'C:\\Users\\Example\\AppData\\Local\\OmniRouteSessionSync', configPath: 'C:\\omni\\bridge\\config.json',
  });
  assert.ok(source.includes('SessionEnv("OMNI_SYNC_DATA_DIR") = "C:\\Users\\Example\\AppData\\Local\\OmniRouteSessionSync"'));
  assert.ok(source.includes('--watch", 0, True)'));
  assert.ok(source.includes('WScript.Quit ExitCode'));
  assert.throws(() => startupVbs('C:\\node.exe', 'C:\\bad"path.mjs'), /Invalid startup path/);
});
