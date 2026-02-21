/**
 * @process github-digest/builder-radar-pivot
 * @description Implement the Builder Radar pivot (Phases 1-6) as specified in github_radar_spec.txt.
 * Transforms the GitHub digest into a Builder Radar: daily feed surfacing cool new tools
 * and actionable build ideas using GitHub + Hacker News cross-platform signals.
 * @inputs { projectDir: string, branch: string }
 * @outputs { success: boolean, phasesCompleted: string[], findings: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

export async function process(inputs, ctx) {
  const projectDir = inputs.projectDir ?? '/home/ubuntu/projects/github-digest';
  const branch = inputs.branch ?? 'github_radar';

  ctx.log('info', `Starting Builder Radar pivot implementation in ${projectDir} on branch ${branch}`);

  // ============================================================================
  // PHASE 1: Documentation - PRODUCT.md + Canonical Schema
  // ============================================================================

  ctx.log('info', 'Phase 1: Creating PRODUCT.md and canonical schema docs');

  const docsResult = await ctx.task(createDocumentationTask, {
    projectDir,
    branch,
  });

  ctx.log('info', `Phase 1 complete: ${docsResult.findings}`);

  // ============================================================================
  // PHASE 2: DB Schema & New Models (ItemV1 tables)
  // ============================================================================

  ctx.log('info', 'Phase 2: Creating DB schema, ORM models, migrations, config.yaml');

  const schemaResult = await ctx.task(createSchemaAndModelsTask, {
    projectDir,
    docsFindings: docsResult.findings,
  });

  ctx.log('info', `Phase 2 complete: ${schemaResult.findings}`);

  // ============================================================================
  // PHASE 3: HN Ingestion Service
  // ============================================================================

  ctx.log('info', 'Phase 3: Implementing Hacker News ingestion service');

  const hnIngestionResult = await ctx.task(createHNIngestionTask, {
    projectDir,
    schemaFindings: schemaResult.findings,
  });

  ctx.log('info', `Phase 3 complete: ${hnIngestionResult.findings}`);

  // ============================================================================
  // PHASE 4: Fusion + Ranking Layer
  // ============================================================================

  ctx.log('info', 'Phase 4: Implementing fusion, deduplication, and ranking layer');

  const rankingResult = await ctx.task(createRankingLayerTask, {
    projectDir,
    schemaFindings: schemaResult.findings,
    hnFindings: hnIngestionResult.findings,
  });

  ctx.log('info', `Phase 4 complete: ${rankingResult.findings}`);

  // ============================================================================
  // PHASE 5: LLM Card Generator
  // ============================================================================

  ctx.log('info', 'Phase 5: Implementing LLM analysis / card generator');

  const llmResult = await ctx.task(createLLMCardGeneratorTask, {
    projectDir,
    rankingFindings: rankingResult.findings,
  });

  ctx.log('info', `Phase 5 complete: ${llmResult.findings}`);

  // ============================================================================
  // PHASE 6: Pairing Engine + UI (/today + /build)
  // ============================================================================

  ctx.log('info', 'Phase 6: Implementing pairing engine and UI routes');

  const pairingUIResult = await ctx.task(createPairingAndUITask, {
    projectDir,
    llmFindings: llmResult.findings,
  });

  ctx.log('info', `Phase 6 complete: ${pairingUIResult.findings}`);

  // ============================================================================
  // PHASE 7: CLI Commands & Daily Pipeline Orchestrator
  // ============================================================================

  ctx.log('info', 'Phase 7: Implementing CLI commands and run_daily_pipeline.py');

  const cliResult = await ctx.task(createCLIAndPipelineTask, {
    projectDir,
    allFindings: {
      docs: docsResult.findings,
      schema: schemaResult.findings,
      hn: hnIngestionResult.findings,
      ranking: rankingResult.findings,
      llm: llmResult.findings,
      pairingUI: pairingUIResult.findings,
    },
  });

  ctx.log('info', `Phase 7 complete: ${cliResult.findings}`);

  // ============================================================================
  // PHASE 8: Tests + Integration Verification
  // ============================================================================

  ctx.log('info', 'Phase 8: Writing tests and verifying integration');

  const testResult = await ctx.task(createTestsAndVerifyTask, {
    projectDir,
    cliFindings: cliResult.findings,
  });

  ctx.log('info', `Phase 8 complete: ${testResult.findings}`);

  // ============================================================================
  // PHASE 9: Final Quality Check & Fix-up
  // ============================================================================

  ctx.log('info', 'Phase 9: Final quality check, lint, and fix-up');

  const qualityResult = await ctx.task(finalQualityCheckTask, {
    projectDir,
    testFindings: testResult.findings,
  });

  ctx.log('info', `Phase 9 complete: ${qualityResult.findings}`);

  return {
    success: qualityResult.success,
    phasesCompleted: [
      'Phase 1: Documentation',
      'Phase 2: DB Schema & Models',
      'Phase 3: HN Ingestion',
      'Phase 4: Fusion & Ranking',
      'Phase 5: LLM Card Generator',
      'Phase 6: Pairing + UI',
      'Phase 7: CLI & Pipeline',
      'Phase 8: Tests',
      'Phase 9: Quality Check',
    ],
    findings: qualityResult.findings,
  };
}

// ============================================================================
// TASK 1: Create Documentation (PRODUCT.md + schemas/item_v1.md)
// ============================================================================

const createDocumentationTask = defineTask('create-documentation', (args) => ({
  kind: 'agent',
  title: 'Create PRODUCT.md and canonical schema docs',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Product architect and technical writer',
      task: 'Create PRODUCT.md and schemas/item_v1.md for the Builder Radar pivot as specified in the spec.',
      context: {
        projectDir: args.projectDir,
        branch: args.branch,
        specFile: `${args.projectDir}/github_radar_spec.txt`,
      },
      instructions: [
        `Read the spec file at ${args.projectDir}/github_radar_spec.txt to understand the full requirements.`,
        `Read the existing codebase: ${args.projectDir}/src/github_digest/ to understand current structure.`,
        `Check current git branch: git -C ${args.projectDir} branch --show-current`,
        `If not on ${args.branch} branch, create and checkout: git -C ${args.projectDir} checkout -b ${args.branch}`,
        `Create ${args.projectDir}/PRODUCT.md with:`,
        '  - Primary user story: "As a builder, I want to discover cool new tools and get concrete project ideas so I can build/learn faster."',
        '  - Daily UX: Today page (7 cards) + Build page (pairings)',
        '  - Input sources v1: GitHub (existing) + Hacker News (new); Reddit/RSS are vNext',
        '  - Output contract: Every surfaced unit = canonical ItemV1 record stored in DB and rendered by UI',
        '  - Keep it crisp, 1 page, no implementation details beyond minimal contract',
        `Create directory ${args.projectDir}/schemas/ if it doesn\'t exist`,
        `Create ${args.projectDir}/schemas/item_v1.md documenting the canonical ItemV1 schema with all fields:`,
        '  - Required fields: id (sha1 hash), source (enum), source_id, url, title, published_at, collected_at',
        '  - github_repo object (optional): full_name, html_url, description, language, stars, forks, open_issues, pushed_at, created_at',
        '  - content object: summary_source_text, readme_excerpt, tags_detected',
        '  - signals object: github_stars_total, github_stars_7d, github_velocity, hn_points, hn_comments, hn_rank',
        '  - tags object: domains, languages, maturity, composable',
        '  - analysis object: unlock, novelty, why_cool, best_start, build_ideas (3 items with size+idea+steps+prerequisites), confidence',
        '  - scores object: cool_score, buildability_score, momentum_score, final_score, score_version',
        '  - daily_pick object: picked_for_date, picked_rank',
        '  - pairing object: paired_with_ids, pairing_rationale',
        'Verify files were created with correct content.',
        'Return JSON with: docsCreated (bool), productMdPath, schemaPath, findings (string summary)',
      ],
      outputFormat: 'JSON with: docsCreated (bool), productMdPath (string), schemaPath (string), findings (string)',
    },
    outputSchema: {
      type: 'object',
      required: ['docsCreated', 'findings'],
      properties: {
        docsCreated: { type: 'boolean' },
        productMdPath: { type: 'string' },
        schemaPath: { type: 'string' },
        findings: { type: 'string' },
      },
    },
  },
}));

// ============================================================================
// TASK 2: Create DB Schema, ORM Models, Migrations, Config
// ============================================================================

const createSchemaAndModelsTask = defineTask('create-schema-models', (args) => ({
  kind: 'agent',
  title: 'Create new DB tables, ORM models, migrations, and config.yaml',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Backend Python engineer specializing in SQLAlchemy and FastAPI',
      task: 'Implement the new database schema (ORM models, migrations, Pydantic ItemV1 model) and config.yaml for the Builder Radar pivot.',
      context: {
        projectDir: args.projectDir,
        specFile: `${args.projectDir}/github_radar_spec.txt`,
        modelsFile: `${args.projectDir}/src/github_digest/db/models.py`,
        migrationsFile: `${args.projectDir}/src/github_digest/db/migrations.py`,
        databaseFile: `${args.projectDir}/src/github_digest/db/database.py`,
        configFile: `${args.projectDir}/src/github_digest/config.py`,
      },
      instructions: [
        `Read all existing files: models.py, migrations.py, database.py, config.py`,
        `Read the spec at ${args.projectDir}/github_radar_spec.txt sections 4 (schema) and 9 (data model)`,
        '',
        '## 1. Create config/radar_config.yaml:',
        `Create ${args.projectDir}/config/radar_config.yaml with:`,
        '```yaml',
        'scoring:',
        '  weights:',
        '    momentum: 0.5',
        '    cool: 0.3',
        '    buildability: 0.2',
        'ranking:',
        '  top_k_for_llm: 30',
        '  daily_picks_count: 7',
        '  candidate_window_hours: 48',
        'ingestion:',
        '  hn_fetch_interval_hours: 2',
        '  hn_top_stories_count: 100',
        'llm:',
        '  enable_llm: false  # set to true to use LLM analysis',
        '  model: "llama3.2"',
        '  ollama_base_url: "http://localhost:11434"',
        '```',
        '',
        '## 2. Add new ORM models to src/github_digest/db/models.py:',
        'Add these new models at the end of the file (keep existing models unchanged):',
        '',
        '### HNStoryRaw model:',
        '- hn_id: String PK (the HN story id as string)',
        '- title: Text',
        '- url: Text nullable',
        '- by: String nullable',
        '- score: Integer nullable',
        '- comments: Integer nullable (maps to "descendants" in HN API)',
        '- time: Integer (unix timestamp)',
        '- raw_json: JSON',
        '- collected_at: DateTime',
        '',
        '### RadarItem model (canonical ItemV1):',
        '- id: String PK (sha1 hash)',
        '- source: String (github/hackernews/reddit/rss/other)',
        '- source_id: String',
        '- url: Text',
        '- title: Text',
        '- published_at: DateTime nullable',
        '- collected_at: DateTime',
        '- github_full_name: String nullable, indexed',
        '- signals_json: JSON nullable',
        '- tags_json: JSON nullable',
        '- scores_json: JSON nullable',
        '- UniqueConstraint on (source, source_id)',
        '',
        '### RadarItemAnalysis model:',
        '- id: Integer PK autoincrement',
        '- item_id: String FK to radar_items.id, indexed',
        '- analysis_version: String default "v1"',
        '- analysis_json: JSON',
        '- created_at: DateTime',
        '- UniqueConstraint on (item_id, analysis_version)',
        '',
        '### DailyPick model:',
        '- date: String (YYYY-MM-DD)',
        '- rank: Integer',
        '- item_id: String FK to radar_items.id',
        '- created_at: DateTime',
        '- PrimaryKey on (date, rank)',
        '',
        '### DailyPairing model:',
        '- id: Integer PK autoincrement',
        '- date: String (YYYY-MM-DD)',
        '- rank: Integer',
        '- item_id_a: String FK to radar_items.id',
        '- item_id_b: String FK to radar_items.id',
        '- rationale: Text',
        '- created_at: DateTime',
        '',
        '## 3. Create src/github_digest/radar/schemas.py:',
        'Create a Pydantic schemas file with ItemV1 model matching the spec schema exactly.',
        'Include all nested models: GithubRepo, Content, Signals, Tags, BuildIdea, Analysis, Scores, DailyPick, Pairing',
        'Add a function: make_item_id(source: str, source_id: str) -> str using sha1',
        '',
        '## 4. Update src/github_digest/db/migrations.py:',
        'Add migration logic for the new tables: hn_story_raw, radar_items, radar_item_analysis, daily_picks, daily_pairings',
        'Use the _table_exists and _column_exists pattern already in migrations.py',
        'Add CREATE TABLE IF NOT EXISTS statements for all new tables with proper indexes',
        '',
        '## 5. Update src/github_digest/db/database.py:',
        'Make sure the create_tables function imports and uses the new models',
        'Import the new radar models: HNStoryRaw, RadarItem, RadarItemAnalysis, DailyPick, DailyPairing',
        '',
        '## 6. Create src/github_digest/radar/__init__.py (empty)',
        '',
        '## Verification:',
        `Run: cd ${args.projectDir} && python3 -c "from github_digest.db.models import HNStoryRaw, RadarItem, RadarItemAnalysis, DailyPick, DailyPairing; print('Models OK')"`,
        `Run: cd ${args.projectDir} && python3 -c "from github_digest.radar.schemas import ItemV1, make_item_id; print('Schemas OK')"`,
        `Run: cd ${args.projectDir} && python3 -c "from github_digest.db.database import create_tables; create_tables(); print('Tables OK')"`,
        'Report any errors and fix them.',
        'Return JSON: filesCreated (list), tablesAdded (list), findings (string)',
      ],
      outputFormat: 'JSON with: filesCreated (array), tablesAdded (array), findings (string)',
    },
    outputSchema: {
      type: 'object',
      required: ['findings'],
      properties: {
        filesCreated: { type: 'array', items: { type: 'string' } },
        tablesAdded: { type: 'array', items: { type: 'string' } },
        findings: { type: 'string' },
      },
    },
  },
}));

// ============================================================================
// TASK 3: HN Ingestion Service
// ============================================================================

const createHNIngestionTask = defineTask('create-hn-ingestion', (args) => ({
  kind: 'agent',
  title: 'Implement Hacker News ingestion service',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Backend Python engineer',
      task: 'Implement the Hacker News ingestion service that fetches HN stories and converts them to ItemV1 candidates.',
      context: {
        projectDir: args.projectDir,
        specFile: `${args.projectDir}/github_radar_spec.txt`,
        radarDir: `${args.projectDir}/src/github_digest/radar/`,
        schemasFile: `${args.projectDir}/src/github_digest/radar/schemas.py`,
        modelsFile: `${args.projectDir}/src/github_digest/db/models.py`,
      },
      instructions: [
        `Read the spec section 5 at ${args.projectDir}/github_radar_spec.txt`,
        `Read existing schemas.py and models.py`,
        `Read the existing github_client.py for HTTP patterns: ${args.projectDir}/src/github_digest/services/github_client.py`,
        '',
        `## Create src/github_digest/radar/hn_ingestion.py:`,
        '',
        'This module must implement:',
        '',
        '### HN API constants:',
        '- HN_TOP_STORIES_URL = "https://hacker-news.firebaseio.com/v0/topstories.json"',
        '- HN_ITEM_URL = "https://hacker-news.firebaseio.com/v0/item/{}.json"',
        '',
        '### extract_github_repo_from_url(url: str) -> str | None:',
        '- Parse GitHub repo URLs like https://github.com/owner/repo',
        '- Return "owner/repo" or None',
        '- Handle trailing slashes, .git suffixes, and subdirectory URLs (return None for those)',
        '',
        '### normalize_url(url: str) -> str:',
        '- Strip tracking parameters (utm_*, ref, etc.)',
        '- Lowercase scheme+host, keep path',
        '- Return normalized URL',
        '',
        '### fetch_hn_top_stories(limit: int = 100) -> list[dict]:',
        '- Fetch top story IDs from HN_TOP_STORIES_URL',
        '- For each story ID (up to limit), fetch item detail from HN_ITEM_URL',
        '- Skip deleted/dead stories',
        '- Return list of raw story dicts',
        '- Use httpx with timeout=10, follow_redirects=True',
        '- Add logging: fetched N stories',
        '',
        '### upsert_hn_story_raw(session, story_dict: dict) -> HNStoryRaw:',
        '- Upsert into hn_story_raw table by hn_id',
        '- Set collected_at = now UTC',
        '- Return the HNStoryRaw record',
        '',
        '### story_to_radar_item(story: HNStoryRaw) -> RadarItem | None:',
        '- Convert HNStoryRaw to a RadarItem',
        '- id = make_item_id("hackernews", str(story.hn_id))',
        '- source = "hackernews", source_id = str(story.hn_id)',
        '- url = story.url or f"https://news.ycombinator.com/item?id={story.hn_id}"',
        '- title = story.title',
        '- published_at = datetime.utcfromtimestamp(story.time) if story.time else None',
        '- signals_json = {"hn_points": story.score, "hn_comments": story.comments}',
        '- github_full_name = extract_github_repo_from_url(story.url) if story.url else None',
        '- Return None if story has no title',
        '',
        '### ingest_hn(db_path: Path, limit: int = 100) -> dict:',
        '- Main entry point for HN ingestion',
        '- Fetch HN stories',
        '- For each story: upsert raw, then upsert/update RadarItem',
        '- When upserting RadarItem: use INSERT OR IGNORE on id, then UPDATE signals_json to merge latest hn signals',
        '- Log: "Ingested N HN stories, M linked to GitHub repos"',
        '- Return {"ingested": N, "github_linked": M}',
        '',
        '## Verify the module works:',
        `Run: cd ${args.projectDir} && python3 -c "from github_digest.radar.hn_ingestion import extract_github_repo_from_url, normalize_url; print(extract_github_repo_from_url('https://github.com/owner/repo')); print(extract_github_repo_from_url('https://example.com')); print('HN ingestion module OK')"`,
        'Report findings and any errors.',
        'Return JSON: fileCreated (string), findings (string)',
      ],
      outputFormat: 'JSON with: fileCreated (string), findings (string)',
    },
    outputSchema: {
      type: 'object',
      required: ['findings'],
      properties: {
        fileCreated: { type: 'string' },
        findings: { type: 'string' },
      },
    },
  },
}));

// ============================================================================
// TASK 4: Fusion + Ranking Layer
// ============================================================================

const createRankingLayerTask = defineTask('create-ranking-layer', (args) => ({
  kind: 'agent',
  title: 'Implement fusion, deduplication, and ranking layer',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Backend Python engineer',
      task: 'Implement the fusion (deduplication), scoring, and daily ranking layer for the Builder Radar.',
      context: {
        projectDir: args.projectDir,
        specFile: `${args.projectDir}/github_radar_spec.txt`,
        radarDir: `${args.projectDir}/src/github_digest/radar/`,
        configFile: `${args.projectDir}/config/radar_config.yaml`,
      },
      instructions: [
        `Read the spec sections 6 (fusion+ranking) at ${args.projectDir}/github_radar_spec.txt`,
        `Read existing files in ${args.projectDir}/src/github_digest/radar/`,
        `Read config/radar_config.yaml`,
        '',
        `## Create src/github_digest/radar/ranking.py:`,
        '',
        '### load_radar_config(config_path: Path) -> dict:',
        '- Load and parse radar_config.yaml using PyYAML (yaml.safe_load)',
        '- Return the config dict',
        '',
        '### deduplicate_items(items: list[RadarItem]) -> list[RadarItem]:',
        '- Deduplicate by preference order:',
        '  1. Same github_full_name (if present and not null)',
        '  2. Same normalized URL',
        '  3. Same source + source_id',
        '- When merging duplicates:',
        '  - Keep item with highest hn_points in signals_json',
        '  - Prefer github_full_name if one record has it',
        '  - Keep earliest collected_at',
        '- Return deduplicated list',
        '',
        '### compute_momentum_score(item: RadarItem) -> float:',
        '- Use signals_json: hn_points, hn_comments, github_stars_total, github_velocity',
        '- momentum = 0',
        '- If hn_points: momentum += log(max(1, hn_points)) / log(1000)  # normalized log scale',
        '- If github_velocity: momentum += min(1.0, github_velocity / 100)',
        '- Return clamp(momentum, 0.0, 1.0)',
        '',
        '### compute_cool_score(item: RadarItem) -> float:',
        '- Placeholder: 0.5 (spec says placeholder until LLM enriches)',
        '- If tags_json has domains or languages, add 0.1',
        '- Return clamp(0.5, 0.0, 1.0)',
        '',
        '### compute_buildability_score(item: RadarItem) -> float:',
        '- Check signals_json for github_full_name',
        '- If github repo present: base = 0.5',
        '- Check description length: if > 50 chars add 0.1',
        '- language known: add 0.1',
        '- Return clamp(score, 0.0, 1.0)',
        '',
        '### score_item(item: RadarItem, weights: dict) -> dict:',
        '- Compute all 3 sub-scores',
        '- final_score = w_momentum*momentum + w_cool*cool + w_buildability*buildability',
        '- Return {"momentum_score": ..., "cool_score": ..., "buildability_score": ..., "final_score": ..., "score_version": "v1"}',
        '',
        '### rank_candidates(db_path: Path, config_path: Path, date_str: str | None = None) -> dict:',
        '- date_str defaults to today (YYYY-MM-DD)',
        '- Load config',
        '- Query RadarItems collected in last candidate_window_hours',
        '- Deduplicate',
        '- Score each item, update scores_json in DB',
        '- Sort by final_score descending',
        '- Select top top_k_for_llm items (default 30)',
        '- Upsert DailyPick rows for top daily_picks_count (default 7) for date_str',
        '  - DELETE existing picks for date_str first, then INSERT',
        '- Log: "Ranked N candidates, selected top 7 for {date_str}, top scores: [title1 (0.xx), ...]"',
        '- Return {"ranked": N, "top_k": top_k, "daily_picks": 7, "date": date_str}',
        '',
        '## Verify:',
        `Run: cd ${args.projectDir} && python3 -c "from github_digest.radar.ranking import load_radar_config, compute_momentum_score; print('Ranking module OK')"`,
        'Report findings.',
        'Return JSON: fileCreated (string), findings (string)',
      ],
      outputFormat: 'JSON with: fileCreated (string), findings (string)',
    },
    outputSchema: {
      type: 'object',
      required: ['findings'],
      properties: {
        fileCreated: { type: 'string' },
        findings: { type: 'string' },
      },
    },
  },
}));

// ============================================================================
// TASK 5: LLM Card Generator
// ============================================================================

const createLLMCardGeneratorTask = defineTask('create-llm-card-generator', (args) => ({
  kind: 'agent',
  title: 'Implement LLM card generator (analysis layer)',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Backend Python engineer with LLM integration experience',
      task: 'Implement the LLM card generator that produces structured analysis fields (unlock, novelty, why_cool, build_ideas) for selected radar items.',
      context: {
        projectDir: args.projectDir,
        specFile: `${args.projectDir}/github_radar_spec.txt`,
        radarDir: `${args.projectDir}/src/github_digest/radar/`,
        existingLlmSummarizer: `${args.projectDir}/src/github_digest/services/llm_summarizer.py`,
        radarConfig: `${args.projectDir}/config/radar_config.yaml`,
      },
      instructions: [
        `Read the spec section 7 (LLM card generator) at ${args.projectDir}/github_radar_spec.txt`,
        `Read existing llm_summarizer.py for patterns`,
        `Read radar schemas.py and models.py`,
        '',
        `## Create src/github_digest/radar/card_generator.py:`,
        '',
        '### build_item_context(item: RadarItem, analysis_existing: RadarItemAnalysis | None) -> str:',
        '- Compile a context bundle for the LLM prompt',
        '- Include: title, url, github_full_name if available',
        '- Include signals: hn_points, hn_comments, github_stars_total from signals_json',
        '- Include tags from tags_json if available',
        '- Truncate any text fields to max 500 chars',
        '- Return as formatted string',
        '',
        '### make_analysis_prompt(context: str) -> str:',
        '- Build the LLM prompt that asks for structured JSON analysis',
        '- Prompt rules from spec:',
        '  - No marketing fluff',
        '  - Must be concrete and testable',
        '  - best_start must be a real pointer',
        '- Output format: JSON object with fields:',
        '  - unlock: string (1 sentence - what does this unlock for a builder)',
        '  - novelty: string (1 sentence - what is novel about this)',
        '  - why_cool: list of 2-4 strings (bullets)',
        '  - best_start: string (file path / README section / demo link)',
        '  - build_ideas: list of exactly 3 objects, each with: size (small|medium|spicy), idea (string), steps (list of strings), prerequisites (list of strings)',
        '  - confidence: float 0.0-1.0',
        '- Add instruction: "Respond ONLY with valid JSON, no markdown code blocks"',
        '- Return the prompt string',
        '',
        '### parse_analysis_response(response_text: str) -> dict | None:',
        '- Try to parse JSON from response_text',
        '- Handle markdown code blocks (strip ```json ... ```)',
        '- Validate: must have unlock, novelty, why_cool, best_start, build_ideas (list of 3), confidence',
        '- Return parsed dict or None if invalid',
        '',
        '### analyze_item_with_ollama(item: RadarItem, ollama_base_url: str, model: str) -> dict | None:',
        '- Use httpx to call Ollama API: POST {ollama_base_url}/api/generate',
        '- payload: {"model": model, "prompt": prompt, "stream": false}',
        '- timeout=60',
        '- Parse response["response"]',
        '- Try parse_analysis_response',
        '- If invalid: retry once with "Fix the JSON only, return valid JSON:" + response_text',
        '- If still invalid: log error, return None',
        '',
        '### analyze_daily_picks(db_path: Path, config_path: Path, date_str: str | None = None, enable_llm: bool = False) -> dict:',
        '- date_str defaults to today',
        '- Load config',
        '- Query DailyPick rows for date_str (up to top_k_for_llm = 30 from config)',
        '- For each item in top_k_for_llm selected items (not just 7):',
        '  - Query RadarItemAnalysis for item_id, skip if already has analysis for "v1"',
        '  - If enable_llm is False: skip LLM call, store null analysis with note "llm_disabled"',
        '  - If enable_llm is True: call analyze_item_with_ollama',
        '  - Upsert RadarItemAnalysis with analysis_json (or null)',
        '- Log: "Analyzed N/M items for {date_str}"',
        '- Return {"analyzed": N, "total": M, "date": date_str, "llm_enabled": enable_llm}',
        '',
        '## Verify:',
        `Run: cd ${args.projectDir} && python3 -c "from github_digest.radar.card_generator import make_analysis_prompt, parse_analysis_response; print('Card generator OK')"`,
        'Report findings.',
        'Return JSON: fileCreated (string), findings (string)',
      ],
      outputFormat: 'JSON with: fileCreated (string), findings (string)',
    },
    outputSchema: {
      type: 'object',
      required: ['findings'],
      properties: {
        fileCreated: { type: 'string' },
        findings: { type: 'string' },
      },
    },
  },
}));

// ============================================================================
// TASK 6: Pairing Engine + UI Routes
// ============================================================================

const createPairingAndUITask = defineTask('create-pairing-and-ui', (args) => ({
  kind: 'agent',
  title: 'Implement pairing engine and UI routes (/today, /build)',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Full-stack Python/FastAPI engineer',
      task: 'Implement the pairing engine and new UI routes /today and /build for the Builder Radar.',
      context: {
        projectDir: args.projectDir,
        specFile: `${args.projectDir}/github_radar_spec.txt`,
        radarDir: `${args.projectDir}/src/github_digest/radar/`,
        apiAppFile: `${args.projectDir}/src/github_digest/api/app.py`,
        templatesDir: `${args.projectDir}/src/github_digest/web/templates/`,
        existingTemplate: `${args.projectDir}/src/github_digest/web/templates/index.html`,
      },
      instructions: [
        `Read the spec sections 8 (pairing + UI) at ${args.projectDir}/github_radar_spec.txt`,
        `Read the existing api/app.py and templates/index.html for patterns`,
        `Read radar schemas.py and models.py`,
        '',
        '## Step 1: Create src/github_digest/radar/pairing.py:',
        '',
        '### COMPLEMENTARY_PAIRS list:',
        '- Define tag-based pairing rules as list of tuples: (tag_a, tag_b, project_hint)',
        '- Examples: ("crawler", "db", "data pipeline"), ("agents", "devtools", "agent toolkit"),',
        '  ("model", "ui", "AI app"), ("infra", "agents", "self-hosted AI"), ("data", "web", "data app")',
        '',
        '### get_item_tags(item: RadarItem) -> list[str]:',
        '- Extract all tags from tags_json.domains, tags_json.languages, signals as flat list of lowercase strings',
        '- Also extract keywords from title (split by spaces, filter short words)',
        '',
        '### items_are_complementary(item_a: RadarItem, item_b: RadarItem) -> tuple[bool, str]:',
        '- Check COMPLEMENTARY_PAIRS rules against both items\' tags',
        '- Also check: if item_a.github_full_name == item_b.github_full_name: return False (same tool)',
        '- Check: if items share >2 tags and same primary domain: not complementary',
        '- Return (True, rationale_hint) or (False, "")',
        '',
        '### generate_pairings(items: list[RadarItem]) -> list[dict]:',
        '- Generate pairings from a list of items (today\'s picks or top 30)',
        '- For each pair (i, j) where i < j:',
        '  - Call items_are_complementary',
        '  - If complementary: add to pairings list with rationale',
        '- Sort by rationale relevance (longer rationale first as proxy)',
        '- Return top 15 pairings as list of {"item_id_a", "item_id_b", "rationale"}',
        '',
        '### pair_daily(db_path: Path, date_str: str | None = None) -> dict:',
        '- date_str defaults to today',
        '- Query DailyPick items for date_str with their RadarItem data',
        '- Also query top 30 ranked items for the date if available',
        '- Generate pairings',
        '- DELETE existing DailyPairing rows for date_str',
        '- INSERT new DailyPairing rows with rank',
        '- Log: "Generated N pairings for {date_str}"',
        '- Return {"pairings": N, "date": date_str}',
        '',
        '## Step 2: Create HTML templates:',
        '',
        '### Create src/github_digest/web/templates/today.html:',
        '- Modern minimal HTML/CSS (similar style to index.html but adapted)',
        '- Navigation: links to "/" (home), "/today", "/build"',
        '- Header: "Builder Radar — Today\'s 7" with date',
        '- For each card (7 items):',
        '  - Title as clickable link to item URL',
        '  - Source badge (HN / GitHub)',
        '  - If analysis available: unlock sentence, novelty sentence, why_cool bullets, best_start, build_ideas with size badges (small🟢/medium🟡/spicy🔴)',
        '  - If analysis pending: show title + signals + "Analysis pending"',
        '  - Signals: HN points (if available), GitHub stars (if available)',
        '- Uses Jinja2 templating with data passed from API',
        '- Gracefully handles missing fields with fallbacks',
        '',
        '### Create src/github_digest/web/templates/build.html:',
        '- Navigation: links to "/" (home), "/today", "/build"',
        '- Header: "Builder Radar — Build With This"',
        '- For each pairing:',
        '  - Pair title: "ItemA.title + ItemB.title"',
        '  - Rationale text',
        '  - Each item shows: unlock (or title if no analysis), best_start',
        '- Empty state: "No pairings yet for today. Run the pipeline first."',
        '',
        '## Step 3: Add routes to src/github_digest/api/app.py:',
        '',
        'Add these imports: DailyPick, RadarItem, RadarItemAnalysis, DailyPairing',
        'Add these routes:',
        '',
        '### GET /api/today?date=YYYY-MM-DD',
        '- Query DailyPick for date (default today)',
        '- Join with RadarItem and RadarItemAnalysis',
        '- Return JSON list of items with their analysis',
        '- Each item: id, source, url, title, published_at, github_full_name, signals_json, scores_json, analysis (from analysis_json or null)',
        '',
        '### GET /api/build?date=YYYY-MM-DD',
        '- Query DailyPairing for date (default today)',
        '- Join with RadarItem for both item_a and item_b',
        '- Return JSON list of pairings',
        '- Each pairing: rank, item_a (full item+analysis), item_b (full item+analysis), rationale',
        '',
        '### GET /today (HTML)',
        '- Query same data as /api/today',
        '- Render today.html template with items data',
        '',
        '### GET /build (HTML)',
        '- Query same data as /api/build',
        '- Render build.html template with pairings data',
        '',
        '## Verify:',
        `Run: cd ${args.projectDir} && python3 -c "from github_digest.radar.pairing import generate_pairings, pair_daily; print('Pairing OK')"`,
        `Run: cd ${args.projectDir} && python3 -m uvicorn github_digest.api.app:app --host 127.0.0.1 --port 8001 &; sleep 2; curl -s http://127.0.0.1:8001/api/today | head -c 200; kill %1 2>/dev/null || true`,
        'Report findings.',
        'Return JSON: filesCreated (list), routesAdded (list), findings (string)',
      ],
      outputFormat: 'JSON with: filesCreated (array), routesAdded (array), findings (string)',
    },
    outputSchema: {
      type: 'object',
      required: ['findings'],
      properties: {
        filesCreated: { type: 'array', items: { type: 'string' } },
        routesAdded: { type: 'array', items: { type: 'string' } },
        findings: { type: 'string' },
      },
    },
  },
}));

// ============================================================================
// TASK 7: CLI Commands & Daily Pipeline Orchestrator
// ============================================================================

const createCLIAndPipelineTask = defineTask('create-cli-pipeline', (args) => ({
  kind: 'agent',
  title: 'Implement CLI commands and run_daily_pipeline.py',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Backend Python engineer',
      task: 'Add new CLI commands (ingest_hn, build_candidates, rank_daily, analyze_daily, pair_daily) and create the run_daily_pipeline.py orchestrator.',
      context: {
        projectDir: args.projectDir,
        specFile: `${args.projectDir}/github_radar_spec.txt`,
        cliFile: `${args.projectDir}/src/github_digest/cli.py`,
        radarDir: `${args.projectDir}/src/github_digest/radar/`,
        configFile: `${args.projectDir}/config/radar_config.yaml`,
        pyprojectFile: `${args.projectDir}/pyproject.toml`,
      },
      instructions: [
        `Read the spec sections 10 (CLI/jobs) at ${args.projectDir}/github_radar_spec.txt`,
        `Read the existing cli.py to understand patterns`,
        `Read pyproject.toml to understand entry points`,
        '',
        '## Step 1: Add radar CLI commands to src/github_digest/cli.py:',
        '',
        'Add imports for new radar modules at top.',
        '',
        'Add these command functions:',
        '',
        '### cmd_ingest_hn(args):',
        '- Call hn_ingestion.ingest_hn(db_path, limit=100)',
        '- Log results',
        '',
        '### cmd_build_candidates(args):',
        '- Call ranking.deduplicate_and_score(db_path, config_path)',
        '  (or equivalent from ranking module)',
        '- Log results',
        '',
        '### cmd_rank_daily(args):',
        '- Call ranking.rank_candidates(db_path, config_path, date=args.date)',
        '- Log results',
        '',
        '### cmd_analyze_daily(args):',
        '- Call card_generator.analyze_daily_picks(db_path, config_path, date=args.date, enable_llm=args.enable_llm)',
        '- Log results',
        '',
        '### cmd_pair_daily(args):',
        '- Call pairing.pair_daily(db_path, date=args.date)',
        '- Log results',
        '',
        'Add subparsers for: ingest-hn, rank-daily, analyze-daily, pair-daily',
        'Each with --date flag (default None = today)',
        'analyze-daily with --enable-llm flag (default False)',
        '',
        '## Step 2: Create run_daily_pipeline.py in project root:',
        '',
        '```python',
        '#!/usr/bin/env python3',
        '"""Daily pipeline orchestrator for Builder Radar."""',
        '# Runs: ingest_github, ingest_hn, rank_daily, analyze_daily, pair_daily',
        '```',
        '',
        'The script should:',
        '1. Parse args: --date (optional), --enable-llm (flag)',
        '2. Set up logging',
        '3. Step 1: ingest GitHub (call existing fetch_once)',
        '4. Step 2: ingest HN (call ingest_hn)',
        '5. Step 3: rank daily (call rank_candidates)',
        '6. Step 4: analyze daily (call analyze_daily_picks)',
        '7. Step 5: pair daily (call pair_daily)',
        '8. Log summary at each step',
        '9. Handle errors gracefully (log and continue to next step)',
        '',
        '## Step 3: Update pyproject.toml if needed:',
        'Check if there are console_scripts entries. If so, add:',
        '  "github-digest-radar = github_digest.cli:main_radar" (optional, if you create a separate entry)',
        'Otherwise the existing entry point covers it since we\'re adding to cli.py',
        '',
        '## Step 4: Make run_daily_pipeline.py executable:',
        `chmod +x ${args.projectDir}/run_daily_pipeline.py`,
        '',
        '## Verify:',
        `Run: cd ${args.projectDir} && python3 -c "from github_digest.cli import cmd_ingest_hn, cmd_rank_daily; print('CLI commands OK')"`,
        `Run: cd ${args.projectDir} && python3 run_daily_pipeline.py --help`,
        'Report findings.',
        'Return JSON: commandsAdded (list), findings (string)',
      ],
      outputFormat: 'JSON with: commandsAdded (array), findings (string)',
    },
    outputSchema: {
      type: 'object',
      required: ['findings'],
      properties: {
        commandsAdded: { type: 'array', items: { type: 'string' } },
        findings: { type: 'string' },
      },
    },
  },
}));

// ============================================================================
// TASK 8: Tests + Integration Verification
// ============================================================================

const createTestsAndVerifyTask = defineTask('create-tests-verify', (args) => ({
  kind: 'agent',
  title: 'Write unit/integration tests and verify the pipeline',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python test engineer',
      task: 'Write tests for the new radar modules and run the full pipeline end-to-end with fixture data.',
      context: {
        projectDir: args.projectDir,
        specFile: `${args.projectDir}/github_radar_spec.txt`,
        testsDir: `${args.projectDir}/tests/`,
        radarDir: `${args.projectDir}/src/github_digest/radar/`,
      },
      instructions: [
        `Read the spec sections 12 (testing) at ${args.projectDir}/github_radar_spec.txt`,
        `Read existing tests in ${args.projectDir}/tests/ for patterns`,
        `Read the radar module files to understand what to test`,
        '',
        '## Step 1: Create tests/test_hn_ingestion.py:',
        '',
        'Test: extract_github_repo_from_url',
        '- "https://github.com/owner/repo" -> "owner/repo"',
        '- "https://github.com/owner/repo.git" -> "owner/repo"',
        '- "https://github.com/owner/repo/tree/main" -> None (subpath)',
        '- "https://example.com/foo" -> None',
        '- "https://github.com/owner/repo/" -> "owner/repo"',
        '',
        'Test: normalize_url',
        '- Strips utm_source, utm_campaign params',
        '- Preserves path',
        '',
        'Test: story_to_radar_item',
        '- Create a mock HNStoryRaw with all fields set',
        '- Verify item has correct source, source_id, signals_json',
        '',
        '## Step 2: Create tests/test_ranking.py:',
        '',
        'Test: compute_momentum_score',
        '- Item with hn_points=500 -> score > 0',
        '- Item with hn_points=0 -> score = 0',
        '',
        'Test: deduplicate_items',
        '- Two items with same github_full_name -> deduplicated to 1',
        '- Two items with different URLs -> kept as 2',
        '',
        '## Step 3: Create tests/test_schemas.py:',
        '',
        'Test: make_item_id',
        '- Deterministic: same inputs -> same hash',
        '- Different inputs -> different hashes',
        '- Format: 40 hex chars',
        '',
        'Test: ItemV1 Pydantic model',
        '- Can instantiate with minimal required fields',
        '- Validation works for source enum',
        '',
        '## Step 4: Create tests/fixtures/ with sample data:',
        'Create tests/fixtures/hn_stories_sample.json with 3 sample HN story dicts',
        '',
        '## Step 5: Run the pipeline end-to-end with test DB:',
        `Use a temp DB: TMPDB=$(mktemp /tmp/radar_test_XXXX.db)`,
        `Run: cd ${args.projectDir} && python3 -c "`,
        `from pathlib import Path`,
        `import tempfile, os`,
        `tmp = Path('/tmp/radar_test.db')`,
        `tmp.unlink(missing_ok=True)`,
        `from github_digest.db.database import create_tables, get_engine`,
        `from github_digest.db.models import Base`,
        `engine = get_engine(tmp)`,
        `create_tables(engine)`,
        `print('DB setup OK')`,
        `"`,
        '',
        '## Step 6: Run existing + new tests:',
        `cd ${args.projectDir} && python3 -m pytest tests/ -x -v --tb=short 2>&1 | tail -40`,
        'If tests fail: fix the failures before returning.',
        '',
        'Return JSON: testsCreated (list), testsPassed (bool), testResults (string), findings (string)',
      ],
      outputFormat: 'JSON with: testsCreated (array), testsPassed (bool), testResults (string), findings (string)',
    },
    outputSchema: {
      type: 'object',
      required: ['findings', 'testsPassed'],
      properties: {
        testsCreated: { type: 'array', items: { type: 'string' } },
        testsPassed: { type: 'boolean' },
        testResults: { type: 'string' },
        findings: { type: 'string' },
      },
    },
  },
}));

// ============================================================================
// TASK 9: Final Quality Check
// ============================================================================

const finalQualityCheckTask = defineTask('final-quality-check', (args) => ({
  kind: 'agent',
  title: 'Final quality check: lint, tests, API smoke test',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer and code reviewer',
      task: 'Run a final quality check on the Builder Radar implementation: lint, all tests pass, API works, pipeline runs.',
      context: {
        projectDir: args.projectDir,
        specFile: `${args.projectDir}/github_radar_spec.txt`,
      },
      instructions: [
        `Read the spec Definition of Done (section 13) at ${args.projectDir}/github_radar_spec.txt`,
        '',
        '## Step 1: Verify all required files exist:',
        `Check for: PRODUCT.md, schemas/item_v1.md, config/radar_config.yaml`,
        `Check for: src/github_digest/radar/__init__.py, schemas.py, hn_ingestion.py, ranking.py, card_generator.py, pairing.py`,
        `Check for: src/github_digest/web/templates/today.html, build.html`,
        `Check for: run_daily_pipeline.py`,
        `Check for: tests/test_hn_ingestion.py, tests/test_ranking.py, tests/test_schemas.py`,
        '',
        '## Step 2: Run linter:',
        `cd ${args.projectDir} && python3 -m ruff check src/github_digest/radar/ --fix 2>&1 | tail -20`,
        `cd ${args.projectDir} && python3 -m ruff check tests/test_hn_ingestion.py tests/test_ranking.py tests/test_schemas.py --fix 2>&1 | tail -20`,
        '',
        '## Step 3: Run all tests:',
        `cd ${args.projectDir} && python3 -m pytest tests/ -x -v --tb=short 2>&1 | tail -50`,
        'Fix any failing tests.',
        '',
        '## Step 4: Run import checks on all radar modules:',
        `cd ${args.projectDir} && python3 -c "`,
        `from github_digest.radar.schemas import ItemV1, make_item_id`,
        `from github_digest.radar.hn_ingestion import extract_github_repo_from_url, ingest_hn`,
        `from github_digest.radar.ranking import rank_candidates, load_radar_config`,
        `from github_digest.radar.card_generator import make_analysis_prompt, analyze_daily_picks`,
        `from github_digest.radar.pairing import pair_daily, generate_pairings`,
        `print('All radar imports OK')`,
        `"`,
        '',
        '## Step 5: Start API server and test routes:',
        `cd ${args.projectDir} && python3 -m uvicorn github_digest.api.app:app --host 127.0.0.1 --port 8002 &`,
        'sleep 3',
        'curl -s http://127.0.0.1:8002/health',
        'curl -s http://127.0.0.1:8002/api/today',
        'curl -s http://127.0.0.1:8002/api/build',
        'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8002/today',
        'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8002/build',
        'kill %1 2>/dev/null || pkill -f "uvicorn.*8002" || true',
        '',
        '## Step 6: Run pipeline dry-run:',
        `cd ${args.projectDir} && python3 run_daily_pipeline.py --help`,
        '',
        '## Step 7: Fix any remaining issues found in steps 1-6.',
        '',
        '## Step 8: Verify backward compatibility:',
        '- The original GitHub digest endpoints (/board/today, /health, /) must still work',
        `cd ${args.projectDir} && python3 -m uvicorn github_digest.api.app:app --host 127.0.0.1 --port 8003 &`,
        'sleep 2',
        'curl -s http://127.0.0.1:8003/health | python3 -m json.tool',
        'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8003/',
        'kill %1 2>/dev/null || pkill -f "uvicorn.*8003" || true',
        '',
        'Return JSON: success (bool), lintPassed (bool), testsPassed (bool), apiRoutesWorking (list), findings (string)',
      ],
      outputFormat: 'JSON with: success (bool), lintPassed (bool), testsPassed (bool), apiRoutesWorking (array), findings (string)',
    },
    outputSchema: {
      type: 'object',
      required: ['success', 'findings'],
      properties: {
        success: { type: 'boolean' },
        lintPassed: { type: 'boolean' },
        testsPassed: { type: 'boolean' },
        apiRoutesWorking: { type: 'array', items: { type: 'string' } },
        findings: { type: 'string' },
      },
    },
  },
}));
