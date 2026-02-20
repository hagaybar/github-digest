#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (e.g., sudo $0)"
  exit 1
fi

systemctl disable --now github-digest-fetch.timer || true
systemctl disable --now github-digest-summarize.timer || true
systemctl disable --now github-digest-api.service || true

rm -f /etc/systemd/system/github-digest-fetch.service
rm -f /etc/systemd/system/github-digest-fetch.timer
rm -f /etc/systemd/system/github-digest-summarize.service
rm -f /etc/systemd/system/github-digest-summarize.timer
rm -f /etc/systemd/system/github-digest-api.service

systemctl daemon-reload

echo "Left /etc/github-digest.env in place. Remove manually if desired."
