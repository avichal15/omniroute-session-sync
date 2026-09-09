import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadState } from '../bridge/runtimeState.mjs';

async function temporaryState(t) {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, 'omni-state-test-'));
  t.after(async () => {
    // Only remove the exact test directory allocated inside the OS temp directory.
    assert.equal(path.dirname(path.resolve(directory)), root);
    assert.ok(path.basename(directory).startsWith('omni-state-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('runtime state persists immutable queued snapshots and survives restart', async t => {
  const directory = await temporaryState(t);
  const { state, persist, filename } = await loadState(directory);
  assert.match(state.ownerToken, /^[a-f0-9]{64}$/);
  const first = structuredClone(state);
  first.mappings = { 'chatgpt-web': 'synthetic-account-a' };
  first.client = { origin: 'chrome-extension://' + 'a'.repeat(32), token: 'synthetic-pairing-token' };
  const second = structuredClone(first);
  second.mappings['qwen-web'] = 'synthetic-account-b';
  const pending = [persist(first), persist(second)];
  second.mappings['qwen-web'] = 'changed-after-enqueue';
  await Promise.all(pending);
  // Persisting a candidate must not publish it into the service's live object.
  assert.deepEqual(state.mappings, {});
  const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.equal(saved.mappings['qwen-web'], 'synthetic-account-b');
  assert.equal(saved.ownerToken, state.ownerToken);
  const restarted = await loadState(directory);
  assert.deepEqual(restarted.state, saved);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['state.json']);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  }
});

test('corrupt runtime state is preserved and rejected instead of resetting authentication', async t => {
  const directory = await temporaryState(t);
  const filename = path.join(directory, 'state.json');
  await fs.writeFile(filename, '{broken');
  await assert.rejects(loadState(directory), { code: 'STATE_INVALID' });
  assert.equal(await fs.readFile(filename, 'utf8'), '{broken');
});
