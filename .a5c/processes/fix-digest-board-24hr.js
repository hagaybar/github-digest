/**
 * @process github-digest/fix-digest-board-24hr
 * @description Fix why the digest board 24hr "new" window only shows 2 repos (both LLMs & RAG).
 *
 * Root causes identified from DB investigation:
 *
 *   Root Cause 1 (MAIN): saved_searches.json has limit=5 per query.
 *     The fetcher always returns the top-5 most-starred repos (sort=stars desc).
 *     These are already in the DB, so repos.first_seen_at never advances beyond 2026-02-23.
 *     The _board_new() query shows repos with first_seen_at >= (max_first_seen - window_days).
 *     max_first_seen = 2026-02-23 → only 2 repos pass the 24hr cutoff.
 *
 *   Root Cause 2 (SECONDARY): No pagination / sort variety.
 *     All queries use sort=stars&order=desc and fetch only 1 page.
 *     The same repos are fetched every time. Discovery stalls.
 *
 *   Root Cause 3 (MINOR): stale 'rag' query in DB (10 rows, last_seen_at 2026-02-21).
 *     The 'rag' saved search was merged into 'llm' (label: "LLM & RAG") but the old
 *     DB rows remain. They get excluded by the cutoff_last_seen filter so they don't
 *     pollute results, but they represent dead weight.
 *
 * Fix Plan:
 *   Phase 1: Increase limit from 5 → 50 in saved_searches.json for all searches.
 *            This causes the fetcher to pull deeper into GitHub search results on the
 *            next fetch cycle, discovering repos not previously seen.
 *   Phase 2: Add a "sort by recently updated" variant for each search so the "New" board
 *            surfaces recently-active repos, not just star-count-sorted ones.
 *            OR alternatively: add additional queries with a tighter created date filter
 *            (e.g. created:>2025-01-01) to surface brand-new repos.
 *   Phase 3: Run a manual fetch to immediately populate new repos.
 *   Phase 4: Deploy to production and verify the board shows >2 repos in 24hr window.
 *
 * @inputs {}
 * @outputs { fixed: boolean, reposDiscovered: number, boardItemCount: number, summary: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

const PROJECT_DIR = '/home/ubuntu/projects/github-digest';
const PROD_DIR = '/opt/github-digest';

export async function process(inputs, ctx) {

  // ============================================================================
  // PHASE 1: Deep-dive diagnosis — confirm root cause numbers
  // ============================================================================

  const diagnosis = await ctx.task(diagnosisTask, { projectDir: PROJECT_DIR });

  // ============================================================================
  // PHASE 2: Fix saved_searches.json — increase limits + add discovery queries
  // ============================================================================

  const fix = await ctx.task(fixSearchesTask, { projectDir: PROJECT_DIR, diagnosis });

  // ============================================================================
  // PHASE 3: Run fetch to discover new repos
  // ============================================================================

  const fetch = await ctx.task(runFetchTask, { projectDir: PROJECT_DIR, fix });

  // ============================================================================
  // PHASE 4: Deploy to production
  // ============================================================================

  const deploy = await ctx.task(deployTask, { projectDir: PROJECT_DIR, prodDir: PROD_DIR, fetchResult: fetch });

  // ============================================================================
  // PHASE 5: Verify board shows more items
  // ============================================================================

  const verify = await ctx.task(verifyTask, { prodDir: PROD_DIR, deployResult: deploy });

  return {
    fixed: verify.boardFixed,
    reposDiscovered: fetch.newReposDiscovered,
    boardItemCount: verify.boardItemCount,
    summary: verify.summary,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Task 1: Confirm root cause
// ──────────────────────────────────────────────────────────────────────────────

const diagnosisTask = defineTask('diagnosis', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Confirm root cause: limit=5, same repos, max_first_seen stale',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Data engineer / diagnostician',
      task: 'Confirm the root cause of why the digest board "new 24hr" window shows only 2 repos',
      context: {
        projectDir: args.projectDir,
        prodDb: '/opt/github-digest/data/github_digest.db',
        knownFindings: [
          'Production DB has 60 repos total',
          'max first_seen_at = 2026-02-23 06:00 (5 days stale)',
          'Only 2 repos have first_seen_at within 1 day of that anchor',
          'All queries (llm, information-retrieval, data-engineering, academic) run daily at 08:00',
          'Fetcher processes 24 repos per run (5 * 4 searches + some multi-query searches)',
          'saved_searches.json has limit=5 for most searches',
          'Queries use sort=stars&order=desc — always returning same top repos',
          'rag query in DB has 10 rows last_seen 2026-02-21 but NOT in config (merged into llm)'
        ]
      },
      instructions: [
        'Query the production DB at /opt/github-digest/data/github_digest.db using python3 + sqlite3',
        'Confirm: SELECT full_name, first_seen_at FROM repos ORDER BY first_seen_at DESC LIMIT 10',
        'Confirm: SELECT query_name, COUNT(*), MAX(last_seen_at), MIN(first_seen_at) FROM repo_searches JOIN repos ON repos.id = repo_searches.repo_id GROUP BY query_name',
        'Check: how many total UNIQUE repos are there? how many are "new" (first_seen_at within 1 day of max_first_seen)?',
        'Check saved_searches.json at /opt/github-digest/config/saved_searches.json to confirm limit values',
        'Run: curl -s "http://localhost:8000/board/today?mode=new&window_days=1&limit=10" | python3 -m json.tool to see current board state',
        'Read the fetcher code at /opt/github-digest/src/github_digest/services/fetcher.py to understand how limit is used (per_page param)',
        'Confirm hypothesis: the fetcher sorts by stars desc and fetches limit=5 per query — always gets same repos — first_seen_at never advances',
        'Also check: does the fetcher use multiple pages? Or just page=1?',
        'Report all findings with exact numbers',
      ],
      outputFormat: 'JSON with: confirmedRootCause (string), totalRepos (number), newReposIn24hr (number), fetcherPageCount (number), savedSearchLimits (object mapping name to limit), staleness (string describing max_first_seen age), additionalFindings (array of strings)'
    },
    outputSchema: {
      type: 'object',
      required: ['confirmedRootCause', 'totalRepos', 'newReposIn24hr', 'savedSearchLimits'],
      properties: {
        confirmedRootCause: { type: 'string' },
        totalRepos: { type: 'number' },
        newReposIn24hr: { type: 'number' },
        fetcherPageCount: { type: 'number' },
        savedSearchLimits: { type: 'object' },
        staleness: { type: 'string' },
        additionalFindings: { type: 'array', items: { type: 'string' } }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  }
}));

// ──────────────────────────────────────────────────────────────────────────────
// Task 2: Fix saved_searches.json — increase limits + add recently-created queries
// ──────────────────────────────────────────────────────────────────────────────

const fixSearchesTask = defineTask('fix-searches', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Fix saved_searches.json: increase limits to 50, add recently-created queries',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python developer',
      task: 'Increase fetch limits and add "recently created" variant queries to saved_searches.json',
      context: {
        projectDir: args.projectDir,
        configPath: args.projectDir + '/config/saved_searches.json',
        diagnosis: args.diagnosis,
        currentStructure: 'Array of {name, label, query/queries, limit} objects',
        approach: [
          'Increase limit for existing searches from 5 to 50',
          'Add a new entry for each search with a tighter created:>2025-01-01 filter',
          'The "recently created" queries find brand-new repos, not just popular old ones',
          'Use same label for existing + new entry so they show up in same board category',
          'For "recently created" variants, sort=stars still works — we just want repos created recently'
        ],
        example: {
          before: '{ "name": "llm", "label": "LLM & RAG", "queries": [...], "limit": 5 }',
          after: '{ "name": "llm", "label": "LLM & RAG", "queries": [...], "limit": 50 }'
        }
      },
      instructions: [
        'Read the current saved_searches.json',
        'Increase limit from 5 to 50 for ALL existing search entries',
        'Add a new search entry for each existing category with these characteristics:',
        '  - name: <original_name>-recent (e.g. llm-recent, information-retrieval-recent)',
        '  - label: same as original (so same board category)',
        '  - query: same topic filter but with created:>2025-01-01 instead of >2023-01-01',
        '  - stars: 10..5000 (lower bar for newer repos)',
        '  - limit: 30',
        '  - DO NOT add a "rag" entry (that name is stale in DB, and RAG is already covered by llm)',
        'For the llm entry with multi-queries, increase limit on both queries',
        'For academic entry with multi-queries, increase limit',
        'Write the updated JSON back to saved_searches.json',
        'Show the full updated JSON in your response',
        'DO NOT restart any services — just update the config file',
      ],
      outputFormat: 'JSON with: success (bool), updatedSearches (array of search names), newSearchesAdded (array of new search names), updatedJson (string — the full updated JSON), error (string or null)'
    },
    outputSchema: {
      type: 'object',
      required: ['success', 'updatedSearches', 'newSearchesAdded'],
      properties: {
        success: { type: 'boolean' },
        updatedSearches: { type: 'array', items: { type: 'string' } },
        newSearchesAdded: { type: 'array', items: { type: 'string' } },
        updatedJson: { type: 'string' },
        error: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  }
}));

// ──────────────────────────────────────────────────────────────────────────────
// Task 3: Run fetch to discover new repos with the new limits
// ──────────────────────────────────────────────────────────────────────────────

const runFetchTask = defineTask('run-fetch', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Run github-digest fetch with updated config to discover new repos',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'DevOps engineer',
      task: 'Run github-digest fetch to populate new repos with the updated saved_searches.json',
      context: {
        projectDir: args.projectDir,
        venvPath: args.projectDir + '/.venv/bin/activate',
        fix: args.fix
      },
      instructions: [
        'cd to ' + args.projectDir,
        'Activate venv: source .venv/bin/activate',
        'IMPORTANT: Before running, check the current max(first_seen_at) in the dev DB:',
        '  python3 -c "import sqlite3; c=sqlite3.connect(\'data/github_digest.db\').cursor(); c.execute(\'SELECT MAX(first_seen_at), COUNT(*) FROM repos\'); print(c.fetchone())"',
        'Run: github-digest fetch 2>&1 | tail -30',
        'Wait for completion, then check the new max(first_seen_at) and COUNT(*) to see how many new repos were discovered',
        'Also check: SELECT COUNT(*) FROM repos WHERE first_seen_at >= datetime("now", "-1 hour") to see how many truly new repos were added',
        'Test the board API on dev: curl -s "http://localhost:8000/board/today?mode=new&window_days=1&limit=10" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(k, len(v)) for k,v in d[\'board\'].items()]"',
        'Note: The dev server runs on :8000 (same as production because its the service). Just check the DB counts, not the live API.',
        'Actually: check if there is a dev server running. If not running, just check DB counts.',
        'Report: how many repos existed before, how many after, how many new repos were discovered in this fetch',
      ],
      outputFormat: 'JSON with: fetchSuccess (bool), reposBefore (number), reposAfter (number), newReposDiscovered (number), newReposWithin1hr (number), fetchOutput (string summary), error (string or null)'
    },
    outputSchema: {
      type: 'object',
      required: ['fetchSuccess', 'reposBefore', 'reposAfter', 'newReposDiscovered'],
      properties: {
        fetchSuccess: { type: 'boolean' },
        reposBefore: { type: 'number' },
        reposAfter: { type: 'number' },
        newReposDiscovered: { type: 'number' },
        newReposWithin1hr: { type: 'number' },
        fetchOutput: { type: 'string' },
        error: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  }
}));

// ──────────────────────────────────────────────────────────────────────────────
// Task 4: Deploy to production
// ──────────────────────────────────────────────────────────────────────────────

const deployTask = defineTask('deploy', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Deploy updated config to production and run fetch',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Linux sysadmin / DevOps',
      task: 'Deploy updated saved_searches.json to production and run a fetch cycle',
      context: {
        projectDir: args.projectDir,
        prodDir: args.prodDir,
        fetchResult: args.fetchResult,
        deploySteps: [
          '1. git -C dev add config/saved_searches.json',
          '2. git -C dev commit -m "Increase fetch limits and add recently-created queries for discovery"',
          '3. sudo git -C /opt/github-digest pull origin main',
          '4. Run github-digest fetch in production to discover new repos with new limits',
          '5. Verify: check health and board'
        ]
      },
      instructions: [
        'cd ' + args.projectDir,
        'Run git status to see what changed',
        'Stage and commit: git add config/saved_searches.json && git commit -m "Increase search limits to 50 and add recently-created queries for 24hr board discovery"',
        'Deploy to production: sudo git -C /opt/github-digest pull origin main',
        'After pulling, run a fetch in production to get new repos with increased limits:',
        '  sudo -u github-digest bash -c "cd /opt/github-digest && source .venv/bin/activate && github-digest fetch 2>&1 | tail -30"',
        'Check production DB for new repos: python3 -c "import sqlite3; c=sqlite3.connect(\'/opt/github-digest/data/github_digest.db\').cursor(); c.execute(\'SELECT COUNT(*), MAX(first_seen_at) FROM repos\'); print(c.fetchone())"',
        'Report: commit hash, production fetch success, new repo count',
      ],
      outputFormat: 'JSON with: success (bool), commitHash (string), productionFetchSuccess (bool), productionRepoCount (number), productionMaxFirstSeen (string), error (string or null)'
    },
    outputSchema: {
      type: 'object',
      required: ['success', 'productionFetchSuccess'],
      properties: {
        success: { type: 'boolean' },
        commitHash: { type: 'string' },
        productionFetchSuccess: { type: 'boolean' },
        productionRepoCount: { type: 'number' },
        productionMaxFirstSeen: { type: 'string' },
        error: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  }
}));

// ──────────────────────────────────────────────────────────────────────────────
// Task 5: Verify board shows more items in 24hr window
// ──────────────────────────────────────────────────────────────────────────────

const verifyTask = defineTask('verify', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Verify digest board 24hr window now shows more repos',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer',
      task: 'Verify the digest board 24hr "new" window now shows more than 2 repos across categories',
      context: {
        prodDir: args.prodDir,
        deployResult: args.deployResult,
        expectedOutcome: 'Multiple repos visible across multiple categories in the 24hr new board'
      },
      instructions: [
        'Call: curl -s "http://localhost:8000/board/today?mode=new&window_days=1&limit=15" | python3 -c "import sys,json; d=json.load(sys.stdin); total=sum(len(v) for v in d[\'board\'].values()); [print(k+\':\', len(v)) for k,v in d[\'board\'].items()]; print(\'TOTAL:\', total)"',
        'Call: curl -s "http://localhost:8000/health" | python3 -m json.tool',
        'Check the production DB: python3 -c "import sqlite3; conn=sqlite3.connect(\'/opt/github-digest/data/github_digest.db\'); c=conn.cursor(); c.execute(\'SELECT MAX(first_seen_at), COUNT(*) FROM repos\'); print(\'Total repos + max first_seen:\', c.fetchone()); c.execute(\'SELECT query_name, COUNT(*), MAX(last_seen_at) FROM repo_searches GROUP BY query_name ORDER BY MAX(last_seen_at) DESC\'); [print(r) for r in c.fetchall()]; conn.close()"',
        'Report: how many items show per category, is the 24hr board fixed (shows >2 items total), what categories now have items',
        'Also verify the board website loads: curl -s http://localhost:8000/ -o /dev/null -w "%{http_code}"',
      ],
      outputFormat: 'JSON with: boardFixed (bool), boardItemCount (number), itemsPerCategory (object), healthRepoCount (number), maxFirstSeenDate (string), summary (string)'
    },
    outputSchema: {
      type: 'object',
      required: ['boardFixed', 'boardItemCount', 'summary'],
      properties: {
        boardFixed: { type: 'boolean' },
        boardItemCount: { type: 'number' },
        itemsPerCategory: { type: 'object' },
        healthRepoCount: { type: 'number' },
        maxFirstSeenDate: { type: 'string' },
        summary: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  }
}));
