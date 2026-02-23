/**
 * @process github-digest/fix-production-issues
 * @description Fix three production issues:
 *   1. pyyaml missing from pyproject.toml → rank-daily fails → Today's 7 empty
 *   2. Summarizer only doing 3/run → slow to catch up
 *   3. Verify "updated" tab works in production and investigate Ollama health bug
 *
 * @inputs {}
 * @outputs { fixesApplied: string[], todayPicks: number, summarizedCount: number, summary: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

export async function process(inputs, ctx) {

  // ============================================================================
  // PHASE 1: Fix pyproject.toml — add pyyaml dependency
  // ============================================================================

  const addPyyaml = await ctx.task(addPyyamlDepTask, {
    projectDir: '/home/ubuntu/projects/github-digest'
  });

  // ============================================================================
  // PHASE 2: Install pyyaml in production venv & run rank-daily for today
  // ============================================================================

  const productionFix = await ctx.task(installAndRunRankTask, {
    projectDir: '/home/ubuntu/projects/github-digest',
    addPyyamlResult: addPyyaml
  });

  // ============================================================================
  // PHASE 3: Check summarizer limit & maybe run manually
  // ============================================================================

  const summaryFix = await ctx.task(fixSummarizerTask, {
    projectDir: '/home/ubuntu/projects/github-digest',
    productionFixResult: productionFix
  });

  // ============================================================================
  // PHASE 4: Investigate Ollama health bug + check updated tab in production
  // ============================================================================

  const healthFix = await ctx.task(fixHealthAndUpdatedTask, {
    projectDir: '/home/ubuntu/projects/github-digest'
  });

  // ============================================================================
  // PHASE 5: Commit the pyproject.toml fix and sync production
  // ============================================================================

  const commit = await ctx.task(commitAndSyncTask, {
    projectDir: '/home/ubuntu/projects/github-digest',
    addPyyamlResult: addPyyaml,
    productionFixResult: productionFix
  });

  // ============================================================================
  // PHASE 6: Verify everything is working
  // ============================================================================

  const verification = await ctx.task(verifyTask, {
    projectDir: '/home/ubuntu/projects/github-digest'
  });

  return {
    fixesApplied: [
      addPyyaml.fix,
      productionFix.fix,
      summaryFix.fix,
      healthFix.fix,
      commit.fix
    ].filter(Boolean),
    todayPicks: verification.todayPicks,
    summarizedCount: verification.summarizedCount,
    summary: verification.summary
  };
}

// ────────────────────────────────────────────────────────────────────────────

const addPyyamlDepTask = defineTask('add-pyyaml-dep', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Add pyyaml to pyproject.toml',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python packaging expert',
      task: `Add pyyaml>=6.0 to the dependencies list in pyproject.toml.
The file is at: ${args.projectDir}/pyproject.toml
Currently it has: fastapi, uvicorn, httpx, pydantic, pydantic-settings, SQLAlchemy, Jinja2, python-dotenv.
Add "pyyaml>=6.0" to that list.
Then verify the edit was saved correctly by reading the file.
Return a brief summary of what was changed.`,
      outputFormat: '{"fix": "description of what was done", "success": true/false}'
    },
    outputSchema: {
      type: 'object',
      required: ['fix', 'success'],
      properties: {
        fix: { type: 'string' },
        success: { type: 'boolean' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

// ────────────────────────────────────────────────────────────────────────────

const installAndRunRankTask = defineTask('install-and-rank', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Install pyyaml in production venv & run rank-daily',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Linux sysadmin',
      task: `Fix the production GitHub Digest service so that Today's 7 picks are generated.

The production service runs from /opt/github-digest/ using sudo -u github-digest.
The production venv is at /opt/github-digest/.venv/

Steps to perform:
1. Install pyyaml in the production venv:
   sudo -u github-digest /opt/github-digest/.venv/bin/pip install pyyaml

2. Verify it installed:
   sudo -u github-digest /opt/github-digest/.venv/bin/python -c "import yaml; print('yaml OK')"

3. Run rank-daily for today in production:
   sudo -u github-digest /opt/github-digest/.venv/bin/github-digest rank-daily

4. Check the result - how many picks were created?
   curl -s http://localhost:8000/api/today | python3 -m json.tool

5. If rank-daily also needs analyze-daily to work, run that too:
   sudo -u github-digest /opt/github-digest/.venv/bin/github-digest analyze-daily

Report what happened and how many items are now in today's picks.`,
      outputFormat: '{"fix": "description", "todayPicksCount": number, "success": true/false, "errors": []}'
    },
    outputSchema: {
      type: 'object',
      required: ['fix', 'todayPicksCount', 'success'],
      properties: {
        fix: { type: 'string' },
        todayPicksCount: { type: 'number' },
        success: { type: 'boolean' },
        errors: { type: 'array', items: { type: 'string' } }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

// ────────────────────────────────────────────────────────────────────────────

const fixSummarizerTask = defineTask('fix-summarizer', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Run summarizer to catch up on unsummarized repos',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'GitHub Digest operator',
      task: `The summarizer is running but only does 3 repos per run (every 4 hours).
With 60 repos, that means it takes 20+ hours to summarize all repos.

Steps:
1. Check how many repos lack summaries:
   Read the summarizer service by checking: journalctl -u github-digest-summarize.service -n 10 --no-pager

2. Run the summarizer manually in production with a higher limit to catch up:
   sudo -u github-digest /opt/github-digest/.venv/bin/github-digest summarize --limit 30

   Note: this may take several minutes as each summary uses Ollama LLM.

3. Check how many repos are now summarized:
   curl -s http://localhost:8000/health | python3 -m json.tool

4. Also check the summarizer config/code to understand the per-run limit.
   Read: /home/ubuntu/projects/github-digest/src/github_digest/services/summarizer.py
   Look for any hardcoded limit and report what it is.

Report what you found and how many were summarized.`,
      outputFormat: '{"fix": "description", "summarizedCount": number, "remainingUnsummarized": number, "success": true/false}'
    },
    outputSchema: {
      type: 'object',
      required: ['fix', 'success'],
      properties: {
        fix: { type: 'string' },
        summarizedCount: { type: 'number' },
        remainingUnsummarized: { type: 'number' },
        success: { type: 'boolean' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

// ────────────────────────────────────────────────────────────────────────────

const fixHealthAndUpdatedTask = defineTask('fix-health-updated', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Investigate Ollama health bug & Updated tab in production',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Fullstack debugger',
      task: `Investigate two issues:

ISSUE A — Health endpoint shows Ollama unreachable despite it being running:
1. Check the health endpoint: curl -s http://localhost:8000/health | python3 -m json.tool
2. Check if Ollama is actually running: curl -s http://localhost:11434/api/tags | python3 -m json.tool
3. Read the health endpoint code: /home/ubuntu/projects/github-digest/src/github_digest/api/app.py
   Find the Ollama health check logic — what URL does it use? Is there a timeout issue?
4. Report the bug and what needs to be fixed.

ISSUE B — "Updated" mode in the Digest Board:
1. Check what the API returns: curl -s "http://localhost:8000/board/today?mode=updated&window_days=7" | python3 -m json.tool | head -50
2. Read the frontend template to see if "Updated" is in the Mode dropdown:
   /home/ubuntu/projects/github-digest/src/github_digest/web/templates/index.html
   Search for "updated" in the template.
3. Check what repos show in updated mode - do they have delta=null? That's expected if no star history.
4. Report your findings and whether there's a real bug or just user confusion.

Report findings for both issues with suggested fixes.`,
      outputFormat: '{"fix": "description of findings and fixes", "ollamaHealthBug": "description", "updatedTabIssue": "description", "success": true/false}'
    },
    outputSchema: {
      type: 'object',
      required: ['fix', 'success'],
      properties: {
        fix: { type: 'string' },
        ollamaHealthBug: { type: 'string' },
        updatedTabIssue: { type: 'string' },
        success: { type: 'boolean' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

// ────────────────────────────────────────────────────────────────────────────

const commitAndSyncTask = defineTask('commit-and-sync', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Commit pyproject.toml fix and sync to production',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Git and deployment specialist',
      task: `Commit the pyproject.toml pyyaml fix to git and sync production.

Steps:
1. Check what changed: cd /home/ubuntu/projects/github-digest && git diff
2. Stage and commit the pyproject.toml change:
   git add pyproject.toml
   git commit -m "Add pyyaml to runtime dependencies

pyyaml was used by radar/ranking.py but missing from pyproject.toml,
causing rank-daily to crash with ModuleNotFoundError in production.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

3. Sync production with the latest code from dev:
   sudo -u github-digest rsync -av --exclude='.git' --exclude='data/' --exclude='logs/' --exclude='.venv/' /home/ubuntu/projects/github-digest/ /opt/github-digest/

4. Install the updated package in production (picks up new pyproject.toml deps):
   sudo -u github-digest /opt/github-digest/.venv/bin/pip install -e /opt/github-digest/

5. Restart the API service to pick up any template changes:
   sudo systemctl restart github-digest-api.service

6. Verify the service is back up:
   sleep 3 && systemctl status github-digest-api.service | head -10

Report what was committed and synced.`,
      outputFormat: '{"fix": "description", "commitHash": "abc123", "synced": true/false, "success": true/false}'
    },
    outputSchema: {
      type: 'object',
      required: ['fix', 'success'],
      properties: {
        fix: { type: 'string' },
        commitHash: { type: 'string' },
        synced: { type: 'boolean' },
        success: { type: 'boolean' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

// ────────────────────────────────────────────────────────────────────────────

const verifyTask = defineTask('verify-all', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Verify all fixes are working',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer',
      task: `Verify all fixes are working in the GitHub Digest production system.

Checks to run:
1. Today's 7 picks exist:
   curl -s http://localhost:8000/api/today | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Today picks: {len(d[\"items\"])}')"

2. API health:
   curl -s http://localhost:8000/health | python3 -m json.tool

3. Board modes working:
   curl -s "http://localhost:8000/board/today?mode=new&window_days=7" | python3 -c "import sys,json; d=json.load(sys.stdin); total=sum(len(v) for v in d['board'].values()); print(f'New mode: {total} repos')"
   curl -s "http://localhost:8000/board/today?mode=updated&window_days=7" | python3 -c "import sys,json; d=json.load(sys.stdin); total=sum(len(v) for v in d['board'].values()); print(f'Updated mode: {total} repos')"

4. Service is running:
   systemctl status github-digest-api.service | head -5

5. pyyaml is now installed in production:
   sudo -u github-digest /opt/github-digest/.venv/bin/python -c "import yaml; print('yaml OK')"

Report a summary of what's working and what's still broken.`,
      outputFormat: '{"todayPicks": number, "summarizedCount": number, "summary": "overall status", "issues": [], "success": true/false}'
    },
    outputSchema: {
      type: 'object',
      required: ['todayPicks', 'summary', 'success'],
      properties: {
        todayPicks: { type: 'number' },
        summarizedCount: { type: 'number' },
        summary: { type: 'string' },
        issues: { type: 'array', items: { type: 'string' } },
        success: { type: 'boolean' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));
