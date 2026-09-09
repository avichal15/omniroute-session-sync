import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { dataDirectory } from '../bridge/runtimeState.mjs';
import { readInstallation, integratedHealth, supervisorRunning, runSupervisor } from './integrated-runtime.mjs';

const launcher = fileURLToPath(import.meta.url);
export async function startIntegrated({ directory = dataDirectory(), timeoutMs = 300000, pollMs = 1000 } = {}) {
  const context = await readInstallation(directory);
  let child;
  if (!await supervisorRunning(context.directory)) {
    child = spawn(context.record.nodePath, [launcher, '--watch'], {
      cwd: context.record.projectDir, env: { ...process.env, OMNI_SYNC_DATA_DIR: context.directory },
      detached: true, windowsHide: true, stdio: 'ignore',
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  }
  const deadline = Date.now() + timeoutMs;
  do {
    const health = await integratedHealth(context, Math.max(1, Math.min(3000, deadline - Date.now())));
    if (health.ready) return { success: true, ready: true, ...(child ? { started: true, processId: child.pid } : { alreadyRunning: true }), syncProcessId: health.syncProcessId };
    if (child?.exitCode && !await supervisorRunning(context.directory))
      throw new Error('The startup service stopped. Check the local startup.log file.');
    if (Date.now() < deadline) await delay(Math.min(pollMs, deadline - Date.now()));
  } while (Date.now() < deadline);
  throw new Error('OmniRoute is still starting or needs attention. Automatic recovery remains active; check npm run status and the local startup.log file.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === launcher) {
  const watch = process.argv.includes('--watch');
  const controller = new AbortController();
  if (watch) for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
  (watch ? runSupervisor({ signal: controller.signal }) : startIntegrated()).then(result => {
    if (!watch) console.log(JSON.stringify(result));
  }, error => {
    console.error(watch ? 'The OmniRoute startup service stopped. Check the local startup log and installation.' : error.message);
    process.exitCode = 1;
  });
}
