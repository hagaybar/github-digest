#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (e.g., sudo $0)"
  exit 1
fi

systemctl disable --now github-digest-fetch.timer || true
systemctl disable --now github-digest-summarize.timer || true
systemctl disable --now github-digest-api.service || true
systemctl disable --now github-digest-orchestrate.timer || true
systemctl disable --now github-digest-watchdog.timer || true

rm -f /etc/systemd/system/github-digest-fetch.service
rm -f /etc/systemd/system/github-digest-fetch.timer
rm -f /etc/systemd/system/github-digest-summarize.service
rm -f /etc/systemd/system/github-digest-summarize.timer
rm -f /etc/systemd/system/github-digest-api.service
rm -f /etc/systemd/system/github-digest-orchestrate.service
rm -f /etc/systemd/system/github-digest-orchestrate.timer
rm -f /etc/systemd/system/github-digest-watchdog.service
rm -f /etc/systemd/system/github-digest-watchdog.timer

systemctl daemon-reload

echo "Left /etc/github-digest.env in place. Remove manually if desired."
