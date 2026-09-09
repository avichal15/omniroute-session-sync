// Run with Playwright MCP browser_run_code_unsafe after starting popup-fixture.mjs.
// Use the repository root as the Playwright working directory. The fixture CLI creates artifacts/.
// This test visits only the synthetic fixture; it never accesses extension pages or browser sessions.
async (page) => {
  const origin = 'http://127.0.0.1:20139';
  const artifacts = 'artifacts';
  const checks = [];
  const errors = [];
  const warnings = [];
  const requests = [];
  const onError = error => errors.push(error.message);
  const onConsole = message => {
    if (message.type() === 'error') errors.push(message.text());
    if (message.type() === 'warning') warnings.push(message.text());
  };
  const onRequest = request => requests.push(request.url());
  const check = (name, passed) => {
    if (!passed) throw new Error(name);
    checks.push(name);
  };
  const refreshFinished = () => page.waitForFunction(() => document.getElementById('refreshBtn').textContent === 'Refresh');
  page.on('pageerror', onError);
  page.on('console', onConsole);
  page.on('request', onRequest);
  try {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto(origin + '/?worker=legacy');
    await refreshFinished();
    check('Legacy worker status explains how to reload the extension', (await page.locator('#statusNotice').textContent()).includes('chrome://extensions'));
    await page.locator('#pairCode').fill('FIXTURE-123');
    check('Pairing is disabled for an incompatible worker', await page.locator('#pairBtn').isDisabled());
    check('No pairing code is sent to a legacy worker', await page.evaluate(() => !omniPopupFixture.calls().some(call => call.action === 'PAIR')));
    await page.goto(origin + '/?worker=unknown-pair');
    await page.evaluate(() => omniPopupFixture.reset());
    await page.reload();
    await refreshFinished();
    await page.locator('#pairCode').fill('FIXTURE-123');
    await page.locator('#pairBtn').click();
    await page.waitForFunction(() => document.getElementById('pairFeedback').dataset.state === 'error');
    check('Unknown action reports extension reload instructions', (await page.locator('#pairFeedback').textContent()).includes('chrome://extensions'));
    check('Unknown action disables repeated pairing attempts', await page.locator('#pairBtn').isDisabled());
    await page.goto(origin + '/');
    await page.evaluate(() => {
      if (!globalThis.omniPopupFixture?.synthetic) throw new Error('Synthetic fixture required');
      omniPopupFixture.reset();
    });
    await page.reload();
    await page.locator('#pairingSection').waitFor({ state: 'visible' });
    check('Unpaired setup is visible', await page.locator('#pairedContent').isHidden());
    check('Pairing command is shown', await page.locator('.command').textContent() === 'node scripts/pair.mjs');
    check('Fixture is explicitly synthetic', (await page.locator('#fixtureBanner').textContent()).includes('SYNTHETIC FIXTURE'));
    await page.screenshot({ path: `${artifacts}/popup-synthetic-unpaired.png`, fullPage: true, scale: 'css' });
    await page.locator('#pairCode').fill('FIXTURE-123');
    await page.locator('#pairBtn').click();
    await page.locator('#pairedContent').waitFor({ state: 'visible' });
    const account = page.locator('#connection-chatgpt-web');
    check('No account is selected implicitly', await account.inputValue() === '');
    check('Explicit connection placeholder is shown', await account.locator('option').first().textContent() === 'Choose connection');
    check('Disabled and unsupported accounts cannot be selected', await account.locator('option:disabled').count() === 2);
    check('Sync is disabled before mapping', await page.getByRole('button', { name: 'Sync ChatGPT Web', exact: true }).isDisabled());
    await account.selectOption('chatgpt-web-work');
    check('No mapping request occurs before Apply', await page.evaluate(() => !omniPopupFixture.calls().some(call => call.action === 'MAP_PROVIDER')));
    const refreshes = await page.evaluate(() => omniPopupFixture.calls().filter(call => call.action === 'GET_STATUS').length);
    await page.waitForTimeout(5500);
    check('Automatic refresh ran', await page.evaluate(before => omniPopupFixture.calls().filter(call => call.action === 'GET_STATUS').length > before, refreshes));
    check('Account draft survives automatic refresh', await account.inputValue() === 'chatgpt-web-work');
    await page.getByRole('button', { name: 'Apply ChatGPT Web connection', exact: true }).click();
    const chat = page.locator('.provider-card').first();
    await chat.locator('.feedback').filter({ hasText: 'Connection mapping saved.' }).waitFor();
    await refreshFinished();
    check('Explicit account mapping is saved', await page.evaluate(() => omniPopupFixture.snapshot().providers[0].connectionId === 'chatgpt-web-work'));

    await page.evaluate(() => omniPopupFixture.queueError('SYNC_ONE', { code: 'SYNC_FAILED', message: 'Synthetic bridge refused the update.', phase: 'error' }));
    await page.getByRole('button', { name: 'Sync ChatGPT Web', exact: true }).click();
    await chat.locator('.feedback').filter({ hasText: 'Synthetic bridge refused the update.' }).waitFor();
    await page.waitForFunction(() => document.querySelector('.provider-card .badge').textContent === 'Error');
    check('Sync failure displays error feedback and phase', await chat.locator('.feedback').getAttribute('data-state') === 'error');
    await page.evaluate(() => omniPopupFixture.queueError('VALIDATE_PROVIDER', { code: 'VALIDATION_UNSUPPORTED', message: 'Synthetic provider does not support a connection test.', phase: 'synced' }));
    await page.getByRole('button', { name: 'Test ChatGPT Web', exact: true }).click();
    await chat.locator('.feedback').filter({ hasText: 'Synthetic provider does not support a connection test.' }).waitFor();
    await page.waitForFunction(() => document.querySelector('.provider-card .badge').textContent === 'Synced');
    check('Unsupported test is not called successful or validated', await chat.locator('.feedback').getAttribute('data-state') === 'error');

    const picker = page.locator('#fallbackModel');
    check('Official API models are absent from the picker', !(await picker.locator('option').evaluateAll(options => options.some(option => option.value.includes('openai/')))));
    const ids = ['chatgpt-web/synthetic-model', 'gemini-web/synthetic-model', 'chatgpt-web/synthetic-model-with-a-long-identifier-to-check-wrapping'];
    for (const id of ids) { await picker.selectOption(id); await page.locator('#addModelBtn').click(); }
    check('Models can be added', await page.locator('#fallbackList li').count() === 3);
    await page.locator('#fallbackList li').nth(2).locator('[data-action="up"]').click();
    await page.locator('#fallbackList li').nth(0).locator('[data-action="down"]').click();
    check('Up and Down change model order', JSON.stringify(await page.locator('#fallbackList .model-id').allTextContents()) === JSON.stringify([ids[2], ids[0], ids[1]]));
    await page.locator('#fallbackList li').nth(0).locator('[data-action="remove"]').click();
    check('Remove updates the draft', await page.locator('#fallbackList li').count() === 2);
    await picker.selectOption(ids[2]);
    await page.locator('#addModelBtn').click();
    await page.locator('#fallbackList li').nth(2).locator('[data-action="up"]').click();
    const expected = [ids[0], ids[2], ids[1]];
    await page.locator('#refreshBtn').click();
    await refreshFinished();
    check('Fallback draft survives refresh', JSON.stringify(await page.locator('#fallbackList .model-id').allTextContents()) === JSON.stringify(expected));
    await page.locator('#saveFallbackBtn').click();
    await page.locator('#fallbackFeedback').filter({ hasText: 'Saved as browser-sessions.' }).waitFor();
    check('Save preserves exact model order', await page.evaluate(order => JSON.stringify(omniPopupFixture.snapshot().fallback.models) === JSON.stringify(order), expected));
    await page.reload();
    await page.locator('#fallbackList li').nth(2).waitFor();
    check('Saved order reloads from fixture status', JSON.stringify(await page.locator('#fallbackList .model-id').allTextContents()) === JSON.stringify(expected));
    check('Saved badge is accurate', await page.locator('#fallbackSavedBadge').textContent() === 'Saved');
    await page.evaluate(() => {
      const select = document.getElementById('fallbackModel');
      const option = document.createElement('option');
      option.value = 'openai/synthetic-official-model'; option.textContent = 'Injected synthetic official API'; option.id = 'injectedSyntheticOption';
      select.append(option); select.value = option.value; select.dispatchEvent(new Event('change'));
    });
    check('An injected official model cannot be added', await page.locator('#addModelBtn').isDisabled());
    check('No official API ID enters the fallback', !(await page.locator('#fallbackList .model-id').allTextContents()).some(id => id.includes('openai/')));
    await page.evaluate(() => {
      document.getElementById('injectedSyntheticOption')?.remove();
      const select = document.getElementById('fallbackModel'); select.value = ''; select.dispatchEvent(new Event('change'));
    });
    const layout = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    check('No horizontal overflow at 420px, including long model IDs', layout.page <= layout.viewport && layout.body <= layout.viewport);
    check('Only the synthetic fixture was requested', requests.every(url => url.startsWith(origin + '/')));
    check('No browser errors or warnings', errors.length === 0 && warnings.length === 0);
    await page.screenshot({ path: `${artifacts}/popup-synthetic-420.png`, fullPage: true, scale: 'css' });
    const result = { checks, errors, warnings, requests, layout, finalOrder: expected,
      screenshots: [`${artifacts}/popup-synthetic-unpaired.png`, `${artifacts}/popup-synthetic-420.png`] };
    return result;
  } finally {
    page.off('pageerror', onError);
    page.off('console', onConsole);
    page.off('request', onRequest);
  }
}
