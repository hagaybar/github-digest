/**
 * @process github-digest/diagnose-and-fix-empty-board
 * @description Diagnose and fix why the GitHub Digest website shows no repos on the board,
 *              and why the GitHub Radar /today page also shows no items.
 *              Covers: scheduler check, manual fetch trigger, radar pipeline run, verification.
 * @inputs {}
 * @outputs { rootCauses: string[], fixesApplied: string[], summary: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

export async function process(inputs, ctx) {

  // ============================================================================
  // PHASE 1: COMPREHENSIVE DIAGNOSIS
  // ============================================================================

  const diagnosis = await ctx.task(diagnosisTask, {
    dbPath: '/home/ubuntu/projects/github-digest/data/github_digest.db',
    projectDir: '/home/ubuntu/projects/github-digest'
  });

  // ============================================================================
  // PHASE 2: FIX - RUN FETCH + SUMMARIZE
  // ============================================================================

  const fetchFix = await ctx.task(runFetchTask, {
    projectDir: '/home/ubuntu/projects/github-digest',
    diagnosis
  });

  // ============================================================================
  // PHASE 3: FIX - SCHEDULER DIAGNOSIS + RECOMMENDATION
  // ============================================================================

  const schedulerFix = await ctx.task(schedulerTask, {
    projectDir: '/home/ubuntu/projects/github-digest',
    diagnosis
  });

  // ============================================================================
  // PHASE 4: FIX - GITHUB RADAR PIPELINE
  // ============================================================================

  const radarFix = await ctx.task(radarPipelineTask, {
    projectDir: '/home/ubuntu/projects/github-digest',
    diagnosis
  });

  // ============================================================================
  // PHASE 5: VERIFY ALL FIXES
  // ============================================================================

  const verification = await ctx.task(verifyFixesTask, {
    projectDir: '/home/ubuntu/projects/github-digest',
    fetchFix,
    radarFix
  });

  // ============================================================================
  // PHASE 6: FINAL REPORT
  // ============================================================================

  const report = await ctx.task(finalReportTask, {
    diagnosis,
    fetchFix,
    schedulerFix,
    radarFix,
    verification
  });

  return {
    rootCauses: report.rootCauses,
    fixesApplied: report.fixesApplied,
    summary: report.summary
  };
}

// ============================================================================
// TASK DEFINITIONS
// ============================================================================

const diagnosisTask = defineTask('diagnosis', (args) => ({
  kind: 'agent',
  title: 'Comprehensive Diagnosis',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Systems diagnostician',
      task: 'Diagnose why both the GitHub Digest main board and the GitHub Radar /today page show no data',
      context: {
        dbPath: args.dbPath,
        projectDir: args.projectDir,
        knownFacts: [
          'Server is running at localhost:8000',
          'Health endpoint shows 58 repos, last_fetch=2026-02-21',
          'board/today returns empty arrays for all search categories',
          'Board filter in board.py uses: WHERE date(last_seen_at) == today_utc()',
          'Today is 2026-02-22, all repo_searches rows have last_seen_at=2026-02-21',
          '/api/today returns {"date":"2026-02-22","items":[]} - radar pipeline not run'
        ]
      },
      instructions: [
        'Use sqlite3 CLI or python3 to query the database at ' + args.dbPath,
        'Confirm: SELECT COUNT(*), date(last_seen_at) FROM repo_searches GROUP BY date(last_seen_at)',
        'Confirm: SELECT date("now") to see what SQLite considers today',
        'Check runs table: SELECT status, started_at FROM runs ORDER BY started_at DESC LIMIT 10',
        'Check if radar tables exist: radar_items, daily_picks, hn_story_raw',
        'Count rows in radar tables if they exist',
        'Check daily_picks for today: SELECT * FROM daily_picks WHERE date = date("now") LIMIT 5',
        'Check crontab -l and systemctl list-timers for any github-digest scheduled jobs',
        'Check journalctl -u github-digest-fetch.service --no-pager -n 20 if that service exists',
        'Report all findings with exact numbers and timestamps',
      ],
      outputFormat: 'JSON with: repoCount, lastFetchDate, todayDate, reposPassingFilter, radarTablesExist, radarItemCount, dailyPicksCount, cronJobExists, cronSchedule, timerExists, timerLastRun, rootCauseHypotheses (array of strings)'
    },
    outputSchema: {
      type: 'object',
      required: ['repoCount', 'lastFetchDate', 'todayDate', 'reposPassingFilter', 'rootCauseHypotheses'],
      properties: {
        repoCount: { type: 'number' },
        lastFetchDate: { type: 'string' },
        todayDate: { type: 'string' },
        reposPassingFilter: { type: 'number' },
        radarTablesExist: { type: 'boolean' },
        radarItemCount: { type: 'number' },
        dailyPicksCount: { type: 'number' },
        cronJobExists: { type: 'boolean' },
        cronSchedule: { type: 'string' },
        timerExists: { type: 'boolean' },
        timerLastRun: { type: 'string' },
        rootCauseHypotheses: { type: 'array', items: { type: 'string' } }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/diagnosis/input.json`,
    outputJsonPath: `tasks/diagnosis/result.json`
  }
}));

const runFetchTask = defineTask('run-fetch', (args) => ({
  kind: 'agent',
  title: 'Run Fetch + Summarize to Populate Board',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'DevOps engineer',
      task: 'Run a manual github-digest fetch cycle to update last_seen_at to today so the board shows data',
      context: {
        projectDir: args.projectDir,
        diagnosis: args.diagnosis,
        venvPath: args.projectDir + '/.venv/bin/activate'
      },
      instructions: [
        'cd to ' + args.projectDir,
        'Activate the virtualenv: source .venv/bin/activate',
        'Run: github-digest fetch (this updates last_seen_at to today for all repos)',
        'Wait for the fetch to complete, capture output',
        'After fetch, run: github-digest summarize --dry-run --limit 5 to verify summarizer works',
        'Check DB after fetch: SELECT COUNT(*), date(last_seen_at) FROM repo_searches WHERE date(last_seen_at) = date("now") - confirm repos are now visible',
        'Test the board API: curl http://localhost:8000/board/today?mode=new&window_days=7&limit=5',
        'Report success/failure and exact output',
        'If fetch fails, capture the full error and diagnose why',
      ],
      outputFormat: 'JSON with: fetchSuccess, fetchOutput, reposUpdatedToday, boardNowShowingData, boardSampleItem, error'
    },
    outputSchema: {
      type: 'object',
      required: ['fetchSuccess', 'reposUpdatedToday', 'boardNowShowingData'],
      properties: {
        fetchSuccess: { type: 'boolean' },
        fetchOutput: { type: 'string' },
        reposUpdatedToday: { type: 'number' },
        boardNowShowingData: { type: 'boolean' },
        boardSampleItem: { type: 'string' },
        error: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/run-fetch/input.json`,
    outputJsonPath: `tasks/run-fetch/result.json`
  }
}));

const schedulerTask = defineTask('scheduler-diagnosis', (args) => ({
  kind: 'agent',
  title: 'Scheduler Diagnosis and Fix Recommendations',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Linux systems engineer',
      task: 'Diagnose why the scheduled fetch did not run today and provide concrete fix instructions',
      context: {
        projectDir: args.projectDir,
        diagnosis: args.diagnosis
      },
      instructions: [
        'Check crontab -l for the ubuntu user',
        'Check systemctl list-timers --all | grep -i github for any timers',
        'Check systemctl status github-digest* to see if any service is installed',
        'Look at deploy/systemd/ directory to understand how scheduling is supposed to work',
        'Check if there are any scripts in the project for scheduling (run_daily_pipeline.py, schedule.sh, etc.)',
        'Check if there is a .env or config that shows when jobs should run',
        'If crontab exists but is not running, diagnose: check the cron log at /var/log/syslog or journalctl -u cron',
        'If systemd timer exists but not running, check: systemctl status and journalctl -u <timer-name>',
        'Provide SPECIFIC and ACTIONABLE recommendations to fix the scheduler',
        'If no scheduler is found, provide exact crontab lines to add to run fetch daily at a sensible time (e.g., 6am UTC)',
        'Check if GITHUB_TOKEN env var is set and available to the scheduled process',
      ],
      outputFormat: 'JSON with: cronExists, cronEntries (array), timerExists, timerStatus, lastScheduledRun, schedulerRootCause, recommendedFix (step-by-step instructions as a string), suggestedCrontab (exact crontab lines to add if needed)'
    },
    outputSchema: {
      type: 'object',
      required: ['cronExists', 'timerExists', 'schedulerRootCause', 'recommendedFix'],
      properties: {
        cronExists: { type: 'boolean' },
        cronEntries: { type: 'array', items: { type: 'string' } },
        timerExists: { type: 'boolean' },
        timerStatus: { type: 'string' },
        lastScheduledRun: { type: 'string' },
        schedulerRootCause: { type: 'string' },
        recommendedFix: { type: 'string' },
        suggestedCrontab: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/scheduler-diagnosis/input.json`,
    outputJsonPath: `tasks/scheduler-diagnosis/result.json`
  }
}));

const radarPipelineTask = defineTask('radar-pipeline', (args) => ({
  kind: 'agent',
  title: 'Run GitHub Radar Pipeline',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'DevOps engineer',
      task: 'Run the GitHub Radar daily pipeline to populate /api/today and /today with data',
      context: {
        projectDir: args.projectDir,
        diagnosis: args.diagnosis,
        pipelineScript: args.projectDir + '/run_daily_pipeline.py',
        availableCommands: [
          'github-digest ingest-hn  # ingest HN stories',
          'github-digest rank-daily  # score + pick top 7',
          'github-digest analyze-daily  # LLM analysis (skip if --enable-llm not set)',
          'github-digest pair-daily  # generate pairings',
          'python3 run_daily_pipeline.py --skip-github  # full pipeline without GitHub fetch'
        ]
      },
      instructions: [
        'cd to ' + args.projectDir,
        'Check if run_daily_pipeline.py exists and what arguments it accepts: python3 run_daily_pipeline.py --help',
        'First, check if any radar data already exists for today: SELECT COUNT(*) FROM radar_items; SELECT COUNT(*) FROM daily_picks WHERE date = date("now")',
        'If no radar data for today, run: source .venv/bin/activate && python3 run_daily_pipeline.py --skip-github 2>&1 | tail -50',
        'If the full pipeline fails, try running steps individually:',
        '  1. github-digest ingest-hn',
        '  2. github-digest rank-daily',
        '  3. github-digest pair-daily',
        'After running, check /api/today: curl http://localhost:8000/api/today',
        'Report what was run, success/failure, and what data is now available',
        'Note: LLM analysis requires Ollama which may not be running - that is fine, skip it or use --skip-llm if available',
        'Do NOT run with --enable-llm unless you first verify Ollama is running at localhost:11434',
      ],
      outputFormat: 'JSON with: pipelineRun, pipelineSuccess, stepsRun (array), radarItemsCount, dailyPicksCount, apiTodayResponse, error'
    },
    outputSchema: {
      type: 'object',
      required: ['pipelineRun', 'pipelineSuccess'],
      properties: {
        pipelineRun: { type: 'boolean' },
        pipelineSuccess: { type: 'boolean' },
        stepsRun: { type: 'array', items: { type: 'string' } },
        radarItemsCount: { type: 'number' },
        dailyPicksCount: { type: 'number' },
        apiTodayResponse: { type: 'string' },
        error: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/radar-pipeline/input.json`,
    outputJsonPath: `tasks/radar-pipeline/result.json`
  }
}));

const verifyFixesTask = defineTask('verify-fixes', (args) => ({
  kind: 'agent',
  title: 'Verify All Fixes',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer',
      task: 'Verify that the board and radar are now showing data after the fixes were applied',
      context: {
        projectDir: args.projectDir,
        fetchFix: args.fetchFix,
        radarFix: args.radarFix
      },
      instructions: [
        'Call: curl -s http://localhost:8000/health and capture the response',
        'Call: curl -s "http://localhost:8000/board/today?mode=new&window_days=7&limit=5" and count total items across all categories',
        'Call: curl -s "http://localhost:8000/board/today?mode=updated&window_days=7&limit=5" and count total items',
        'Call: curl -s http://localhost:8000/api/today and count items array length',
        'Call: curl -s http://localhost:8000/api/build and check response',
        'For each endpoint: report if data is present (non-empty) or still empty',
        'Also check the web UI is accessible: curl -s http://localhost:8000/ -I (just check status code)',
        'Report a clear pass/fail for each: mainBoardNew, mainBoardUpdated, radarToday, radarBuild',
      ],
      outputFormat: 'JSON with: mainBoardNewCount, mainBoardUpdatedCount, radarTodayCount, radarBuildCount, healthRepoCount, mainBoardFixed, radarFixed, allFixed'
    },
    outputSchema: {
      type: 'object',
      required: ['mainBoardFixed', 'radarFixed', 'allFixed'],
      properties: {
        mainBoardNewCount: { type: 'number' },
        mainBoardUpdatedCount: { type: 'number' },
        radarTodayCount: { type: 'number' },
        radarBuildCount: { type: 'number' },
        healthRepoCount: { type: 'number' },
        mainBoardFixed: { type: 'boolean' },
        radarFixed: { type: 'boolean' },
        allFixed: { type: 'boolean' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/verify-fixes/input.json`,
    outputJsonPath: `tasks/verify-fixes/result.json`
  }
}));

const finalReportTask = defineTask('final-report', (args) => ({
  kind: 'agent',
  title: 'Final Root Cause Report',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior engineer',
      task: 'Write a clear, user-friendly final report of what was found, what was fixed, and what still needs attention',
      context: {
        diagnosis: args.diagnosis,
        fetchFix: args.fetchFix,
        schedulerFix: args.schedulerFix,
        radarFix: args.radarFix,
        verification: args.verification
      },
      instructions: [
        'Synthesize all the findings into a clear root cause analysis',
        'List every root cause clearly and concisely',
        'List every fix that was applied and whether it worked',
        'Write a concise summary (3-5 sentences) that explains: what was broken, why, what was done to fix it, and what still needs attention (especially the scheduler)',
        'If the scheduler is not set up, include the exact crontab lines to add',
        'If the radar pipeline needs to run daily, include the exact command to add to crontab',
        'Make the summary actionable so the user knows exactly what to do next',
      ],
      outputFormat: 'JSON with: rootCauses (array of strings), fixesApplied (array of strings), pendingActions (array of strings), summary (string)'
    },
    outputSchema: {
      type: 'object',
      required: ['rootCauses', 'fixesApplied', 'summary'],
      properties: {
        rootCauses: { type: 'array', items: { type: 'string' } },
        fixesApplied: { type: 'array', items: { type: 'string' } },
        pendingActions: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/final-report/input.json`,
    outputJsonPath: `tasks/final-report/result.json`
  }
}));
