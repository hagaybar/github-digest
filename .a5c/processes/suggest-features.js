/**
 * @process github-digest/suggest-features
 * @description Analyze the Builder Radar app and suggest 3 high-value new features.
 *
 * @inputs { projectDir: string }
 * @outputs { features: Array<{title, description, rationale, effort}> }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

export async function process(inputs, ctx) {
  const projectDir = inputs.projectDir || '/home/ubuntu/projects/github-digest';

  const result = await ctx.task(suggestFeaturesTask, { projectDir });

  return { features: result.features };
}

const suggestFeaturesTask = defineTask('suggest-features', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Suggest 3 new features for Builder Radar',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior product manager and developer',
      task: `Analyze the Builder Radar / GitHub Digest application at ${args.projectDir} and suggest exactly 3 high-value new features.

Read these key files to understand what the app does today:
1. ${args.projectDir}/PRODUCT.md (product spec, if exists)
2. ${args.projectDir}/src/github_digest/api/app.py (API endpoints)
3. ${args.projectDir}/src/github_digest/web/templates/today.html (main UI)
4. ${args.projectDir}/src/github_digest/radar/ranking.py (scoring system)
5. ${args.projectDir}/config/radar_config.yaml (configuration)
6. ${args.projectDir}/src/github_digest/radar/card_generator.py (LLM analysis)

After reading, understand:
- Current sources: HN (Firebase API) + DEV.to (public API)
- Daily 7 picks with LLM-generated "build ideas" cards
- Source diversity enforcement (max 5/7 from one source)
- GitHub star enrichment for items with repo links
- /today page (7 cards), /build page (pairings)
- Historical date navigation

Then propose exactly 3 features that would most enhance the app's value for builders discovering cool tools and projects. Each feature should be:
- Meaningfully different from what exists
- Technically feasible given the stack (Python/FastAPI/SQLite/Jinja2/vanilla JS)
- Ranked by impact vs effort

For each feature provide:
- title: Short punchy name (5 words max)
- description: What it does (2-3 sentences, concrete)
- rationale: Why it adds value for the target user (builders discovering tools)
- effort: "small" (1 day), "medium" (2-3 days), or "large" (1 week+)
- implementation_hint: Key files to change and how`,
      outputFormat: `{
  "features": [
    {
      "title": "...",
      "description": "...",
      "rationale": "...",
      "effort": "small|medium|large",
      "implementation_hint": "..."
    }
  ]
}`
    },
    outputSchema: {
      type: 'object',
      required: ['features'],
      properties: {
        features: {
          type: 'array',
          minItems: 3,
          maxItems: 3
        }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));
