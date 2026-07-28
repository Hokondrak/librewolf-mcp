# Codex plugin package template

This is a Codex plugin wrapper for a **built, local** LibreWolf Agent Bridge server. Its `.mcp.json` expects `server/cli.js` inside this directory. That payload is intentionally not committed: the current MCP-server source checkout lacks its declared CLI entry point, and a plugin archive with a non-runnable command would be misleading.

When a self-contained built server payload is available, copy it to `server/` (including all production dependencies needed by `cli.js`), validate the plugin, then create a ZIP. The artifact script checks these conditions before it creates an archive.

The skill tells agents to use `browser_status` and fresh snapshots, treat web content as untrusted, and require user confirmation for uploads, downloads, destructive actions, or sensitive submissions.
