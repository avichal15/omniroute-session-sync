import { initDb, getMonitoredProviders, decrypt } from '../bridge/dbUpdater.mjs';

console.log('\n======================================================');
console.log('   OmniRoute Monitored Web-Cookie Providers Status');
console.log('======================================================\n');

try {
  const { hasKey } = initDb();
  console.log(`Database: C:/Users/avich/.omniroute/storage.sqlite`);
  console.log(`Encryption Key Configured: ${hasKey}\n`);

  const providers = getMonitoredProviders();
  if (providers.length === 0) {
    console.log('No web-cookie providers configured in OmniRoute.');
  } else {
    for (const p of providers) {
      const activeIcon = p.isActive ? '🟢 Active' : '⚪ Disabled';
      const statusIcon = p.testStatus === 'active' ? '✅ Ready' : (p.testStatus === 'expired' ? '⚠️ Expired' : '❓ ' + p.testStatus);
      console.log(`Provider: ${p.provider.padEnd(16)} | ID: ${p.id}`);
      console.log(`  Status: ${activeIcon} | Test: ${statusIcon} | Key Preview: ${p.keyPreview}`);
      console.log(`  Updated: ${p.updatedAt || 'Never'} | Last Tested: ${p.lastTested || 'Never'}\n`);
    }
  }
} catch (err) {
  console.error('Error querying status:', err.message);
}
