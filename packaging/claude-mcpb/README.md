# Claude Desktop MCPB template

This directory is a Claude Desktop extension source template using `manifest_version` `0.3`. `npm run package:all` stages the built server and its runtime dependencies before creating the `.mcpb` archive.

The archive does not bundle Node, LibreWolf, or a browser profile. Node `>=20.19.0` and LibreWolf remain user-managed prerequisites. The server uses controlled mode by default. Companion mode additionally requires the matching extension and registered native host; on Windows it uses the packaged current-user-only secure-pipe helper.

Create the archive through `npm run package:all`. Do not rename the manifest or substitute an external path: `${__dirname}` intentionally keeps the command inside the staged MCPB payload.
