# Install on Windows

## Controlled mode

Requirements:

- LibreWolf installed locally. `COMPATIBILITY.md` records a successful run on Windows 11 x64 with LibreWolf `146.0-2`.
- Node `>=20.19.0`. Verify with `node --version`; `20.18.2` is below the upstream engine floor.
- A source checkout with a present `apps/mcp-server/src/cli.ts` and generated `apps/mcp-server/dist/cli.js`.

From the repository root:

```powershell
npm ci
npm run build
Test-Path .\apps\mcp-server\dist\cli.js
Test-Path .\apps\mcp-server\dist\native\secure-pipe-helper.exe
```

Both checks must be `True`. The helper owns the controlled browser's Windows
Job Object as well as supporting the optional companion transport. If either
check is `False`, do not register an MCP server; inspect and fix the build
failure first.

## Node version is the most common failure

The pinned Mozilla upstream requires Node `>=20.19.0`. An MCP client launches
the server with whatever `node` resolves to on its own `PATH`, which is often
the system install rather than the one in your shell. If that is too old, the
server exits immediately with:

```text
[librewolf-agent-bridge] Node.js 20.18.2 is unsupported; install Node.js 20.19.0 or newer.
```

The client will report this only as a failed or disconnected server. Either
install a supported Node, or set `command` to the absolute path of a supported
`node.exe` instead of the bare name `node`.

## Client configuration

Every example is stdio and uses an absolute path. Replace
`C:\src\librewolf-mcp` with your checkout.

### Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` and merge in an
`mcpServers` key at the top level:

```json
{
  "mcpServers": {
    "librewolf-agent-bridge": {
      "command": "node",
      "args": ["C:\\src\\librewolf-mcp\\apps\\mcp-server\\dist\\cli.js"]
    }
  }
}
```

Restart Claude Desktop fully; reloading a conversation is not enough.

### Claude Code

Either commit a `.mcp.json` at the root of the project you want the browser
available in:

```json
{
  "mcpServers": {
    "librewolf-agent-bridge": {
      "command": "node",
      "args": ["C:\\src\\librewolf-mcp\\apps\\mcp-server\\dist\\cli.js"]
    }
  }
}
```

Or register it from a terminal without editing files:

```bash
claude mcp add librewolf-agent-bridge -- node C:/src/librewolf-mcp/apps/mcp-server/dist/cli.js
```

### Codex CLI

Add to `%USERPROFILE%\.codex\config.toml`. The startup timeout matters: a first
run downloads GeckoDriver and launches a browser.

```toml
[mcp_servers.librewolf-agent-bridge]
command = "node"
args = ['C:/src/librewolf-mcp/apps/mcp-server/dist/cli.js']
startup_timeout_sec = 90
```

### ChatGPT Desktop

ChatGPT Desktop reads the same stdio MCP server shape. Add the server through
its connector settings using command `node` and the single argument
`C:\src\librewolf-mcp\apps\mcp-server\dist\cli.js`. The server itself is
client-agnostic; it contains no client-specific code.

## Verifying the connection

Reconnect the client and call `browser_status`. A successful controlled session
reports `"mode": "controlled"` and a dedicated profile path under the managed
profile root. It must not reference your personal LibreWolf profile. If the
server fails to start, its stderr carries a stage-specific diagnostic naming the
step that failed — runtime, locate, profile, spawn, initialize, or tool
contract.

## Codex plugin template

The plugin under `packaging/codex-plugin/librewolf-agent-bridge` is a distribution template. Before installing it, place the built MCP server files in its `server/` directory (or adjust `.mcp.json` to a supported packaged entry point), then validate it:

```powershell
npm run validate:plugin
```

The template deliberately does not bundle Node or an unverified server build.

## Claude Desktop one-click install (recommended)

This is the shortest path and needs no config editing and no `npm install`.

```powershell
npm run package:all
```

That writes `artifacts/librewolf-agent-bridge-<version>.mcpb` (~47 MB). The
bundle is self-contained: the built server, the pinned
`@mozilla/firefox-devtools-mcp` with its full dependency tree, GeckoDriver, and
the compiled Windows secure-pipe/Job Object helper. Install it by opening the
`.mcpb` with Claude Desktop, then call `browser_status`.

`packaging/claude-mcpb/manifest.json` declares manifest version `0.3`,
`server.type` of `node`, and `compatibility.runtimes.node` of `>=20.19.0`. The
host supplies the Node runtime for a `node`-type extension. If installation
fails on the runtime constraint, install Node 20.19 or newer and retry; that is
the same floor the manual configurations need.

Verify a bundle before distributing it:

```powershell
node scripts/bundled-server-smoke.mjs <extracted>\server
```

The smoke checks the ESM boundary, a zero-exit CLI, stdout reserved for MCP
frames, help routed to stderr, the packaged secure helper, and the pinned
Mozilla version.

## Companion package (optional)

Companion mode is separate from controlled mode and is for a deliberately approved existing LibreWolf session. Build or obtain a self-contained native-host payload containing `dist/cli.js`, production dependencies, and `dist/native/secure-pipe-helper.exe`, then preview the install:

```powershell
Set-Location packaging\windows
.\install-native-host.ps1 -PayloadRoot C:\release\native-host-payload
```

The command above is a dry run. Add `-Apply` only after reviewing the paths. The installer resolves Node `>=20.19.0`, copies the host and secure helper under `%LOCALAPPDATA%`, creates the native-messaging launcher/manifest, applies a current-user-only ACL, and registers the host under `HKCU`. It never needs administrator rights.

Use `browser_status` after connecting; it reports the actual companion capabilities. An optional managed extension policy requires all of `-Apply`, `-RegisterManagedExtensionPolicy`, and `-ManagedExtensionXpiPath <absolute-xpi>`. Verify any policy at `about:policies`.

To remove the package, first preview then apply:

```powershell
.\uninstall-native-host.ps1
.\uninstall-native-host.ps1 -Apply
```

This preserves ordinary LibreWolf profiles. `-RemoveDedicatedProfiles` is a separate, permanent removal of only `%LOCALAPPDATA%\LibreWolfAgentBridge\profiles`.
