/**
 * @process github-digest/suggest-source-expansion
 * @description Suggest 3 features to expand source variety, frequency, and change rate.
 * Goal: more sources → more interesting content → higher refresh rate → all tabs always full.
 *
 * @inputs { projectDir: string }
 * @outputs { features: Array<{title, description, sources, rationale, effort, implementation_hint}> }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

export async function process(inputs, ctx) {
  const projectDir = inputs.projectDir || '/home/ubuntu/projects/github-digest';

  const result = await ctx.task(suggestTask, { projectDir });
  return { features: result.features };
}

const suggestTask = defineTask('suggest-source-expansion', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Suggest 3 source-expansion features',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior product strategist for developer tools',
      task: `Analyze the Builder Radar app at ${args.projectDir} and suggest exactly 3 features that expand source variety, increase content frequency, and raise the change rate so all tabs always have fresh, interesting content from many places.

Read these files first:
- ${args.projectDir}/src/github_digest/radar/hn_ingestion.py
- ${args.projectDir}/src/github_digest/radar/devto_ingestion.py
- ${args.projectDir}/src/github_digest/radar/reddit_ingestion.py
- ${args.projectDir}/src/github_digest/radar/ranking.py
- ${args.projectDir}/src/github_digest/cli.py (look at how ingest-hn and ingest-devto are structured)
- ${args.projectDir}/config/radar_config.yaml
- ${args.projectDir}/src/github_digest/api/app.py (look at /api/today and /api/build endpoints)
- ${args.projectDir}/src/github_digest/web/templates/today.html
- ${args.projectDir}/src/github_digest/web/templates/index.html (especially the source badge system)

Current state to understand:
- Sources: HN (Firebase API) + DEV.to (showdev/opensource/buildinpublic tags)
- Reddit is blocked (HTTP 403 from server IPs)
- candidate_window_hours: 48 — only items from last 48h are ranked
- daily_picks_count: 7 — only 7 items picked per day
- reuse_exclusion_days: 3 — items picked recently are excluded
- max_picks_per_source: 5 — diversity cap
- The /build page shows "pairings" of items
- index.html has source badges (orange=HN, blue=#3b49df=DEV.to)

The user's goal: MORE sources feeding the pipeline → MORE interesting/varied content → picks change MORE often → /today, /build and all tabs always have reading material from many different corners of the web.

Think about what public APIs are freely accessible from a server (no auth, no paid tier needed) that produce builder-relevant content with GitHub repo links or tool references. Consider:
- GitHub itself (trending, search API)
- Lobste.rs (has public JSON API at lobste.rs/newest.json, lobste.rs/active.json)
- Product Hunt (has GraphQL API but requires free API key)
- Papers With Code (ML papers + code links)
- arxiv (CS papers)
- GitHub releases/discussions feeds
- npm/PyPI new packages
- etc.

For each of the 3 features, think about:
1. Which NEW source(s) it adds and why they produce interesting builder-relevant content
2. How it fits into the existing ingest → rank → pick pipeline
3. How it affects content variety and change rate
4. What the /today and /build pages would look like with this source mixed in

Return exactly 3 features as JSON:
{
  "features": [
    {
      "title": "...",
      "sources": ["list", "of", "new", "sources", "added"],
      "description": "What it adds and how it works end to end (3-4 sentences, concrete)",
      "content_variety": "How this makes content more varied and interesting",
      "frequency_impact": "How this increases the change rate / freshness",
      "effort": "small|medium|large",
      "implementation_hint": "Concrete steps: new file(s) to create, existing files to modify, key APIs/URLs"
    }
  ]
}`,
      outputFormat: '{"features": [...]}'
    },
    outputSchema: {
      type: 'object',
      required: ['features'],
      properties: { features: { type: 'array', minItems: 3, maxItems: 3 } }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));
