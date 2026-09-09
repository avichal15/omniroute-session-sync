import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addPreload, readNodeOptions, updateNodeOptions, startupVbs } from '../scripts/embedded-install-lib.mjs';

const preload = 'file:///C:/a%20project/bridge/omniroute-preload.mjs';

test('embedded installation preserves other settings and existing Node options', () => {
  const original = '# settings\r\nSTORAGE_ENCRYPTION_KEY=synthetic-only\r\nNODE_OPTIONS="--require=C:/local/hide-windows.cjs --max-old-space-size=2048"\r\nPORT=20128\r\n';
  const updated = updateNodeOptions(original, preload);
  assert.ok(updated.includes('STORAGE_ENCRYPTION_KEY=synthetic-only\r\n'));
  assert.ok(updated.includes('PORT=20128\r\n'));
  assert.equal(readNodeOptions(updated), '--require=C:/local/hide-windows.cjs --max-old-space-size=2048 --import=' + preload);
  assert.equal(updateNodeOptions(updated, preload), updated);
});

test('installation adds one preload to a new environment without duplicates', () => {
  const updated = updateNodeOptions('PORT=20128', preload);
  assert.equal(updated, 'PORT=20128\nNODE_OPTIONS=--import=' + preload + '\n');
  assert.equal(addPreload('--trace-warnings --import=' + preload, preload), '--trace-warnings --import=' + preload);
  assert.equal(addPreload('', preload), '--import=' + preload);
});

test('ambiguous environment options are rejected instead of rewriting unrelated data', () => {
  assert.throws(() => updateNodeOptions('NODE_OPTIONS=a\nNODE_OPTIONS=b\n', preload), /multiple NODE_OPTIONS/i);
  assert.throws(() => addPreload('ok\nBAD=value', preload), /single line/i);
});

test('Windows startup uses absolute quoted paths and a hidden launch', () => {
  const source = startupVbs('C:\\Program Files\\nodejs\\node.exe', 'C:\\My Project\\scripts\\start-integrated.mjs');
  assert.ok(source.includes('""C:\\Program Files\\nodejs\\node.exe""'));
  assert.ok(source.includes('""C:\\My Project\\scripts\\start-integrated.mjs""'));
  assert.ok(source.includes('--watch'));
  assert.ok(source.includes(', 0, True)'));
  assert.ok(source.includes('WScript.Quit ExitCode'));
  assert.ok(!source.includes('cmd.exe'));
});

test('hidden launcher starts the CLI with its preload and avoids a duplicate gateway', { timeout: 10000 }, async t => {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, 'omni-launcher-test-'));
  let pid;
  t.after(async () => {
    if (pid) {
      if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
      else { try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    }
    assert.equal(path.dirname(path.resolve(directory)), root);
    assert.ok(path.basename(directory).startsWith('omni-launcher-test-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  await fs.mkdir(path.join(directory, 'bridge'));
  await fs.writeFile(path.join(directory, 'bridge', 'config.json'), JSON.stringify({ host: '127.0.0.1', port, omnirouteBaseUrl: `http://127.0.0.1:${port}` }));
  const marker = path.join(directory, 'started.json');
  const hook = path.join(directory, 'hook.mjs');
  await fs.writeFile(hook, 'globalThis.embeddedTestPreloaded=true;');
  const cli = path.join(directory, 'cli.mjs');
  await fs.writeFile(cli, `import http from 'node:http';import fs from 'node:fs';
    const startedAt=Date.now();
    http.createServer((req,res)=>{const ready=Date.now()-startedAt>250;res.writeHead(ready?200:503,{'Content-Type':'application/json'});
      res.end(JSON.stringify({service:'omniroute-session-sync',ready,runtime:{lifecycle:'omniroute',processId:process.pid}}));
    }).listen(${port},'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({args:process.argv.slice(2),preloaded:globalThis.embeddedTestPreloaded,nodeOptions:process.env.NODE_OPTIONS,startedAt})));`);
  const envFile = path.join(directory, '.env');
  await fs.writeFile(envFile, 'NODE_OPTIONS=--trace-warnings\n');
  await fs.writeFile(path.join(directory, 'installation.json'), JSON.stringify({ version: 1, nodePath: process.execPath,
    cliPath: cli, projectDir: directory, omniInstallDir: directory, envFile, preload: pathToFileURL(hook).href, serveArgs: ['serve', '--no-open'] }));
  const launcher = fileURLToPath(new URL('../scripts/start-integrated.mjs', import.meta.url));
  const exec = promisify(execFile);
  const env = { ...process.env, OMNI_SYNC_DATA_DIR: directory, NODE_OPTIONS: '--no-warnings' };
  const first = JSON.parse((await exec(process.execPath, [launcher], { env, windowsHide: true })).stdout);
  assert.equal(first.started, true); pid = first.processId;
  assert.equal(first.ready, true, 'A successful spawn must not be reported as a ready gateway');
  let started;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { started = JSON.parse(await fs.readFile(marker, 'utf8')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(started, 'The expected CLI entrypoint must actually start');
  assert.ok(Date.now() - started.startedAt >= 250, 'An open port must not count as readiness during initialization');
  assert.deepEqual(started.args, ['serve', '--no-open']);
  assert.equal(started.preloaded, true);
  assert.ok(started.nodeOptions.includes('--no-warnings'));
  const second = JSON.parse((await exec(process.execPath, [launcher], { env, windowsHide: true })).stdout);
  assert.equal(second.alreadyRunning, true);
  assert.equal(second.processId, undefined);
});
