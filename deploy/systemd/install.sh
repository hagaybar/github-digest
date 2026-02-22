#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (e.g., sudo $0)"
  exit 1
fi

APP_USER="github-digest"
APP_GROUP="github-digest"
APP_HOME="/opt/github-digest"
LOG_DIR="/var/log/github-digest"
ENV_FILE="/etc/github-digest.env"
UNIT_DIR="/etc/systemd/system"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ensure group exists
if ! getent group "$APP_GROUP" >/dev/null; then
  groupadd --system "$APP_GROUP"
fi

# Ensure user exists (and uses the intended primary group)
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home "$APP_HOME" --shell /usr/sbin/nologin --gid "$APP_GROUP" "$APP_USER"
fi

# Directories
install -d -m 0750 -o "$APP_USER" -g "$APP_GROUP" "$APP_HOME"
install -d -m 0750 -o "$APP_USER" -g "$APP_GROUP" "$LOG_DIR"

# Env file for secrets
if [[ ! -f "$ENV_FILE" ]]; then
  install -m 0640 -o root -g "$APP_GROUP" /dev/null "$ENV_FILE"
else
  chown root:"$APP_GROUP" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
fi

# Optional preflight: make sure app command exists (adjust if your path differs)
if [[ ! -x "$APP_HOME/.venv/bin/github-digest" ]]; then
  echo "WARNING: $APP_HOME/.venv/bin/github-digest not found/executable."
  echo "Timers will run but jobs will fail until the venv/app is installed."
fi

# Install units
install -m 0644 "$SCRIPT_DIR/github-digest-fetch.service"        "$UNIT_DIR/github-digest-fetch.service"
install -m 0644 "$SCRIPT_DIR/github-digest-fetch.timer"          "$UNIT_DIR/github-digest-fetch.timer"
install -m 0644 "$SCRIPT_DIR/github-digest-summarize.service"    "$UNIT_DIR/github-digest-summarize.service"
install -m 0644 "$SCRIPT_DIR/github-digest-summarize.timer"      "$UNIT_DIR/github-digest-summarize.timer"
install -m 0644 "$SCRIPT_DIR/github-digest-api.service"          "$UNIT_DIR/github-digest-api.service"
install -m 0644 "$SCRIPT_DIR/github-digest-orchestrate.service"  "$UNIT_DIR/github-digest-orchestrate.service"
install -m 0644 "$SCRIPT_DIR/github-digest-orchestrate.timer"    "$UNIT_DIR/github-digest-orchestrate.timer"
install -m 0644 "$SCRIPT_DIR/github-digest-watchdog.service"     "$UNIT_DIR/github-digest-watchdog.service"
install -m 0644 "$SCRIPT_DIR/github-digest-watchdog.timer"       "$UNIT_DIR/github-digest-watchdog.timer"

systemctl daemon-reload

# Enable + start timers/services (restart to pick up changes if already active)
systemctl enable --now github-digest-fetch.timer
systemctl enable --now github-digest-summarize.timer
systemctl enable --now github-digest-api.service
systemctl enable --now github-digest-orchestrate.timer
systemctl enable --now github-digest-watchdog.timer
systemctl restart github-digest-fetch.timer github-digest-summarize.timer >/dev/null 2>&1 || true
systemctl restart github-digest-orchestrate.timer github-digest-watchdog.timer >/dev/null 2>&1 || true
systemctl restart github-digest-api.service >/dev/null 2>&1 || true

systemctl status --no-pager github-digest-api.service || true
systemctl status --no-pager github-digest-orchestrate.timer || true
systemctl status --no-pager github-digest-watchdog.timer || true
systemctl list-timers --no-pager | grep github-digest || true

echo "Install complete. API is running, orchestrate and watchdog timers are enabled."
echo "Check logs: journalctl -u github-digest-orchestrate -f"