#!/usr/bin/env sh
# Per-user Firefox/LibreWolf native-messaging registration. Defaults to a dry run.
set -eu

HOST_NAME='org.librewolf_agent_bridge.native'
EXTENSION_ID='librewolf-agent-bridge@librewolf-agent-bridge.org'
APPLY=0
PAYLOAD_ROOT=''
NODE_PATH=''
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
INSTALL_ROOT="$DATA_HOME/LibreWolfAgentBridge/native-host"
MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts"

usage() {
  cat <<'EOF'
Usage: install-native-host.sh --payload-root PATH [options]

Copies a self-contained native-host payload and registers a per-user Firefox-family
native-messaging manifest. It is a dry run unless --apply is provided.

Options:
  --payload-root PATH  Payload containing dist/cli.js and runtime dependencies (required)
  --node PATH          Node >=20.19.0; defaults to node on PATH
  --install-root PATH  Per-user install location (must stay under XDG data home)
  --manifest-dir PATH  Native-messaging manifest location (default ~/.mozilla/...)
  --apply              Perform changes
  --dry-run            Print planned changes (default)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --payload-root) PAYLOAD_ROOT=${2:?missing payload path}; shift 2 ;;
    --node) NODE_PATH=${2:?missing node path}; shift 2 ;;
    --install-root) INSTALL_ROOT=${2:?missing install path}; shift 2 ;;
    --manifest-dir) MANIFEST_DIR=${2:?missing manifest path}; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$PAYLOAD_ROOT" ] || { printf '%s\n' '--payload-root is required.' >&2; exit 2; }
PAYLOAD_ROOT=$(realpath "$PAYLOAD_ROOT")
DATA_HOME=$(realpath -m "$DATA_HOME")
INSTALL_ROOT=$(realpath -m "$INSTALL_ROOT")
MANIFEST_DIR=$(realpath -m "$MANIFEST_DIR")
ALLOWED_ROOT="$DATA_HOME/LibreWolfAgentBridge/native-host"

case "$INSTALL_ROOT" in "$ALLOWED_ROOT"|"$ALLOWED_ROOT"/*) ;; *)
  printf 'Install root must stay under %s\n' "$ALLOWED_ROOT" >&2; exit 2 ;;
esac
[ -f "$PAYLOAD_ROOT/dist/cli.js" ] || { printf '%s\n' 'Payload is missing dist/cli.js.' >&2; exit 2; }

if [ -z "$NODE_PATH" ]; then NODE_PATH=$(command -v node || true); fi
[ -n "$NODE_PATH" ] && [ -x "$NODE_PATH" ] || { printf '%s\n' 'Node >=20.19.0 was not found; use --node.' >&2; exit 2; }
NODE_VERSION=$($NODE_PATH --version)
VERSION=${NODE_VERSION#v}
IFS=. read -r NODE_MAJOR NODE_MINOR NODE_PATCH <<EOF
$VERSION
EOF
case "$NODE_MAJOR:$NODE_MINOR" in
  ''|*[!0-9:]*|0:*|1:*|2:*|3:*|4:*|5:*|6:*|7:*|8:*|9:*|10:*|11:*|12:*|13:*|14:*|15:*|16:*|17:*|18:*|19:*|20:0|20:1|20:2|20:3|20:4|20:5|20:6|20:7|20:8|20:9|20:10|20:11|20:12|20:13|20:14|20:15|20:16|20:17|20:18)
    printf 'Node >=20.19.0 is required; found %s.\n' "$NODE_VERSION" >&2; exit 2 ;;
esac

MANIFEST_PATH="$MANIFEST_DIR/$HOST_NAME.json"
LAUNCHER_PATH="$INSTALL_ROOT/librewolf-agent-native-host"
if [ "$APPLY" -ne 1 ]; then
  printf 'Dry run: would copy %s to %s, create a 0700 launcher, and write %s. Re-run with --apply to make changes.\n' "$PAYLOAD_ROOT" "$INSTALL_ROOT" "$MANIFEST_PATH"
  printf '%s\n' 'Note: this is direct-host registration. Flatpak LibreWolf cannot generally see host-side native-messaging manifests; use controlled mode unless the Flatpak explicitly supports this integration.'
  exit 0
fi

STAGE="$DATA_HOME/LibreWolfAgentBridge/staging/native-host-$$"
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
mkdir -p "$STAGE"
cp -R "$PAYLOAD_ROOT" "$STAGE/payload"
printf '#!/usr/bin/env sh\nexec "%s" "$(dirname "$0")/payload/dist/cli.js" --extension-id "%s"\n' "$NODE_PATH" "$EXTENSION_ID" >"$STAGE/librewolf-agent-native-host"
chmod 700 "$STAGE/librewolf-agent-native-host"
HOST_JSON=$(printf '%s' "$LAUNCHER_PATH" | sed 's/[\\&|]/\\&/g')
sed "s|__HOST_PATH__|$HOST_JSON|" "$(dirname "$0")/native-host.manifest.template.json" >"$STAGE/$HOST_NAME.json"

rm -rf "$INSTALL_ROOT"
mkdir -p "$(dirname "$INSTALL_ROOT")" "$MANIFEST_DIR"
mv "$STAGE" "$INSTALL_ROOT"
chmod -R go-rwx "$INSTALL_ROOT"
mv "$INSTALL_ROOT/$HOST_NAME.json" "$MANIFEST_PATH"
chmod 600 "$MANIFEST_PATH"
printf 'Installed %s for this user. The current secure companion transport is Windows-only; on Linux use controlled mode.\n' "$HOST_NAME"
