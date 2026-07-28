#!/usr/bin/env sh
# Removes only this project's per-user native-messaging files. Defaults to a dry run.
set -eu

HOST_NAME='org.librewolf_agent_bridge.native'
APPLY=0
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
INSTALL_ROOT="$DATA_HOME/LibreWolfAgentBridge/native-host"
MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts"

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

DATA_HOME=$(realpath -m "$DATA_HOME")
INSTALL_ROOT=$(realpath -m "$INSTALL_ROOT")
MANIFEST_DIR=$(realpath -m "$MANIFEST_DIR")
ALLOWED_ROOT="$DATA_HOME/LibreWolfAgentBridge/native-host"
case "$INSTALL_ROOT" in "$ALLOWED_ROOT"|"$ALLOWED_ROOT"/*) ;; *)
  printf 'Refusing to remove a path outside %s\n' "$ALLOWED_ROOT" >&2; exit 2 ;;
esac
MANIFEST_PATH="$MANIFEST_DIR/$HOST_NAME.json"

if [ "$APPLY" -ne 1 ]; then
  printf 'Dry run: would remove %s and %s. Re-run with --apply to make changes.\n' "$MANIFEST_PATH" "$INSTALL_ROOT"
  exit 0
fi
rm -f "$MANIFEST_PATH"
rm -rf "$INSTALL_ROOT"
printf 'Removed the per-user %s registration and copied payload.\n' "$HOST_NAME"
