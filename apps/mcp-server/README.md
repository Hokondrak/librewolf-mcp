# LibreWolf Agent Bridge MCP server

This package is the local stdio MCP server for controlled and companion
LibreWolf automation. It exposes the bridge's compact, semantic `browser_*`
tool contract and wraps the pinned Mozilla Firefox DevTools MCP process only
for controlled mode.

Requirements are Node `>=20.19.0` and a locally installed compatible LibreWolf.
The npm package contains the bridge runtime and Windows native helper. In
controlled mode the helper owns Mozilla, GeckoDriver, and the dedicated
LibreWolf process in a kill-on-close Job Object; in companion mode it hardens
the current-user named-pipe transport. The pinned Mozilla runtime remains a
normal npm dependency.

After installing the package, launch its declared executable:

```json
{
  "command": "npx",
  "args": ["--yes", "librewolf-agent-bridge@0.1.0"]
}
```

For an offline or reproducible setup, install the tarball first and use the
absolute path to `dist/cli.js`. Controlled mode creates an app-owned LibreWolf
profile. Companion mode requires the matching extension and native host and
uses an authenticated, current-user-only Windows named pipe.

See the repository [installation guide](../../docs/INSTALL-WINDOWS.md),
[protocol](../../docs/PROTOCOL.md), and
[third-party notices](THIRD_PARTY_NOTICES.md).
