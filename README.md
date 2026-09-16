# OmniRoute Session Sync

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests: 66 passed](https://img.shields.io/badge/Tests-66%20passed-brightgreen.svg)](tests/)

> **Third-party / community-maintained integration.** OmniRoute Session Sync is an independent open-source companion project and is **not part of the OmniRoute core codebase**. The OmniRoute team has not audited this repository and does not endorse or guarantee its security, privacy, reliability, or compatibility. Review the source and permissions before use. See [THIRD_PARTY_NOTICE.md](THIRD_PARTY_NOTICE.md).

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
   This installs the **OmniRoute Session Sync** Windows Task Scheduler task. It starts silently 20 seconds after this user's Windows sign-in, works on battery, and requires no stored Windows password. The recovery service starts a local bridge process before OmniRoute, monitors both services independently, and retries either one if it stops. Prior environment files and startup scripts are backed up to `%USERPROFILE%\.omniroute\session-sync\backups`; the old Startup-folder VBS is removed only after the replacement task is verified.
   The bridge uses OmniRoute's authenticated local management API, but does not share OmniRoute's event loop. A busy or recovering gateway therefore leaves Chrome's local sync channel available and queues its next retry.
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

3. Give the bridge a dedicated OmniRoute key with the `manage` scope. If OmniRoute's local CLI authentication already works, this step is unnecessary. Otherwise create the key in OmniRoute and pass it through standard input, not a command argument.

4. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this project's `extension` directory. If already installed, click **Reload** and check that the version is **2.0.1**.
5. In a second terminal, generate a pairing code:
   ```powershell
   npm run pair
   ```
   Enter it in the extension popup. Codes expire after five minutes and work once.
6. For each provider, choose the exact OmniRoute connection, then click **Apply**. Sign in to that provider in this Chrome profile, click **Sync**, then **Test**.

**Synced** means OmniRoute accepted the credential update. **Validated** means a separate connection test passed.

## Model fallback

In the popup, add up to eight browser models, arrange their order, and click **Save fallback**. The bridge creates or updates the OmniRoute combo named `browser-sessions` with priority routing.

Keep your existing OmniRoute API key and base URL in the application, and use:

```json
{
  "model": "browser-sessions",
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

Fallback behavior, cooldowns, account selection within a provider, and which failures trigger another attempt are controlled by OmniRoute. A catalog entry is not proof that a particular browser account can use that model; test the route with your account.

## Automatic sync and recovery

- Relevant cookie changes debounce independently for each provider, then send freshly read credentials.
- The Windows sign-in task uses the same saved local data directory every time. Startup recovery remains active, checks health every ten seconds, and backs off retries after repeated CLI failures.
- Chrome startup and a one-minute alarm reconcile mapped sessions.
- Failed updates remain pending and retry with the latest cookies.
- When the local bridge is online but OmniRoute is recovering, the popup shows **OmniRoute recovering** and keeps the current browser session queued for the next automatic retry.
- Cookie values are sent only to the paired local bridge. The bridge authenticates, checks the mapping and local-only setting, and calls `PUT /api/providers/:id` on OmniRoute. OmniRoute owns credential encryption and storage.

## Local state and security

The bridge stores its owner token, paired extension token/origin, management token, mappings, status timestamps, acknowledgement hashes, and fallback configuration in `%USERPROFILE%\.omniroute\session-sync\state.json` on Windows. Provider cookies are **not** saved in bridge state, logs, or status responses.

The bridge binds to loopback, requires bearer authentication on protected routes, and binds browser access to the paired extension origin. Requests have size, timeout, and rate limits. Pair only an extension/profile you control, and keep the management key private.

**For the project's relationship to OmniRoute and the limits of its security claims, see [THIRD_PARTY_NOTICE.md](THIRD_PARTY_NOTICE.md).**

## Development and verification

```powershell
npm test
npm run check
npm audit
```

There are no runtime package dependencies. Tests use synthetic credentials and fake local gateways, never the real OmniRoute database. They cover cookie extraction, account isolation, authenticated HTTP routes, pairing, concurrency, retries, worker restarts, revision handling, validation, and browser-only fallback configuration. Syntax checks also verify extension assets.

See [the v2 verification report](audit/V2-VERIFICATION.md) for the recorded test results, live gateway check, and remaining runtime checks.

## License

This project is licensed under the [MIT License](LICENSE). Copyright (c) 2026 Avichal Goyal.
