import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

export function gatewayHeaders(state, config = {}) {
  let cliToken;
  return () => {
    const managementToken = process.env.OMNIROUTE_MANAGEMENT_TOKEN || state.managementToken;
    if (managementToken) return { Authorization: `Bearer ${managementToken}` };
    if (process.env.OMNIROUTE_CLI_TOKEN) return { 'x-omniroute-cli-token': process.env.OMNIROUTE_CLI_TOKEN };
    if (cliToken === undefined) {
      try {
        const install = config.omnirouteInstallDir || process.env.OMNIROUTE_INSTALL_DIR ||
          (process.platform === 'win32' ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'omniroute')
            : path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'omniroute'));
        const require = createRequire(path.join(install, 'package.json'));
        // OmniRoute's published CLI algorithm, with CJS interop for node-machine-id.
        const module = require('node-machine-id');
        const machineId = (module.machineIdSync || module.default?.machineIdSync)();
        cliToken = machineId ? createHash('sha256').update(machineId + (process.env.OMNIROUTE_CLI_SALT || 'omniroute-cli-auth-v1')).digest('hex').slice(0, 32) : '';
      } catch { cliToken = ''; }
    }
    return cliToken ? { 'x-omniroute-cli-token': cliToken } : {};
  };
}
