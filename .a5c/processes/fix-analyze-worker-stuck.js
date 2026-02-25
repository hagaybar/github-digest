/**
 * @process github-digest/fix-analyze-worker-stuck
 * @description Fix the analyze-worker stuck issue:
 *   1. Reset stale 'processing' lock in production DB + restart worker immediately
 *   2. Patch watchdog to restart worker when no_worker but pending items exist
 *   3. Deploy code fix to production and verify all 7 items are analyzed
 *
 * @inputs {}
 * @outputs { fixesApplied: string[], allItemsAnalyzed: boolean, summary: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

export async function process(inputs, ctx) {
  const projectDir = '/home/ubuntu/projects/github-digest';

  // ============================================================================
  // PHASE 1: Immediate fix — reset stale lock + restart analyze-worker in prod
  // ============================================================================

  const immediatefix = await ctx.task(immediateFixTask, { projectDir });

  // ============================================================================
  // PHASE 2: Code fix — patch watchdog to auto-restart when no_worker + pending
  // ============================================================================

  const codeFix = await ctx.task(codeFixTask, {
    projectDir,
    immediateFixResult: immediatefix,
  });

  // ============================================================================
  // PHASE 3: Deploy code fix to production + run git pull
  // ============================================================================

  const deploy = await ctx.task(deployTask, {
    projectDir,
    codeFixResult: codeFix,
  });

  // ============================================================================
  // PHASE 4: Verify all 7 items get analyzed
  // ============================================================================

  const verification = await ctx.task(verifyTask, {
    projectDir,
    deployResult: deploy,
  });

  return {
    fixesApplied: [immediatefix.fix, codeFix.fix, deploy.fix].filter(Boolean),
    allItemsAnalyzed: verification.allAnalyzed,
    summary: verification.summary,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Task 1: Reset stale lock in production DB + restart worker
// ────────────────────────────────────────────────────────────────────────────

const immediateFixTask = defineTask('immediate-fix', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Reset stale processing lock + restart analyze-worker in production',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Linux sysadmin / Python operator',
      task: `Fix the stuck analyze-worker in production. The production app is at /opt/github-digest/.

CONTEXT:
- The analyze-worker processed item 17 ('huggingface/skills') at 06:02:16 UTC and hung
- Item 17 is stuck in 'processing' status in the DB (the worker process is dead)
- Items 18-22 are in 'pending' status (never processed)
- No analyze-worker is currently running (confirmed by /tmp/github-digest-worker-2026-02-25.pid being absent)
- Ollama is running and healthy at localhost:11434

STEPS TO PERFORM:
1. Verify current DB state in production:
   sudo /opt/github-digest/.venv/bin/python3 -c "
import sqlite3
conn = sqlite3.connect('/opt/github-digest/data/github_digest.db')
rows = conn.execute(\"SELECT id, item_id, status, attempts, error_message FROM radar_item_analysis ORDER BY id DESC LIMIT 15\").fetchall()
for r in rows: print(r)
conn.close()
"

2. Reset stale 'processing' lock in production DB:
   sudo /opt/github-digest/.venv/bin/python3 -c "
import sqlite3
conn = sqlite3.connect('/opt/github-digest/data/github_digest.db')
result = conn.execute(\"UPDATE radar_item_analysis SET status='pending' WHERE status='processing'\")
conn.commit()
print(f'Reset {result.rowcount} stale processing locks')
conn.close()
"

3. Launch the analyze-worker in production (as the github-digest user, detached):
   sudo -u github-digest bash -c 'cd /opt/github-digest && GITHUB_DIGEST_HOME=/opt/github-digest nohup /opt/github-digest/.venv/bin/github-digest analyze-worker --date 2026-02-25 > /opt/github-digest/logs/analyze-worker-2026-02-25-restart.log 2>&1 & echo "PID: $!"'

4. Wait 15 seconds then check the log and DB status to confirm the worker started:
   sleep 15
   tail -20 /opt/github-digest/logs/analyze-worker-2026-02-25-restart.log

   sudo /opt/github-digest/.venv/bin/python3 -c "
import sqlite3
conn = sqlite3.connect('/opt/github-digest/data/github_digest.db')
rows = conn.execute(\"SELECT status, COUNT(*) FROM radar_item_analysis GROUP BY status\").fetchall()
for r in rows: print(r)
conn.close()
"

5. Check the API analyze/status endpoint to see current state:
   curl -s 'http://localhost:8000/api/analyze/status?date=2026-02-25' | python3 -m json.tool

Return a summary of what was done and the current worker state.`,
      outputFormat: '{"fix": "description of what was done", "workerStarted": true/false, "pendingCount": number, "processingCount": number, "success": true/false, "errors": []}',
    },
    outputSchema: {
      type: 'object',
      required: ['fix', 'workerStarted', 'success'],
      properties: {
        fix: { type: 'string' },
        workerStarted: { type: 'boolean' },
        pendingCount: { type: 'number' },
        processingCount: { type: 'number' },
        success: { type: 'boolean' },
        errors: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`,
  },
}));

// ────────────────────────────────────────────────────────────────────────────
// Task 2: Patch watchdog to auto-restart when no_worker + pending items
// ────────────────────────────────────────────────────────────────────────────

const codeFixTask = defineTask('code-fix-watchdog', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Patch watchdog to restart worker when no_worker + pending items exist',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python backend developer',
      task: `Fix the watchdog in the GitHub Digest project to auto-restart the analyze-worker when there are pending analysis items but no worker is running.

PROJECT DIR: ${args.projectDir}

CONTEXT:
The watchdog is in: ${args.projectDir}/src/github_digest/services/orchestrator.py
Function: run_watchdog()

CURRENT BEHAVIOR:
- The watchdog checks worker state via check_worker_stuck()
- If stuck_state == 'stuck': restarts the worker ✓
- If stuck_state == 'no_worker': does NOTHING ✗ (BUG)
- So if the worker dies mid-processing, items remain pending forever

DESIRED BEHAVIOR:
When stuck_state == 'no_worker' AND there are pending/processing items in radar_item_analysis for today, the watchdog should restart the worker.

SPECIFIC CHANGES NEEDED:
1. Read ${args.projectDir}/src/github_digest/services/orchestrator.py first
2. In run_watchdog(), after the stuck_state check, add logic:
   - If stuck_state == 'no_worker': query the DB for count of pending/processing items for today
   - If count > 0: call restart_stuck_worker() (it already handles the DB reset + relaunch)
   - Log appropriately: "Worker not running but X pending items found. Relaunching worker."
3. Also add a 'worker_relaunched' key to the result dict when this happens

Also check the result dict structure to add proper reporting.

IMPLEMENTATION RULES:
- Read the file first, understand the full run_watchdog function
- Make the minimal change needed (just the no_worker + pending items case)
- After editing, read the file back to verify the change is correct
- Do NOT break the existing stuck_state == 'stuck' handling
- Test logic: the DB query should check daily_picks for today AND radar_item_analysis status IN ('pending', 'processing')

Return a summary of the change made.`,
      outputFormat: '{"fix": "description of the code change", "fileEdited": "path to file", "success": true/false, "errors": []}',
    },
    outputSchema: {
      type: 'object',
      required: ['fix', 'success'],
      properties: {
        fix: { type: 'string' },
        fileEdited: { type: 'string' },
        success: { type: 'boolean' },
        errors: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`,
  },
}));

// ────────────────────────────────────────────────────────────────────────────
// Task 3: Deploy code fix to production + commit
// ────────────────────────────────────────────────────────────────────────────

const deployTask = defineTask('deploy-code-fix', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Commit code fix and deploy to production',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'DevOps engineer',
      task: `Commit the watchdog code fix and deploy it to the production server at /opt/github-digest/.

PROJECT DIR: ${args.projectDir}
PRODUCTION DIR: /opt/github-digest/

CONTEXT:
The file ${args.projectDir}/src/github_digest/services/orchestrator.py was modified to fix the watchdog.
The code fix result was: ${JSON.stringify(args.codeFixResult)}

STEPS:
1. Check what changed: run git diff in ${args.projectDir}

2. If there are changes to commit:
   cd ${args.projectDir}
   git add src/github_digest/services/orchestrator.py
   git commit -m "Fix watchdog: restart worker when no_worker + pending items exist

When the analyze-worker dies mid-processing, items remain pending forever
because the watchdog only restarts for 'stuck' state (stale heartbeat),
not for 'no_worker' state. This patch adds a DB query to detect pending
items and relaunch the worker when none is running.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

3. Deploy to production:
   sudo git -C /opt/github-digest pull origin main
   sudo systemctl restart github-digest-api.service

4. Verify the production API is up:
   sleep 5
   curl -s http://localhost:8000/health | python3 -m json.tool

5. Run the watchdog once manually to test the new logic (if worker is done):
   - Only run watchdog if analyze_worker is no longer running and there are pending items
   - Check: curl -s 'http://localhost:8000/api/analyze/status?date=2026-02-25' | python3 -m json.tool

Return a summary of what was deployed.`,
      outputFormat: '{"fix": "description of deployment", "committed": true/false, "deployed": true/false, "success": true/false, "errors": []}',
    },
    outputSchema: {
      type: 'object',
      required: ['fix', 'success'],
      properties: {
        fix: { type: 'string' },
        committed: { type: 'boolean' },
        deployed: { type: 'boolean' },
        success: { type: 'boolean' },
        errors: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`,
  },
}));

// ────────────────────────────────────────────────────────────────────────────
// Task 4: Verify all 7 items are analyzed
// ────────────────────────────────────────────────────────────────────────────

const verifyTask = defineTask('verify-analysis', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Verify all 7 items for today are analyzed',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer',
      task: `Verify that all 7 daily picks for 2026-02-25 are now fully analyzed.

CONTEXT:
We fixed the analyze-worker and restarted it. This task verifies the outcome.
NOTE: The analyze-worker may still be running (each Ollama call takes ~30-120 seconds).
Poll until all items are complete (up to 20 minutes), checking every 30 seconds.

STEPS:
1. Check current analyze status:
   curl -s 'http://localhost:8000/api/analyze/status?date=2026-02-25' | python3 -m json.tool

2. Check the worker log to see progress:
   sudo tail -30 /opt/github-digest/logs/analyze-worker-2026-02-25-restart.log

3. If not all completed yet, wait 30 seconds and check again (repeat up to 20 times = 10 minutes):
   - If 'done': true in the API response, all items are analyzed
   - If not done, check: are any items 'failed' with max_attempts exhausted?

4. If any items failed permanently (attempts >= 3), report what failed and why.

5. Check the production DB for final state:
   sudo /opt/github-digest/.venv/bin/python3 -c "
import sqlite3
conn = sqlite3.connect('/opt/github-digest/data/github_digest.db')
rows = conn.execute('''
  SELECT ria.id, ria.status, ria.attempts, ria.error_message, ri.title
  FROM radar_item_analysis ria
  JOIN radar_items ri ON ria.item_id=ri.id
  JOIN daily_picks dp ON dp.item_id=ria.item_id
  WHERE dp.date=\\'2026-02-25\\'
  ORDER BY dp.rank
''').fetchall()
for r in rows: print(r)
conn.close()
"

6. Final API check - does the today page show analysis for items?
   curl -s 'http://localhost:8000/api/today?date=2026-02-25' | python3 -c "
import json, sys
data = json.load(sys.stdin)
items = data.get('items', [])
print(f'Total items: {len(items)}')
for item in items:
    has_analysis = bool(item.get('analysis'))
    print(f'  [{item.get(\"rank\")}] {item.get(\"title\", \"\")[:50]} - analysis: {has_analysis}')
"

Return whether all 7 items are now analyzed and a summary of the state.`,
      outputFormat: '{"allAnalyzed": true/false, "completedCount": number, "failedCount": number, "pendingCount": number, "summary": "description of final state"}',
    },
    outputSchema: {
      type: 'object',
      required: ['allAnalyzed', 'summary'],
      properties: {
        allAnalyzed: { type: 'boolean' },
        completedCount: { type: 'number' },
        failedCount: { type: 'number' },
        pendingCount: { type: 'number' },
        summary: { type: 'string' },
      },
    },
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`,
  },
}));
