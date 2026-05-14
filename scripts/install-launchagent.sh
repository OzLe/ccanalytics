#!/usr/bin/env bash
#
# install-launchagent.sh — run `ccanalytics web` automatically at macOS login.
#
# Installs a per-user LaunchAgent that starts the ccanalytics web dashboard
# (API on :3001, dashboard on :5173) when you log in, and keeps it running.
#
# Usage:
#   ./scripts/install-launchagent.sh              install + load (default)
#   ./scripts/install-launchagent.sh --uninstall  unload + remove the agent
#   ./scripts/install-launchagent.sh --status     show whether it is loaded
#   ./scripts/install-launchagent.sh --help       this help
#
# Notes:
#   - LaunchAgents do not source your shell, so absolute paths to `node` are
#     baked into the plist. With nvm that path is node-version-specific —
#     re-run this script after switching node versions.
#   - The dashboard is served from the built `dashboard/dist/`, so run
#     `npm run build:dashboard` after frontend changes for the agent to serve
#     them. The API server runs from source via tsx and is always current.
#
set -euo pipefail

LABEL="com.ccanalytics.web"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.ccanalytics/logs"

# Repo root = the parent directory of this script's directory.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

print_help() { sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

require_macos() {
  if [ "$(uname)" != "Darwin" ]; then
    echo "Error: this script only supports macOS (LaunchAgents)." >&2
    exit 1
  fi
}

unload_agent() {
  # `launchctl unload` is the legacy API but, unlike `bootout`/`bootstrap`, it
  # behaves consistently regardless of the caller's launchd context. It is a
  # harmless no-op (non-zero exit) when the agent is not loaded.
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
}

cmd_status() {
  # Query the label directly: `launchctl list <label>` exits 0 and prints the
  # service dict when loaded, non-zero when not — more reliable than scraping
  # the full `launchctl list` table.
  if launchctl list "$LABEL" >/dev/null 2>&1; then
    local pid
    pid="$(launchctl list "$LABEL" 2>/dev/null \
      | awk -F' = ' '/"PID"/ { gsub(/[^0-9]/, "", $2); print $2 }')"
    if [ -n "$pid" ]; then
      echo "status:  loaded (running, pid $pid)"
    else
      echo "status:  loaded (not running)"
    fi
  else
    echo "status:  not loaded"
  fi
  if [ -f "$PLIST_PATH" ]; then
    echo "plist:   $PLIST_PATH"
  else
    echo "plist:   (not installed)"
  fi
}

cmd_uninstall() {
  require_macos
  if [ -f "$PLIST_PATH" ]; then
    unload_agent
    rm -f "$PLIST_PATH"
    echo "Uninstalled — removed $PLIST_PATH and unloaded the agent."
  else
    echo "Nothing to uninstall ($PLIST_PATH not found)."
  fi
}

cmd_install() {
  require_macos

  # Resolve the absolute node path — baked into the plist since LaunchAgents
  # run with a minimal environment and do not source your shell profile.
  local node_bin node_dir cli_entry
  node_bin="$(command -v node || true)"
  if [ -z "$node_bin" ]; then
    echo "Error: 'node' is not on PATH. Run this from a shell where node works." >&2
    exit 1
  fi
  node_dir="$(dirname "$node_bin")"

  cli_entry="$REPO_ROOT/dist/cli.cjs"
  if [ ! -f "$cli_entry" ]; then
    echo "Error: $cli_entry not found — run 'npm run build' first." >&2
    exit 1
  fi

  mkdir -p "$LOG_DIR" "$(dirname "$PLIST_PATH")"

  # `ccanalytics web` spawns `npm run server` and `npm run preview` as child
  # processes, so npm/node must be resolvable from the agent's PATH.
  local agent_path="$node_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>$node_bin</string>
        <string>$cli_entry</string>
        <string>web</string>
        <string>--no-open</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$REPO_ROOT</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$agent_path</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ProcessType</key>
    <string>Background</string>

    <key>StandardOutPath</key>
    <string>$LOG_DIR/web.out.log</string>

    <key>StandardErrorPath</key>
    <string>$LOG_DIR/web.err.log</string>
</dict>
</plist>
PLIST

  echo "Wrote $PLIST_PATH"

  # Reload cleanly: unload any existing instance, then `load -w` (which enables
  # the agent and, via RunAtLoad, starts it now). `launchctl load` is the
  # legacy API, but it behaves consistently across launchd contexts whereas
  # `bootstrap` can fail with a vague I/O error depending on the caller's
  # session. At login, launchd loads the plist from ~/Library/LaunchAgents/
  # itself regardless — this step just avoids needing a re-login right now.
  unload_agent
  launchctl load -w "$PLIST_PATH"

  echo ""
  echo "Installed. 'ccanalytics web' will now start at login (and is starting now)."
  echo "  API:        http://localhost:3001"
  echo "  Dashboard:  http://localhost:5173"
  echo "  Logs:       $LOG_DIR/web.out.log  /  web.err.log"
  echo "  Status:     ./scripts/install-launchagent.sh --status"
  echo "  Uninstall:  ./scripts/install-launchagent.sh --uninstall"
}

case "${1:-}" in
  --help | -h) print_help ;;
  --status)    cmd_status ;;
  --uninstall) cmd_uninstall ;;
  "")          cmd_install ;;
  *)
    echo "Unknown option: $1" >&2
    echo "Run with --help for usage." >&2
    exit 1
    ;;
esac
