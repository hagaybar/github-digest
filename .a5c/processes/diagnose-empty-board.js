/**
 * @process github-digest/diagnose-empty-board
 * @description Diagnose why the GitHub Digest website shows no repos on the board
 * @inputs {}
 * @outputs { rootCauses: string[], fixes: string[], summary: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

/**
 * Diagnose Empty Board Process
 *
 * Investigates why the GitHub Digest website board shows no repositories
 * even though fetch runs are scheduled and appear to execute.
 *
 * Steps:
 * 1. Database diagnostics - check data state, timestamps, filters
 * 2. Scheduler diagnostics - check systemd timers, fetch schedule
 * 3. API diagnostics - verify endpoint behavior
 * 4. Root cause report + fix recommendations
 */
export async function process(inputs, ctx) {

  // ============================================================================
  // PHASE 1: DATABASE DIAGNOSTICS
  // ============================================================================

  const dbDiagnostics = await ctx.task(dbDiagnosticsTask, {
    dbPath: '/home/ubuntu/projects/github-digest/data/github_digest.db',
    projectDir: '/home/ubuntu/projects/github-digest'
  });

  // ============================================================================
  // PHASE 2: SCHEDULER DIAGNOSTICS
  // ============================================================================

  const schedulerDiagnostics = await ctx.task(schedulerDiagnosticsTask, {
    projectDir: '/home/ubuntu/projects/github-digest'
  });

  // ============================================================================
  // PHASE 3: API LIVE TEST
  // ============================================================================

  const apiDiagnostics = await ctx.task(apiDiagnosticsTask, {
    projectDir: '/home/ubuntu/projects/github-digest'
  });

  // ============================================================================
  // PHASE 4: ROOT CAUSE ANALYSIS + FIX REPORT
  // ============================================================================

  const report = await ctx.task(rootCauseReportTask, {
    dbDiagnostics,
    schedulerDiagnostics,
    apiDiagnostics,
    projectDir: '/home/ubuntu/projects/github-digest'
  });

  return {
    rootCauses: report.rootCauses,
    fixes: report.fixes,
    summary: report.summary
  };
}

// ============================================================================
// TASK DEFINITIONS
// ============================================================================

const dbDiagnosticsTask = defineTask('db-diagnostics', (args) => ({
  kind: 'agent',
  title: 'Database Diagnostics',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Database analyst',
      task: 'Run SQL diagnostics on the GitHub Digest SQLite database to understand why the board shows no repos',
      context: {
        dbPath: args.dbPath,
        projectDir: args.projectDir,
        todayUtc: new Date().toISOString().split('T')[0]
      },
      instructions: [
        'Use Bash to run sqlite3 or python3 to query the database at ' + args.dbPath,
        'Check today\'s UTC date vs last_seen_at dates in repo_searches table',
        'Count repos by date(last_seen_at) in repo_searches',
        'Check the _board_new filter: it requires last_seen_at == today (UTC)',
        'Count repos that pass the today filter vs total repos',
        'Check first_seen_at dates in repos table',
        'Check repo_stats_daily table row count and date range',
        'Check runs table for fetch run status and timestamps',
        'Determine if fetch ran today or only on previous days',
        'Report all findings with exact values and timestamps',
      ],
      outputFormat: 'JSON object with: repoCount, statsCount, lastFetchDate, todayDate, reposPassingTodayFilter, reposBoardNew, scheduledSearchDates, rootCauseHypothesis'
    },
    outputSchema: {
      type: 'object',
      required: ['repoCount', 'lastFetchDate', 'todayDate', 'reposPassingTodayFilter', 'rootCauseHypothesis'],
      properties: {
        repoCount: { type: 'number' },
        statsCount: { type: 'number' },
        lastFetchDate: { type: 'string' },
        todayDate: { type: 'string' },
        reposPassingTodayFilter: { type: 'number' },
        reposBoardNew: { type: 'number' },
        scheduledSearchDates: { type: 'array', items: { type: 'string' } },
        rootCauseHypothesis: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/db-diagnostics/input.json`,
    outputJsonPath: `tasks/db-diagnostics/result.json`
  }
}));

const schedulerDiagnosticsTask = defineTask('scheduler-diagnostics', (args) => ({
  kind: 'agent',
  title: 'Scheduler Diagnostics',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Linux systems analyst',
      task: 'Check the fetch scheduler (systemd timers/cron/scripts) to understand if and when fetches run',
      context: {
        projectDir: args.projectDir
      },
      instructions: [
        'Check systemctl list-timers to see if any github-digest timer is scheduled',
        'Check systemctl status for any github-digest service units',
        'Look at deploy/systemd/ directory for service and timer unit files',
        'Check if there are any cron jobs: crontab -l',
        'Check journalctl for github-digest service logs if it exists',
        'Check if the timer has a calendar spec that runs daily or more often',
        'Determine when the next scheduled fetch would run',
        'Check for any fetch-related scripts in the project',
        'Report exact schedule, last run time, and next run time',
      ],
      outputFormat: 'JSON object with: timerExists, timerSchedule, lastTimerRun, nextTimerRun, serviceStatus, cronExists, cronSchedule, schedulerFindings'
    },
    outputSchema: {
      type: 'object',
      required: ['timerExists', 'schedulerFindings'],
      properties: {
        timerExists: { type: 'boolean' },
        timerSchedule: { type: 'string' },
        lastTimerRun: { type: 'string' },
        nextTimerRun: { type: 'string' },
        serviceStatus: { type: 'string' },
        cronExists: { type: 'boolean' },
        cronSchedule: { type: 'string' },
        schedulerFindings: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/scheduler-diagnostics/input.json`,
    outputJsonPath: `tasks/scheduler-diagnostics/result.json`
  }
}));

const apiDiagnosticsTask = defineTask('api-diagnostics', (args) => ({
  kind: 'agent',
  title: 'API Live Test',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'API tester',
      task: 'Test the GitHub Digest API endpoints to see what data is returned and why repos may be absent',
      context: {
        projectDir: args.projectDir
      },
      instructions: [
        'Check if the FastAPI server is running: ps aux | grep uvicorn or curl http://localhost:8000/health',
        'If running, call GET /health to see repo_count and last_fetch',
        'Call GET /board/today?mode=new&window_days=7&limit=10 and capture the response',
        'Call GET /board/today?mode=updated&window_days=30&limit=10 and capture the response',
        'Call GET /board/today?mode=rising&window_days=7&limit=10 and capture the response',
        'Try with larger window_days values (e.g., window_days=30, window_days=90) to see if that helps',
        'Report exact API responses and whether the board array is empty',
        'If server is not running, note that and skip API calls',
      ],
      outputFormat: 'JSON object with: serverRunning, healthResponse, boardNewEmpty, boardUpdatedEmpty, boardRisingEmpty, boardNewCount, apiFindings'
    },
    outputSchema: {
      type: 'object',
      required: ['serverRunning', 'apiFindings'],
      properties: {
        serverRunning: { type: 'boolean' },
        healthResponse: { type: 'object' },
        boardNewEmpty: { type: 'boolean' },
        boardUpdatedEmpty: { type: 'boolean' },
        boardRisingEmpty: { type: 'boolean' },
        boardNewCount: { type: 'number' },
        apiFindings: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/api-diagnostics/input.json`,
    outputJsonPath: `tasks/api-diagnostics/result.json`
  }
}));

const rootCauseReportTask = defineTask('root-cause-report', (args) => ({
  kind: 'agent',
  title: 'Root Cause Analysis Report',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior engineer analyzing a bug',
      task: 'Synthesize all diagnostics into a clear root cause analysis and actionable fix recommendations',
      context: {
        dbDiagnostics: args.dbDiagnostics,
        schedulerDiagnostics: args.schedulerDiagnostics,
        apiDiagnostics: args.apiDiagnostics,
        projectDir: args.projectDir,
        boardFilterLogic: 'The board queries filter repos using: WHERE date(repo_searches.last_seen_at) = today (UTC). If fetch did not run today, all repos fail this filter and the board is empty.',
        knownFacts: 'DB has 37 repos all with last_seen_at from 2026-02-20 (yesterday). Today is 2026-02-21. repo_stats_daily is empty (0 rows). Runs table shows last fetch at 2026-02-20.'
      },
      instructions: [
        'Read the board.py service file to confirm the exact SQL filter logic',
        'Synthesize all diagnostic findings into a clear root cause analysis',
        'List every root cause found (there may be more than one)',
        'For each root cause, provide a specific actionable fix',
        'Consider: is this a code bug (filter too strict), a scheduler problem (not running daily), or both?',
        'Consider the empty repo_stats_daily table as a separate issue for the "rising" mode',
        'Prioritize fixes by impact: which fix would immediately unblock the user?',
        'Write a concise summary that the user can understand without reading all the details',
        'Look at the fetcher.py to understand how last_seen_at is updated and whether it should update on every fetch',
        'Check if there are any window_days settings that could be relaxed as a workaround',
      ],
      outputFormat: 'JSON object with: rootCauses (array of strings), fixes (array of strings with priority), summary (string), immediateWorkaround (string)'
    },
    outputSchema: {
      type: 'object',
      required: ['rootCauses', 'fixes', 'summary'],
      properties: {
        rootCauses: { type: 'array', items: { type: 'string' } },
        fixes: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
        immediateWorkaround: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/root-cause-report/input.json`,
    outputJsonPath: `tasks/root-cause-report/result.json`
  }
}));
