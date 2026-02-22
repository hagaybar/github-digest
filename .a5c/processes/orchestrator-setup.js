/**
 * @process github-digest/orchestrator-setup
 * @description Production-grade orchestrator for the Builder Radar pipeline.
 * Implements: orchestrator bash/python command, worker heartbeat + stuck detection,
 * extended health endpoint, systemd units + watchdog, install script, OPERATIONS.md.
 * Works on a new git branch, all changes additive and backwards-compatible.
 *
 * @inputs { projectDir: string, branch: string }
 * @outputs { success: boolean, filesCreated: string[], summary: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

export async function process(inputs, ctx) {
  const projectDir = inputs.projectDir ?? '/home/ubuntu/projects/github-digest';
  const branch = inputs.branch ?? 'orchestrator';

  ctx.log('info', `Starting orchestrator-setup in ${projectDir} on branch ${branch}`);

  // ============================================================================
  // PHASE 1: Branch + repo analysis
  // ============================================================================

  ctx.log('info', 'Phase 1: Create branch and analyze existing codebase state');

  const analysisResult = await ctx.task(branchAndAnalyzeTask, {
    projectDir,
    branch,
  });

  ctx.log('info', `Phase 1 complete: ${analysisResult.summary}`);

  // ============================================================================
  // PHASE 2: Orchestrator script
  // ============================================================================

  ctx.log('info', 'Phase 2: Implement orchestrate-daily CLI command + flock + prerequisites');

  const orchestratorResult = await ctx.task(implementOrchestratorTask, {
    projectDir,
    branch,
    analysisSummary: analysisResult.summary,
  });

  ctx.log('info', `Phase 2 complete: ${orchestratorResult.summary}`);

  // ============================================================================
  // PHASE 3: Worker heartbeat + stuck detection
  // ============================================================================

  ctx.log('info', 'Phase 3: Add worker heartbeat to analyze-worker + watchdog stuck detection');

  const heartbeatResult = await ctx.task(implementHeartbeatTask, {
    projectDir,
    branch,
    orchestratorSummary: orchestratorResult.summary,
  });

  ctx.log('info', `Phase 3 complete: ${heartbeatResult.summary}`);

  // ============================================================================
  // PHASE 4: Extend /health endpoint
  // ============================================================================

  ctx.log('info', 'Phase 4: Extend /api/health endpoint with DB table checks');

  const healthResult = await ctx.task(extendHealthEndpointTask, {
    projectDir,
    branch,
  });

  ctx.log('info', `Phase 4 complete: ${healthResult.summary}`);

  // ============================================================================
  // PHASE 5: systemd units + watchdog
  // ============================================================================

  ctx.log('info', 'Phase 5: Create systemd units, timers, watchdog service');

  const systemdResult = await ctx.task(createSystemdUnitsTask, {
    projectDir,
    branch,
    orchestratorSummary: orchestratorResult.summary,
    heartbeatSummary: heartbeatResult.summary,
  });

  ctx.log('info', `Phase 5 complete: ${systemdResult.summary}`);

  // ============================================================================
  // PHASE 6: Install script update
  // ============================================================================

  ctx.log('info', 'Phase 6: Update install.sh to include all new units');

  const installResult = await ctx.task(updateInstallScriptTask, {
    projectDir,
    branch,
    systemdSummary: systemdResult.summary,
  });

  ctx.log('info', `Phase 6 complete: ${installResult.summary}`);

  // ============================================================================
  // PHASE 7: OPERATIONS.md
  // ============================================================================

  ctx.log('info', 'Phase 7: Write OPERATIONS.md with setup/enable/verify/troubleshoot');

  const docsResult = await ctx.task(writeOperationsDocsTask, {
    projectDir,
    branch,
  });

  ctx.log('info', `Phase 7 complete: ${docsResult.summary}`);

  // ============================================================================
  // PHASE 8: Smoke test + dry-run verification
  // ============================================================================

  ctx.log('info', 'Phase 8: Run smoke tests and verify dry-run mode');

  const smokeResult = await ctx.task(runSmokeTestsTask, {
    projectDir,
    branch,
  });

  ctx.log('info', `Phase 8 complete: ${smokeResult.summary}`);

  // ============================================================================
  // PHASE 9: Commit
  // ============================================================================

  ctx.log('info', 'Phase 9: Commit all changes on branch');

  const commitResult = await ctx.task(commitChangesTask, {
    projectDir,
    branch,
  });

  ctx.log('info', `Phase 9 complete: ${commitResult.summary}`);

  return {
    success: true,
    branch,
    filesCreated: [
      ...(orchestratorResult.filesCreated || []),
      ...(heartbeatResult.filesCreated || []),
      ...(healthResult.filesCreated || []),
      ...(systemdResult.filesCreated || []),
      ...(installResult.filesCreated || []),
      ...(docsResult.filesCreated || []),
    ],
    summary: commitResult.summary,
  };
}

// ============================================================================
// TASK DEFINITIONS
// ============================================================================

const branchAndAnalyzeTask = defineTask('branch-and-analyze', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Create branch and analyze codebase',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior platform engineer',
      task: 'Create the git branch and analyze the existing codebase to understand what exists before implementing the orchestrator.',
      context: {
        projectDir: args.projectDir,
        branch: args.branch,
        instructions: `
1. In the project at ${args.projectDir}, create and switch to branch "${args.branch}" (if not already on it: git checkout -b ${args.branch} or git checkout ${args.branch}).
2. Read and summarize:
   - src/github_digest/cli.py (existing commands: fetch, analyze-daily, analyze-worker, rank-daily, pair-daily, serve, health, ingest-hn)
   - src/github_digest/radar/card_generator.py (run_analyze_worker function, current heartbeat/status tracking)
   - src/github_digest/api/app.py (/health endpoint current implementation, /api/analyze/status)
   - run_daily_pipeline.py (full pipeline flow)
   - deploy/systemd/ (existing units and install.sh)
   - config/radar_config.yaml (worker section: max_attempts, timeout_seconds, stale_timeout_minutes)
3. Document what already exists vs what needs to be created.
        `,
      },
      outputFormat: 'JSON with fields: summary (string), existingFiles (array of {file, purpose}), gapsList (array of strings)',
    },
    outputSchema: {
      type: 'object',
      required: ['summary', 'existingFiles', 'gapsList'],
    },
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`,
  },
}));

const implementOrchestratorTask = defineTask('implement-orchestrator', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Implement orchestrate-daily command',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior platform engineer',
      task: 'Implement the orchestrate-daily CLI command as a Python module added to the existing CLI.',
      context: {
        projectDir: args.projectDir,
        analysisSummary: args.analysisSummary,
        spec: `
Add "orchestrate-daily" subcommand to src/github_digest/cli.py and implement the logic
in src/github_digest/services/orchestrator.py. Key requirements:

COMMAND SIGNATURE:
  github-digest orchestrate-daily [--date YYYY-MM-DD] [--dry-run] [--skip-github] [--skip-hn] [--skip-analyze] [--skip-pair]

ORCHESTRATOR LOGIC (in orchestrator.py):
1. PREREQUISITES CHECK (fail fast with clear errors):
   - venv usable: import the package
   - DB path exists and writable
   - config/radar_config.yaml exists
   - saved_searches.json exists
   - Ollama reachable: GET http://localhost:11434/api/tags with 5s timeout
   - Required model available: check model name from config against tags response

2. FLOCK: Acquire /tmp/github-digest-orchestrate.lock (non-blocking). If already locked: print "Orchestration already running for today" and exit 0.

3. WORKER SINGLE-INSTANCE CHECK:
   - Check /tmp/github-digest-worker-{date}.pid
   - If file exists, check if PID is alive (os.kill(pid, 0))
   - If alive: log "Worker already running for {date} (pid={pid}), skipping analyze-worker launch"
   - If dead: remove stale pid file

4. RUN PIPELINE (in order, each step logged):
   Step 1: github fetch (unless --skip-github)
   Step 2: ingest-hn (unless --skip-hn)
   Step 3: rank-daily --date {date}
   Step 4: analyze-daily --date {date}  (fast queue populate)
   Step 4b: launch analyze-worker --date {date} as background subprocess (unless --skip-analyze or worker already running)
             Write PID to /tmp/github-digest-worker-{date}.pid
             Log worker pid
   Step 5: pair-daily --date {date} (unless --skip-pair)

5. DRY-RUN: Print each step that would run, but don't execute. Print prerequisites check result.

6. ENV VAR OVERRIDES:
   - GITHUB_DIGEST_HOME: project root
   - GITHUB_DIGEST_MODEL: LLM model name
   - GITHUB_DIGEST_LOG_DIR: log directory
   - GITHUB_DIGEST_DB_PATH: DB path override

Also add a "status" subcommand:
  github-digest orchestrate-status
  → prints: API health, Ollama health, worker PID/status for today, last analyze/status from DB

IMPORTANT:
- All new code in src/github_digest/services/orchestrator.py
- cli.py only adds the two subcommands and delegates to orchestrator.py
- Use subprocess.run to invoke github-digest subcommands (find the binary via shutil.which or sys.executable + -m)
- Return exit codes properly (0=success, 1=failure, 0=already-running)
- All steps logged with INFO level
        `,
      },
      instructions: [
        'Read src/github_digest/cli.py first to understand current pattern',
        'Read src/github_digest/radar/card_generator.py to understand run_analyze_worker',
        'Create src/github_digest/services/orchestrator.py with the full implementation',
        'Add orchestrate-daily and orchestrate-status commands to cli.py following existing pattern',
        'Make sure the code is syntactically correct Python',
        'Return a summary of what was created/changed and any files created',
      ],
      outputFormat: 'JSON with fields: summary (string), filesCreated (array of strings)',
    },
    outputSchema: {
      type: 'object',
      required: ['summary', 'filesCreated'],
    },
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`,
  },
}));

const implementHeartbeatTask = defineTask('implement-heartbeat', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Worker heartbeat + stuck detection',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior platform engineer',
      task: 'Add a heartbeat file to the analyze-worker so the watchdog can detect if it is stuck.',
      context: {
        projectDir: args.projectDir,
        spec: `
HEARTBEAT FILE: /tmp/github-digest-worker-{date}.heartbeat
Format: JSON { "pid": N, "date": "YYYY-MM-DD", "processed": N, "total": N, "current_item": "title", "last_update": "ISO8601" }

CHANGES TO src/github_digest/radar/card_generator.py:
In run_analyze_worker():
- After claiming each item, write heartbeat file before calling Ollama
- After completing/failing each item, update heartbeat file
- Heartbeat updated at: item claim, post-ollama-call

STUCK DETECTION (add to src/github_digest/services/orchestrator.py):
def check_worker_stuck(date_str, stuck_minutes=20):
  - Read /tmp/github-digest-worker-{date_str}.heartbeat
  - If file missing: return ("no_heartbeat", None)
  - If last_update > stuck_minutes ago: return ("stuck", heartbeat_data)
  - Else: return ("ok", heartbeat_data)

def restart_stuck_worker(date_str, db_path, config_path):
  - Kill PID from heartbeat file
  - Remove pid and heartbeat files
  - Reset stale processing locks in DB (call the reset logic)
  - Launch new analyze-worker subprocess
  - Write new pid file

WATCHDOG COMMAND: add "watchdog" subcommand to cli.py
  github-digest watchdog [--date YYYY-MM-DD] [--stuck-minutes 20]
  → checks API health (curl /health), Ollama health, worker heartbeat
  → if worker stuck: restart it
  → logs all checks with timestamp
  → exit 0 if all healthy, 1 if any unhealthy
        `,
      },
      instructions: [
        'Read src/github_digest/radar/card_generator.py (run_analyze_worker function) first',
        'Add heartbeat writes to run_analyze_worker in card_generator.py',
        'Add check_worker_stuck and restart_stuck_worker to orchestrator.py',
        'Add watchdog command to cli.py',
        'Keep all changes minimal and backwards compatible',
        'Return summary of what was changed',
      ],
      outputFormat: 'JSON with fields: summary (string), filesCreated (array of strings)',
    },
    outputSchema: {
      type: 'object',
      required: ['summary', 'filesCreated'],
    },
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`,
  },
}));

const extendHealthEndpointTask = defineTask('extend-health-endpoint', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Extend /health endpoint',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior platform engineer',
      task: 'Extend the /health endpoint in the FastAPI app to return richer DB connectivity and table health checks.',
      context: {
        projectDir: args.projectDir,
        spec: `
EXTEND GET /health in src/github_digest/api/app.py to return:
{
  "status": "ok" | "degraded" | "error",
  "repo_count": N,
  "last_fetch": "ISO8601 or null",
  "db": {
    "connected": true,
    "tables": {
      "radar_items": N,       -- COUNT(*)
      "daily_picks": N,       -- COUNT(*) WHERE date = today
      "radar_item_analysis": N -- COUNT(*) WHERE status IN ('pending','processing','completed','failed')
    }
  },
  "ollama": {
    "reachable": true|false,
    "model_available": true|false,
    "model": "llama3.2"
  }
}

The ollama check should be a fast non-blocking GET to localhost:11434/api/tags with a 2s timeout.
If it fails, set reachable=false, don't crash the endpoint.
status="degraded" if ollama.reachable=false; "ok" if everything fine; "error" if DB fails.
        `,
      },
      instructions: [
        'Read src/github_digest/api/app.py first',
        'Extend the /health endpoint (do NOT break existing fields: status, repo_count, last_fetch)',
        'Add ollama health check with httpx and 2s timeout',
        'Add db.tables counts for radar_items, daily_picks, radar_item_analysis',
        'Return summary of changes',
      ],
      outputFormat: 'JSON with fields: summary (string), filesCreated (array of strings)',
    },
    outputSchema: {
      type: 'object',
      required: ['summary', 'filesCreated'],
    },
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`,
  },
}));

const createSystemdUnitsTask = defineTask('create-systemd-units', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Create systemd units and watchdog',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior platform engineer',
      task: 'Create systemd service and timer units for the orchestrator, API server, and watchdog.',
      context: {
        projectDir: args.projectDir,
        spec: `
Create the following files under deploy/systemd/:

1. github-digest-orchestrate.service (Type=oneshot)
   - ExecStart: flock + github-digest orchestrate-daily (with --skip-analyze removed; background worker is managed)
   - After=network-online.target ollama.service
   - ReadWritePaths includes project dir and logs dir
   - EnvironmentFile=/etc/github-digest.env

2. github-digest-orchestrate.timer
   - OnCalendar=*-*-* 06:00:00
   - Persistent=true
   - Unit=github-digest-orchestrate.service

3. github-digest-watchdog.service (Type=oneshot)
   - ExecStart: github-digest watchdog
   - Lightweight, fast

4. github-digest-watchdog.timer
   - OnCalendar=*-*-* *:00/10:00  (every 10 minutes)
   - Persistent=true

5. github-digest-api.service (UPDATE existing: ensure Restart=always, add proper logging)
   - Keep existing content but make sure it has:
     StandardOutput=journal
     StandardError=journal
     SyslogIdentifier=github-digest-api

NOTES:
- Use /opt/github-digest as APP_HOME (configurable)
- Use /var/log/github-digest as LOG_DIR
- All services use User=github-digest Group=github-digest
- ReadWritePaths=/opt/github-digest /var/log/github-digest /tmp
- The analyze-worker is spawned as a subprocess BY orchestrate-daily, NOT as its own service
  (because it's date-scoped and manages its own lifecycle)
        `,
      },
      instructions: [
        'Read existing deploy/systemd/ files first to understand the pattern',
        'Create the 4 new files (orchestrate.service, orchestrate.timer, watchdog.service, watchdog.timer)',
        'Update deploy/systemd/github-digest-api.service to add journal logging directives',
        'All files should follow the existing security hardening pattern from fetch.service',
        'Return summary and list of files created/modified',
      ],
      outputFormat: 'JSON with fields: summary (string), filesCreated (array of strings)',
    },
    outputSchema: {
      type: 'object',
      required: ['summary', 'filesCreated'],
    },
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`,
  },
}));

const updateInstallScriptTask = defineTask('update-install-script', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Update install.sh',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior platform engineer',
      task: 'Update deploy/systemd/install.sh to install and enable all new units.',
      context: {
        projectDir: args.projectDir,
        spec: `
Update deploy/systemd/install.sh to:
1. Install all 4 new unit files (orchestrate.service/.timer, watchdog.service/.timer)
2. Install the updated github-digest-api.service
3. Enable and start:
   - github-digest-api.service (was not auto-enabled before, now enable it)
   - github-digest-orchestrate.timer
   - github-digest-watchdog.timer
4. Add a "make logs dir" step: install -d -m 0750 /var/log/github-digest

Also create deploy/systemd/uninstall.sh that:
- Stops and disables all units (fetch, summarize, api, orchestrate, watchdog)
- Removes unit files from /etc/systemd/system/
- Runs daemon-reload
(Keep it simple, don't remove the app files or user)
        `,
      },
      instructions: [
        'Read deploy/systemd/install.sh first',
        'Update it to include new units following existing pattern',
        'Also update deploy/systemd/uninstall.sh if it exists, or create it',
        'Return summary of changes',
      ],
      outputFormat: 'JSON with fields: summary (string), filesCreated (array of strings)',
    },
    outputSchema: {
      type: 'object',
      required: ['summary', 'filesCreated'],
    },
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`,
  },
}));

const writeOperationsDocsTask = defineTask('write-operations-docs', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Write OPERATIONS.md',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior platform engineer',
      task: 'Write OPERATIONS.md with complete setup, enable, verify, logs, and troubleshoot sections.',
      context: {
        projectDir: args.projectDir,
        spec: `
Write OPERATIONS.md at the project root covering:

# Operations Guide — Builder Radar

## Architecture Overview
Brief diagram showing: API server + daily orchestrator timer + watchdog + analyze-worker (bg subprocess) + Ollama

## Prerequisites
- Python 3.11+, venv, pip
- Ollama installed + llama3.2 model
- ARM64 Linux (OCI Ampere) or x86_64

## Quick Start (Dev Machine)
- source .venv/bin/activate
- github-digest orchestrate-daily --dry-run   # verify setup
- github-digest orchestrate-status           # check current state
- github-digest serve                        # start API
- github-digest orchestrate-daily           # run pipeline once

## Systemd Setup (Production)
Step-by-step:
1. Create /opt/github-digest, copy files, install venv
2. Set up /etc/github-digest.env with GITHUB_TOKEN
3. Run sudo deploy/systemd/install.sh
4. Verify: systemctl list-timers | grep github-digest
5. Enable API: sudo systemctl enable --now github-digest-api

## OCI / Firewall Note
- Ollama bound to localhost only (127.0.0.1:11434) — do NOT expose
- API on 0.0.0.0:8000 — add OCI Security List ingress rule for TCP 8000 from your IP
- Do not add 0.0.0.0/0 ingress for Ollama

## Verifying Operation
- curl http://localhost:8000/health | jq .
- curl http://localhost:8000/api/analyze/status | jq .
- github-digest orchestrate-status
- systemctl status github-digest-orchestrate.timer
- journalctl -u github-digest-orchestrate.service -f

## Viewing Logs
- journalctl -u github-digest-api -n 50
- journalctl -u github-digest-orchestrate -n 50
- journalctl -u github-digest-watchdog -n 50
- tail -f logs/analyze-worker-YYYY-MM-DD.log

## Env Var Overrides
- GITHUB_DIGEST_HOME, GITHUB_DIGEST_MODEL, GITHUB_DIGEST_LOG_DIR, GITHUB_DIGEST_DB_PATH

## Troubleshooting
- Ollama not reachable → systemctl start ollama; ollama pull llama3.2
- Worker stuck → github-digest watchdog --date today
- No picks today → check ingest: github-digest ingest-hn; github-digest rank-daily
- DB errors → github-digest health
- Duplicate runs → check /tmp/github-digest-orchestrate.lock; rm if stale
        `,
      },
      instructions: [
        'Write OPERATIONS.md to the project root at /home/ubuntu/projects/github-digest/OPERATIONS.md',
        'Use exact command names from the CLI implementation',
        'Include the firewall/OCI note prominently',
        'Return summary',
      ],
      outputFormat: 'JSON with fields: summary (string), filesCreated (array of strings)',
    },
    outputSchema: {
      type: 'object',
      required: ['summary', 'filesCreated'],
    },
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`,
  },
}));

const runSmokeTestsTask = defineTask('run-smoke-tests', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Run smoke tests and dry-run',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior platform engineer',
      task: 'Verify the orchestrator implementation works: syntax check, imports, dry-run, status command, and pytest.',
      context: {
        projectDir: args.projectDir,
        branch: args.branch,
      },
      instructions: [
        `cd ${args.projectDir}`,
        'source .venv/bin/activate',
        'Run: python -c "from github_digest.services.orchestrator import run_orchestrate_daily; print(\'imports OK\')" to verify syntax',
        'Run: github-digest orchestrate-daily --help to verify CLI is registered',
        'Run: github-digest orchestrate-status to verify status command',
        'Run: github-digest orchestrate-daily --dry-run --skip-github --skip-hn to verify dry-run',
        'Run: github-digest watchdog --help to verify watchdog is registered',
        'Run: python -m pytest tests/ --ignore=tests/test_phase2.py -q to ensure no regressions',
        'Report any errors and fix them if found (read the error, fix the code, re-run)',
        'Return a summary of test results',
      ],
      outputFormat: 'JSON with fields: summary (string), allPassed (boolean), errors (array of strings)',
    },
    outputSchema: {
      type: 'object',
      required: ['summary', 'allPassed'],
    },
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`,
  },
}));

const commitChangesTask = defineTask('commit-changes', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Commit all changes',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior platform engineer',
      task: 'Stage and commit all new and modified files on the orchestrator branch.',
      context: {
        projectDir: args.projectDir,
        branch: args.branch,
      },
      instructions: [
        `cd ${args.projectDir}`,
        'Run git status to see all changes',
        'Stage all relevant new/modified files (do NOT stage .a5c/ runs or node_modules)',
        'Commit with message: "Add production orchestrator: orchestrate-daily, watchdog, systemd units, OPERATIONS.md"',
        'Run git log --oneline -3 to confirm commit',
        'Return summary with commit hash',
      ],
      outputFormat: 'JSON with fields: summary (string), commitHash (string)',
    },
    outputSchema: {
      type: 'object',
      required: ['summary'],
    },
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`,
  },
}));
