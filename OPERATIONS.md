# Operations Guide — Builder Radar

## Architecture Overview

```
                     ┌─────────────────────────────────────────┐
                     │            OCI Ampere (ARM64)            │
                     │                                          │
  [Timer 06:00]──► orchestrate-daily                           │
                       │                                        │
                       ├─► ingest-hn (HackerNews → DB)         │
                       ├─► rank-daily (score + pick top 7)      │
                       ├─► analyze-daily (populate queue)       │
                       ├─► analyze-worker (bg subprocess) ──► Ollama:11434
                       └─► pair-daily (complementary pairs)    │
                                                               │
  [Timer */10min]──► watchdog ──► health check + stuck detect  │
                                                               │
  [Always-on]──► github-digest-api.service ──► :8000 ─────────┤
                     │                                          │
  Browser ──────────►│ /today, /api/today, /api/analyze/status  │
                     └─────────────────────────────────────────┘
```

Key files:
- PID file: `/tmp/github-digest-worker-YYYY-MM-DD.pid`
- Heartbeat: `/tmp/github-digest-worker-YYYY-MM-DD.heartbeat`
- Orchestrate lock: `/tmp/github-digest-orchestrate.lock`
- Worker log: `logs/analyze-worker-YYYY-MM-DD.log`

---

## Prerequisites

- Python 3.11+, pip
- [Ollama](https://ollama.ai) installed with `llama3.2` model pulled
- ARM64 Linux (OCI Ampere A1) or x86_64

```bash
# Install Ollama (Linux ARM64)
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull llama3.2

# Verify
ollama list
curl http://localhost:11434/api/tags
```

---

## Quick Start (Dev Machine)

```bash
# 1. Activate virtualenv
source .venv/bin/activate

# 2. Verify setup (no-op dry run)
github-digest orchestrate-daily --dry-run

# 3. Check current state
github-digest orchestrate-status

# 4. Run the full pipeline once
github-digest orchestrate-daily

# 5. Start API server (separate terminal)
github-digest serve

# 6. Open in browser
open http://localhost:8000/today
```

### Manual pipeline steps (advanced)

```bash
github-digest ingest-hn               # Fetch HackerNews stories → DB
github-digest rank-daily              # Score + pick top 7
github-digest analyze-daily           # Populate analysis queue (fast)
github-digest analyze-worker          # Process queue (LLM, blocking)
github-digest pair-daily              # Generate complementary pairs
```

---

## Systemd Setup (Production)

### 1. Create app directory and copy files

```bash
sudo mkdir -p /opt/github-digest
sudo rsync -av --exclude='.git' /path/to/repo/ /opt/github-digest/
sudo chown -R github-digest:github-digest /opt/github-digest
```

### 2. Install Python venv

```bash
sudo -u github-digest bash -c "
  cd /opt/github-digest
  python3 -m venv .venv
  .venv/bin/pip install -e .
"
```

### 3. Configure secrets

```bash
sudo tee /etc/github-digest.env > /dev/null << 'EOF'
GITHUB_TOKEN=ghp_your_token_here
# Optional overrides:
# GITHUB_DIGEST_MODEL=llama3.2
# GITHUB_DIGEST_DB_PATH=/opt/github-digest/data/github_digest.db
EOF
sudo chmod 640 /etc/github-digest.env
sudo chown root:github-digest /etc/github-digest.env
```

### 4. Install and enable systemd units

```bash
sudo deploy/systemd/install.sh
```

This installs all units and enables:
- `github-digest-api.service` (always-on FastAPI server)
- `github-digest-orchestrate.timer` (daily at 06:00)
- `github-digest-watchdog.timer` (every 10 minutes)

### 5. Verify

```bash
systemctl list-timers | grep github-digest
systemctl status github-digest-api.service
```

---

## OCI / Firewall Notes

> **Security:** Ollama listens on `127.0.0.1:11434` by default. **Do NOT expose it to the internet.**

To access the web UI from outside:
1. In OCI Console → Networking → VCN → Security Lists
2. Add an **Ingress Rule**: TCP, port 8000, from your IP only (e.g., `203.0.113.42/32`)
3. Do **not** add `0.0.0.0/0` for port 8000 or 11434

For production, put nginx in front with HTTPS:
```nginx
server {
    listen 443 ssl;
    location / { proxy_pass http://127.0.0.1:8000; }
}
```

---

## Verifying Operation

```bash
# Health check (shows DB, Ollama, status)
curl http://localhost:8000/health | jq .

# Analysis queue status for today
curl "http://localhost:8000/api/analyze/status?date=$(date +%F)" | jq .

# CLI status summary
github-digest orchestrate-status

# Timer status
systemctl status github-digest-orchestrate.timer
systemctl status github-digest-watchdog.timer

# Watch logs live
journalctl -u github-digest-orchestrate.service -f
```

Expected `/health` output when healthy:
```json
{
  "status": "ok",
  "repo_count": 1500,
  "last_fetch": "2026-02-22T06:00:00",
  "db": {
    "connected": true,
    "tables": {"radar_items": 42, "daily_picks_today": 7, "radar_item_analysis": 7}
  },
  "ollama": {"reachable": true, "model_available": true, "model": "llama3.2"}
}
```

---

## Viewing Logs

```bash
# Systemd journal logs
journalctl -u github-digest-api -n 50
journalctl -u github-digest-orchestrate -n 50
journalctl -u github-digest-watchdog -n 50

# Follow live
journalctl -u github-digest-orchestrate -f

# Worker LLM analysis log (per-item progress)
tail -f logs/analyze-worker-$(date +%F).log

# All github-digest units at once
journalctl -t github-digest-orchestrate -t github-digest-watchdog -n 100
```

---

## Environment Variable Overrides

These can be set in `/etc/github-digest.env` or exported before running:

| Variable | Default | Purpose |
|----------|---------|---------|
| `GITHUB_TOKEN` | (none) | GitHub API token (raises rate limits) |
| `GITHUB_DIGEST_HOME` | `/opt/github-digest` | App home dir |
| `GITHUB_DIGEST_MODEL` | `llama3.2` | Ollama model name |
| `GITHUB_DIGEST_LOG_DIR` | `$HOME/logs` | Log directory |
| `GITHUB_DIGEST_DB_PATH` | `$HOME/data/github_digest.db` | SQLite DB path |

---

## Troubleshooting

### Ollama not reachable

```bash
# Check if running
systemctl status ollama

# Start if stopped
sudo systemctl start ollama

# Check model is pulled
ollama list

# Pull if missing
ollama pull llama3.2
```

### Worker stuck / analysis not completing

```bash
# Run watchdog manually — will detect and restart if stuck
github-digest watchdog --date today

# Or check heartbeat file directly
cat /tmp/github-digest-worker-$(date +%F).heartbeat | jq .

# Force reset stuck items in DB (last resort)
sqlite3 data/github_digest.db "
  UPDATE radar_item_analysis
  SET status='pending', started_at=NULL
  WHERE status='processing'
    AND started_at < datetime('now', '-30 minutes');
"
```

### No picks today

```bash
# Re-run ingestion steps manually
github-digest ingest-hn
github-digest rank-daily

# Check DB directly
sqlite3 data/github_digest.db \
  "SELECT date, count(*) FROM daily_picks GROUP BY date ORDER BY date DESC LIMIT 5;"
```

### DB errors

```bash
github-digest health

# Check DB file exists and is readable
ls -lh data/github_digest.db

# Run migrations manually
python3 -c "from github_digest.db.migrations import run_migrations; run_migrations()"
```

### Duplicate/stuck orchestrator run

```bash
# Check if lock is stale
ls -la /tmp/github-digest-orchestrate.lock

# If process is not running, remove lock
lsof /tmp/github-digest-orchestrate.lock || rm /tmp/github-digest-orchestrate.lock

# Check running processes
pgrep -af github-digest
```

### Test that everything is wired up

```bash
# Dry run — checks prerequisites, prints what would run, exits
github-digest orchestrate-daily --dry-run

# If dry run passes, run for real:
github-digest orchestrate-daily
```

---

## Uninstall

```bash
sudo deploy/systemd/uninstall.sh

# Optionally remove app files (destructive — keep DB backup first)
# sudo rm -rf /opt/github-digest
# sudo userdel github-digest
# sudo groupdel github-digest
```
