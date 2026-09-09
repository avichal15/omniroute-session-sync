import { localRequest } from './bridge-client.mjs';
try {
  const result = await localRequest('/api/pairing-code', {});
  console.log(`Pairing code: ${result.code}`);
  console.log('Enter this code in the Chrome extension. It expires in five minutes and can be used once.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
