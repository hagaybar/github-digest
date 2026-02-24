/**
 * @process github-digest/fix-reddit-devto
 * @description Replace broken Reddit ingestion (403-blocked) with DEV.to ingestion.
 *   Reddit returns 403 from this datacenter IP. Replace with DEV.to public API
 *   which is open, builder-focused (showdev/opensource/buildinpublic tags), and
 *   frequently links to GitHub repos.
 *
 * Changes:
 *   1. Create src/github_digest/radar/devto_ingestion.py
 *   2. Update ranking.py to score devto_reactions signal
 *   3. Update cli.py: add ingest-devto command
 *   4. Update index.html: add devto badge CSS + JS
 *   5. Update today.html: show devto_reactions in signals
 *   6. Update run_daily_pipeline.py to use ingest-devto
 *   7. Test: ingest-devto → rank-daily → verify /api/today has devto items
 *   8. Commit, push, deploy to /opt/github-digest, verify
 *
 * @inputs { projectDir: string, prodDir: string }
 * @outputs { devtoItemsIngested: number, picksWithDevto: number, deployed: boolean, summary: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

export async function process(inputs, ctx) {
  const projectDir = inputs.projectDir || '/home/ubuntu/projects/github-digest';
  const prodDir = inputs.prodDir || '/opt/github-digest';

  // ============================================================================
  // PHASE 1: Create devto_ingestion.py
  // ============================================================================
  const createDevto = await ctx.task(createDevtoIngestionTask, { projectDir });

  // ============================================================================
  // PHASE 2: Update ranking.py to score devto_reactions
  // ============================================================================
  const updateRanking = await ctx.task(updateRankingTask, { projectDir });

  // ============================================================================
  // PHASE 3: Update CLI with ingest-devto command
  // ============================================================================
  const updateCli = await ctx.task(updateCliTask, { projectDir });

  // ============================================================================
  // PHASE 4: Update index.html badge CSS/JS for devto source
  // ============================================================================
  const updateIndexHtml = await ctx.task(updateIndexHtmlTask, { projectDir });

  // ============================================================================
  // PHASE 5: Update today.html signals section for devto
  // ============================================================================
  const updateTodayHtml = await ctx.task(updateTodayHtmlTask, { projectDir });

  // ============================================================================
  // PHASE 6: Update run_daily_pipeline.py to use ingest-devto
  // ============================================================================
  const updatePipeline = await ctx.task(updatePipelineTask, { projectDir });

  // ============================================================================
  // PHASE 7: Test end-to-end
  // ============================================================================
  const testE2e = await ctx.task(testE2eTask, { projectDir });

  // ============================================================================
  // PHASE 8: Commit, push, deploy, verify
  // ============================================================================
  const deploy = await ctx.task(deployTask, { projectDir, prodDir, testResult: testE2e });

  return {
    devtoItemsIngested: testE2e.devtoItemsIngested,
    picksWithDevto: testE2e.picksWithDevto,
    deployed: deploy.success,
    summary: deploy.summary,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const createDevtoIngestionTask = defineTask('create-devto-ingestion', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Create devto_ingestion.py',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python developer',
      task: `Create the file ${args.projectDir}/src/github_digest/radar/devto_ingestion.py.

This module replaces Reddit ingestion (which is 403-blocked) with DEV.to ingestion.

The DEV.to public API is at https://dev.to/api/articles and returns JSON with no auth required.

The module should:
1. Fetch articles from DEV.to API using these tags (in separate requests): "showdev", "opensource", "buildinpublic"
   - URL: https://dev.to/api/articles?tag={tag}&per_page=30&sort_by=published_at&sort_direction=desc
2. For each article, extract GitHub repo from:
   - canonical_url if it matches github.com/{owner}/{repo}
   - OR description/body_html if it contains a github.com/{owner}/{repo} link (simple regex search)
   - Field names available in API response: id, title, description, url, canonical_url, published_at, public_reactions_count, comments_count, tag_list, user
3. Create RadarItem data dicts with:
   - source = "devto"
   - source_id = str(article["id"])
   - url = article["url"]  (the DEV.to article URL)
   - title = article["title"]
   - published_at = parse article["published_at"]
   - github_full_name = extracted GitHub repo or None
   - signals_json = {"devto_reactions": article["public_reactions_count"], "devto_comments": article["comments_count"], "tags": article["tag_list"]}
4. Use existing upsert_radar_item from hn_ingestion.py
5. After ingestion, call enrich_github_signals to enrich items with github_full_name
6. Main function: ingest_devto(db_path, tags=None, per_tag=30, github_token=None) -> dict
   - Default tags: ["showdev", "opensource", "buildinpublic"]
   - Returns: {"ingested": N, "tags": [...], "github_linked": N, "github_enriched": N}
7. Use httpx with timeout=15, follow_redirects=True
8. Add proper User-Agent header: "github-digest/0.1"
9. Add logger = logging.getLogger(__name__)
10. Handle errors per article gracefully (warn and continue)

Pattern reference (follow this pattern from reddit_ingestion.py):
- It imports from github_digest.radar.hn_ingestion: enrich_github_signals, extract_github_repo_from_url, make_item_id, upsert_radar_item
- It uses Session(engine) as session: for DB operations
- It calls enrich_github_signals after all items are upserted

IMPORTANT: Actually write the file, don't just describe it. After writing, verify the file exists with the correct content.`,
      outputFormat: '{"success": true/false, "filePath": "...", "linesWritten": N, "message": "..."}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

const updateRankingTask = defineTask('update-ranking', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Update ranking.py to score devto_reactions',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python developer',
      task: `Update ${args.projectDir}/src/github_digest/radar/ranking.py to score DEV.to reactions.

Read the current file first.

In the function compute_momentum_score(), currently it has:
  reddit_score = signals.get("reddit_score") or 0
  if reddit_score > 0:
      momentum += 0.4 * min(1.0, math.log(max(1, reddit_score)) / math.log(1000))

Add similar logic AFTER the reddit_score block to also handle devto_reactions:
  devto_reactions = signals.get("devto_reactions") or 0
  if devto_reactions > 0:
      # DEV.to reactions: similar scale to reddit; cap contribution at 0.3
      momentum += 0.3 * min(1.0, math.log(max(1, devto_reactions)) / math.log(1000))

This ensures DEV.to items are scored appropriately.

IMPORTANT: Only add the devto_reactions block - don't change anything else. Read the file first to get the exact existing code, then make the targeted edit.`,
      outputFormat: '{"success": true/false, "message": "..."}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

const updateCliTask = defineTask('update-cli', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Add ingest-devto CLI command',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python developer',
      task: `Update ${args.projectDir}/src/github_digest/cli.py to add an ingest-devto command.

Read the file first to understand the existing pattern.

1. Add an import at the top of the file (after or near the existing reddit import):
   from github_digest.radar.devto_ingestion import ingest_devto

2. Find the section where ingest-reddit is handled (look for "ingest-reddit" in the dispatch/main function).

3. Add a new "ingest-devto" case with the same pattern as ingest-reddit:
   - Parse optional --tags argument (comma-separated list, default None)
   - Call ingest_devto(db_path=db_path, tags=tags_list, github_token=cfg.github_token)
   - Print stats

4. ALSO: Update the ingest-reddit case to print a deprecation warning:
   print("WARNING: Reddit ingestion is blocked (HTTP 403). Use ingest-devto instead.", file=sys.stderr)
   Then still attempt it (for backward compat).

IMPORTANT: Read the file first to get the exact code structure, then make the minimal changes.`,
      outputFormat: '{"success": true/false, "message": "..."}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

const updateIndexHtmlTask = defineTask('update-index-html', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Add devto badge to index.html',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Frontend developer',
      task: `Update ${args.projectDir}/src/github_digest/web/templates/index.html to support the "devto" source badge.

Read the file first to understand the current badge system.

1. Find the CSS section for .source-badge (look around line 302-330). Add a new CSS rule after the .source-badge.reddit rule:
   .source-badge.devto { background: #3b49df; color: #fff; }
   (DEV.to brand color is #3b49df - a nice blue)

2. Find the sourceBadgeHTML JavaScript function (around line 948). In the if/else chain that checks source types, add a new case for "devto":
   } else if (s === 'devto') {
     cls = 'devto';
     label = 'DEV.to';
   }

3. Also in the signals display section (where hn_points is shown), add devto_reactions display:
   Find the part that checks item.signals.hn_points and add similar logic for devto_reactions:
   if (item.signals && item.signals.devto_reactions) {
     html += ' <span style="color:#6a5d54">&#10084; ' + item.signals.devto_reactions + ' DEV reactions</span>';
   }
   (Add this near where hn_points and reddit_score are displayed)

IMPORTANT: Read the file first to understand exact code structure. Make targeted edits only - don't rewrite large sections.`,
      outputFormat: '{"success": true/false, "message": "..."}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

const updateTodayHtmlTask = defineTask('update-today-html', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Update today.html for devto signals',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Frontend developer',
      task: `Update ${args.projectDir}/src/github_digest/web/templates/today.html to:

1. Show a styled badge for DEV.to source. Read the file first.
   Find the .source-badge CSS rule and add after it:
   .source-badge.devto { background: #3b49df; color: #fff; }

2. Update the source badge display. Find:
   <span class="source-badge">{{ item.source }}</span>
   Replace with:
   <span class="source-badge {% if item.source == 'hackernews' %}hn{% elif item.source == 'devto' %}devto{% endif %}">{% if item.source == 'hackernews' %}HN{% elif item.source == 'devto' %}DEV.to{% else %}{{ item.source }}{% endif %}</span>

3. In the signals div at the bottom (around line 88-92), add devto_reactions display after the hn_points line:
   {% if item.signals.devto_reactions %} &middot; &#10084; {{ item.signals.devto_reactions }} DEV reactions{% endif %}

IMPORTANT: Read the file first, make minimal targeted edits.`,
      outputFormat: '{"success": true/false, "message": "..."}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

const updatePipelineTask = defineTask('update-pipeline', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Update run_daily_pipeline.py for devto',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python developer',
      task: `Update ${args.projectDir}/run_daily_pipeline.py to use ingest-devto instead of (or in addition to) ingest-reddit.

Read the file first to understand its structure.

1. Find where "ingest-reddit" is called/mentioned
2. Replace it with "ingest-devto" (DEV.to works, Reddit 403-blocks)
3. If there's a --skip-reddit flag, add/change to --skip-devto flag or keep both
4. Add a comment explaining why: "# Reddit replaced with DEV.to (Reddit 403-blocks server IPs)"

IMPORTANT: Read the file first. Make minimal targeted changes.`,
      outputFormat: '{"success": true/false, "message": "..."}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

const testE2eTask = defineTask('test-e2e', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Test DEV.to ingestion end-to-end',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer',
      task: `Test the DEV.to ingestion pipeline end-to-end at ${args.projectDir}.

Steps:
1. Activate venv: source ${args.projectDir}/.venv/bin/activate
2. Run ingestion: github-digest ingest-devto
   - Verify it exits 0
   - Note how many items were ingested
3. Check DB for devto items:
   python3 -c "
from src.github_digest.db.database import get_engine
from sqlalchemy import text
engine = get_engine()
with engine.connect() as conn:
    count = conn.execute(text(\"SELECT COUNT(*) FROM radar_items WHERE source='devto'\")).scalar()
    sample = conn.execute(text(\"SELECT title, github_full_name, signals_json FROM radar_items WHERE source='devto' LIMIT 3\")).fetchall()
    print('DevTo items:', count)
    for r in sample:
        print(f'  title={r[0][:50]}, gh={r[1]}, signals={r[2][:80]}')
"
4. Run rank-daily: github-digest rank-daily
   - Note result
5. Check /api/today for devto picks:
   curl -s http://localhost:8000/api/today | python3 -c "
import json,sys
data=json.load(sys.stdin)
items=data.get('items',[])
sources={}
for i in items:
    s=i.get('source','?')
    sources[s]=sources.get(s,0)+1
print('Picks by source:', sources)
for i in items:
    if i['source']=='devto':
        print('DEV.to pick:', i['title'][:60])
"
6. Verify the /today HTML page shows DEV.to badge (check it mentions devto or DEV.to)

Return the results.`,
      outputFormat: '{"success": true/false, "devtoItemsIngested": N, "picksWithDevto": N, "message": "detailed results"}'
    },
    outputSchema: { type: 'object', required: ['success', 'devtoItemsIngested'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

const deployTask = defineTask('commit-push-deploy', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Commit, push, deploy to production',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'DevOps engineer',
      task: `Commit all changes, push to remote, deploy to production at ${args.prodDir}.

The test result was: ${JSON.stringify(args.testResult)}

Steps:
1. git -C ${args.projectDir} add src/github_digest/radar/devto_ingestion.py src/github_digest/radar/ranking.py src/github_digest/cli.py src/github_digest/web/templates/index.html src/github_digest/web/templates/today.html run_daily_pipeline.py
2. git -C ${args.projectDir} status (to see what's staged)
3. git -C ${args.projectDir} commit -m "$(cat <<'EOF'
Replace Reddit with DEV.to ingestion (Reddit 403-blocks server IPs)

- Add devto_ingestion.py: fetches showdev/opensource/buildinpublic articles
- Update ranking.py: score devto_reactions signal
- Add ingest-devto CLI command; deprecate ingest-reddit
- Update index.html + today.html: DEV.to source badge (#3b49df)
- Update run_daily_pipeline.py to use ingest-devto

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
4. git -C ${args.projectDir} push origin main
5. sudo git -C ${args.prodDir} pull origin main
6. sudo -u github-digest ${args.prodDir}/.venv/bin/pip install -e ${args.prodDir}/ -q
7. sudo systemctl restart github-digest-api.service
8. sudo systemctl is-active github-digest-api.service
9. Run ingest-devto in production:
   sudo -u github-digest bash -c "cd ${args.prodDir} && .venv/bin/github-digest ingest-devto"
10. Run rank-daily in production:
    sudo -u github-digest bash -c "cd ${args.prodDir} && .venv/bin/github-digest rank-daily"
11. Verify /api/today has devto items:
    curl -s http://localhost:8000/api/today | python3 -c "import json,sys; d=json.load(sys.stdin); items=d.get('items',[]); sources={i['source'] for i in items}; print('Sources in picks:', sources)"
12. Return summary.`,
      outputFormat: '{"success": true/false, "committed": true/false, "pushed": true/false, "deployed": true/false, "devtoInProd": true/false, "summary": "..."}'
    },
    outputSchema: { type: 'object', required: ['success', 'summary'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));
