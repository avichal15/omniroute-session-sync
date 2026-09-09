# OmniRoute Session Sync: Architecture and Operator Guide

This guide explains how Session Sync captures browser session cookies from Google Chrome, forwards them to a local OmniRoute instance, and maintains automated model routing when web sessions rotate.

---

## How It Works

OmniRoute exposes an OpenAI-compatible HTTP interface (`/v1/chat/completions`) backed by multiple model providers. For web-based providers (such as ChatGPT Web, Gemini Web, Z.ai Web, Qwen Web, Grok Web, and DeepSeek Web), OmniRoute uses browser session cookies instead of standard API keys.

Web session cookies expire or rotate during normal browser usage. When a cookie changes, requests made through OmniRoute fail until the new cookie value is copied into OmniRoute's provider settings.

Session Sync automates this update path locally:

```
+------------------+         Local Loopback         +-------------------+
|  Google Chrome   |   HTTP POST (Bearer Auth)     | Session Sync      |
|  Extension       | ----------------------------> | Bridge (Port 20129|
|  (background.js) |                               +-------------------+
+------------------+                                         |
         |                                                   | PUT /api/providers/:id
         | Reads cookies                                     v
         v                                         +-------------------+
  chatgpt.com, ...                                 | OmniRoute Gateway |
                                                   | (Port 20128)      |
                                                   +-------------------+
                                                             |
                                                             v
                                                   storage.sqlite (encrypted)
```

1. The Chrome extension listens for cookie changes across supported provider domains.
2. When a relevant cookie updates, the background service worker extracts and formats the session credentials.
3. The extension transmits the payload over loopback to the Session Sync bridge on port 20129.
4. The bridge authenticates the request using an origin-bound bearer token generated during pairing.
5. The bridge calls OmniRoute's management API (`PUT /api/providers/:id`) to save the updated cookie in OmniRoute's encrypted database.
6. OmniRoute immediately uses the fresh session for subsequent inference requests.

At no point are cookie values saved to disk by the sync bridge. OmniRoute remains the sole persistent store and encryption owner for inference credentials.

---

## Runtime Modes

Session Sync supports two execution models:

### 1. Embedded Mode (Default & Recommended)

The bridge runs inside OmniRoute's existing Node.js server process through an `--import` preload (`bridge/omniroute-preload.mjs`).

- Single OS process handles both the OmniRoute API (port 20128) and the sync bridge (port 20129).
- The preload attaches before OmniRoute's HTTP wrappers initialize.
- A Windows Scheduled Task (`OmniRoute Session Sync`) manages autostart on user sign-in, with automatic process recovery and backoff.
- No extra terminal windows or standalone background daemons are required.

### 2. Standalone Mode

The bridge runs as an independent Node.js HTTP server started via `npm start`.

- Useful for testing, development, or environments where OmniRoute runs in a container or external machine reachable over loopback.
- Requires keeping a terminal process running or managing a separate service wrapper.

---

## Installation & Setup

### Prerequisites

- Node.js 24 through 26.
- Google Chrome 120 or newer.
- OmniRoute 3.8.49 or newer running locally.
- Active browser connections already created in OmniRoute under each provider you plan to sync.

---

### Step 1: Verify OmniRoute Local Security Settings

The bridge requires Cloud Sync to be disabled so session credentials never leave your machine:

1. Open OmniRoute's web interface (default: `http://127.0.0.1:20128`).
2. Go to **Settings** and ensure **Cloud Sync** is turned off.
3. In `bridge/config.json`, verify `"allowCloudSync": false`. If OmniRoute reports Cloud Sync is enabled, the bridge rejects credential updates.

---

### Step 2: Run One-Time Embedded Setup

From the project root:

```powershell
npm run setup:embedded
```

What this does:
- Locates your local OmniRoute installation and data directory.
- Updates OmniRoute's `.env` to include `--import=.../bridge/omniroute-preload.mjs` in `NODE_OPTIONS`.
- Backs up existing environment files to `%USERPROFILE%\.omniroute\session-sync\backups`.
- Registers a Windows Scheduled Task (`OmniRoute Session Sync`) to run `scripts/start-integrated.mjs --watch` on logon with a 20-second startup delay.
- Removes obsolete startup scripts from `shell:startup`.

To start OmniRoute with Session Sync immediately:

```powershell
npm run start:integrated
```

Verify that both ports are active under the same PID:

```powershell
npm run status
```

---

### Step 3: Configure OmniRoute Management Key (If Required)

If OmniRoute's CLI already has local management access, the bridge uses it automatically. If management authentication is needed, generate a key with the `manage` scope in OmniRoute and pass it via standard input:

```powershell
$key = Read-Host 'OmniRoute Management Key' -AsSecureString
$plain = [System.Net.NetworkCredential]::new('', $key).Password
$plain | node scripts/configure-gateway.mjs --stdin
Remove-Variable plain, key
```

This stores the management credential in `%USERPROFILE%\.omniroute\session-sync\state.json` with user-only file access permissions (`0600` / Windows ACLs).

---

### Step 4: Install the Chrome Extension

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Turn on **Developer mode** using the toggle in the top right corner.
3. Click **Load unpacked**.
4. Select the `extension` folder inside this project repository (`c:\omni\extension`).
5. Confirm that **OmniRoute Session Sync** appears with version **2.0.0**.

---

### Step 5: Pair Chrome with the Bridge

Pairing links your specific Chrome profile to the local bridge so arbitrary web pages or unauthorized local scripts cannot send updates.

1. In your terminal, generate a one-time pairing code:

   ```powershell
   npm run pair
   ```

   The code is 8 characters long and valid for 5 minutes.

2. Click the OmniRoute Session Sync icon in your Chrome toolbar to open the popup.
3. Paste the pairing code into the input field and click **Connect**.
4. Once connected, the popup displays the list of supported browser providers and available OmniRoute connections.

Pairing is permanent for that Chrome profile. You do not need to re-pair on subsequent reboots.

---

### Step 6: Map Accounts and Test Synchronization

1. In the popup, find the provider you wish to use (for example, **ChatGPT Web**).
2. Open the dropdown and select the specific OmniRoute connection ID assigned to that account.
3. Click **Apply**.
4. Make sure you are signed in to that provider in your browser (e.g. `https://chatgpt.com`).
5. Click **Sync** to force an initial cookie transfer.
6. Click **Test** to run an upstream validation check through OmniRoute.

Status indicators:
- **Pending:** Account mapped, waiting for browser cookies.
- **Synced:** Fresh cookie payload delivered and saved in OmniRoute.
- **Validated:** OmniRoute verified the session against the provider API.
- **Login Required:** The provider rejected the session; sign in to the website again in Chrome.

---

### Step 7: Configure Model Fallback Routing

To prevent interruptions when a specific provider experiences rate limits or temporary outages, configure a fallback route:

1. In the extension popup, expand the **Model Fallback** section.
2. Select models from the available browser providers (e.g. `chatgpt-web/gpt-5.5`, `gemini-web/gemini-3.5-flash`, `qwen-web/qwen3.7-plus`, `zai-web/glm-5.3`).
3. Drag or order them by priority.
4. Click **Save fallback**.

This creates an OmniRoute combo named `browser-sessions`. In your code or client applications, point requests to `model: "browser-sessions"`. OmniRoute will route queries to the first available provider and fail over to subsequent models if errors occur.

```json
{
  "model": "browser-sessions",
  "messages": [
    { "role": "user", "content": "Explain binary search trees." }
  ]
}
```

---

## Internal Mechanics

### Independent Provider Debounce & Queuing

Different providers update cookies on independent cycles. The extension maintains per-provider debouncing:
- Cookie events for ChatGPT do not delay or block events from Gemini or Qwen.
- Rapid successive cookie writes (such as session rotation plus analytics tokens) collapse into a single read of the latest cookie jar state.
- In-flight HTTP sync requests do not overlap; new changes queue cleanly behind active transmissions.

### Cookie Sanitization & Chunk Reassembly

Each provider has unique extraction logic defined in `extension/lib/cookieExtractors.js`:
- **ChatGPT:** Reassembles chunked session cookies (`__Secure-next-auth.session-token.0`, `.1`, `.2`, etc.) in sequential numeric order.
- **DeepSeek:** Rejects analytics-only identifiers (`HSSO_TOKEN`) and extracts authentic `userToken` sessions.
- **Gemini:** Gathers the complete `__Secure-1PSID`, `__Secure-1PSIDTS`, `__Secure-1PSIDCC`, and `__Secure-1PAPISID` token chain.
- **Qwen:** Reconstructs canonical headers from `chat.qwen.ai` without duplicating root domain cookies.

### State Persistence & Redirection Protection

On Windows, sandboxed applications (such as packaged editors or terminal hosts) can redirect `%LOCALAPPDATA%` into isolated `LocalCache` directories. If the startup launcher and the interactive terminal look at different paths, pairing records fail to resolve.

Session Sync solves this by storing all state in:
```
%USERPROFILE%\.omniroute\session-sync\state.json
```
This path is uniform across native Windows scheduled tasks, user shells, and packaged runtimes.

---

## Operational Commands

| Command | Purpose |
| --- | --- |
| `npm run verify` | Runs syntax checks across all 32 files and executes the 66-test test suite. |
| `npm run status` | Inspects health of OmniRoute, bridge lifecycle, pairing status, and mapped accounts. |
| `npm run setup:embedded` | Configures OmniRoute preload and Windows Scheduled Task autostart. |
| `npm run start:integrated` | Launches OmniRoute with Session Sync supervisor in the background. |
| `npm run pair` | Generates a single-use pairing code for the Chrome extension popup. |
| `npm run configure -- --stdin` | Saves an OmniRoute management token securely into local state. |

---

## Troubleshooting

### Bridge reports offline when running `npm run status`
Check whether the recovery service is running:
```powershell
node scripts/start-integrated.mjs
```
Review the startup log at `%USERPROFILE%\.omniroute\session-sync\startup.log` for port conflicts or missing Node paths.

### Extension displays "Unknown action" or fails to pair
This occurs if Chrome is still executing an older version of the background service worker.
1. Open `chrome://extensions`.
2. Click the **Reload** button on the OmniRoute Session Sync card.
3. Open the extension popup, run `npm run pair`, and enter the fresh code.

### Status shows "Cloud sync must be disabled"
OmniRoute has Cloud Sync active. Disable Cloud Sync in OmniRoute Settings under General or Cloud Settings. The bridge will not write credentials while Cloud Sync is enabled.
