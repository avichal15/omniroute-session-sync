# Session Sync v2 verification

Verified locally on 9 September 2026 with Node 24.11.1 and OmniRoute 3.8.49. This report covers the replacement for the historical implementation audited in `AUDIT.md`.

## Audit findings addressed

| Original finding | v2 change | Evidence |
| --- | --- | --- |
| Unauthenticated credential writes and status disclosure | One-time pairing, origin-bound bearer authentication, provider allowlist, secret-free status | HTTP auth, origin, pairing and disclosure tests |
| Every account for a provider overwritten | Explicit mapping to one active supported connection ID | Account-isolation and disabled/mismatched connection tests |
| Tests modify the real Z.ai connection | Test runner uses synthetic credentials and fake gateways only | `npm test` runs only `tests/*.test.mjs` |
| Fragile encryption-key parsing and direct database writes | Authenticated OmniRoute management API owns encryption and persistence | Client contract verifies exact PUT path, method and body |
| Write errors reported as success | Failed upstream and local-state saves return failure; bulk results stay truthful | Failure, retry, bulk and persistence tests |
| Failed sync poisons deduplication | Acknowledgements follow accepted updates; pending work survives worker restarts | Retry, stale-revision, fresh-cookie and restart tests |
| Shared debounce drops other providers | Independent provider debounce and request queues | Simultaneous-provider and in-flight-change tests |
| DeepSeek analytics treated as authentication | Require a recognized authentication value | Extractor regression tests |
| ChatGPT sessions truncated after three chunks | Reassemble all contiguous numeric chunks in order | Multi-chunk and missing-chunk tests |
| Malformed request handling escapes handler | Bounded parsing, local Host checks, sanitized errors | JSON, request-size and malformed-secret tests |
| Health reports success despite unavailable backend | Readiness authenticates against OmniRoute | Gateway outage test and live readiness check |
| Runtime tied to a global native SQLite module | Node built-ins; no runtime package dependencies; relocatable launchers | Syntax/asset checks and package audit |

Additional tests cover concurrent pairing-code redemption, old-profile writes during re-pairing, failed state commits overlapping other providers, and cloud-sync enforcement for all upstream mutations. Invalid and unsupported validation attempts cannot set a successful validation timestamp.

## Automated results

- The initial v2 run passed **54 tests**; subsequent startup and recovery results are recorded below.
- Initial syntax checks covered 24 JavaScript files and extension assets; later checks include the added startup utilities.
- `npm audit`: zero vulnerabilities; no runtime package dependencies.
- `git diff --check`: passed.
- Private bridge state uses an atomic file replacement and survived a restart test; corrupt state was rejected without resetting authentication.

The synthetic popup passed **26 checks** in a real Playwright browser at a 420px viewport. Pairing, explicit account selection, disabled choices, draft preservation across timed refreshes, failure feedback, unsupported validation, fallback order editing/save/reload, and official-provider exclusion passed. No horizontal overflow, console errors or warnings were observed. This fixture uses no real browser cookies, extension storage, or OmniRoute connections.

## Live results

- OmniRoute Cloud Sync was disabled at the user's request and subsequently verified as `false` through its settings API.
- A dedicated management credential was configured in the bridge's private local state. No existing inference API key was replaced.
- The restarted bridge authenticated against the real OmniRoute management API.
- OmniRoute's connection test passed for the existing ChatGPT connection named `main`.
- The `browser-sessions` priority combo was saved and reread from OmniRoute with this exact browser-only order:
  1. `chatgpt-web/gpt-5.5`
  2. `qwen-web/qwen3.7-plus`
  3. `gemini-web/gemini-3.5-flash`
  4. `zai-web/glm-5.3`
- A real `/v1/chat/completions` request to `browser-sessions` returned HTTP 200, model `gpt-5.5`, content `PONG`, and finish reason `stop` in about 14.5 seconds.

## Remaining live verification

The initial Chrome reload/pairing was user-controlled because extension management was blocked by browser security policy. The subsequent reboot investigation confirmed a paired browser, four account mappings, and further accepted cookie updates after service recovery. That initial setup is complete. A deliberately induced provider-cookie rotation has not been tested.

The successful combo request used its ChatGPT target. A forced live failure followed by another provider succeeding was not performed; the saved priority configuration and browser-provider restrictions were verified. Web sessions can still expire or be revoked, and upstream restrictions may require signing in again.

## Follow-up: unknown pairing action

The reported `Unknown action` text matches the previous background worker, whose message handler supports status and sync but not pairing. Reproducing its status response with the current popup showed that the popup incorrectly presented normal pairing controls. The popup now detects this incompatible response and unknown-action errors, explains Chrome's extension Reload control, and disables repeated pairing attempts until a compatible worker responds.

The expanded synthetic browser suite passed 31 checks with no console errors or warnings; the legacy-worker and unknown-action cases also passed a focused check after the final copy edit. All 54 automated tests and JavaScript/asset checks passed again. The user's signed-in Chrome profile still requires manual reload and pairing. The earlier live PONG used OmniRoute's existing stored session, not a newly captured Chrome cookie.

## Follow-up: one-time setup and embedded startup

Session Sync now loads inside OmniRoute's server process using a scoped Node preload. The preload waits until the sync listener binds before OmniRoute installs its HTTP/WebDAV wrappers, and ignores CLI helpers, unrelated applications and worker threads. The existing private state persists pairing and account mappings; a synthetic paired client successfully updated its selected account again after the host process restarted.

The installer preserved the existing OmniRoute environment settings, added only its preload, backed up prior configuration in the private sync directory, and reused the existing `StartOmniRoute.vbs` startup entry. A repeat installer dry run reported no changes. The hidden launcher merges inherited Node options and preserves normal OmniRoute process recovery.

Live verification launched the actual Windows startup entry after one controlled restart. Both API port 20128 and sync port 20129 belonged to the same process; sync health reported `lifecycle: omniroute` and `ready: true`, and OmniRoute health reported healthy. A repeated launch returned `alreadyRunning: true` without changing the listener PID. Cloud sync remained false and the existing browser-only priority combo was unchanged. A live request returned HTTP 200 and PONG from gpt-5.5 in about 22.8 seconds, using OmniRoute's existing credentials.

The suite now has **61 passing tests**, with syntax checks covering 30 JavaScript files. Chrome's documented `background` permission was added to support operation without an open browser window. The updated extension must still be loaded and paired once in the user's signed-in Chrome profile; that live cookie handoff remains unverified. Explicitly quitting Chrome stops browser-side work until Chrome starts again. No laptop reboot was performed; the configured startup entry itself was executed and checked.

## Follow-up: actual reboot failure and Windows storage redirection

The user rebooted and neither local service was running. The saved browser pairing and mappings still existed in the agent's filesystem view. A diagnostic launched by Windows Task Scheduler outside Codex then returned `ENOENT` for the same apparent `AppData\Local\OmniRouteSessionSync\installation.json` path and could not see the VBS launcher. The visible state inside Codex matched the physical file under `Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\OmniRouteSessionSync`. Packaged-app AppData redirection made the earlier terminal-based startup check insufficient.

Windows state now lives at `%USERPROFILE%\.omniroute\session-sync`, outside redirected AppData. The installer copied the observed paired v2 state into the empty destination, retained the source as a backup, and preserved all authentication tokens, selected account IDs and fallback settings. A native Windows task subsequently read the new installation and state, wrote diagnostics, and detected the same recovery process as the Codex terminal. The installer refuses to overwrite an existing destination state during migration.

The enabled **OmniRoute Session Sync** Windows task starts 20 seconds after this user's sign-in, permits battery operation, has no execution time limit, and requests restart after failure. Its hidden launcher pins the shared state directory and waits for the recovery service. The recovery service prevents duplicate launches, distinguishes open ports from ready services, retries stopped CLI processes with backoff, and records only process/status information and fixed error categories. A transient Windows file lock while replacing diagnostic status is retried and cannot terminate a healthy gateway.

Live results:

- The actual Windows task started at **13:34:19 UTC** and both services were ready at **13:35:23 UTC**. Ports 20128 and 20129 belonged to the same gateway process, PID 33156, with the recovery process owned by the task's WScript process.
- Authentication tokens, browser pairing, mappings and fallback settings matched the pre-migration fingerprint checks.
- Chrome delivered an additional Gemini session update after the task launch; no agent-issued cookie sync was used for that update.
- The mapped ChatGPT `main` connection passed validation (`valid: true`). Cloud Sync was still `false`.
- A repeat immediate-start command reported `alreadyRunning: true` and the same gateway PID. Installer dry run reported `changed: false`.
- The **OmniRoute - Start and Sync** desktop shortcut was created and executed successfully. The existing pairing shortcut now uses the shared state directory.

Automated regressions cover readiness before success, failure during startup, recovery after a later crash, duplicate prevention during initialization, occupied unhealthy ports, secret-free diagnostics, preserved pairing state, and a stable Windows state directory across different AppData contexts. These fixtures do not touch live provider cookies or register Windows tasks.

The final `npm run verify` passed **66 tests** and syntax/asset checks for **32 JavaScript files**. The temporary Windows diagnostic task was removed. Tool policy blocked optional removal of the temporary diagnostic files; they remain in the local private state backup area and ignored `artifacts` directory.

The corrected task was launched and verified directly from Windows Task Scheduler. Another full laptop reboot has not been performed. Cold initialization takes time, and provider revocation or an explicit Chrome exit remains outside cookie synchronization's control.
