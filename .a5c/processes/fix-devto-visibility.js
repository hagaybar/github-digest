/**
 * @process github-digest/fix-devto-visibility
 * @description Fix DEV.to items not appearing in daily picks.
 *
 * Root cause: DEV.to items have no GitHub links extracted (buildability=0.2),
 * while HN items with high points + GitHub stars dominate all 7 picks.
 *
 * Fix strategy:
 *   1. devto_ingestion.py: fetch individual article detail (/api/articles/{id})
 *      to get body_markdown, parse for GitHub repo links → more items get github_full_name
 *   2. ranking.py: add source diversity enforcement — no single source
 *      takes more than max_per_source (default 5) of the 7 picks
 *   3. radar_config.yaml: add max_picks_per_source: 5 config key
 *   4. Test end-to-end in dev: verify devto items appear in picks
 *   5. Commit, push, deploy to /opt/github-digest, re-run rank-daily, verify
 *
 * @inputs { projectDir: string, prodDir: string }
 * @outputs { devtoInPicks: number, deployed: boolean, summary: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

export async function process(inputs, ctx) {
  const projectDir = inputs.projectDir || '/home/ubuntu/projects/github-digest';
  const prodDir = inputs.prodDir || '/opt/github-digest';

  // ============================================================================
  // PHASE 1: Fix devto_ingestion.py to fetch article body and extract GitHub links
  // ============================================================================
  const fixIngestion = await ctx.task(fixDevtoIngestionTask, { projectDir });

  // ============================================================================
  // PHASE 2: Add source diversity enforcement in ranking.py
  // ============================================================================
  const fixRanking = await ctx.task(fixRankingDiversityTask, { projectDir });

  // ============================================================================
  // PHASE 3: Update radar_config.yaml with max_picks_per_source setting
  // ============================================================================
  const updateConfig = await ctx.task(updateRadarConfigTask, { projectDir });

  // ============================================================================
  // PHASE 4: Test end-to-end in dev environment
  // ============================================================================
  const testE2e = await ctx.task(testDevtoVisibilityTask, { projectDir });

  // ============================================================================
  // PHASE 5: Commit, push, deploy to production, verify
  // ============================================================================
  const deploy = await ctx.task(deployAndVerifyTask, { projectDir, prodDir, testResult: testE2e });

  return {
    devtoInPicks: testE2e.devtoInPicks,
    deployed: deploy.success,
    summary: deploy.summary,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const fixDevtoIngestionTask = defineTask('fix-devto-ingestion', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Fix devto_ingestion.py to fetch article body',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python developer',
      task: `Fix ${args.projectDir}/src/github_digest/radar/devto_ingestion.py to extract GitHub repo links from article bodies.

Read the current file first to understand its structure.

The DEV.to article listing API (/api/articles?tag=...) does NOT return body_markdown.
The individual article endpoint GET /api/articles/{id} DOES return body_markdown.

Add a new function:
\`\`\`python
def fetch_devto_article_body(article_id: int) -> str:
    """Fetch the full body_markdown for a single DEV.to article."""
    url = f"https://dev.to/api/articles/{article_id}"
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            resp = client.get(url, headers={"User-Agent": _USER_AGENT})
            resp.raise_for_status()
            return resp.json().get("body_markdown", "") or ""
    except Exception as e:
        logger.warning("Failed to fetch article body for id=%d: %s", article_id, e)
        return ""
\`\`\`

Then in \`article_to_radar_item_data\`, update the GitHub extraction to also check body_markdown:
- After trying canonical_url and description (existing logic), if still no github_full_name:
  - Fetch the article body: body = fetch_devto_article_body(article["id"])
  - Search body for GitHub repo links using _GITHUB_REPO_RE or extract_github_repo_from_url approach
  - Use the FIRST match found (typically the most prominent repo link)

This adds one HTTP request per article that doesn't have a GitHub link from canonical_url/description.
To avoid excessive API calls, only fetch the body if canonical_url and description don't yield a result.

IMPORTANT: Read the file first to understand the existing extraction logic, then add the body fetching in the right place. The function fetch_devto_article_body should be called lazily only when needed.`,
      outputFormat: '{"success": true/false, "message": "..."}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

const fixRankingDiversityTask = defineTask('fix-ranking-diversity', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Add source diversity enforcement to ranking.py',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python developer',
      task: `Update ${args.projectDir}/src/github_digest/radar/ranking.py to enforce source diversity in daily picks.

Read the current file first.

In the \`rank_candidates\` function, after scoring and sorting (after the \`scored.sort(...)\` line),
add diversity enforcement BEFORE selecting top_7_items:

\`\`\`python
# Enforce source diversity: no single source takes more than max_per_source picks
max_per_source = ranking_cfg.get("max_picks_per_source", 5)
if max_per_source < daily_count:
    source_counts: dict[str, int] = {}
    diverse_picks = []
    overflow = []
    for item, scores in scored:
        src = item.source
        count = source_counts.get(src, 0)
        if count < max_per_source:
            diverse_picks.append((item, scores))
            source_counts[src] = count + 1
        else:
            overflow.append((item, scores))
        if len(diverse_picks) >= daily_count:
            break
    # If we still need more, fill from overflow (maintaining score order)
    if len(diverse_picks) < daily_count:
        overflow.sort(key=lambda x: x[1]["final_score"], reverse=True)
        diverse_picks.extend(overflow[:daily_count - len(diverse_picks)])
    top_7_items = diverse_picks[:daily_count]
else:
    top_7_items = scored[:daily_count]
\`\`\`

Replace the existing \`top_7_items = scored[:daily_count]\` line with this block.

Also remove or update the old \`top_7_items = scored[:daily_count]\` line that may appear near the top_k selection.

IMPORTANT: Read the file carefully to understand the exact code at the selection point. The top_k_items selection (top 30) should remain unchanged. Only the final top_7_items selection needs diversity enforcement.`,
      outputFormat: '{"success": true/false, "message": "..."}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

const updateRadarConfigTask = defineTask('update-radar-config', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Add max_picks_per_source to radar_config.yaml',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Configuration engineer',
      task: `Update ${args.projectDir}/config/radar_config.yaml to add max_picks_per_source setting.

Read the file first to understand the current structure.

In the \`ranking:\` section, add:
  max_picks_per_source: 5

This limits any single source (hackernews, devto) to at most 5 of the 7 daily picks,
ensuring at least 2 picks come from other sources.

IMPORTANT: Read the file first, make the minimal targeted addition.`,
      outputFormat: '{"success": true/false, "message": "..."}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

const testDevtoVisibilityTask = defineTask('test-devto-visibility', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Test DEV.to items appear in daily picks',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer',
      task: `Test that DEV.to items now appear in daily picks at ${args.projectDir}.

Steps:
1. cd ${args.projectDir} && source .venv/bin/activate
2. Re-run DEV.to ingestion (to pick up body-extracted GitHub links):
   github-digest ingest-devto 2>&1 | tail -5
3. Check how many devto items now have github_full_name:
   python3 -c "
from src.github_digest.db.database import get_engine
from sqlalchemy import text
engine = get_engine()
with engine.connect() as conn:
    total = conn.execute(text(\\"SELECT COUNT(*) FROM radar_items WHERE source='devto'\\")).scalar()
    gh_linked = conn.execute(text(\\"SELECT COUNT(*) FROM radar_items WHERE source='devto' AND github_full_name IS NOT NULL\\")).scalar()
    print(f'DevTo total: {total}, with GitHub: {gh_linked}')
"
4. Re-run rank-daily:
   github-digest rank-daily 2>&1 | tail -5
5. Check picks by source:
   curl -s http://localhost:8000/api/today | python3 -c "
import json,sys
d=json.load(sys.stdin)
items=d.get('items',[])
sources={}
for i in items:
    sources[i['source']]=sources.get(i['source'],0)+1
print('Picks by source:', sources)
for i in items:
    if i['source']=='devto':
        print(f'  DEV.to: {i[\\"title\\"][:60]}')
"
Return the results.`,
      outputFormat: '{"success": true/false, "devtoInPicks": N, "devtoWithGithub": N, "message": "..."}'
    },
    outputSchema: { type: 'object', required: ['success', 'devtoInPicks'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

const deployAndVerifyTask = defineTask('deploy-and-verify', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Commit, push, deploy, verify DEV.to in prod picks',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'DevOps engineer',
      task: `Commit all changes, push, deploy to ${args.prodDir}, and verify DEV.to items appear in production picks.

Test result context: ${JSON.stringify(args.testResult)}

Steps:
1. git -C ${args.projectDir} add src/github_digest/radar/devto_ingestion.py src/github_digest/radar/ranking.py config/radar_config.yaml
2. git -C ${args.projectDir} status
3. git -C ${args.projectDir} commit -m "$(cat <<'EOF'
Fix DEV.to visibility: article body extraction + source diversity ranking

- devto_ingestion.py: fetch article body to extract GitHub repo links
- ranking.py: enforce source diversity (max_picks_per_source=5 per source)
- radar_config.yaml: add max_picks_per_source: 5

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
4. git -C ${args.projectDir} push origin main
5. sudo git -C ${args.prodDir} pull origin main
6. sudo -u github-digest ${args.prodDir}/.venv/bin/pip install -e ${args.prodDir}/ -q
7. sudo systemctl restart github-digest-api.service
8. sudo systemctl is-active github-digest-api.service
9. Run ingest-devto + rank-daily in production:
   sudo -u github-digest bash -c "cd ${args.prodDir} && .venv/bin/github-digest ingest-devto" 2>&1 | tail -3
   sudo -u github-digest bash -c "cd ${args.prodDir} && .venv/bin/github-digest rank-daily" 2>&1 | tail -3
10. Verify /api/today sources:
    curl -s http://localhost:8000/api/today | python3 -c "
import json,sys
d=json.load(sys.stdin)
items=d.get('items',[])
sources={}
for i in items:
    sources[i['source']]=sources.get(i['source'],0)+1
print('Production picks by source:', sources)
for i in items:
    if i['source']=='devto':
        print(f'  DEV.to card: {i[\\"title\\"][:60]}')
"
Return a full summary.`,
      outputFormat: '{"success": true/false, "committed": true/false, "pushed": true/false, "deployed": true/false, "devtoInProdPicks": N, "summary": "..."}'
    },
    outputSchema: { type: 'object', required: ['success', 'summary'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));
