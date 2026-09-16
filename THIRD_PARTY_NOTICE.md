# Third-Party / Community Integration Notice

**OmniRoute Session Sync is an independently maintained open-source companion project.**

This repository is created and maintained by Avichal Goyal. It integrates with the separate [OmniRoute](https://github.com/diegosouzapw/OmniRoute) project through OmniRoute's local management interface.

This project is **not part of the OmniRoute core codebase** and should not be treated as an official OmniRoute component unless the OmniRoute maintainers explicitly state otherwise.

The OmniRoute team has not audited this repository. Any security, privacy, reliability, or compatibility statements in this repository describe the implementation as maintained here and are **not endorsements, guarantees, or security attestations from the OmniRoute project or its maintainers**.

## Why this project exists

OmniRoute can use authenticated browser sessions for supported web-based AI providers. Those sessions may rotate or expire during normal browser use, which can require manually updating credentials.

Session Sync is an optional local companion designed to automate that synchronization path for supported providers while leaving OmniRoute itself unchanged.

## Integration boundary

- **OmniRoute:** the upstream AI gateway and the system that stores and uses provider credentials.
- **OmniRoute Session Sync:** the independent Chrome extension and local bridge that detects supported browser-session changes and sends updates to the selected local OmniRoute connection.
- **Users:** remain responsible for deciding whether to install and use this third-party software and for reviewing its source and permissions.

For technical details and the current implementation, see the main [README](README.md) and [Architecture & Operator Guide](GUIDE.md).
