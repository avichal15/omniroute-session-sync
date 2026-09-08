# OmniRoute Session Sync audit

Audited 8 September 2026. Scope: all application source, extension assets, configuration, launch scripts, and the test script in `C:\omni`. This directory is not a Git repository, so this is an audit of the current files rather than a commit comparison.

**Verdict: address the credential-write and test-isolation problems before relying on unattended sync.** There are three P1 findings and nine P2 findings below. P1 means high priority because ordinary use or an unauthorized request can replace credentials. P2 means a concrete reliability, configuration, or deployment defect that should be fixed next.

Application source and configuration were not changed. This audit added only this report and [reproduce.mjs](C:/omni/audit/reproduce.mjs).

## Findings

### 1. P1 — Credential mutation endpoints have no authentication or provider restriction

**Location:** [server.mjs:110](C:/omni/bridge/server.mjs:110), [server.mjs:35](C:/omni/bridge/server.mjs:35), [dbUpdater.mjs:112](C:/omni/bridge/dbUpdater.mjs:112).

Any caller able to reach the loopback bridge can call `/api/sync` or `/api/sync/bulk` without authentication. The supplied provider is passed directly to the database updater, which permits existing non-web providers as well. The server accepts JSON in a `text/plain` body and returns wildcard CORS headers. An isolated request with an unrelated Origin replaced the key of a synthetic `openai` connection and received HTTP 200. Loopback binding limits reachability; it does not authenticate callers. Whether a remote website can reach loopback also depends on the browser's local-network access policy; that browser path was not tested.

Unauthenticated `/api/status` and `/api/needed` also expose decrypted credential previews: values up to 25 characters are returned in full, and longer values expose 15 leading and 10 trailing characters ([dbUpdater.mjs:83](C:/omni/bridge/dbUpdater.mjs:83)). The short-value disclosure was reproduced with a synthetic token.

**Fix:** pair the extension and bridge with a secret, authenticate protected routes, restrict permitted origins and request formats, and allow writes only to explicitly mapped web-provider connection IDs. Return credential-presence metadata instead of fragments of credentials.

### 2. P1 — A sync replaces every account belonging to the provider

**Location:** [dbUpdater.mjs:112](C:/omni/bridge/dbUpdater.mjs:112), [dbUpdater.mjs:134](C:/omni/bridge/dbUpdater.mjs:134).

The updater selects all rows with the same provider and assigns the same browser cookie to every row. It does not select an account or exclude disabled connections. Two synthetic connections with different credentials, including a disabled connection, were both overwritten by one sync. Their existing account metadata remains while their credentials now represent the same browser account.

This is relevant to the current installation: a read-only aggregate query found two connections each for `chatgpt-web`, `gemini-web`, and `zai-web`, and one for `qwen-web`. No credential values were queried.

**Fix:** require an explicit browser-account-to-connection mapping and update one connection by ID. Reject ambiguous mappings and preserve disabled connections unless explicitly selected for sync.

### 3. P1 — `npm test` overwrites real Z.ai credentials

**Location:** [test-sync.mjs:7](C:/omni/scripts/test-sync.mjs:7), [test-sync.mjs:11](C:/omni/scripts/test-sync.mjs:11), [dbUpdater.mjs:18](C:/omni/bridge/dbUpdater.mjs:18).

The package's test command generates a fake token and calls the production updater without an isolated database configuration. That opens the user's real OmniRoute database and overwrites all `zai-web` connections, without restoring their previous values. Running the same script against an in-memory fixture confirmed that both existing credentials were replaced with simulated tokens.

The script also prints an encryption-success claim without asserting encryption or a correct round trip. Its catch block logs failures without throwing or setting a nonzero exit code ([test-sync.mjs:19](C:/omni/scripts/test-sync.mjs:19)); an injected database failure confirmed that behavior.

**Fix:** make the test command use a temporary or in-memory database, synthetic keys, real assertions, and nonzero failure exits. Do not use production credentials or tables as fixtures.

### 4. P2 — Key parsing can disable encryption or derive the wrong key

**Location:** [dbUpdater.mjs:24](C:/omni/bridge/dbUpdater.mjs:24), [dbUpdater.mjs:41](C:/omni/bridge/dbUpdater.mjs:41).

The `.env` parser only captures an unquoted hexadecimal prefix. A quoted key is missed; a non-hex key beginning with hex characters is silently truncated. If no key is found, `encrypt()` returns the plaintext and sync continues. Fixtures confirmed plaintext database writes for a missing or quoted key, and ciphertext that cannot be decrypted using the intended full non-hex key.

The configured key file currently exists and the regex matches its complete value, so the parser failure was not observed for today's configuration. A separate synthetic compatibility check confirmed that the AES-GCM format and salt match the installed OmniRoute version when the same key is used.

**Fix:** use a proper environment-file parser, preserve the full key exactly as OmniRoute does, and refuse credential writes when encryption configuration is missing or invalid. Treat key rotation explicitly.

### 5. P2 — API success responses hide failed database updates

**Location:** [server.mjs:126](C:/omni/bridge/server.mjs:126), [server.mjs:161](C:/omni/bridge/server.mjs:161), [server.mjs:171](C:/omni/bridge/server.mjs:171).

`updateProviderCookie()` returns `{ success: false, updatedRows: 0 }` when no connection exists, but the single endpoint wraps this in `success: true`. The bulk endpoint also labels the item successful; even caught item errors leave the top-level response successful. Both missing-connection cases were reproduced with zero rows written. The popup uses the outer flag to show completion, and single-provider sync uses it to populate the deduplication cache.

**Fix:** propagate database failures, return an appropriate status for a missing connection, and make bulk results distinguish completed, failed, and skipped updates. Display those results in the popup and update the cache only for confirmed writes.

### 6. P2 — Failed bulk sync is cached as if it succeeded

**Location:** [background.js:335](C:/omni/extension/background.js:335), [background.js:343](C:/omni/extension/background.js:343).

`syncAllProviders()` populates `lastSyncedCache` before sending the request and records `lastSyncTime` regardless of the result. A fixture with a successful health check followed by a network failure confirmed that a subsequent automatic single-provider retry returned `skipped: true` without sending anything. Recovery depends on a later full sweep, a forced manual sync, or service-worker state being reset.

**Fix:** cache only successfully acknowledged items, retain failed items for retry, and distinguish last-attempt time from last-success time.

### 7. P2 — One debounce timer drops changes from other providers

**Location:** [background.js:372](C:/omni/extension/background.js:372).

All providers share one timer. If ChatGPT and Z.ai rotate cookies within three seconds, the second event cancels the first provider's pending sync. The event fixture confirmed that only Z.ai was synced. The dropped provider must wait for another cookie event or the ten-minute full sweep.

**Fix:** keep a debounce timer per provider, or collect pending providers in a set and drain the entire set when the timer fires.

### 8. P2 — DeepSeek analytics cookies are treated as authentication

**Location:** [background.js:207](C:/omni/extension/background.js:207).

When neither `userToken` nor `token` exists, the extractor falls back to any cookies and marks the result as an active credential. A cookie jar containing only `_ga` produced `hasCredentials: true`. A periodic or manual full sync can therefore replace a valid existing DeepSeek credential with analytics data while the popup says the session is active. This path is in the loaded background worker, not only the unused extractor library.

**Fix:** require a recognized authentication token and report the session as missing otherwise. Do not overwrite a stored credential with an unauthenticated cookie jar.

### 9. P2 — ChatGPT sessions with more than three chunks are truncated

**Location:** [background.js:61](C:/omni/extension/background.js:61), [background.js:69](C:/omni/extension/background.js:69).

The extractor explicitly reads only `.0`, `.1`, and `.2`. A four-chunk fixture produced `ABC` instead of `ABCD` while still reporting valid credentials. This is conditional on a session having four or more chunks; no real browser session was inspected to establish its current chunk count.

**Fix:** enumerate all matching chunk names, order them by numeric suffix, verify a complete sequence, and concatenate all chunks. Apply the same rule to the duplicate extractor or remove that duplication when refactoring.

### 10. P2 — Malformed request URLs can escape the HTTP handler

**Location:** [server.mjs:55](C:/omni/bridge/server.mjs:55).

`new URL()` uses the incoming Host header outside any error handler. A request with `Host: [` rejected the async handler with `Invalid URL` in the isolated reproduction. The HTTP event listener has no rejection handler; under normal Node unhandled-rejection behavior this can terminate the bridge. The exception was reproduced; a live service was not crashed.

**Fix:** validate the request target inside a try/catch, use a fixed local base URL, respond with HTTP 400 for malformed requests, and contain errors at the request-handler boundary.

### 11. P2 — Health checks succeed after database initialization fails

**Location:** [server.mjs:27](C:/omni/bridge/server.mjs:27), [server.mjs:59](C:/omni/bridge/server.mjs:59).

Startup logs a database initialization failure but continues listening. `/health` always returns HTTP 200 with `status: online`, so the extension's health gate permits sync attempts against an unusable bridge. An injected startup failure reproduced that healthy response.

**Fix:** fail startup when essential database/encryption dependencies are unavailable, or expose a readiness result that reflects those dependencies and have the extension check it.

### 12. P2 — Runtime dependency and installation are tied to one user's global npm tree

**Location:** [dbUpdater.mjs:7](C:/omni/bridge/dbUpdater.mjs:7), [package.json](C:/omni/bridge/package.json), [start-bridge.bat:4](C:/omni/scripts/start-bridge.bat:4).

The bridge imports a native SQLite dependency from an absolute path inside another application's global npm installation. Its own package declares no dependency, supported Node version, or lockfile. `npm install` in this project cannot provision the required module on a clean machine, and global OmniRoute upgrades can change the dependency without a project change. Launch scripts also assume `C:\omni`.

The existing native dependency loaded successfully on this machine, but `npm audit --json --ignore-scripts` failed with `ENOLOCK`; no clean dependency-audit result can be claimed.

**Fix:** declare and lock runtime dependencies or use a supported OmniRoute API, specify compatible Node versions, resolve the data directory through configuration, and derive launch paths from the scripts' location.

## Verification and limits

- All seven original JavaScript/module files passed `node --check` on Node v24.11.1. There is no configured build or lint command.
- `node --test C:/omni/audit/reproduce.mjs` completed with **15 passing checks: 14 defect reproductions and one encryption-compatibility baseline**. These checks intentionally assert the current defective behavior; they are evidence for this report, not a passing product regression suite.
- HTTP handlers and Chrome APIs were exercised with synthetic inputs. SQLite writes used `:memory:` only, with a guard that rejects any on-disk database path. No browser cookies were collected and no live sync request was sent.
- Installed OmniRoute package: 3.8.49. The bridge's referenced `better-sqlite3` package: 13.0.3, with SQLite 3.53.4. Encryption compatibility was checked against the installed CLI implementation. The app source also uses the same primary encryption format and has a five-second connection-cache TTL; a persistent hot-refresh failure was not established.
- The real database was opened read-only for schema and provider-count checks only. The configured encryption key was checked without outputting its value.
- At the time of the read-only service probe, OmniRoute's `/api/monitoring/health` returned HTTP 200 on port 20128. The sync bridge connection to port 20129 was refused. No service or startup registration was changed.
- The production `npm test` command was not run against real data because of finding 3; its source was executed against an isolated fixture instead.
- Dependency advisory coverage is incomplete because the project has no lockfile. No dependency installation or automatic remediation was performed.
- Browser-extension installation, real session extraction, upstream provider authentication, and end-to-end browser-to-OmniRoute sync were not verified. The audit therefore does not certify live provider compatibility or browser network-policy behavior.

## Suggested repair order

1. Isolate the test command, authenticate the bridge, remove credential previews, and require per-connection mapping.
2. Make encryption initialization fail closed and make readiness/error responses accurate.
3. Fix sync acknowledgement, retries, provider debouncing, and credential extraction.
4. Make installation reproducible and add regression coverage that expects the repaired behavior, then verify real browser sync on a deliberately selected connection.
