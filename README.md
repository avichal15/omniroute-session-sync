# OmniRoute Session Sync

Keep one OmniRoute API key in your application while this Chrome extension updates the credentials of your selected browser-session connections. OmniRoute handles model routing and fallback; the extension handles cookie changes.

Version 2 replaces direct database writes with OmniRoute's authenticated management API. Each browser provider maps to **one connection you choose**. Other accounts are left alone.

## Requirements

- Node.js 24–26 and Chrome 120 or newer.
- OmniRoute running locally, normally at `http://127.0.0.1:20128`. The management integration was checked against OmniRoute 3.8.49.
- Existing, active browser connections using OmniRoute's `apikey` authentication type.
- A signed-in browser session for each provider you want to sync.

Supported providers: ChatGPT Web, Gemini Web, Z.ai Web, Qwen Web, Grok Web, and DeepSeek Web. Provider websites can change their authentication requirements. Sync can copy a working session; it cannot renew a revoked session or guarantee uninterrupted upstream service.

## Setup

1. In OmniRoute, turn off Cloud Sync if sessions should remain on this PC. The bridge refuses credential updates, connection tests, and fallback changes unless OmniRoute explicitly reports cloud sync disabled. Keep `allowCloudSync: false` in `bridge/config.json`.
2. Start the bridge from this project folder:

   ```powershell
   npm start
   ```

   It listens on `http://127.0.0.1:20129`. Keep that terminal running. `scripts/start-bridge.bat` is an alternative.

3. Give the bridge a dedicated OmniRoute key with the `manage` scope. If OmniRoute's local CLI authentication already works, this step is unnecessary. Otherwise create the key in OmniRoute and pass it through standard input, not a command argument:

   ```powershell
   $syncKey = Read-Host 'OmniRoute management key' -AsSecureString
   $syncPlain = [System.Net.NetworkCredential]::new('', $syncKey).Password
   $syncPlain | node scripts/configure-gateway.mjs --stdin
   Remove-Variable syncPlain, syncKey
   ```

   The command verifies management access before saving the key in the bridge's private local state. This key is separate from your application's inference key. `OMNIROUTE_MANAGEMENT_TOKEN` is also supported for process-managed configuration.

4. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this project's `extension` directory. If already installed, click **Reload** and check that the version is **2.0.0**.
5. In a second terminal, generate a pairing code:

   ```powershell
   npm run pair
   ```

   Enter it in the extension popup. Codes expire after five minutes and work once. Pairing a different profile replaces the previous pairing and clears account mappings; choose the mappings again. If pairing reports that operations are busy, retry the same unused code after they finish.
6. For each provider, choose the exact OmniRoute connection, then click **Apply**. Sign in to that provider in this Chrome profile, click **Sync**, then **Test**.

**Synced** means OmniRoute accepted the credential update. **Validated** means a separate connection test passed. A provider without a supported test remains Synced. Sign-in failures and temporary upstream errors are shown separately.

The bridge configuration is `bridge/config.json`. Both addresses must stay on loopback. The extension's bridge address is fixed to port 20129; changing that port also requires updating the extension's worker address and host permissions.

## Model fallback

In the popup, add up to eight browser models, arrange their order, and click **Save fallback**. The bridge creates or updates the OmniRoute combo named `browser-sessions` with priority routing. It only offers known browser providers with active connections and rejects official API providers. Existing unrelated combos are preserved.

Keep your existing OmniRoute API key and base URL in the application, and use:

```json
{
  "model": "browser-sessions",
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

Fallback behavior, cooldowns, account selection within a provider, and which failures trigger another attempt are controlled by OmniRoute. A catalog entry is not proof that a particular browser account can use that model; test the route with your account. The popup lets you change the order later.

## Automatic sync and recovery

- Relevant cookie changes debounce independently for each provider, then send freshly read credentials.
- Chrome startup and a one-minute alarm reconcile mapped sessions. Chrome must be running and able to wake the extension worker; timer timing is subject to Chrome and OS scheduling.
- Failed updates remain pending and retry with the latest cookies. Successful acknowledgements are tied to the selected connection and bridge revision, so a failed write cannot suppress a later retry.
- Cookie values are sent only to the paired local bridge. The bridge authenticates, checks the mapping and local-only setting, and calls `PUT /api/providers/:id` on OmniRoute. OmniRoute owns credential encryption and storage.
- Signing out does not replace a saved connection with empty data. The popup requests a new browser login. Other healthy providers may still serve the fallback route.

## Local state and security

The bridge stores its owner token, paired extension token/origin, management token, mappings, status timestamps, acknowledgement hashes, and fallback configuration in:

- Windows: `%LOCALAPPDATA%\OmniRouteSessionSync\state.json`
- Other systems: the OS user-data location selected by `bridge/runtimeState.mjs`
- Tests or custom deployments: `OMNI_SYNC_DATA_DIR` overrides the directory.

The directory is restricted to the current Windows user, or mode `0700` on other systems; the state file is written atomically. Provider cookies are **not** saved in bridge state, logs, or status responses. Chrome's extension storage retains its pairing token and non-secret sync metadata. OmniRoute necessarily stores the provider credentials it uses for inference.

The bridge binds to loopback, requires bearer authentication on protected routes, and binds browser access to the paired extension origin. Requests have size, timeout, and rate limits. Pair only an extension/profile you control, and keep the management key private. The bridge's local-only check governs its own writes; OmniRoute and provider websites still make network requests normally.

## Status and troubleshooting

```powershell
npm run status
```

- **Bridge unavailable:** start `npm start`; check that ports 20128 and 20129 are reachable locally.
- **Management authentication failed:** configure a current `manage`-scoped key with `npm run configure -- --stdin`.
- **Pairing expired or invalid:** run `npm run pair` for a new code. If another profile replaced the pairing, pair this profile again and reselect its connections.
- **Unknown action / Reload extension:** Chrome may still be running the previous background worker while loading the updated popup. Close the popup, open `chrome://extensions` in the profile where you use the provider, and click the extension's Reload arrow. Reopen the popup and pair with a fresh code. Confirm the loaded extension folder is this project's `extension` directory if the message persists. The popup's Refresh button only fetches status; it does not reload Chrome's extension worker.
- **Cloud sync must be disabled:** turn it off in OmniRoute, then retry. Changing an unrelated general setting may not toggle OmniRoute's Cloud Sync control.
- **Not mapped / unavailable connection:** choose an existing active connection of the matching browser provider and supported authentication type.
- **Sign-in required:** log in to the provider in the paired Chrome profile, then Sync and Test.
- **Synced but not validated:** run Test or make a small inference request. Cookie storage success does not establish upstream access.
- **Temporary provider error:** wait for OmniRoute's cooldown or use another browser provider in the fallback order.

For optional Windows sign-in startup, inspect and run `scripts/install-startup.ps1`. It installs a shortcut for the hidden bridge launcher. Startup registration is not part of `npm start` or the tests.

## Development and verification

```powershell
npm test
npm run check
npm audit
```

There are no runtime package dependencies. Tests use synthetic credentials and fake local gateways, never the real OmniRoute database. They cover cookie extraction, account isolation, authenticated HTTP routes, pairing, concurrency, retries, worker restarts, revision handling, validation, and browser-only fallback configuration. Syntax checks also verify extension assets.

The original audit in `audit/AUDIT.md` documents the pre-v2 implementation. Its historical reproduction script targets the old implementation and is not part of the test command. Live Chrome sync and real provider inference must be verified separately from the synthetic suite.

For the synthetic popup check, start `node scripts/popup-fixture.mjs` from the repository root, then run `scripts/popup-smoke.js` with Playwright MCP's `browser_run_code_unsafe` filename argument. Use the repository root as Playwright's working directory. The fixture serves only popup assets on port 20139, creates the ignored `artifacts` directory, and uses the fake pairing code `FIXTURE-123`. It never connects to the real bridge or reads browser sessions.

See [the v2 verification report](audit/V2-VERIFICATION.md) for the recorded test results, live gateway check, and remaining Chrome setup step.
