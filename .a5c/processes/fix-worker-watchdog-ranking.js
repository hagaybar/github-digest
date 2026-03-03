/**
 * @process github-digest/fix-worker-watchdog-ranking
 * @description Fix 4 bugs discovered 2026-02-28:
 *
 *   Bug 1 (CRITICAL): Watchdog kills spawned analyze-worker via systemd cgroup cleanup.
 *     The watchdog is Type=oneshot with default KillMode=control-group; when it exits,
 *     systemd kills every process in its cgroup — including the worker it just launched.
 *     Fix: add KillMode=process to the watchdog service unit.
 *
 *   Bug 2: Watchdog exits code 1 on successful worker relaunch.
 *     result["healthy"]=False even when relaunched successfully → systemd shows "failed".
 *     Fix: exit 0 when worker was successfully relaunched.
 *
 *   Bug 3: API returns score:0.00 — scores_json fetched from DB but never included in
 *     the /api/today response dict.
 *     Fix: parse scores_json and include final_score in the items list.
 *
 *   Bug 4: Ranking picks non-builder news content.
 *     Non-GitHub items (news articles) get buildability_score=0.3, letting high-HN-point
 *     political posts dominate the Today's 7. Fix: lower non-GitHub baseline to 0.0.
 *
 * @inputs {}
 * @outputs { allBugsFixed: boolean, deployed: boolean, summary: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

const PROJECT_DIR = '/home/ubuntu/projects/github-digest';

export async function process(inputs, ctx) {

  // ============================================================================
  // PHASE 1: Apply all 4 code/config fixes
  // ============================================================================

  const fixes = await ctx.task(applyFixesTask, { projectDir: PROJECT_DIR });

  // ============================================================================
  // PHASE 2: Run tests to verify nothing broke
  // ============================================================================

  const tests = await ctx.task(runTestsTask, { projectDir: PROJECT_DIR, fixes });

  // ============================================================================
  // PHASE 3: Deploy to production + reload systemd unit
  // ============================================================================

  const deploy = await ctx.task(deployTask, { projectDir: PROJECT_DIR, testResult: tests });

  // ============================================================================
  // PHASE 4: Verify production — watchdog relaunches worker and worker stays alive
  // ============================================================================

  const verify = await ctx.task(verifyTask, { projectDir: PROJECT_DIR, deployResult: deploy });

  return {
    allBugsFixed: fixes.success && tests.passed && deploy.success,
    deployed: deploy.success,
    summary: verify.summary,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Task 1: Apply all 4 fixes
// ────────────────────────────────────────────────────────────────────────────

const applyFixesTask = defineTask('apply-fixes', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Apply 4 bug fixes (watchdog KillMode, exit code, API score, ranking)',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python/Linux developer',
      task: 'Apply 4 bug fixes to the github-digest project',
      context: {
        projectDir: args.projectDir,
        bugs: [
          {
            id: 'bug1',
            name: 'Watchdog KillMode — worker killed by systemd cgroup',
            file: '/etc/systemd/system/github-digest-watchdog.service',
            fix: 'Add KillMode=process under [Service] so only the watchdog process itself is killed on exit, not its subprocesses',
            note: 'Use sudo to edit the systemd unit file'
          },
          {
            id: 'bug2',
            name: 'Watchdog exit code 1 on successful relaunch',
            file: `${args.projectDir}/src/github_digest/cli.py`,
            function: 'cmd_watchdog',
            currentBehavior: 'raises SystemExit(1) whenever result["healthy"] is False, including the successful relaunch case',
            fix: 'Exit 0 when the worker was successfully relaunched (result.get("worker_relaunched",{}).get("restarted") is True). Only exit 1 for genuine failures (API down, Ollama down, stuck worker restart failed).'
          },
          {
            id: 'bug3',
            name: 'API returns score:0.00 for all items',
            file: `${args.projectDir}/src/github_digest/api/app.py`,
            function: '_get_today_items',
            currentBehavior: 'scores_json is fetched (row[6]) but never parsed or included in the returned dict',
            fix: 'Parse scores_json (json.loads if string) and include "score": scores.get("final_score", 0.0) in the items.append({...}) call'
          },
          {
            id: 'bug4',
            name: 'Ranking picks non-builder news content',
            file: `${args.projectDir}/src/github_digest/radar/ranking.py`,
            function: 'compute_buildability_score',
            currentBehavior: 'Non-GitHub items get buildability_score=0.2+0.1=0.3, letting high-viral news dominate',
            fix: 'Set the non-GitHub baseline to 0.0 (zero instead of 0.2) so items without a GitHub URL get buildability_score=0.0. Items WITH GitHub repos keep their 0.5 baseline. This ensures that a purely viral news post (no code) cannot beat a real builder project on final_score.'
          }
        ]
      },
      instructions: [
        'Read each file before editing it.',
        'Apply all 4 fixes one by one.',
        'For bug1: use sudo tee or sudo sed to add KillMode=process to the [Service] section of /etc/systemd/system/github-digest-watchdog.service.',
        'For bug2: in cli.py cmd_watchdog, replace the simple `if not result.get("healthy"): raise SystemExit(1)` with logic that checks for genuine failures vs. successful relaunch.',
        'For bug3: in app.py _get_today_items, after the analysis = json.loads block, add scores parsing from row[6] and include "score" in the items dict.',
        'For bug4: in ranking.py compute_buildability_score, in the else branch (non-GitHub), change the starting score from 0.2 to 0.0.',
        'Do not run tests, do not restart services — just apply the code/config changes.',
        'Return a summary of what was changed in each file.',
      ],
      outputFormat: 'JSON with fields: success (bool), changes (array of {file, description}), error (string or null)'
    },
    outputSchema: {
      type: 'object',
      required: ['success', 'changes'],
      properties: {
        success: { type: 'boolean' },
        changes: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, description: { type: 'string' } } } },
        error: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  }
}));

// ────────────────────────────────────────────────────────────────────────────
// Task 2: Run tests
// ────────────────────────────────────────────────────────────────────────────

const runTestsTask = defineTask('run-tests', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Run pytest to verify no regressions',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer',
      task: 'Run the test suite and verify the fixes did not introduce regressions',
      context: {
        projectDir: args.projectDir,
        previousFixes: args.fixes,
        knownFailure: 'tests/test_phase2.py::test_eligibility_today_board_only — pre-existing failure, ignore it'
      },
      instructions: [
        `cd ${args.projectDir} && source .venv/bin/activate && make test 2>&1`,
        'Capture the output. Count how many tests passed vs failed.',
        'The pre-existing failure test_eligibility_today_board_only is expected and should be ignored.',
        'Any OTHER failures are regressions introduced by the fixes.',
        'Return passed=true only if no new failures beyond the known pre-existing one.',
      ],
      outputFormat: 'JSON with fields: passed (bool), total (int), failed (int), newFailures (array of string test names), output (string summary)'
    },
    outputSchema: {
      type: 'object',
      required: ['passed', 'total'],
      properties: {
        passed: { type: 'boolean' },
        total: { type: 'integer' },
        failed: { type: 'integer' },
        newFailures: { type: 'array', items: { type: 'string' } },
        output: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  }
}));

// ────────────────────────────────────────────────────────────────────────────
// Task 3: Deploy to production
// ────────────────────────────────────────────────────────────────────────────

const deployTask = defineTask('deploy', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Deploy fixes to production and reload systemd',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Linux sysadmin',
      task: 'Deploy code + config fixes to the production environment at /opt/github-digest',
      context: {
        projectDir: args.projectDir,
        productionDir: '/opt/github-digest',
        testResult: args.testResult,
        deploySteps: [
          '1. git add + commit the code fixes (NOT the systemd unit — that was edited directly in /etc/)',
          '2. sudo git -C /opt/github-digest pull origin main',
          '3. sudo -u github-digest /opt/github-digest/.venv/bin/pip install -e /opt/github-digest/ -q',
          '4. sudo systemctl daemon-reload (picks up KillMode=process change)',
          '5. sudo systemctl restart github-digest-api.service',
          '6. Confirm API responds: curl -s http://localhost:8000/health'
        ]
      },
      instructions: [
        'Before committing, run git status to see what files changed.',
        'Commit only the Python source files (cli.py, app.py, ranking.py) — NOT /etc/ files.',
        'Use the standard deploy sequence: git pull to production, pip install, daemon-reload, restart API.',
        'After deploy, confirm the API is healthy.',
        'Return success=true only when API is confirmed healthy after restart.',
      ],
      outputFormat: 'JSON with fields: success (bool), commitHash (string or null), servicesRestarted (array), apiHealthy (bool), error (string or null)'
    },
    outputSchema: {
      type: 'object',
      required: ['success', 'apiHealthy'],
      properties: {
        success: { type: 'boolean' },
        commitHash: { type: 'string' },
        servicesRestarted: { type: 'array', items: { type: 'string' } },
        apiHealthy: { type: 'boolean' },
        error: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  }
}));

// ────────────────────────────────────────────────────────────────────────────
// Task 4: Verify production — watchdog no longer kills worker
// ────────────────────────────────────────────────────────────────────────────

const verifyTask = defineTask('verify', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Verify watchdog relaunches worker and worker stays alive in production',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer / Linux sysadmin',
      task: 'Verify that the 4 bug fixes are working correctly in production',
      context: {
        productionDir: '/opt/github-digest',
        verifications: [
          {
            name: 'KillMode fix: worker stays alive after watchdog exits',
            steps: [
              'Kill any running analyze-worker: kill $(cat /tmp/github-digest-worker-*.pid) 2>/dev/null || true',
              'Wait 2s then manually run: sudo systemctl start github-digest-watchdog.service',
              'Wait 3s then check if a new analyze-worker process is running: ps aux | grep analyze-worker | grep -v grep',
              'The worker MUST still be running after the watchdog service has exited'
            ]
          },
          {
            name: 'Exit code fix: watchdog exits 0 after successful relaunch',
            steps: [
              'Check systemctl status github-digest-watchdog.service',
              'It should show "inactive (dead)" not "failed"',
              'Last exit code should be 0'
            ]
          },
          {
            name: 'API score fix: /api/today returns non-zero scores',
            steps: [
              'curl -s http://localhost:8000/api/today | python3 -m json.tool | grep -i score',
              'Scores should be non-zero decimal numbers'
            ]
          },
          {
            name: 'Ranking fix: confirm buildability_score=0.0 for non-GitHub items in code',
            steps: [
              'grep -A 5 "Non-GitHub" /opt/github-digest/src/github_digest/radar/ranking.py',
              'Should show score = 0.0 not score = 0.2'
            ]
          }
        ]
      },
      instructions: [
        'Perform all 4 verifications in order.',
        'For verification 1, kill any existing workers first, then trigger the watchdog service, wait a few seconds, and check if a worker process is still alive.',
        'For verification 2, check the watchdog service exit status after the trigger in step 1.',
        'For verification 3, curl the API and check score values.',
        'For verification 4, grep the source code.',
        'Report clearly which verifications passed and which failed.',
        'If verification 1 fails (worker still killed), provide the exact systemd service status output.',
      ],
      outputFormat: 'JSON with fields: allPassed (bool), results (array of {name, passed, details}), summary (string)'
    },
    outputSchema: {
      type: 'object',
      required: ['allPassed', 'summary'],
      properties: {
        allPassed: { type: 'boolean' },
        results: { type: 'array' },
        summary: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  }
}));
