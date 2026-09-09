import { localRequest } from './bridge-client.mjs';
try {
  let token = process.env.OMNIROUTE_MANAGEMENT_TOKEN;
  if (process.argv.includes('--stdin')) {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 8192) throw new Error('Token input is too long'); }
    token = input.trim();
  }
  if (!token) throw new Error('Supply a manage-scoped OmniRoute key through OMNIROUTE_MANAGEMENT_TOKEN or --stdin. Do not put keys in command arguments.');
  await localRequest('/api/gateway-auth', { token });
  console.log('OmniRoute management access verified and saved in the private bridge configuration.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
