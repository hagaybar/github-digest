/**
 * @process github-digest/fix-webserver-db-path
 * @description Fix the GitHub Digest web server to use the production /opt database,
 *              install the proper systemd serve unit, backfill stats for rising mode,
 *              and verify everything works end-to-end.
 * @inputs {}
 * @outputs { success: boolean, boardNewCount: number, boardRisingCount: number, summary: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

export async function process(inputs, ctx) {

  // ============================================================================
  // STEP 1: Stop dev server and install production systemd web service
  // ============================================================================

  const installResult = await ctx.task(installServeDaemonTask, {
    projectDir: '/home/ubuntu/projects/github-digest',
    optDir: '/opt/github-digest',
  });

  // ============================================================================
  // STEP 2: Backfill repo_stats_daily for rising mode baseline
  // ============================================================================

  const backfillResult = await ctx.task(backfillStatsTask, {
    optDbPath: '/opt/github-digest/data/github_digest.db',
    windowDays: 7,
  });

  // ============================================================================
  // STEP 3: End-to-end verification — confirm board shows repos
  // ============================================================================

  const verifyResult = await ctx.task(verifyBoardTask, {
    apiBase: 'http://localhost:8000',
    optDbPath: '/opt/github-digest/data/github_digest.db',
  });

  return {
    success: verifyResult.boardWorking,
    boardNewCount: verifyResult.boardNewCount,
    boardRisingCount: verifyResult.boardRisingCount,
    summary: verifyResult.summary,
  };
}

// ============================================================================
// TASK: Install production systemd serve unit and switch from dev server
// ============================================================================

const installServeDaemonTask = defineTask('install-serve-daemon', (args) => ({
  kind: 'agent',
  title: 'Install production web server systemd unit',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Linux systems engineer',
      task: 'Stop the dev web server and install the production github-digest-serve.service systemd unit so the website reads from the correct /opt/github-digest database',
      context: {
        projectDir: args.projectDir,
        optDir: args.optDir,
        unitFile: `${args.projectDir}/deploy/systemd/github-digest-serve.service`,
        installDir: '/etc/systemd/system',
        problem: 'Current uvicorn server runs from /home/ubuntu/projects/github-digest and reads wrong database. We need it running from /opt/github-digest to read the active fetch database.',
      },
      instructions: [
        'First check which process is listening on port 8000: sudo ss -tlnp | grep 8000 or sudo lsof -i :8000',
        'Find the PID of the current uvicorn/github-digest serve process running from the dev directory',
        'Kill the current server process gracefully: sudo kill <PID> (use SIGTERM first)',
        'Wait 2 seconds and verify it stopped: sudo ss -tlnp | grep 8000',
        'If still running, use sudo kill -9 <PID>',
        'Read the github-digest-serve.service unit file to confirm it uses WorkingDirectory=/opt/github-digest',
        'Copy it to /etc/systemd/system/: sudo cp /home/ubuntu/projects/github-digest/deploy/systemd/github-digest-serve.service /etc/systemd/system/github-digest-serve.service',
        'Run: sudo systemctl daemon-reload',
        'Run: sudo systemctl enable github-digest-serve.service',
        'Run: sudo systemctl start github-digest-serve.service',
        'Wait 3 seconds for startup',
        'Check status: sudo systemctl status github-digest-serve.service',
        'Verify the new server is listening: curl -s http://localhost:8000/health',
        'Report: old PID killed, new service started, health check response',
      ],
      outputFormat: 'JSON object with: oldPidKilled, serviceInstalled, serviceRunning, healthCheckResponse, findings',
    },
    outputSchema: {
      type: 'object',
      required: ['serviceInstalled', 'serviceRunning', 'findings'],
      properties: {
        oldPidKilled: { type: 'boolean' },
        serviceInstalled: { type: 'boolean' },
        serviceRunning: { type: 'boolean' },
        healthCheckResponse: { type: 'object' },
        findings: { type: 'string' },
      },
    },
  },
  io: {
    inputJsonPath: `tasks/install-serve-daemon/input.json`,
    outputJsonPath: `tasks/install-serve-daemon/result.json`,
  },
}));

// ============================================================================
// TASK: Backfill repo_stats_daily for rising mode
// ============================================================================

const backfillStatsTask = defineTask('backfill-stats', (args) => ({
  kind: 'agent',
  title: 'Backfill historical stats for rising mode',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Database engineer',
      task: 'Backfill the repo_stats_daily table with a historical baseline row so the rising board mode works with default window_days=7',
      context: {
        optDbPath: args.optDbPath,
        windowDays: args.windowDays,
        problem: 'The _board_rising query in board.py does an INNER JOIN requiring a baseline stats row where date <= (today - window_days). Since the app only started 2 days ago, there are no rows from 7 days ago. We need to insert a synthetic baseline row dated 7+ days ago for rising mode to work.',
        boardRisingQuery: 'Requires: stats_today row (date = today) AND stats_baseline row (date <= today - 7 days). Delta = stats_today.stars - stats_baseline.stars.',
      },
      instructions: [
        'Check the current state of repo_stats_daily using: sudo python3 -c "import sqlite3; conn=sqlite3.connect(\'/opt/github-digest/data/github_digest.db\'); cur=conn.cursor(); cur.execute(\'SELECT date, COUNT(*) FROM repo_stats_daily GROUP BY date ORDER BY date\'); print(cur.fetchall()); conn.close()"',
        'Calculate what date is 8 days before today (to be safely before window_days=7 cutoff)',
        'Check if any rows already exist for a date <= today - 7 days',
        'If no baseline rows exist, insert them: copy stars/forks/open_issues from the earliest available stats date for each repo, but set the date to (today - 8 days)',
        'Run this SQL using sudo python3 with sqlite3 on /opt/github-digest/data/github_digest.db:',
        '  First: find the earliest available stats date',
        '  Then: INSERT OR IGNORE INTO repo_stats_daily (repo_id, date, stars, forks, open_issues) SELECT repo_id, date(\'now\',\'-8 days\'), stars, forks, open_issues FROM repo_stats_daily WHERE date = (SELECT MIN(date) FROM repo_stats_daily)',
        'Verify the insert: count rows by date after the insert',
        'Report: rows inserted, dates now available, whether rising mode baseline exists',
      ],
      outputFormat: 'JSON object with: baselineExisted, rowsInserted, statsDateRange, risingModeReady, findings',
    },
    outputSchema: {
      type: 'object',
      required: ['rowsInserted', 'risingModeReady', 'findings'],
      properties: {
        baselineExisted: { type: 'boolean' },
        rowsInserted: { type: 'number' },
        statsDateRange: { type: 'array', items: { type: 'string' } },
        risingModeReady: { type: 'boolean' },
        findings: { type: 'string' },
      },
    },
  },
  io: {
    inputJsonPath: `tasks/backfill-stats/input.json`,
    outputJsonPath: `tasks/backfill-stats/result.json`,
  },
}));

// ============================================================================
// TASK: End-to-end verification
// ============================================================================

const verifyBoardTask = defineTask('verify-board', (args) => ({
  kind: 'agent',
  title: 'Verify board shows repos end-to-end',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer verifying the fix',
      task: 'Verify the GitHub Digest website now correctly displays repos in all board modes',
      context: {
        apiBase: args.apiBase,
        optDbPath: args.optDbPath,
      },
      instructions: [
        'Check the service is running: sudo systemctl is-active github-digest-serve.service',
        'Call GET http://localhost:8000/health and capture last_fetch — it should now reflect todays date',
        'Call GET http://localhost:8000/board/today?mode=new&window_days=7&limit=10 and count total repos returned across all query labels',
        'Call GET http://localhost:8000/board/today?mode=updated&window_days=30&limit=10 and count repos returned',
        'Call GET http://localhost:8000/board/today?mode=rising&window_days=7&limit=10 and count repos returned',
        'If board/today?mode=new still returns empty, try window_days=14 and window_days=30',
        'Check the database the service is using: sudo python3 -c "import sqlite3; conn=sqlite3.connect(\'/opt/github-digest/data/github_digest.db\'); cur=conn.cursor(); cur.execute(\'SELECT date(last_seen_at), COUNT(*) FROM repo_searches GROUP BY date(last_seen_at)\'); print(cur.fetchall()); conn.close()"',
        'Report exact counts for each mode, and whether repos are visible on the board',
        'Report any errors or empty modes with explanation',
      ],
      outputFormat: 'JSON object with: serviceActive, healthLastFetch, boardNewCount, boardUpdatedCount, boardRisingCount, boardWorking, summary',
    },
    outputSchema: {
      type: 'object',
      required: ['boardWorking', 'boardNewCount', 'summary'],
      properties: {
        serviceActive: { type: 'boolean' },
        healthLastFetch: { type: 'string' },
        boardNewCount: { type: 'number' },
        boardUpdatedCount: { type: 'number' },
        boardRisingCount: { type: 'number' },
        boardWorking: { type: 'boolean' },
        summary: { type: 'string' },
      },
    },
  },
  io: {
    inputJsonPath: `tasks/verify-board/input.json`,
    outputJsonPath: `tasks/verify-board/result.json`,
  },
}));
