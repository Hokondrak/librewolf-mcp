# Linux native-messaging templates

`install-native-host.sh` and `uninstall-native-host.sh` are per-user, dry-run-by-default helpers for Firefox-family native messaging. They require `--apply` before writing or removing anything. The installer copies a self-contained payload, requires Node `>=20.19.0`, creates a mode-`0700` launcher, and writes a mode-`0600` manifest at `~/.mozilla/native-messaging-hosts/` by default.

The supplied secure companion transport is Windows-only because it depends on the packaged Windows named-pipe helper. Installing a manifest on Linux does not make existing-session companion automation available; use controlled mode.

## Flatpak LibreWolf

Do not assume a host-side `~/.mozilla/native-messaging-hosts` manifest is visible inside a Flatpak browser sandbox. Native hosts must be discoverable and executable within the browser sandbox, and this package does not grant Flatpak filesystem or process permissions, install a portal, or modify a Flatpak. Use controlled mode unless the specific LibreWolf Flatpak explicitly documents and supports the required native-messaging integration.
