# Embedded Session Sync

User request: one-time setup; refreshed browser-provider credentials should flow to OmniRoute automatically, and sync must start with the existing laptop/OmniRoute startup. Keep sessions local and browser-only fallback. The extension must use the user's signed-in Chrome profile.

## Design

Load the authenticated sync server inside OmniRoute's actual Node server process through a scoped `NODE_OPTIONS --import` preload. The preload verifies the main-thread entrypoint and OmniRoute package identity before starting. It does not start in CLI helpers, other Node programs, or workers. Preserve the existing private pairing, management credential, mappings and fallback state. OmniRoute remains the owner of inference, encryption and fallback; Chrome remains the supported source of browser cookies.

Install the preload in OmniRoute's existing local environment file and reuse its existing Windows startup launcher. Preserve existing flags, launch behavior and unrelated settings; back up changed configuration inside the private sync state directory. Do not modify browser profile files, force-load/reload Chrome extensions, or read browser cookie databases.

## Work

- [ ] Add an embedded startup adapter with main-thread/entrypoint guards and observable hosting mode.
- [ ] Prove that a paired extension token and mapping continue to work after the OmniRoute host process restarts, using synthetic sessions only.
- [ ] Add and test an idempotent local installer that preserves existing environment/startup configuration.
- [ ] Install against the user's existing OmniRoute startup path and switch the live service to embedded hosting.
- [ ] Verify both ports belong to the same OmniRoute process, management access remains ready, cloud sync stays off, and the existing fallback still works.
- [ ] Finish the one-time reload/pairing in the signed-in Chrome profile if user-controlled browser setup is available; report any remaining manual initial setup exactly.

This does not promise to renew a provider-revoked browser session or run Chrome's extension while Chrome is completely closed. Routine reboots do not require re-pairing or token copying.
