# Embedded Session Sync

User request: one-time setup; refreshed browser-provider credentials should flow to OmniRoute automatically, and sync must start with the existing laptop/OmniRoute startup. Keep sessions local and browser-only fallback. The extension must use the user's signed-in Chrome profile.

## Design

Load the authenticated sync server inside OmniRoute's actual Node server process through a scoped `NODE_OPTIONS --import` preload. The preload verifies the main-thread entrypoint and OmniRoute package identity before starting. It does not start in CLI helpers, other Node programs, or workers. Preserve the existing private pairing, management credential, mappings and fallback state. OmniRoute remains the owner of inference, encryption and fallback; Chrome remains the supported source of browser cookies.

Install the preload in OmniRoute's existing local environment file and reuse its existing Windows startup launcher. Preserve existing flags, launch behavior and unrelated settings; back up changed configuration inside the private sync state directory. Do not modify browser profile files, force-load/reload Chrome extensions, or read browser cookie databases.

## Work

- [x] Add an embedded startup adapter with main-thread/entrypoint guards and observable hosting mode.
- [x] Prove that a paired extension token and mapping continue to work after the OmniRoute host process restarts, using synthetic sessions only.
- [x] Add and test an idempotent local installer that preserves existing environment/startup configuration.
- [x] Install against the user's existing OmniRoute startup path and switch the live service to embedded hosting.
- [x] Verify both ports belong to the same OmniRoute process, management access remains ready, cloud sync stays off, and the existing fallback still works.
- [x] Finish the one-time reload/pairing in the signed-in Chrome profile if user-controlled browser setup is available; report any remaining manual initial setup exactly. Subsequent live state confirmed pairing and automatic browser updates.

This does not promise to renew a provider-revoked browser session or run Chrome's extension while Chrome is completely closed. Routine reboots do not require re-pairing or token copying.

Installed and verified: the existing `StartOmniRoute.vbs` now calls the hidden integrated launcher; the scoped preload is present in OmniRoute's existing environment file. A cold launch through that actual startup entry produced one process listening on both 20128 and 20129. Health reported embedded hosting and ready status; a second launch detected the existing gateway. The unchanged browser-only combo returned HTTP 200 and PONG from gpt-5.5 in about 22.8 seconds. All 61 isolated tests passed. Chrome background permission was added; loading and pairing the extension in the user's signed-in profile remains the initial user-controlled step.

Reboot correction: the user later rebooted and exposed packaged-app AppData redirection. The earlier launcher and installation record existed in a sandboxed application's private AppData copy, which native Windows startup could not read. State and saved pairing were migrated to `%USERPROFILE%\.omniroute\session-sync`. An enabled Windows sign-in task now runs a hidden recovery service, and the obsolete Startup-folder VBS was removed after replacement registration. The native task read the shared state, started both listeners, and retained all authentication, mappings and fallback settings. ChatGPT validated and Chrome delivered another session update. Another full reboot remains a live check; initial browser pairing is complete.
