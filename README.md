# LibreWolf Agent Bridge

Local-first [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) browser automation for LibreWolf. It wraps the pinned Mozilla [`@mozilla/firefox-devtools-mcp`](https://github.com/mozilla/firefox-devtools-mcp) process; it is not a LibreWolf or Firefox fork and is not affiliated with Mozilla, LibreWolf, OpenAI, or Anthropic.

## Current status

The controlled-profile design is the supported path. It launches a **dedicated, app-owned LibreWolf profile** and exposes a deliberately small `browser_*` MCP surface. Browser data stays on the local machine except for normal browser traffic to sites you choose.

The repository contains a locally verified source distribution and reproducible release assembly. Build the declared MCP CLI before configuring a client; the preflight in the setup below confirms that the server and its Windows process supervisor were produced.

The optional companion package can connect an explicitly approved existing LibreWolf session on Windows. It must be installed from a complete native-host payload: its secure helper enforces same-user named-pipe checks, and `browser_status` reports the final capability state. Linux, macOS, and Flatpak LibreWolf should use controlled mode because this hardened companion transport is Windows-only.

No artifact is deployed by this project.

## Five-minute controlled setup (Windows)

1. Install LibreWolf and Node **20.19.0 or newer**. The compatibility check was run with LibreWolf `146.0-2`; Node `20.18.2` is known to be too old for the pinned Mozilla dependency.
2. In an elevated-free PowerShell window, clone the repository and install its locked dependencies:

   ```powershell
   git clone <your-fork-or-checkout-url> librewolf-agent-bridge
   Set-Location librewolf-agent-bridge
   node --version
   npm ci
   npm run build
   Test-Path .\apps\mcp-server\dist\cli.js
   Test-Path .\apps\mcp-server\dist\native\secure-pipe-helper.exe
   ```

   Both checks must print `True`. If either does not, stop and inspect the
   build output before configuring a client.

3. Configure one of the clients below, replacing the absolute path. Each example launches a local process over stdio and creates a separate controlled profile; it does not attach to your everyday browser profile.

   For Codex, add this to `%USERPROFILE%\.codex\config.toml`:

   ```toml
   [mcp_servers.librewolf-agent-bridge]
   command = "node"
   args = ['C:/absolute/path/to/librewolf-agent-bridge/apps/mcp-server/dist/cli.js']
   startup_timeout_sec = 90
   ```

   For Claude Desktop, add this server to its MCP configuration:

   ```json
   {
     "mcpServers": {
       "librewolf-agent-bridge": {
         "command": "node",
         "args": ["C:\\absolute\\path\\to\\librewolf-agent-bridge\\apps\\mcp-server\\dist\\cli.js"]
       }
     }
   }
   ```

4. Restart or reconnect your MCP client, then call `browser_status`. Confirm the reported mode is `controlled` and inspect its capabilities before browsing.

See [Windows installation](docs/INSTALL-WINDOWS.md), [security](docs/SECURITY.md), and [troubleshooting](docs/TROUBLESHOOTING.md) before using credentials or downloads. [ACCEPTANCE.md](ACCEPTANCE.md) records what has been verified, how to re-run it, and what remains open.

## What the server can do

The public surface contains status and tab control, navigation, compact snapshots and text lookup, UID-based input, screenshots, console and network inspection, downloads, and bounded batches. Its exact names and input contracts are documented in [the protocol reference](docs/PROTOCOL.md). State-changing actions, uploads, downloads, tab closing, and batches deserve explicit user confirmation in the MCP client.

Controlled mode supports delta snapshots. Companion actions briefly highlight
their target in the page; controlled-mode highlighting is limited to native
hover state and is reported as degraded. Screen recording is explicitly
unavailable on the tested LibreWolf `146.0-2` because the pinned upstream
screencast requires Firefox 154 or newer. The extension popup and options page
show connection and permission state; an optional persistent sidebar is not
shipped.

## Distribution inputs

- `packaging/codex-plugin/` — Codex plugin template.
- `packaging/claude-mcpb/` — Claude Desktop MCPB template using manifest `0.3`.
- `packaging/windows/` — native host and secure-helper installation/removal scripts (dry-run by default).
- `packaging/linux/` and `packaging/macos/` — per-user native-messaging registration templates; they do not add Windows-only secure companion transport.
- `scripts/package-artifacts.mjs` — deterministic local artifact collector. It makes no installation, registry, network, or deployment changes.

Run `npm run package:all` only from a build-ready checkout. It emits an artifact manifest and SHA-256 checksums under `artifacts/`, or exits with a specific missing-prerequisite error.
The complete release matrix is assembled on Windows because the npm, Codex,
MCPB, and Windows archives include the compiled Windows Job Object/secure-pipe
helper. Linux and macOS users can build and run controlled mode locally, but
their source hosts do not produce that complete release matrix.

## Development

Read [architecture](docs/ARCHITECTURE.md), [performance profiling](docs/PERFORMANCE.md), [contributing](docs/CONTRIBUTING.md), and [compatibility evidence](COMPATIBILITY.md). Source code is Apache-2.0; see [third-party notices](THIRD_PARTY_NOTICES.md).
