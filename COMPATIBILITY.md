# LibreWolf compatibility

Last verified: 2026-07-28 on Windows 11 x64.

## Decision

`librewolf-agent-bridge` wraps Mozilla's
`@mozilla/firefox-devtools-mcp` as a pinned MCP-over-stdio child process.
It does not fork or copy Mozilla's implementation.

The controlled-profile path is viable with LibreWolf 146.0-2. The wrapper is
necessary for product-specific discovery, profile ownership, a smaller
semantic tool surface, stable wrapper UIDs, output bounds, secret redaction,
batching, diagnostics, and companion-mode capability reporting.

Direct TypeScript imports were rejected because Mozilla's exported internals
are undocumented and pre-1.0, and the published `0.9.15` package points its
`types` field at a missing `dist/index.d.ts`. The stdio boundary keeps the
upstream server replaceable and lets this project enforce lifecycle and
security policy.

## Tested versions

| Component              | Result                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| LibreWolf              | `146.0-2`, `C:\Program Files\LibreWolf\librewolf.exe`                                             |
| Mozilla MCP            | `@mozilla/firefox-devtools-mcp@0.9.15`                                                            |
| Mozilla npm integrity  | `sha512-lsDhAthrH4Lcz71wzyQbc25nrkxdmGNoOseH8QrIDr+JBvNij0SqgPEtpTXZVvB22bFM9/kstZfpScnLfkx+SQ==` |
| Node used for live run | `v24.14.0`                                                                                        |
| Installed system Node  | `v20.18.2` — incompatible with Mozilla's `>=20.19.0` engine floor                                 |
| Mode                   | Headless, viewport `1280x720`, loopback-only fixture                                              |

The source matrix is reproducible with:

```powershell
& "C:\Users\Maxim\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" `
  .\scripts\compatibility-spike.mjs
```

The latest machine-readable run is written to
`.temp/compatibility/latest.json`.

## Live results

The successful run started at `2026-07-28T09:23:21.184Z`.

| Probe                           | Result        | Measurement/evidence                                                                       |
| ------------------------------- | ------------- | ------------------------------------------------------------------------------------------ |
| LibreWolf discovery and launch  | Pass          | Reported binary and version `146.0-2`; cold browser initialization `3796.7 ms`             |
| Dedicated profile               | Pass          | Upstream created `<parent>\firefox_devtools_mcp_profile`                                   |
| MCP initialize and tool listing | Pass          | Connect `484.8 ms`; tools/list `6.7 ms`                                                    |
| Tab listing                     | Pass with gap | `23.7 ms`; upstream output contains index/title but omits URL despite its tool description |
| Navigation                      | Pass          | Distinct loopback URL completed in `4842.3 ms`                                             |
| Compact snapshot                | Pass          | `39.1 ms`, `378 bytes`                                                                     |
| Single-field fill               | Pass          | `135.3 ms`                                                                                 |
| Multi-field fill                | Pass          | `189.8 ms`                                                                                 |
| UID click                       | Pass          | `159.7 ms`                                                                                 |
| DOM mutation detection          | Pass          | Fresh snapshot contained `Saved`                                                           |
| Filtered console errors         | Pass          | Unique fixture error was returned                                                          |
| Failed network request list     | Pass          | Unique `POST /api/fail` with HTTP `503` was returned                                       |
| Individual request lookup       | Pass          | Request ID resolved to the matching request                                                |
| Screenshot to caller path       | Pass          | `41.4 ms`; valid 25,380-byte PNG                                                           |
| Stale UID response              | Pass          | Specific error instructed the caller to take a new snapshot                                |
| Clean shutdown                  | Pass          | Zero profile-specific LibreWolf or geckodriver processes remained                          |

The click and fill figures narrowly miss or exceed some desired steady-state
targets. They are single cold-sample compatibility measurements, not a
benchmark claim. Steady-state latency and memory come from
`npm run profile:performance`, and in-process snapshot and redaction cost comes
from the `npm run benchmark` suite; both are reported in
[docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## LibreWolf and upstream incompatibilities

1. **Node floor.** Mozilla `0.9.15` requires Node `>=20.19.0`; the machine's
   default Node is `20.18.2`. The bridge performs a startup version check with
   a stage-specific diagnostic. Packaged desktop artifacts must provide or
   require a compatible runtime.
2. **Profile path semantics.** Mozilla does not use `--profile-path P`
   directly. It creates or reuses `P\firefox_devtools_mcp_profile` and only
   copies `P\prefs.js` on first creation. The bridge therefore passes an
   app-owned parent and reports the effective nested profile.
3. **Tab URLs missing.** `list_pages` describes index, title, and URL but
   formats only index and title in `0.9.15`. The bridge retains URLs for tabs it
   opens or navigates and marks unknown URLs explicitly.
4. **Snapshot roles are partly tag-based.** LibreWolf's two text fields were
   rendered as `input`, not the semantic role `textbox`. The bridge normalizes
   common form-control roles while preserving the upstream UID.
5. **Sensitive request data is not redacted upstream.** Both the detailed list
   and individual request output exposed the spike's authorization token and
   submitted email. The bridge must redact headers, query parameters, request
   bodies, form values, and likely secrets before any MCP result or log leaves
   the adapter.
6. **Repeated same-URL navigation can time out.** One run navigating to the
   already loaded start URL returned `BiDi command timeout:
browsingContext.navigate`. Navigation to a distinct URL passed. The bridge
   rejects same-URL requests before dispatch. After a distinct-URL timeout, it
   verifies the current URL and reports success only when navigation actually
   reached the requested destination.
7. **Tool presets and documentation drift.** Mozilla's shipped `0.9.15`
   README contains unresolved merge-conflict markers, and its preset
   membership differs from the runtime registry. The bridge pins the package
   and verifies the runtime tool contract rather than trusting the README.
8. **Version-gated upstream modules.** Debugging needs Firefox 153+; profiler
   and screencast need Firefox 154+. LibreWolf 146 is intentionally run with an
   explicit core module list. Screen recording is capability-gated until the
   browser reaches the required version.
9. **Broad management module.** Enabling upstream `management` also exposes
   `restart_firefox` with caller-controlled binary/profile/environment
   arguments. Production mode does not expose that upstream module; bridge
   diagnostics are implemented separately.
10. **Geckodriver first-use message.** Mozilla logs that it is downloading via
    its pinned npm geckodriver package when no driver is cached. Packaging and
    troubleshooting must distinguish this from a network download failure.

## Upstream tool selection

Production controlled mode starts Mozilla with exactly:

```text
--tools pages,snapshot,input,network,console,screenshot,downloads,utilities,script
```

The pinned runtime currently advertises 28 tools from that set; startup verifies
the 24 upstream operations the adapter requires. The public bridge maps them
into the smaller 25-tool `browser_*` interface and never relays arbitrary
upstream tool calls. General-purpose script evaluation is not public: the
adapter uses fixed, bounded functions for narrow fallbacks, URL verification,
and sensitive-field metadata probes.

The compatibility spike additionally enables `management` only to verify
LibreWolf identity. That module is not agent-callable in the product surface.

## Wrap, fork, or upstream

- **Wrap now:** all core controlled-profile capabilities work on LibreWolf.
- **Do not fork:** no LibreWolf engine patch was required.
- **Upstream candidates:** missing URLs in `list_pages`, missing published type
  declarations, stale README/preset documentation, and a documented redaction
  contract would benefit Firefox users generally.

## Sources

- Mozilla project: <https://github.com/mozilla/firefox-devtools-mcp>
- Mozilla `0.9.15` package metadata:
  <https://github.com/mozilla/firefox-devtools-mcp/blob/v0.9.15/package.json>
- Mozilla remote protocol security:
  <https://firefox-source-docs.mozilla.org/remote/Security.html>
- LibreWolf settings:
  <https://gitlab.com/librewolf-community/settings/>
