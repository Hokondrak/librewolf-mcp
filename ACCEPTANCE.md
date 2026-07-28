# Acceptance record

The Windows MVP defines fifteen acceptance criteria. This file maps each one to the command that
proves it and the result observed on the reference machine. It is written so a reviewer can
re-run every line rather than take the result on trust.

Reference environment:

| Item          | Value                                                 |
| ------------- | ----------------------------------------------------- |
| OS            | Windows 11 x64 (26200)                                |
| LibreWolf     | `146.0-2`, `C:\Program Files\LibreWolf\librewolf.exe` |
| Upstream      | `@mozilla/firefox-devtools-mcp@0.9.15` (pinned)       |
| Node          | `v24.14.0` (the pinned upstream requires `>=20.19.0`) |
| Last verified | 2026-07-28                                            |

Automated evidence comes from three sources. `npm test` runs unit and integration suites with no
browser. `npm run test:e2e` with `LIBREWOLF_AGENT_BRIDGE_E2E=1` drives the built CLI against real
LibreWolf. The `scripts/*.mjs` collectors write machine-readable JSON under `.temp/`, which is
gitignored — regenerate it rather than expecting it in a fresh checkout.

## Criteria

| #   | Criterion                                                                                                                   | Status      | Evidence                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | A clean installation detects or accepts the LibreWolf executable                                                            | Pass        | `packages/librewolf-locator` unit suite covers registry, well-known-path, and `PATH` discovery plus the `--librewolf-path` override; `scripts/npm-package-smoke.mjs` installs the packed tarball into a clean root and starts its CLI                                                                                                                                    |
| 2   | Codex starts the MCP server and launches LibreWolf                                                                          | Pass        | `npm run test:e2e` connects a stdio MCP client to `dist/cli.js`, which launches LibreWolf in a dedicated profile; `packaging/codex-plugin/librewolf-agent-bridge/.mcp.json` uses the same stdio invocation                                                                                                                                                               |
| 3   | The model lists tabs and opens a page                                                                                       | Pass        | e2e "lists the dedicated tab and keeps a normal-page snapshot under 20 KB"                                                                                                                                                                                                                                                                                               |
| 4   | A normal page snapshot is below 20 KB unless expanded                                                                       | Pass        | e2e asserts `< 20480` bytes; the recorded controlled-smoke snapshot was 397 bytes                                                                                                                                                                                                                                                                                        |
| 5   | The model fills and submits a multi-field form using stable UIDs                                                            | Pass        | e2e "fills and submits a multi-field form, then observes the resulting DOM change"                                                                                                                                                                                                                                                                                       |
| 6   | The model survives a stale-UID event by taking a new snapshot                                                               | Pass        | e2e "recovers from a stale UID by taking a new snapshot" asserts `STALE_REFERENCE`, then completes the action from a fresh snapshot; the integration suite additionally asserts no upstream click was dispatched                                                                                                                                                         |
| 7   | Console errors can be filtered and returned                                                                                 | Pass        | e2e "filters console output down to the fixture error"; integration asserts the upstream filter argument is `level: error`                                                                                                                                                                                                                                               |
| 8   | Failed HTTP requests can be listed and individually inspected                                                               | Pass        | e2e "lists the failed request, inspects it individually, and redacts its secrets"                                                                                                                                                                                                                                                                                        |
| 9   | A screenshot can be saved to a caller-provided path                                                                         | Pass        | e2e "saves a screenshot to a caller-provided path" verifies size and PNG magic number                                                                                                                                                                                                                                                                                    |
| 10  | A ten-action batch uses one MCP tool call                                                                                   | Pass        | e2e "executes a self-contained ten-action batch through one MCP tool call": ten results, `transportCalls: 1`, 368 ms wall clock                                                                                                                                                                                                                                          |
| 11  | Sensitive headers and form values are redacted from logs                                                                    | Pass        | e2e and integration assert secrets are absent from network listings, individual request lookups, snapshot values, and batch output. See the caveat below.                                                                                                                                                                                                                |
| 12  | No service binds to a non-loopback network interface                                                                        | Pass        | `tests/integration/local-only-surface.test.ts` scans all product source for listeners and outbound calls and finds none; IPC is a Windows named pipe with a current-user-only DACL                                                                                                                                                                                       |
| 13  | No browser data is sent to an external server                                                                               | Pass        | Same source scan: no `fetch`, `http(s).request`, `WebSocket`, or `dgram` in product source. Shipped MCP templates are stdio-only with no host or port                                                                                                                                                                                                                    |
| 14  | Claude Desktop and ChatGPT Desktop/Codex can independently use the same MCP package                                         | **Partial** | Both packages are produced and their servers start and complete an MCP handshake from a clean install (`scripts/npm-package-smoke.mjs`, `scripts/bundled-server-smoke.mjs`). The server is client-agnostic stdio with no client-specific code. **Not yet done:** a manual session driven from the Claude Desktop and Codex UIs                                           |
| 15  | Removing the connector removes its extension, native-host registration, runtime files, and dedicated profile when requested | **Partial** | `packaging/windows/uninstall-native-host.ps1` removes the registration, copied payload, and runtime/discovery records, and removes dedicated profiles only under `-RemoveDedicatedProfiles`, guarded to the managed profile root. It is `ShouldProcess`-gated and dry-run by default. **Not yet done:** a recorded end-to-end install/uninstall cycle on a clean machine |

## Reproducing

```powershell
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

Then, with LibreWolf installed:

```powershell
$env:LIBREWOLF_AGENT_BRIDGE_E2E = '1'
npm run test:e2e
```

Optional machine-readable collectors, each writing `.temp/<name>/latest.json`:

```powershell
node scripts/compatibility-spike.mjs
node scripts/controlled-smoke.mjs
node scripts/mcp-controlled-smoke.mjs
node scripts/companion-secure-smoke.mjs
node scripts/profile-performance.mjs
```

## Caveats and known gaps

**Redaction scope (criterion 11).** Redaction covers authorization and cookie headers, sensitive
query parameters, snapshot values on sensitive fields, and serialized request bodies in JSON and
form encodings. A secret carried in a field name the heuristic does not recognize, or in an
encoding it cannot decode, can still pass through. Redaction is defense in depth, not a guarantee.

**Performance.** The idle-memory target is currently **not met** — see
[docs/PERFORMANCE.md](docs/PERFORMANCE.md). Performance targets are not among the fifteen
acceptance criteria, so this does not block MVP acceptance, but it is an open issue rather than a
resolved one.

**Screen recording** is unavailable on LibreWolf 146: the pinned upstream screencast requires
Firefox 154 or newer. It is reported as unavailable rather than silently degraded.

**Companion mode** is Windows-only, because its hardened transport depends on named-pipe ACL
verification. Console and network inspection are unavailable in companion mode and report so
through `browser_status`.
