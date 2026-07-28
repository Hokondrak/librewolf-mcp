# Troubleshooting

## Node is rejected or the bridge will not start

Run `node --version`. Mozilla's pinned `@mozilla/firefox-devtools-mcp@0.9.15` needs Node `>=20.19.0`; Node `20.18.2` is too old. Install a compatible Node runtime and ensure the MCP client invokes that `node` binary.

## `npm run build` does not produce `apps/mcp-server/dist/cli.js`

Do not register the MCP server until the build succeeds and the CLI file exists. Read the first build error; dependency, TypeScript, or native-host build failures are separate from LibreWolf configuration.

## LibreWolf cannot be located or launches the wrong profile

Confirm LibreWolf is installed and inspect `browser_status` diagnostics. Controlled mode owns a profile parent and Mozilla creates a nested `firefox_devtools_mcp_profile`; do not point it at a profile you actively use. See the tested locations and versions in [COMPATIBILITY.md](../COMPATIBILITY.md).

## Controlled mode reports a missing Windows process supervisor

Rebuild the full workspace and confirm
`apps/mcp-server/dist/native/secure-pipe-helper.exe` exists beside the built
server. Do not bypass this check or substitute process-name-wide cleanup. The
helper places only the app-owned Mozilla, GeckoDriver, and LibreWolf processes
in a private Job Object, so closing the bridge cannot terminate an unrelated
LibreWolf session.

## A same-URL navigation times out

Mozilla's upstream server can time out when navigating to the already loaded URL. Inspect the current selected tab and retry only when safe; use a reload semantic where the client/server supports it. Do not blindly replay form submissions.

## A tab URL is missing

The tested upstream `list_pages` output may omit URLs even though its description claims to include them. The bridge retains URLs it opens or navigates and marks unknown URLs explicitly. Select by bridge tab ID, index, or title when necessary.

## `STALE_UID` or element not found

Take a new `browser_snapshot`, identify the current UID, and retry the intended action. UIDs are document-scoped and become invalid after navigation or DOM changes.

## Companion mode cannot find the secure helper

Install the complete Windows native-host payload rather than pointing a manifest at a loose `cli.js`. The payload must include `dist/native/secure-pipe-helper.exe`, and the installer must have selected Node `>=20.19.0`. Preview `packaging/windows/install-native-host.ps1` first, then run it with `-Apply`; inspect `browser_status` for the specific capability/error.

Do not weaken registry permissions, pipe permissions, or discovery-file checks to make a connection succeed. On Linux, macOS, or Flatpak LibreWolf, use controlled mode: the supplied secure companion transport is Windows-only.

## `npm run package:all` fails

Read the reported prerequisite. The script requires a build-ready server entry point before it can create an npm tarball, a built extension before it can create XPIs, and self-contained payloads before it can create plugin or MCPB archives. It never runs installers and leaves no partial published artifact on a preflight failure.
