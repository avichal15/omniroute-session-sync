# Session Sync v2 implementation plan

**Goal:** Keep the application's OmniRoute API key stable while its selected browser-session connections receive current credentials, with browser-provider fallback owned by OmniRoute.

**Architecture:** Chrome collects credentials and sends authenticated updates to a loopback bridge. The bridge uses OmniRoute's authenticated management API and never opens SQLite or stores provider cookies. A single paired Chrome profile explicitly maps each provider to one existing active connection. OmniRoute owns encryption, validation, inference and priority fallback.

**Tech stack:** Node 24 built-ins, Chrome Manifest V3 modules, vanilla popup UI, Node test runner. No new runtime packages.

**Approved design:** User approved the architecture presented in the preceding conversation. First live provider: ChatGPT. Fallback: existing browser-session providers only. Implement here; no additional design approval needed.

## Constraints

- Local bridge on 127.0.0.1:20129; default OmniRoute on 127.0.0.1:20128.
- Provider credentials never appear in logs, status responses, tests, or persistent bridge state.
- No direct SQLite writes. No paid/official-API fallback targets. Preserve existing connections and unrelated routes.
- Pairing is explicit; origin-bound bearer credential; persistent configuration lives in the documented OS user data directory with owner-only permissions.
- Chrome startup/alarm reconciliation rereads current cookies. Failed requests never advance the acknowledgement fingerprint.
- Tests use synthetic credentials and local fake OmniRoute servers. Live writes target only the user's selected connection.
- Preserve the existing Git history and user changes. The initial local baseline was superseded by the current repository history during implementation; inspect the current branch and diff before any commit. Do not push without a request.

## Tasks

- [x] 1. Add failing extraction and sync-engine tests covering arbitrary ChatGPT chunks, analytics-only sessions, account isolation, acknowledgements, retries, and stale updates. Run `node --test tests/*.test.mjs` and confirm the initial failures.
- [x] 2. Implement shared provider extractors and a dependency-free OmniRoute client. Readiness authenticates the management API; updates use PUT on one verified active connection and never expose upstream secret fields. Tests assert exact method, path and body against a fake gateway.
- [x] 3. Implement the authenticated bridge, one-time pairing, durable non-secret mapping/status state, size limits, exact origin checks, bounded errors, update serialization, optional validation, and priority-combo management. Verify auth, mapping, retry and failure paths over real loopback HTTP in tests.
- [x] 4. Implement a Manifest V3 sync coordinator with per-provider timers, durable pending markers, fresh-cookie retries and reconciliation. Wire the popup contract: GET_STATUS, PAIR, MAP_PROVIDER, SYNC_ONE, SYNC_ALL, VALIDATE_PROVIDER, SAVE_FALLBACK. Verify popup states with a synthetic browser fixture and worker lifecycle with the Chrome API test harness.
- [x] 5. Replace destructive test/status scripts, make launchers relocatable, document pairing and selected-account setup, and create a lockfile for the dependency-free package. Run tests, syntax checks, npm audit and secret/diff review.
- [ ] 6. Start the bridge, load/reload the extension, pair it, select the ChatGPT connection, and verify a live request/update/request cycle when browser access permits. Configure and verify the named browser-only fallback route. Record exact successes and remaining external requirements without claiming an unobserved rotation or upstream success.

Step 6 progress: bridge started with authenticated management access; cloud sync disabled; existing ChatGPT `main` connection test passed; browser-only priority combo saved and reread; live combo inference returned PONG from gpt-5.5. Manual Chrome reload/pairing remains pending because browser security policy blocked extension management. See `audit/V2-VERIFICATION.md` for exact evidence and limits.

## Popup contract

`GET_STATUS` returns `{success, paired, bridge:{ready,error?}, providers, models, fallback}`. A provider has `{provider,name,hasCredentials,connectionId,connections,phase,message,lastSyncedAt,lastValidatedAt}`. Phases are `unmapped`, `pending`, `synced`, `validated`, `login-required`, `error`. Models have `{id,provider,label}`. Fallback is `{name:'browser-sessions',models,saved}`. Actions return `{success,error?}`; messages are never credential-bearing.

The initial provider credential format is OmniRoute's existing `apikey` connection format, which all current configured web providers use. Unsupported auth types fail clearly rather than silently writing to a wrong field.
