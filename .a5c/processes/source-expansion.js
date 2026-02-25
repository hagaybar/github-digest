/**
 * @process github-digest/source-expansion
 * @description Implement 4 features:
 *   1. GitHub Trending ingestion (no API key, scrapes github.com/trending)
 *   2. ProductHunt RSS ingestion (public feed, no key, stdlib ET parser)
 *   3. Fix "Today's 7" empty gap (API fallback to most recent day with picks)
 *   4. Intra-day re-ranking (rank-refresh every 2h, systemd timer)
 *   5. Wire all new sources into run_daily_pipeline.py
 *   6. Full integration test: all sources → picks → UI badges visible
 *   7. Commit, push, deploy to /opt/github-digest, install timers, verify
 *
 * @inputs { projectDir: string, prodDir: string }
 * @outputs { sourcesAdded: string[], picksFromNewSources: number, deployed: boolean, summary: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

export async function process(inputs, ctx) {
  const projectDir = inputs.projectDir || '/home/ubuntu/projects/github-digest';
  const prodDir    = inputs.prodDir    || '/opt/github-digest';

  // Phase 1 — GitHub Trending ingestion
  const trending = await ctx.task(githubTrendingTask, { projectDir });

  // Phase 2 — ProductHunt RSS ingestion
  const ph = await ctx.task(productHuntTask, { projectDir });

  // Phase 3 — Fix empty Today's 7 gap
  const emptyFix = await ctx.task(fixEmptyTodayTask, { projectDir });

  // Phase 4 — Intra-day re-ranking + systemd timer
  const rerank = await ctx.task(intraDayRerankTask, { projectDir });

  // Phase 5 — Wire into run_daily_pipeline.py + radar_config.yaml
  const pipeline = await ctx.task(updatePipelineTask, { projectDir });

  // Phase 6 — Integration test
  const test = await ctx.task(integrationTestTask, { projectDir });

  // Phase 7 — Commit, push, deploy, install timers, verify
  const deploy = await ctx.task(deployTask, {
    projectDir, prodDir,
    trendingResult: trending, phResult: ph,
    emptyFixResult: emptyFix, rerankResult: rerank,
    testResult: test,
  });

  return {
    sourcesAdded: ['github_trending', 'producthunt'],
    picksFromNewSources: test.picksFromNewSources || 0,
    deployed: deploy.success,
    summary: deploy.summary,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — GitHub Trending ingestion
// ─────────────────────────────────────────────────────────────────────────────
const githubTrendingTask = defineTask('github-trending-ingestion', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Create github_trending_ingestion.py + CLI cmd + badges',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python developer',
      task: `Implement GitHub Trending ingestion for ${args.projectDir}.

Read these files first for patterns:
- ${args.projectDir}/src/github_digest/radar/devto_ingestion.py  (full pattern to follow)
- ${args.projectDir}/src/github_digest/radar/ranking.py          (to add trending_delta scoring)
- ${args.projectDir}/src/github_digest/cli.py                    (to add ingest-github-trending)
- ${args.projectDir}/src/github_digest/web/templates/today.html  (to add badge)
- ${args.projectDir}/src/github_digest/web/templates/index.html  (to add badge CSS+JS)

STEP 1 — Create ${args.projectDir}/src/github_digest/radar/github_trending_ingestion.py:

The file must:
- Fetch https://github.com/trending?since=daily and https://github.com/trending?since=weekly
  with User-Agent "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0"
  (required — github.com redirects bots without a browser UA)
- Parse the HTML with html.parser from Python stdlib (NO external libs)
  Each trending repo is in an article.Box-row element; extract:
    - owner/repo from the <h2><a href="/owner/repo"> text
    - language from [itemprop="programmingLanguage"] span (may be absent)
    - total stars from the star count anchor (strip commas → int)
    - star delta ("NNN stars today" or "NNN stars this week") from last span.d-inline-block
- Deduplicate by github_full_name (daily overrides weekly if same repo)
- Create RadarItem dicts with:
    source = "github_trending"
    source_id = github_full_name (e.g. "owner/repo")
    url = "https://github.com/" + github_full_name
    title = github_full_name  (will be overwritten by enrich_github_signals which gets the real description)
    github_full_name = "owner/repo"
    signals_json = {"github_stars_total": N, "github_trending_delta": N, "trending_period": "daily"|"weekly", "github_language": "..."}
- Call upsert_radar_item() per item, then enrich_github_signals() afterwards
- Main function: ingest_github_trending(db_path, github_token=None) -> dict
  Returns {"ingested": N, "daily": N, "weekly": N, "github_enriched": N}
- Follow the exact same module structure as devto_ingestion.py
- Add logger = logging.getLogger(__name__)

STEP 2 — Update ${args.projectDir}/src/github_digest/radar/ranking.py:
In compute_momentum_score(), after the devto_reactions block, add:
  trending_delta = signals.get("github_trending_delta") or 0
  if trending_delta > 0:
      # GitHub Trending delta stars: log-scale, cap at 0.4
      momentum += 0.4 * min(1.0, math.log(max(1, trending_delta)) / math.log(5000))

STEP 3 — Update ${args.projectDir}/src/github_digest/cli.py:
Add import: from github_digest.radar.github_trending_ingestion import ingest_github_trending
Add cmd_ingest_github_trending() function (same pattern as cmd_ingest_devto)
Add "ingest-github-trending" subparser + dispatch in main()

STEP 4 — Update ${args.projectDir}/src/github_digest/web/templates/today.html:
In CSS: add .source-badge.trending { background: #1a7f37; color: #fff; }  (GitHub green)
Update the source badge Jinja2 span to also handle 'github_trending':
  add {% elif item.source == 'github_trending' %}trending{% endif %} to class
  add {% elif item.source == 'github_trending' %}Trending{% endif %} to label
In signals div: add {% if item.signals.github_trending_delta %} &middot; &#11088; +{{ item.signals.github_trending_delta }} today{% endif %}

STEP 5 — Update ${args.projectDir}/src/github_digest/web/templates/index.html:
Add CSS: .source-badge.trending { background: #1a7f37; color: #fff; }  (after devto rule)
In sourceBadgeHTML JS: add } else if (s === 'github_trending') { cls = 'trending'; label = 'Trending'; }
In signals display: if (signals.github_trending_delta) add "+N today" next to star count

IMPORTANT: Actually write/edit all files. Verify each exists after writing. Return a JSON summary.`,
      outputFormat: '{"success": true/false, "filesCreated": [...], "filesModified": [...], "message": "..."}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — ProductHunt RSS ingestion
// ─────────────────────────────────────────────────────────────────────────────
const productHuntTask = defineTask('producthunt-ingestion', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Create producthunt_ingestion.py + CLI cmd + badges',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python developer',
      task: `Implement ProductHunt RSS ingestion for ${args.projectDir}.

Read these files first:
- ${args.projectDir}/src/github_digest/radar/devto_ingestion.py  (pattern)
- ${args.projectDir}/src/github_digest/cli.py
- ${args.projectDir}/src/github_digest/web/templates/today.html
- ${args.projectDir}/src/github_digest/web/templates/index.html

STEP 1 — Create ${args.projectDir}/src/github_digest/radar/producthunt_ingestion.py:

The file must:
- Fetch https://www.producthunt.com/feed with xml.etree.ElementTree (stdlib, NO feedparser)
  Use User-Agent: "github-digest/0.1"
  Parse <item> elements: <title>, <link>, <description>, <pubDate>
- Extract github_full_name from <link> and <description> using the existing
  extract_github_repo_from_url and a regex search on description text
  (import _GITHUB_REPO_RE pattern from devto_ingestion or redefine it locally)
- Create RadarItem dicts with:
    source = "producthunt"
    source_id = sha hash of the <link> URL (use make_item_id("producthunt", link))
    url = the <link> value
    title = the <title> value
    github_full_name = extracted or None
    published_at = parse <pubDate> with email.utils.parsedate_to_datetime (stdlib)
    signals_json = {"ph_tagline": description[:200]}
- Call upsert_radar_item() per item, enrich_github_signals() at the end
- Main function: ingest_producthunt(db_path, github_token=None) -> dict
  Returns {"ingested": N, "github_linked": N, "github_enriched": N}
- Follow the exact same module structure as devto_ingestion.py
- Add logger = logging.getLogger(__name__)

STEP 2 — Update ${args.projectDir}/src/github_digest/cli.py:
Add import: from github_digest.radar.producthunt_ingestion import ingest_producthunt
Add cmd_ingest_producthunt() function (same pattern as cmd_ingest_devto)
Add "ingest-producthunt" subparser + dispatch in main()

STEP 3 — Update ${args.projectDir}/src/github_digest/web/templates/today.html:
In CSS: add .source-badge.ph { background: #da552f; color: #fff; }
Update source badge Jinja2 span to also handle 'producthunt':
  add {% elif item.source == 'producthunt' %}ph{% endif %} to class
  add {% elif item.source == 'producthunt' %}PH{% endif %} to label

STEP 4 — Update ${args.projectDir}/src/github_digest/web/templates/index.html:
Add CSS: .source-badge.ph { background: #da552f; color: #fff; }
In sourceBadgeHTML JS: add } else if (s === 'producthunt') { cls = 'ph'; label = 'Product Hunt'; }

IMPORTANT: Actually write/edit all files. Return a JSON summary.`,
      outputFormat: '{"success": true/false, "filesCreated": [...], "filesModified": [...], "message": "..."}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Fix empty Today's 7 gap
// ─────────────────────────────────────────────────────────────────────────────
const fixEmptyTodayTask = defineTask('fix-empty-today', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Fix empty Today\'s 7: fallback to most recent picks',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python+frontend developer',
      task: `Fix the empty "Today's 7" gap in ${args.projectDir}.

Problem: Between midnight and when the daily pipeline runs (~06:00 UTC),
/api/today returns 0 items and /today shows "No picks for today yet."

Fix: When today has no picks, fall back to the most recent date that HAS picks.

Read these files first:
- ${args.projectDir}/src/github_digest/api/app.py  (lines 222-266 for _get_today_items, lines 375-420 for /api/today and /today)
- ${args.projectDir}/src/github_digest/web/templates/today.html
- ${args.projectDir}/src/github_digest/web/templates/index.html

STEP 1 — Update _get_today_items() in app.py:
The function currently takes (db, date_str). Change it to also accept a fallback:

After the current query, if rows is empty, do a fallback query to find the most recent date with picks:
  fallback_date = db.scalar(text("SELECT MAX(date) FROM daily_picks WHERE date < :d"), {"d": date_str})
  if fallback_date:
      rows = db.execute(... same query but with fallback_date ...).fetchall()
      # mark items with is_fallback=True and actual_date=fallback_date

Return items list where each item has an extra key "is_fallback": True/False and "actual_date": the date string.

STEP 2 — Update /api/today endpoint in app.py:
In the JSON response dict, add:
  "is_fallback": any(i.get("is_fallback") for i in items),
  "actual_date": items[0]["actual_date"] if items else date_str,

STEP 3 — Update today.html:
Add a subtle banner BELOW the subtitle when fallback is active.
The /today template receives items; check if any item has is_fallback:
  {% if items and items[0].is_fallback %}
  <p class="fallback-notice">&#8634; Showing picks from {{ items[0].actual_date }} &mdash; today's pipeline hasn't run yet.</p>
  {% endif %}
Add CSS: .fallback-notice { color: #a08060; font-size: 13px; margin: -16px 0 16px; font-style: italic; }

STEP 4 — Update index.html (the JS-driven tab):
In the fetch /api/today response handler, if data.is_fallback is true,
show a small italic note under the date: "↻ Showing picks from {data.actual_date}"
Find the section where the date/subtitle is rendered and add this conditional note.

IMPORTANT: Read the files first to understand exact code. Make targeted edits. Return JSON summary.`,
      outputFormat: '{"success": true/false, "filesModified": [...], "message": "..."}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — Intra-day re-ranking + systemd timer
// ─────────────────────────────────────────────────────────────────────────────
const intraDayRerankTask = defineTask('intraday-rerank', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Add rank-refresh command + systemd timer (every 2h)',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python + DevOps developer',
      task: `Add intra-day re-ranking to ${args.projectDir}.

Read these files first:
- ${args.projectDir}/src/github_digest/radar/ranking.py          (rank_candidates function to adapt)
- ${args.projectDir}/src/github_digest/cli.py                    (to add rank-refresh command)
- ${args.projectDir}/config/radar_config.yaml                    (to add min_score_delta_for_refresh)
- ${args.projectDir}/deploy/systemd/github-digest-radar.service  (template for new service)
- ${args.projectDir}/deploy/systemd/github-digest-radar.timer    (template for new timer)

STEP 1 — Add rank_refresh() to ${args.projectDir}/src/github_digest/radar/ranking.py:

Add this function AFTER rank_candidates():

def rank_refresh(db_path, config_path, date_str=None):
    """Re-score all 48h candidates and replace any daily pick whose replacement scores
    min_score_delta_for_refresh higher. Runs fast (no LLM). Returns dict of stats."""

    Logic:
    1. Load config, read min_score_delta_for_refresh (default 0.05) and other ranking params
    2. Call the same scoring logic as rank_candidates() to get all scored candidates
       (query 48h window, deduplicate, exclude reuse window, score each)
    3. Read current daily_picks for date_str from DB
    4. If current picks count == 0 → call rank_candidates() fully and return (first-time population)
    5. Otherwise, apply diversity selection to get the best 7 from fresh scores
    6. Compare new best-7 vs current picks:
       - For each position (rank 1-7), if new_pick.final_score > old_pick.final_score + threshold AND new_pick.id != old_pick.id: replace
    7. If any replacements were made, rewrite daily_picks for today (DELETE + INSERT the updated set)
    8. Return {"date": date_str, "candidates": N, "replaced": N, "picks_unchanged": N, "first_run": bool}

STEP 2 — Add rank-refresh to ${args.projectDir}/src/github_digest/cli.py:
Add cmd_rank_refresh() (same pattern as cmd_rank_daily):
  - calls rank_refresh(db_path, config_path)
  - prints stats
Add "rank-refresh" subparser + dispatch in main()

STEP 3 — Update ${args.projectDir}/config/radar_config.yaml:
In ranking section add:
  min_score_delta_for_refresh: 0.05

STEP 4 — Create systemd service ${args.projectDir}/deploy/systemd/github-digest-rank-refresh.service:
Copy structure from github-digest-radar.service but:
  Description=Builder Radar intra-day rank refresh (every 2 hours)
  ExecStart=/usr/bin/flock -n /run/github-digest/rank-refresh.lock \\
      /opt/github-digest/.venv/bin/github-digest rank-refresh

STEP 5 — Create systemd timer ${args.projectDir}/deploy/systemd/github-digest-rank-refresh.timer:
Copy structure from github-digest-radar.timer but:
  Description=Run Builder Radar rank refresh every 2 hours
  OnCalendar=*-*-* 00/2:10:00  (at :10 past every even hour, offset from ingest)
  Persistent=true

STEP 6 — Update ${args.projectDir}/deploy/systemd/install.sh:
Add the new service/timer installation (follow the existing pattern for enabling timers).
Read install.sh first to understand the exact pattern.

IMPORTANT: Read all files before modifying. Make targeted edits. Return JSON summary.`,
      outputFormat: '{"success": true/false, "filesCreated": [...], "filesModified": [...], "message": "..."}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 — Wire new sources into run_daily_pipeline.py + radar_config.yaml
// ─────────────────────────────────────────────────────────────────────────────
const updatePipelineTask = defineTask('update-pipeline', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Wire GitHub Trending + PH into run_daily_pipeline.py',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python developer',
      task: `Update ${args.projectDir}/run_daily_pipeline.py to include the two new ingestion sources.

Read the file first to understand its current structure.

1. Add Step 2c: GitHub Trending ingestion (after DEV.to, before rank-daily)
   - Follow exact same pattern as Step 2 (HN) and Step 2b (DEV.to)
   - import ingest_github_trending from github_digest.radar.github_trending_ingestion
   - Add --skip-trending flag with action='store_true'
   - Run ingest_github_trending(db_path) unless --skip-trending
   - Comment: "# GitHub Trending: high-buildability repos currently spiking"

2. Add Step 2d: ProductHunt ingestion (after trending, before rank-daily)
   - Follow same pattern
   - import ingest_producthunt from github_digest.radar.producthunt_ingestion
   - Add --skip-producthunt flag
   - Run ingest_producthunt(db_path)
   - Comment: "# ProductHunt: daily commercial/polished tool launches"

3. Update the docstring/module description to list the new sources.

Also update ${args.projectDir}/config/radar_config.yaml ingestion section to add:
  github_trending_fetch_interval_hours: 2
  producthunt_fetch_interval_hours: 6

IMPORTANT: Read the files first. Make targeted additions only. Return JSON summary.`,
      outputFormat: '{"success": true/false, "message": "..."}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6 — Integration test
// ─────────────────────────────────────────────────────────────────────────────
const integrationTestTask = defineTask('integration-test', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Integration test: all sources → picks → UI badges',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer',
      task: `Test the full source-expansion implementation at ${args.projectDir}.

All commands must be run from ${args.projectDir} with source .venv/bin/activate.

STEP 1 — Syntax check new files (no import errors):
  cd ${args.projectDir} && source .venv/bin/activate
  python3 -c "from src.github_digest.radar.github_trending_ingestion import ingest_github_trending; print('trending OK')"
  python3 -c "from src.github_digest.radar.producthunt_ingestion import ingest_producthunt; print('ph OK')"
  python3 -c "from src.github_digest.radar.ranking import rank_refresh; print('rank_refresh OK')"

STEP 2 — Run GitHub Trending ingestion:
  github-digest ingest-github-trending 2>&1 | tail -5
  Check how many trending items are in DB:
  python3 -c "
from src.github_digest.db.database import get_engine
from sqlalchemy import text
e = get_engine()
with e.connect() as c:
    n = c.execute(text(\"SELECT COUNT(*) FROM radar_items WHERE source='github_trending'\")).scalar()
    s = c.execute(text(\"SELECT title, github_full_name, signals_json FROM radar_items WHERE source='github_trending' LIMIT 3\")).fetchall()
    print(f'Trending items: {n}')
    for r in s: print(f'  {r[0][:50]} | gh={r[1]} | {str(r[2])[:60]}')
"

STEP 3 — Run ProductHunt ingestion:
  github-digest ingest-producthunt 2>&1 | tail -5
  Check PH items in DB similarly.

STEP 4 — Run rank-daily (full daily pick selection):
  github-digest rank-daily 2>&1 | tail -5

STEP 5 — Test rank-refresh:
  github-digest rank-refresh 2>&1 | tail -5

STEP 6 — Check /api/today for new sources:
  curl -s http://localhost:8000/api/today | python3 -c "
import json,sys
d=json.load(sys.stdin)
items=d.get('items',[])
is_fallback=d.get('is_fallback',False)
print('is_fallback:', is_fallback, '| actual_date:', d.get('actual_date'))
sources={}
for i in items:
    sources[i['source']]=sources.get(i['source'],0)+1
print('Picks by source:', sources)
for i in items:
    if i['source'] in ('github_trending','producthunt'):
        print(f'  [{i[\"source\"]}] {i[\"title\"][:60]}')
"

STEP 7 — Verify /today HTML has new badges:
  curl -s http://localhost:8000/today | grep -o 'source-badge[^"]*' | sort | uniq

STEP 8 — Test empty fallback (delete today's picks and check API falls back):
  python3 -c "
from src.github_digest.db.database import get_engine
from sqlalchemy import text
from datetime import UTC, datetime
today = datetime.now(UTC).strftime('%Y-%m-%d')
e = get_engine()
with e.begin() as c:
    c.execute(text('DELETE FROM daily_picks WHERE date = :d'), {'d': today})
print('Deleted today picks')
"
  curl -s http://localhost:8000/api/today | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('is_fallback:', d.get('is_fallback'), '| actual_date:', d.get('actual_date'), '| items:', len(d.get('items',[])))
"
  # Restore picks
  github-digest rank-daily 2>&1 | tail -3

Return comprehensive test results.`,
      outputFormat: '{"success": true/false, "trendingItems": N, "phItems": N, "picksFromNewSources": N, "fallbackWorks": true/false, "message": "..."}'
    },
    outputSchema: { type: 'object', required: ['success', 'picksFromNewSources'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 7 — Deploy to production
// ─────────────────────────────────────────────────────────────────────────────
const deployTask = defineTask('deploy', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Commit, push, deploy to production, install timers, verify',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'DevOps engineer',
      task: `Deploy all source-expansion changes to production at ${args.prodDir}.

Test results: ${JSON.stringify({
  trending: args.trendingResult,
  ph: args.phResult,
  emptyFix: args.emptyFixResult,
  rerank: args.rerankResult,
  test: args.testResult,
})}

STEP 1 — Stage all changed/new files:
git -C ${args.projectDir} add \\
  src/github_digest/radar/github_trending_ingestion.py \\
  src/github_digest/radar/producthunt_ingestion.py \\
  src/github_digest/radar/ranking.py \\
  src/github_digest/cli.py \\
  src/github_digest/api/app.py \\
  src/github_digest/web/templates/today.html \\
  src/github_digest/web/templates/index.html \\
  run_daily_pipeline.py \\
  config/radar_config.yaml \\
  deploy/systemd/github-digest-rank-refresh.service \\
  deploy/systemd/github-digest-rank-refresh.timer \\
  deploy/systemd/install.sh

STEP 2 — Commit:
git -C ${args.projectDir} commit -m "$(cat <<'COMMITMSG'
Add GitHub Trending + ProductHunt sources, intra-day re-ranking, fix empty Today's 7

New sources:
- github_trending_ingestion.py: scrapes github.com/trending (daily+weekly, no API key)
  Green badge, github_trending_delta scoring, enrich_github_signals pipeline
- producthunt_ingestion.py: parses producthunt.com/feed RSS (stdlib ET, no API key)
  Orange PH badge, ph_tagline in signals

Fixes:
- Empty Today's 7 gap: /api/today falls back to most recent day with picks
  Shows fallback notice in both today.html and index.html

Ranking:
- rank_refresh() in ranking.py: intra-day re-ranking every 2h
  Replaces lowest picks if better candidates score >threshold higher
- rank-refresh CLI command
- github-digest-rank-refresh.service + .timer (every 2h at :10 past even hours)

Pipeline:
- run_daily_pipeline.py: added ingest-github-trending + ingest-producthunt steps
- radar_config.yaml: min_score_delta_for_refresh: 0.05, new fetch intervals

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
COMMITMSG
)"

STEP 3 — Push:
git -C ${args.projectDir} push origin main

STEP 4 — Deploy to production:
sudo git -C ${args.prodDir} pull origin main
sudo -u github-digest ${args.prodDir}/.venv/bin/pip install -e ${args.prodDir}/ -q
sudo systemctl restart github-digest-api.service
sudo systemctl is-active github-digest-api.service

STEP 5 — Install new systemd timer in production:
sudo cp ${args.prodDir}/deploy/systemd/github-digest-rank-refresh.service /etc/systemd/system/
sudo cp ${args.prodDir}/deploy/systemd/github-digest-rank-refresh.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now github-digest-rank-refresh.timer
sudo systemctl is-active github-digest-rank-refresh.timer

STEP 6 — Run new ingest sources in production (populate initial data):
sudo -u github-digest bash -c "cd ${args.prodDir} && .venv/bin/github-digest ingest-github-trending" 2>&1 | tail -3
sudo -u github-digest bash -c "cd ${args.prodDir} && .venv/bin/github-digest ingest-producthunt" 2>&1 | tail -3
sudo -u github-digest bash -c "cd ${args.prodDir} && .venv/bin/github-digest rank-refresh" 2>&1 | tail -3

STEP 7 — Verify production:
curl -s http://localhost:8000/api/today | python3 -c "
import json,sys
d=json.load(sys.stdin)
items=d.get('items',[])
sources={}
for i in items:
    sources[i['source']]=sources.get(i['source'],0)+1
print('Production picks by source:', sources)
print('is_fallback:', d.get('is_fallback'), '| actual_date:', d.get('actual_date'))
for i in items:
    if i['source'] in ('github_trending','producthunt'):
        print(f'  [{i[\"source\"]}] {i[\"title\"][:60]}')
"
curl -s http://localhost:8000/health | python3 -c "import json,sys; d=json.load(sys.stdin); print('radar_items:', d.get('radar_items'), '| picks today:', d.get('daily_picks_today'))"

Return a full summary.`,
      outputFormat: '{"success": true/false, "committed": true/false, "pushed": true/false, "deployed": true/false, "timerInstalled": true/false, "prodPicksBySource": {}, "summary": "..."}'
    },
    outputSchema: { type: 'object', required: ['success', 'summary'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));
