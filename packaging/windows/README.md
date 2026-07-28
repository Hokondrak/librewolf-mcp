# Windows native-messaging package

The Windows scripts install a packaged native-host payload for the optional LibreWolf companion extension. The payload must contain `dist/cli.js`, its production runtime dependencies, and `dist/native/secure-pipe-helper.exe`. The helper enforces same-user named-pipe ACLs and validates the discovery-record ACL.

Both scripts are dry-run-by-default: use `-Apply` to make changes and combine it with `-WhatIf` to preview PowerShell's protected operations. Installation copies the payload below `%LOCALAPPDATA%\LibreWolfAgentBridge\native-host`, resolves Node `>=20.19.0` (an explicit `-NodePath`, packaged `node\node.exe`, or PATH), creates a launcher and native-messaging manifest, applies a current-user-only ACL, and writes only the current-user Mozilla registration.

```powershell
.\install-native-host.ps1 -PayloadRoot C:\release\native-host-payload
.\install-native-host.ps1 -PayloadRoot C:\release\native-host-payload -Apply
```

`uninstall-native-host.ps1 -Apply` removes only this project’s per-user registration, copied payload, and runtime/discovery directory. It preserves normal LibreWolf profiles. Deleting the project-managed controlled profiles needs the separate `-RemoveDedicatedProfiles` switch.

## Optional managed extension policy

The installer only writes an `ExtensionSettings` policy when both `-Apply` and `-RegisterManagedExtensionPolicy -ManagedExtensionXpiPath <absolute-xpi>` are provided. It is a per-user policy attempt, not an enterprise deployment mechanism; confirm whether the installed LibreWolf build honors it at `about:policies`. Do not use it to silently install an extension for someone else.
