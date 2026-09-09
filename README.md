# OmniRoute Session Sync

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests: 66 passed](https://img.shields.io/badge/Tests-66%20passed-brightgreen.svg)](tests/)

Automated local cookie and session synchronization between Google Chrome and OmniRoute. Keep a single OmniRoute API key in your application while the extension updates credentials for your chosen browser-session connections when web cookies rotate.

For an in-depth walkthrough of data flow, architecture, and step-by-step pairing, see the [Architecture and Operator Guide](GUIDE.md).

Version 2 replaces direct database writes with OmniRoute's authenticated management API. Each browser provider maps to **one connection you choose**. Other accounts are left alone.

## Requirements

- Node.js 24–26 and Chrome 120 or newer.
- OmniRoute running locally, normally at `http://127.0.0.1:20128`. The management integration was checked against OmniRoute 3.8.49.
- Existing, active browser connections using OmniRoute's `apikey` authentication type.
- A signed-in browser session for each provider you want to sync.

Supported providers: ChatGPT Web, Gemini Web, Z.ai Web, Qwen Web, Grok Web, and DeepSeek Web. Provider websites can change their authentication requirements. Sync can copy a working session; it cannot renew a revoked session or guarantee uninterrupted upstream service.

## Setup

This is a **one-time setup per Chrome profile**. Pairing, account mappings, and fallback choices survive browser restarts and laptop restarts.

1. In OmniRoute, turn off Cloud Sync if sessions should remain on this PC. The bridge refuses credential updates, connection tests, and fallback changes unless OmniRoute explicitly reports cloud sync disabled. Keep `allowCloudSync: false` in `bridge/config.json`.
2. Start the bridge using either Embedded Mode (recommended) or Standalone Mode:

   ### Option A: Embedded Mode (Starts with OmniRoute)
   Run the one-time embedded installer:
   ```powershell
   npm run setup:embedded
   ```
   This configures OmniRoute's `.env` with a main-thread `--import` preload and installs the **OmniRoute Session Sync** Windows Task Scheduler task. It starts silently 20 seconds after this user's Windows sign-in, works on battery, and requires no stored Windows password. A recovery service starts OmniRoute, checks both local services, and retries when the CLI stops. The task restarts the recovery service if that process fails. Prior environment files and startup scripts are backed up to `%USERPROFILE%\.omniroute\session-sync\backups`; the old Startup-folder VBS is removed only after the replacement task is verified.
   If OmniRoute is already running when you install, restart its CLI supervisor once to load the preload. The sync listener then runs inside the same process as OmniRoute. Future starts reuse the saved setup automatically.
   To start OmniRoute with Session Sync immediately:
   ```powershell
   npm run start:integrated
   ```
   This command waits for both services to be ready, allowing up to five minutes for a cold start. A local instance guard prevents duplicate launches while initialization is in progress. If the wait times out, background recovery continues and `npm run status` shows startup progress.

   ### Option B: Standalone Mode
   Run the bridge independently from this folder:
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

Keep this project directory in place: the installed preload and unpacked Chrome extension use its files. Do not run standalone and embedded sync on the same port.

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
- The Windows sign-in task uses the same saved local data directory every time. Startup recovery remains active, checks health every ten seconds, and backs off retries after repeated CLI failures. A provider authentication failure does not cause the application to restart or reset its pairing.
- Chrome startup and a one-minute alarm reconcile mapped sessions. Chrome must be running and able to wake the extension worker; timer timing is subject to Chrome and OS scheduling.
- The extension requests Chrome's `background` permission so Chrome can start at computer login and remain running after its last window closes. Explicitly quitting Chrome, or disabling its background operation, stops browser-side work until Chrome starts again. See [Chrome's permission documentation](https://developer.chrome.com/docs/extensions/reference/permissions-list#background).
- Failed updates remain pending and retry with the latest cookies. Successful acknowledgements are tied to the selected connection and bridge revision, so a failed write cannot suppress a later retry.
- Cookie values are sent only to the paired local bridge. The bridge authenticates, checks the mapping and local-only setting, and calls `PUT /api/providers/:id` on OmniRoute. OmniRoute owns credential encryption and storage.
- Signing out does not replace a saved connection with empty data. The popup requests a new browser login. Other healthy providers may still serve the fallback route.

## Local state and security

The bridge stores its owner token, paired extension token/origin, management token, mappings, status timestamps, acknowledgement hashes, and fallback configuration in:

- Windows: `%USERPROFILE%\.omniroute\session-sync\state.json`
- Other systems: the OS user-data location selected by `bridge/runtimeState.mjs`
- Tests or custom deployments: `OMNI_SYNC_DATA_DIR` overrides the directory.

The directory is restricted to the current Windows user, or mode `0700` on other systems; the state file is written atomically. Provider cookies are **not** saved in bridge state, logs, or status responses. Chrome's extension storage retains its pairing token and non-secret sync metadata. OmniRoute necessarily stores the provider credentials it uses for inference.

Windows uses this home-directory location because packaged desktop apps can redirect AppData into a private copy that Windows startup cannot read. The installer imports an existing v2 state when the destination has no state, preserving pairing and mappings and keeping the source as a backup. For an explicit migration source, use `npm run setup:embedded -- --migrate-from "C:\absolute\previous-state-directory"`. An existing destination state is never overwritten by migration.

Embedded setup also writes `installation.json` here, containing local program/configuration paths, and saves original environment/startup files under `backups`. Those backups can contain original OmniRoute secrets and inherit the private directory permissions. `startup-status.json` records readiness and process IDs; `startup.log` records startup, exit and recovery events and rotates at 256 KB. Console output and provider credentials are not copied into these diagnostics. Setup changes only the preload entry in OmniRoute's environment; it does not change global Node or Codex configuration. `OMNI_SYNC_CONFIG_FILE` selects an alternate bridge configuration for isolated tests or custom installations.

The bridge binds to loopback, requires bearer authentication on protected routes, and binds browser access to the paired extension origin. Requests have size, timeout, and rate limits. Pair only an extension/profile you control, and keep the management key private. The bridge's local-only check governs its own writes; OmniRoute and provider websites still make network requests normally.

## Status and troubleshooting

```powershell
npm run status
```

- **Bridge unavailable:** start OmniRoute with `npm run start:integrated`; check that ports 20128 and 20129 are reachable locally. Restart the CLI supervisor once if embedded setup was installed while it was already running.
- **Not ready after Windows sign-in:** check `npm run status` and `%USERPROFILE%\.omniroute\session-sync\startup.log`. Task Scheduler should show **OmniRoute Session Sync** enabled and running. Cold initialization can take several minutes; an open port alone does not mean the gateway is ready. The task runs after Windows sign-in, rather than before a user logs in.
- **Management authentication failed:** configure a current `manage`-scoped key with `npm run configure -- --stdin`.
- **Pairing expired or invalid:** run `npm run pair` for a new code. If another profile replaced the pairing, pair this profile again and reselect its connections.
- **Unknown action / Reload extension:** Chrome may still be running the previous background worker while loading the updated popup. Close the popup, open `chrome://extensions` in the profile where you use the provider, and click the extension's Reload arrow. Reopen the popup and pair with a fresh code. Confirm the loaded extension folder is this project's `extension` directory if the message persists. The popup's Refresh button only fetches status; it does not reload Chrome's extension worker.
- **Cloud sync must be disabled:** turn it off in OmniRoute, then retry. Changing an unrelated general setting may not toggle OmniRoute's Cloud Sync control.
- **Not mapped / unavailable connection:** choose an existing active connection of the matching browser provider and supported authentication type.
- **Sign-in required:** log in to the provider in the paired Chrome profile, then Sync and Test.
- **Synced but not validated:** run Test or make a small inference request. Cookie storage success does not establish upstream access.
- **Temporary provider error:** wait for OmniRoute's cooldown or use another browser provider in the fallback order.

Embedded setup manages the **OmniRoute Session Sync** Windows task and migrates the previous OmniRoute Startup-folder VBS. To deliberately stop automatic operation, disable the task and end its running instance in Task Scheduler. The older `scripts/install-startup.ps1` is for standalone bridge deployments only; do not install it alongside embedded mode. Tests never register startup entries or edit the real OmniRoute environment.

## Development and verification

```powershell
npm test
npm run check
npm audit
```

There are no runtime package dependencies. Tests use synthetic credentials and fake local gateways, never the real OmniRoute database. They cover cookie extraction, account isolation, authenticated HTTP routes, pairing, concurrency, retries, worker restarts, revision handling, validation, and browser-only fallback configuration. Syntax checks also verify extension assets.

The original audit in `audit/AUDIT.md` documents the pre-v2 implementation. Its historical reproduction script targets the old implementation and is not part of the test command. Live Chrome sync and real provider inference must be verified separately from the synthetic suite.

For the synthetic popup check, start `node scripts/popup-fixture.mjs` from the repository root, then run `scripts/popup-smoke.js` with Playwright MCP's `browser_run_code_unsafe` filename argument. Use the repository root as Playwright's working directory. The fixture serves only popup assets on port 20139, creates the ignored `artifacts` directory, and uses the fake pairing code `FIXTURE-123`. It never connects to the real bridge or reads browser sessions.

See [the v2 verification report](audit/V2-VERIFICATION.md) for the recorded test results, live gateway check, and remaining runtime checks.

## License

This project is licensed under the [MIT License](LICENSE). Copyright (c) 2026 Avichal Goyal.
