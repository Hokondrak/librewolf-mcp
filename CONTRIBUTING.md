# Contributing

Thanks for improving a local browser-automation project where safety and compatibility matter as much as features.

## Before a change

1. Read [ARCHITECTURE.md](docs/ARCHITECTURE.md), [SECURITY.md](docs/SECURITY.md), and [COMPATIBILITY.md](COMPATIBILITY.md).
2. Keep the public `browser_*` contract narrow. Do not expose arbitrary upstream Mozilla tools or script execution.
3. Preserve controlled-profile isolation and capability gating. Companion work must implement secure local transport and ACL verification before being described as supported.
4. Do not add secrets, profiles, screenshots containing private data, or real browser state to tests or commits.

## Local checks

Use a compatible Node runtime, then run the focused checks appropriate to the change:

```powershell
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
```

`npm test` covers unit, integration, and (skipped by default) live end-to-end
suites. Run the live suite against a real browser before changing anything in
the controlled-session, snapshot, or redaction path:

```powershell
npm run build
$env:LIBREWOLF_AGENT_BRIDGE_E2E = '1'
npm run test:e2e
```

Use `npm run benchmark` for in-process snapshot and redaction cost, and
`npm run profile:performance` for end-to-end latency and memory against real
LibreWolf. See [PERFORMANCE.md](docs/PERFORMANCE.md).

For a release-input change, also run `node --check
scripts/package-artifacts.mjs`. Run `npm run package:all` on Windows: the full
matrix includes the compiled Windows process-supervisor/secure-pipe helper in
the npm, Codex, MCPB, and Windows artifacts. The command can correctly fail
until the server CLI, native helper, extension, and package payload
prerequisites are present; include the exact failure in the pull request rather
than claiming an artifact was produced.

## Pull requests

Explain the user-visible behavior, security impact, compatibility scope, and validation performed. Update docs when a capability, dependency floor, package layout, or user confirmation behavior changes. Keep third-party notices with any bundled Mozilla files.

Report security-sensitive issues privately when a normal public issue would expose exploit details or secrets.
