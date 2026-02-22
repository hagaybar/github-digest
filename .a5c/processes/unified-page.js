/**
 * @process github-digest/unified-page
 * @description Create unified tabbed page integrating GitHub Digest Board + Radar Today's 7 + Build Pairings.
 *              Merges github_radar branch into main, enables LLM, builds unified index.html, runs pipeline.
 * @inputs {}
 * @outputs { success: boolean, tabsWorking: number, summary: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

const PROJECT = '/home/ubuntu/projects/github-digest';

export async function process(inputs, ctx) {

  // ============================================================================
  // PHASE 1: MERGE github_radar → main + enable LLM
  // ============================================================================

  const merge = await ctx.task(mergeRadarBranchTask, { projectDir: PROJECT });

  // ============================================================================
  // PHASE 2: BUILD UNIFIED INDEX.HTML + UPDATE APP.PY
  // ============================================================================

  const buildPage = await ctx.task(buildUnifiedPageTask, { projectDir: PROJECT, merge });

  // ============================================================================
  // PHASE 3: RESTART SERVER + RUN RADAR PIPELINE
  // ============================================================================

  const pipeline = await ctx.task(runPipelineTask, { projectDir: PROJECT, buildPage });

  // ============================================================================
  // PHASE 4: QA — VERIFY ALL TABS SHOW DATA
  // ============================================================================

  const qa = await ctx.task(qaVerifyTask, { projectDir: PROJECT, pipeline });

  // ============================================================================
  // PHASE 5: ITERATIVE REFINEMENT (if QA fails)
  // ============================================================================

  if (!qa.allTabsWorking) {
    const fix = await ctx.task(fixIssuesTask, { projectDir: PROJECT, qa });
    const qa2 = await ctx.task(qaVerifyTask, { projectDir: PROJECT, pipeline: fix });
    return { success: qa2.allTabsWorking, tabsWorking: qa2.tabsWorking, summary: qa2.summary };
  }

  return { success: qa.allTabsWorking, tabsWorking: qa.tabsWorking, summary: qa.summary };
}

// ============================================================================
// TASK DEFINITIONS
// ============================================================================

const mergeRadarBranchTask = defineTask('merge-radar-branch', (args) => ({
  kind: 'agent',
  title: 'Merge github_radar → main + Enable LLM',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Git engineer and DevOps',
      task: 'Merge the github_radar branch into main, preserving the board.py fix, and enable LLM in radar config',
      context: {
        projectDir: args.projectDir,
        currentState: {
          branch: 'main',
          uncommittedChanges: ['src/github_digest/services/board.py (filter fix: last_seen_at >= cutoff)'],
          radarBranch: 'github_radar (2 commits ahead, adds radar module, templates, API routes)',
          mergeBase: '0b708ab (same as HEAD of main — no conflict expected)',
        },
        radarFilesAdded: [
          'src/github_digest/radar/__init__.py',
          'src/github_digest/radar/schemas.py',
          'src/github_digest/radar/hn_ingestion.py',
          'src/github_digest/radar/ranking.py',
          'src/github_digest/radar/card_generator.py',
          'src/github_digest/radar/pairing.py',
          'src/github_digest/web/templates/today.html',
          'src/github_digest/web/templates/build.html',
          'config/radar_config.yaml',
          'run_daily_pipeline.py',
          'PRODUCT.md',
          'schemas/item_v1.md',
        ],
        radarModifiedFiles: [
          'src/github_digest/api/app.py (adds /api/today, /api/build, /today, /build routes)',
          'src/github_digest/db/models.py (adds 5 new ORM models)',
          'src/github_digest/db/migrations.py (adds CREATE TABLE IF NOT EXISTS for new tables)',
          'src/github_digest/cli.py (adds ingest-hn, rank-daily, analyze-daily, pair-daily commands)',
        ]
      },
      instructions: [
        'cd ' + args.projectDir,
        'Step 1: Commit the board.py fix that is currently unstaged:',
        '  git add src/github_digest/services/board.py',
        '  git commit -m "Fix board filter: replace today-gate with window_days cutoff"',
        'Step 2: Merge github_radar into main:',
        '  git merge github_radar --no-edit',
        'Step 3: If there are merge conflicts, resolve them:',
        '  - For app.py: keep ALL content (both existing routes + new radar routes)',
        '  - For models.py: keep ALL content (both existing + new radar models)',
        '  - For cli.py: keep ALL content (both existing + new radar commands)',
        '  - For board.py: keep the window-based cutoff fix (last_seen_at >= cutoff), NOT the old today-gate',
        '  git add <conflicted files> && git commit',
        'Step 4: Enable LLM in radar config:',
        '  Edit config/radar_config.yaml: change "enable_llm: false" to "enable_llm: true"',
        '  git add config/radar_config.yaml && git commit -m "Enable LLM analysis in radar config"',
        'Step 5: Verify the merge result:',
        '  git log --oneline -5',
        '  ls src/github_digest/radar/',
        '  grep "enable_llm" config/radar_config.yaml',
        '  python3 -c "from github_digest.radar.schemas import ItemV1; print(\'schemas ok\')" 2>&1',
        'Report: was merge clean? any conflicts? LLM enabled? imports working?',
      ],
      outputFormat: 'JSON with: mergeSuccess, conflictsResolved (array of files), llmEnabled, importsWorking, commitHash, error'
    },
    outputSchema: {
      type: 'object',
      required: ['mergeSuccess', 'llmEnabled'],
      properties: {
        mergeSuccess: { type: 'boolean' },
        conflictsResolved: { type: 'array', items: { type: 'string' } },
        llmEnabled: { type: 'boolean' },
        importsWorking: { type: 'boolean' },
        commitHash: { type: 'string' },
        error: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/merge-radar-branch/input.json`,
    outputJsonPath: `tasks/merge-radar-branch/result.json`
  }
}));

const buildUnifiedPageTask = defineTask('build-unified-page', (args) => ({
  kind: 'agent',
  title: 'Build Unified Tabbed Page',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Full-stack web developer',
      task: 'Create a unified single-page app with three tabs: Digest Board, Today\'s 7, and Build Pairings. Replace the existing index.html and update app.py.',
      context: {
        projectDir: args.projectDir,
        existingFiles: {
          indexHtml: 'src/github_digest/web/templates/index.html (322 lines — digest board)',
          todayHtml: 'src/github_digest/web/templates/today.html (100 lines — 7 curated picks)',
          buildHtml: 'src/github_digest/web/templates/build.html (79 lines — pairings)',
          appPy: 'src/github_digest/api/app.py',
        },
        designSystem: {
          colors: 'bg: #f7f4ef, border: #eadfcd, accent: #b8884a, text: #3d2b1a, muted: #8a6a50',
          fonts: 'Iowan Old Style, serif for headings; system-ui for body',
          style: 'warm earth tones, serif typography, card-based grid layout',
        },
        tabStructure: {
          tab1: { id: 'digest', label: 'Digest Board', api: '/board/today?mode={mode}&window_days={days}&limit={limit}' },
          tab2: { id: 'today', label: "Today's 7", api: '/api/today?date={date}' },
          tab3: { id: 'build', label: 'Build Pairings', api: '/api/build?date={date}' },
        },
        digestBoardData: 'response: { date, mode, window_days, board: { "Search Name": [ { full_name, html_url, stars, language, forks, delta, pushed_at, star_history[], description, summary, why_interesting, latest_release_tag, latest_release_summary, tags[] } ] } }',
        radarTodayData: 'response: { date, items: [ { id, source, url, title, github_full_name, signals: { github_stars_total, github_stars_7d, hn_points }, analysis: { unlock, novelty, why_cool[], best_start, build_ideas: [ { size, idea } ], confidence }, rank } ] }',
        radarBuildData: 'response: { date, pairings: [ { rank, rationale, item_a: ItemV1, item_b: ItemV1 } ] }',
      },
      instructions: [
        'Read the existing files first:',
        '  - Read src/github_digest/web/templates/index.html (full file)',
        '  - Read src/github_digest/web/templates/today.html (full file)',
        '  - Read src/github_digest/web/templates/build.html (full file)',
        '  - Read src/github_digest/api/app.py (to understand current routes)',

        'Create a new UNIFIED src/github_digest/web/templates/index.html with THREE TABS:',

        'TAB 1 - DIGEST BOARD (preserve ALL existing index.html functionality):',
        '  - Mode selector: new / rising / updated',
        '  - Timeframe selector: 24h / 7d / 30d',
        '  - Tag filter pills (click to filter)',
        '  - Category sections with repo cards',
        '  - Each repo card: title+link, stars, language, forks, delta, push date, sparkline, summary, tags',
        '  - Keep exact same card layout, colors, sparkline rendering logic',

        'TAB 2 - TODAY\'S 7 (adapt today.html content into a tab panel):',
        '  - Show 7 curated picks for today (from /api/today)',
        '  - Each card: source badge (github/hackernews), title+link, rank number',
        '  - If analysis exists: unlock (one-liner), novelty, why_cool bullets, best_start, build_ideas with sizes (small/medium/spicy)',
        '  - If no analysis yet: show "Analysis pending" placeholder',
        '  - Show signals: HN points (if any), GitHub stars (if any)',
        '  - If /api/today returns empty items: show "No picks yet for today — run the radar pipeline"',

        'TAB 3 - BUILD PAIRINGS (adapt build.html content into a tab panel):',
        '  - Show complementary tool pairings from /api/build',
        '  - Each pairing card: two items side by side with "+" between them',
        '  - Show rationale text explaining why they work together',
        '  - Each item: title, source badge, unlock line',
        '  - If empty: show "No pairings yet for today — run the radar pipeline"',

        'UNIFIED HEADER (shared across all tabs):',
        '  - App title: "GitHub Digest & Builder Radar"',
        '  - Tab nav: [Digest Board] [Today\'s 7] [Build Pairings]',
        '  - Active tab highlighted with accent color',
        '  - Tab switching via URL hash (#digest, #today, #build)',
        '  - On page load, read hash to activate correct tab (default to #digest)',

        'STYLING REQUIREMENTS:',
        '  - Keep all existing CSS from index.html for the digest board tab',
        '  - Add tab nav styles consistent with earth tone design',
        '  - Radar cards should match the warm earth-tone card style',
        '  - Source badges: small colored chips (github=dark, hackernews=orange)',
        '  - Build idea size badges: small=green, medium=blue, spicy=red/orange',
        '  - Responsive: single column on mobile, grid on desktop',

        'JAVASCRIPT REQUIREMENTS:',
        '  - Keep ALL existing digest board JS (fetchBoard, renderBoard, sparklines, tag filtering, etc)',
        '  - Add fetchToday() for /api/today, fetchBuild() for /api/build',
        '  - Tab switching: show/hide tab panels, update URL hash, lazy-load on first tab visit',
        '  - Each tab loads data independently when first activated',

        'After creating unified index.html, UPDATE src/github_digest/api/app.py:',
        '  - The "/" route already returns index.html — keep it as-is',
        '  - The "/today" route should redirect to "/#today" (or still render the old today.html for backwards compat — your choice, but unified page is the primary experience)',
        '  - The "/build" route similar treatment',
        '  - Keep ALL existing routes unchanged',

        'Write the complete unified index.html file (replace the existing one)',
        'Make minimal changes to app.py (just ensure / serves the unified page)',
        'Report: files created/modified, line counts, any issues',
      ],
      outputFormat: 'JSON with: filesModified (array), indexHtmlLines, appPyChanged, issues (array), implementationNotes'
    },
    outputSchema: {
      type: 'object',
      required: ['filesModified', 'indexHtmlLines'],
      properties: {
        filesModified: { type: 'array', items: { type: 'string' } },
        indexHtmlLines: { type: 'number' },
        appPyChanged: { type: 'boolean' },
        issues: { type: 'array', items: { type: 'string' } },
        implementationNotes: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/build-unified-page/input.json`,
    outputJsonPath: `tasks/build-unified-page/result.json`
  }
}));

const runPipelineTask = defineTask('run-pipeline', (args) => ({
  kind: 'agent',
  title: 'Restart Server + Run Radar Pipeline',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'DevOps engineer',
      task: 'Restart the server to pick up new code, then run the full radar pipeline to generate today\'s data with LLM analysis',
      context: {
        projectDir: args.projectDir,
        buildPage: args.buildPage,
        ollamaStatus: 'running at localhost:11434 with llama3.2:latest',
        llmEnabled: 'enable_llm: true in config/radar_config.yaml',
        pipeline: 'python3 run_daily_pipeline.py --skip-github --enable-llm',
      },
      instructions: [
        'Step 1: Restart the server',
        '  - Check if uvicorn is running: ps aux | grep uvicorn | grep -v grep',
        '  - If it is running as a systemd service: sudo systemctl restart github-digest.service',
        '  - If running as a direct process: kill the process and restart:',
        '    pkill -f "github-digest serve" || pkill -f "uvicorn.*github_digest"',
        '    sleep 1',
        '    nohup /home/ubuntu/projects/github-digest/.venv/bin/github-digest serve > /tmp/github-digest.log 2>&1 &',
        '  - Wait 3 seconds: sleep 3',
        '  - Verify server is up: curl -s http://localhost:8000/health',

        'Step 2: Run the radar pipeline',
        '  cd ' + args.projectDir,
        '  source .venv/bin/activate',
        '  python3 run_daily_pipeline.py --skip-github --enable-llm 2>&1 | tail -50',
        '  (This runs: ingest-hn → rank-daily → analyze-daily with LLM → pair-daily)',
        '  Note: LLM analysis may take 2-5 minutes per item (7 items total)',
        '  If --enable-llm flag does not exist, try: python3 run_daily_pipeline.py --skip-github',
        '  Then run: github-digest analyze-daily separately (check if --enable-llm is a CLI flag)',

        'Step 3: Check database after pipeline',
        '  python3 -c "',
        '  import sqlite3',
        '  conn = sqlite3.connect(\'data/github_digest.db\')',
        '  cur = conn.cursor()',
        '  cur.execute(\'SELECT date, COUNT(*) FROM daily_picks GROUP BY date ORDER BY date DESC LIMIT 3\')',
        '  print(\'daily_picks:\', cur.fetchall())',
        '  cur.execute(\'SELECT COUNT(*) FROM radar_item_analysis\')',
        '  print(\'analyses:\', cur.fetchone())',
        '  cur.execute(\'SELECT COUNT(*) FROM daily_pairings\')',
        '  print(\'pairings:\', cur.fetchone())',
        '  "',

        'Step 4: Test the API endpoints',
        '  curl -s http://localhost:8000/api/today | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\'items: {len(d.get(chr(105)+chr(116)+chr(101)+chr(109)+chr(115),[]))}, first: {d.get(chr(105)+chr(116)+chr(101)+chr(109)+chr(115),[{}])[0].get(chr(116)+chr(105)+chr(116)+chr(108)+chr(101),\'\") if d.get(chr(105)+chr(116)+chr(101)+chr(109)+chr(115)) else chr(110)+chr(111)+chr(110)+chr(101)}"',
        '  Simpler: curl -s http://localhost:8000/api/today > /tmp/api_today.json && python3 -c "import json; d=json.load(open(\'/tmp/api_today.json\')); items=d.get(\'items\',[]); print(f\'items count: {len(items)}\'); print([i.get(\'title\',\'\')[:40] for i in items[:3]])"',
        '  curl -s http://localhost:8000/api/build > /tmp/api_build.json && python3 -c "import json; d=json.load(open(\'/tmp/api_build.json\')); p=d.get(\'pairings\',[]); print(f\'pairings: {len(p)}\')"',

        'Report: server restarted, pipeline steps run, items with LLM analysis count, API responses',
      ],
      outputFormat: 'JSON with: serverRestarted, pipelineRun, pipelineSteps (array), dailyPicksCount, analysisCount, pairingsCount, apiTodayCount, apiBuildCount, llmAnalysisWorked, error'
    },
    outputSchema: {
      type: 'object',
      required: ['serverRestarted', 'pipelineRun', 'dailyPicksCount'],
      properties: {
        serverRestarted: { type: 'boolean' },
        pipelineRun: { type: 'boolean' },
        pipelineSteps: { type: 'array', items: { type: 'string' } },
        dailyPicksCount: { type: 'number' },
        analysisCount: { type: 'number' },
        pairingsCount: { type: 'number' },
        apiTodayCount: { type: 'number' },
        apiBuildCount: { type: 'number' },
        llmAnalysisWorked: { type: 'boolean' },
        error: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/run-pipeline/input.json`,
    outputJsonPath: `tasks/run-pipeline/result.json`
  }
}));

const qaVerifyTask = defineTask('qa-verify', (args, taskCtx) => ({
  kind: 'agent',
  title: 'QA — Verify All Tabs',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer',
      task: 'Verify the unified page works correctly: server responds, all three tabs have data, HTML structure is correct',
      context: {
        projectDir: args.projectDir,
        pipeline: args.pipeline,
        effectId: taskCtx.effectId,
      },
      instructions: [
        'Step 1: Check server health',
        '  curl -s http://localhost:8000/health',

        'Step 2: Verify unified page HTML structure',
        '  curl -s http://localhost:8000/ | grep -c "tab" (should find tab-related elements)',
        '  curl -s http://localhost:8000/ | grep -E "digest|today|build" | head -10',
        '  Check the HTML has: tab navigation, three tab panels, correct IDs',

        'Step 3: Verify Digest Board tab data',
        '  curl -s "http://localhost:8000/board/today?mode=new&window_days=7&limit=5"',
        '  Count total items across all categories',

        'Step 4: Verify Today\'s 7 tab data',
        '  curl -s http://localhost:8000/api/today > /tmp/today.json',
        '  python3 -c "import json; d=json.load(open(\'/tmp/today.json\')); items=d.get(\'items\',[]); print(f\'count: {len(items)}\'); [print(f\'  #{i.get(chr(114)+chr(97)+chr(110)+chr(107))}: {i.get(chr(116)+chr(105)+chr(116)+chr(108)+chr(101),\'\")[:50]}, analysis: {bool(i.get(chr(97)+chr(110)+chr(97)+chr(108)+chr(121)+chr(115)+chr(105)+chr(115)))}\') for i in items]"',
        '  Simpler: python3 -c "import json,sys; items=json.load(open(\'/tmp/today.json\')).get(\'items\',[]); [print(i.get(\'title\',\'\')[:50], \'analysis:\', bool(i.get(\'analysis\'))) for i in items]"',

        'Step 5: Verify Build Pairings tab data',
        '  curl -s http://localhost:8000/api/build > /tmp/build.json',
        '  python3 -c "import json; d=json.load(open(\'/tmp/build.json\')); print(f\'pairings: {len(d.get(chr(112)+chr(97)+chr(105)+chr(114)+chr(105)+chr(110)+chr(103)+chr(115),[]))}\') "',
        '  Simpler: python3 -c "import json; d=json.load(open(\'/tmp/build.json\')); print(\'pairings:\', len(d.get(\'pairings\', [])))"',

        'Step 6: Check the HTML file was actually updated',
        '  grep -c "tab" ' + args.projectDir + '/src/github_digest/web/templates/index.html',
        '  grep -E "Today.s 7|Build Pair|Digest Board" ' + args.projectDir + '/src/github_digest/web/templates/index.html | head -5',

        'Step 7: Check for any JavaScript errors by examining the HTML for common issues',
        '  grep -n "fetchBoard\|fetchToday\|fetchBuild" ' + args.projectDir + '/src/github_digest/web/templates/index.html | head -10',

        'Determine: digestBoardWorking (>0 items), todayWorking (>0 items), buildWorking (>0 pairings), htmlHasTabs',
        'tabsWorking = count of tabs that are working (0-3)',
      ],
      outputFormat: 'JSON with: healthOk, htmlHasTabs, digestBoardItemCount, todayItemCount, todayItemsHaveAnalysis, buildPairingsCount, digestBoardWorking, todayWorking, buildWorking, allTabsWorking, tabsWorking, issues (array), summary'
    },
    outputSchema: {
      type: 'object',
      required: ['allTabsWorking', 'tabsWorking', 'digestBoardWorking', 'todayWorking', 'buildWorking'],
      properties: {
        healthOk: { type: 'boolean' },
        htmlHasTabs: { type: 'boolean' },
        digestBoardItemCount: { type: 'number' },
        todayItemCount: { type: 'number' },
        todayItemsHaveAnalysis: { type: 'boolean' },
        buildPairingsCount: { type: 'number' },
        digestBoardWorking: { type: 'boolean' },
        todayWorking: { type: 'boolean' },
        buildWorking: { type: 'boolean' },
        allTabsWorking: { type: 'boolean' },
        tabsWorking: { type: 'number' },
        issues: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  }
}));

const fixIssuesTask = defineTask('fix-issues', (args) => ({
  kind: 'agent',
  title: 'Fix QA Issues',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Full-stack developer debugging issues',
      task: 'Fix any issues found during QA verification of the unified page',
      context: {
        projectDir: args.projectDir,
        qa: args.qa,
      },
      instructions: [
        'Review the QA issues: ' + JSON.stringify(args.qa?.issues || []),
        'For each issue, diagnose and fix:',

        'If HTML does not have tabs (htmlHasTabs=false):',
        '  - Read the current index.html',
        '  - If it still looks like the old digest-only page, the unified page was not written correctly',
        '  - Rewrite it with the three-tab structure as described in the build-unified-page task',

        'If /api/today is empty (todayWorking=false):',
        '  - Check if daily_picks exist: python3 -c "import sqlite3; c=sqlite3.connect(\'data/github_digest.db\').cursor(); c.execute(\'SELECT date, COUNT(*) FROM daily_picks GROUP BY date ORDER BY date DESC\'); print(c.fetchall())"',
        '  - If no data: re-run pipeline: cd ' + args.projectDir + ' && source .venv/bin/activate && python3 run_daily_pipeline.py --skip-github',
        '  - Check /api/today route exists in app.py: grep -n "api/today" src/github_digest/api/app.py',

        'If /api/build is empty (buildWorking=false):',
        '  - Check daily_pairings: python3 -c "import sqlite3; c=sqlite3.connect(\'data/github_digest.db\').cursor(); c.execute(\'SELECT COUNT(*) FROM daily_pairings\'); print(c.fetchone())"',
        '  - Re-run pair step: github-digest pair-daily',

        'If digest board not working (digestBoardWorking=false):',
        '  - Run: github-digest fetch',
        '  - Check board API: curl http://localhost:8000/board/today?mode=new&window_days=7&limit=5',

        'After fixes, restart server if code changed:',
        '  pkill -f "github-digest serve" || true',
        '  sleep 1',
        '  nohup /home/ubuntu/projects/github-digest/.venv/bin/github-digest serve > /tmp/github-digest.log 2>&1 &',
        '  sleep 3',

        'Report all fixes applied',
      ],
      outputFormat: 'JSON with: fixesApplied (array), serverRestarted, pipelineReRun, error'
    },
    outputSchema: {
      type: 'object',
      required: ['fixesApplied'],
      properties: {
        fixesApplied: { type: 'array', items: { type: 'string' } },
        serverRestarted: { type: 'boolean' },
        pipelineReRun: { type: 'boolean' },
        error: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/fix-issues/input.json`,
    outputJsonPath: `tasks/fix-issues/result.json`
  }
}));
