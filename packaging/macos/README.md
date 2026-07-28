# macOS native-messaging templates

The macOS scripts install or remove only a per-user launcher/payload and Firefox-family manifest at `~/Library/Application Support/Mozilla/NativeMessagingHosts`. They default to a dry run and require `--apply` for changes. The installer requires a self-contained payload and Node `>=20.19.0`, then uses owner-only modes (`0700` for the launcher and `0600` for the manifest).

The native host can be registered on macOS, but the secure existing-session companion transport shipped by this project is Windows-only. Use controlled mode on macOS.
