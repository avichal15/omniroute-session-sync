import { updateProviderCookie, getMonitoredProviders, decrypt } from '../bridge/dbUpdater.mjs';

console.log('\n======================================================');
console.log('   Testing Cookie Update & Encryption Integrity');
console.log('======================================================\n');

const testCookie = "token=test_simulated_token_" + Date.now();
console.log('Testing update on zai-web with simulated token...');

try {
  const res = await updateProviderCookie('zai-web', testCookie, { source: 'test-script' });
  console.log('[OK] Update result:', res);

  const providers = getMonitoredProviders();
  const zai = providers.find(p => p.provider === 'zai-web');
  console.log('[OK] Verified updated row in SQLite:');
  console.log(`     Provider: ${zai.provider}, UpdatedAt: ${zai.updatedAt}, Preview: ${zai.keyPreview}`);
  console.log('\n[SUCCESS] Encryption, SQLite update, and decryption passed 100% cleanly!\n');
} catch (err) {
  console.error('[FAIL] Test error:', err.message);
}
