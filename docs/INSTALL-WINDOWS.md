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

When it is `True`, configure your client with an absolute path:

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

Reconnect the client and call `browser_status`. A successful controlled session should report a dedicated profile and `controlled` mode. It should not reuse your personal LibreWolf profile.

## Codex plugin template

The plugin under `packaging/codex-plugin/librewolf-agent-bridge` is a distribution template. Before installing it, place the built MCP server files in its `server/` directory (or adjust `.mcp.json` to a supported packaged entry point), then validate it:

```powershell
npm run validate:plugin
```

The template deliberately does not bundle Node or an unverified server build.

## Claude MCPB template

`packaging/claude-mcpb/manifest.json` uses conservative manifest version `0.3`. Put a runnable, self-contained server payload at `server/cli.js` before creating/importing an `.mcpb`. The package script checks that entry point instead of creating a misleading archive.

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
