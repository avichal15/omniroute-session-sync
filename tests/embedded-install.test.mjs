import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.ok(source.includes(', 0, False'));
  assert.ok(!source.includes('cmd.exe'));
});
