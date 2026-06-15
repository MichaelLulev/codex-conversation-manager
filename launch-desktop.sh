#!/usr/bin/env sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cd "$script_dir"

log_dir="${XDG_CACHE_HOME:-"$HOME/.cache"}/codex-conversation-manager"
mkdir -p "$log_dir"
log_file="$log_dir/desktop.log"

# WebKitGTK 4.1 is unstable on this Wayland session, so run this app through
# XWayland. The backend server remains bound to 127.0.0.1 either way.
export GDK_BACKEND="${GDK_BACKEND:-x11}"
export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"

{
  printf '\n[%s] starting Codex Conversation Manager\n' "$(date -Is)"
  exec python3 desktop_app.py "$@"
} >>"$log_file" 2>&1
