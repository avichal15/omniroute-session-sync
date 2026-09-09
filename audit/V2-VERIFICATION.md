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

- **54 tests passed**, zero failures, cancellations or skips.
- Syntax checks for 24 JavaScript files and extension asset checks passed.
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

Chrome extension management was blocked by browser security policy, so the user must reload version 2.0.0, pair it, and choose the intended ChatGPT connection in Chrome. At the last check the bridge was not yet paired. Automatic cookie delivery from that profile and a natural provider-cookie rotation have therefore **not** been observed live.

The successful combo request used its ChatGPT target. A forced live failure followed by another provider succeeding was not performed; the saved priority configuration and browser-provider restrictions were verified. Web sessions can still expire or be revoked, and upstream restrictions may require signing in again.

## Follow-up: unknown pairing action

The reported `Unknown action` text matches the previous background worker, whose message handler supports status and sync but not pairing. Reproducing its status response with the current popup showed that the popup incorrectly presented normal pairing controls. The popup now detects this incompatible response and unknown-action errors, explains Chrome's extension Reload control, and disables repeated pairing attempts until a compatible worker responds.

The expanded synthetic browser suite passed 31 checks with no console errors or warnings; the legacy-worker and unknown-action cases also passed a focused check after the final copy edit. All 54 automated tests and JavaScript/asset checks passed again. The user's signed-in Chrome profile still requires manual reload and pairing. The earlier live PONG used OmniRoute's existing stored session, not a newly captured Chrome cookie.
