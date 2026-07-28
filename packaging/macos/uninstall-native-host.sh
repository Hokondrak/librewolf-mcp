#!/usr/bin/env sh
# Removes only this project's per-user native-messaging files. Defaults to a dry run.
set -eu
HOST_NAME='org.librewolf_agent_bridge.native'; APPLY=0
INSTALL_ROOT="$HOME/Library/Application Support/LibreWolfAgentBridge/native-host"
MANIFEST_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-root) INSTALL_ROOT=${2:?missing install path}; shift 2 ;;
    --manifest-dir) MANIFEST_DIR=${2:?missing manifest path}; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --help|-h) printf '%s\n' 'Usage: uninstall-native-host.sh [--apply] [--install-root PATH] [--manifest-dir PATH]'; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
BASE_ROOT="$HOME/Library/Application Support/LibreWolfAgentBridge"
case "$INSTALL_ROOT" in "$BASE_ROOT/native-host"|"$BASE_ROOT/native-host"/*) ;; *) printf 'Refusing to remove a path outside %s/native-host\n' "$BASE_ROOT" >&2; exit 2;; esac
MANIFEST_PATH="$MANIFEST_DIR/$HOST_NAME.json"
if [ "$APPLY" -ne 1 ]; then printf 'Dry run: would remove %s and %s. Re-run with --apply to make changes.\n' "$MANIFEST_PATH" "$INSTALL_ROOT"; exit 0; fi
rm -f "$MANIFEST_PATH"; rm -rf "$INSTALL_ROOT"; printf 'Removed the per-user %s registration and copied payload.\n' "$HOST_NAME"
