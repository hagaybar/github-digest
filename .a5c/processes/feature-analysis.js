/**
 * @process github-digest/feature-analysis
 * @description Analyze the Builder Radar project holistically and propose
 *              the top three high-impact enhancement features with clear
 *              rationale, feasibility, and implementation sketch.
 *
 * @inputs {}
 * @outputs { topFeatures: Feature[], summary: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

export async function process(inputs, ctx) {

  // ============================================================================
  // PHASE 1: Deep multi-angle project analysis
  // ============================================================================

  const analysis = await ctx.task(deepAnalysisTask, {
    projectDir: '/home/ubuntu/projects/github-digest'
  });

  // ============================================================================
  // PHASE 2: Synthesise top 3 feature proposals
  // ============================================================================

  const proposal = await ctx.task(featureSynthesisTask, {
    analysis
  });

  return {
    topFeatures: proposal.topFeatures,
    summary: proposal.summary
  };
}

// ────────────────────────────────────────────────────────────────────────────

const deepAnalysisTask = defineTask('deep-analysis', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Deep multi-angle project analysis',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior product engineer and analyst',
      task: `Perform a thorough analysis of the Builder Radar project to identify improvement opportunities.

Project root: ${args.projectDir}

Please read and analyse the following (in order):
1. ${args.projectDir}/PRODUCT.md — mission, user story, non-goals
2. ${args.projectDir}/OPERATIONS.md — pipeline architecture, scheduling
3. ${args.projectDir}/src/github_digest/radar/ranking.py — scoring weights & logic
4. ${args.projectDir}/src/github_digest/radar/hn_ingestion.py — HN source limitations
5. ${args.projectDir}/src/github_digest/radar/card_generator.py — LLM prompt quality
6. ${args.projectDir}/src/github_digest/radar/pairing.py — pairing heuristic
7. ${args.projectDir}/config/radar_config.yaml — config knobs
8. ${args.projectDir}/config/saved_searches.json — GitHub search scope
9. ${args.projectDir}/src/github_digest/web/templates/index.html — current UI capabilities
10. Live API — run these commands:
    curl -s http://localhost:8000/api/today | python3 -m json.tool | head -80
    curl -s http://localhost:8000/api/build | python3 -m json.tool | head -40
    curl -s http://localhost:8000/health | python3 -m json.tool

Then analyse these dimensions:
- **Signal quality**: Are HN top-stories the right signal? What's missing?
- **Content quality**: How good is the LLM analysis? What's generic vs. sharp?
- **User experience**: What's missing in the UI for a discovery-focused product?
- **Data freshness**: How well does the pipeline serve a daily-discovery use case?
- **Source diversity**: What sources are absent that would multiply value?
- **Ranking accuracy**: Does the scoring actually surface interesting builder tools?
- **Retention**: Is there anything to bring users back beyond the first visit?

Return a structured JSON analysis report covering all the above dimensions with concrete observations (not vague generalities). Be specific — cite exact files, line numbers, config values, or live API responses where relevant.`,
      outputFormat: `{
  "signalQuality": { "strengths": [], "gaps": [], "evidence": "" },
  "contentQuality": { "strengths": [], "gaps": [], "evidence": "" },
  "userExperience": { "strengths": [], "gaps": [], "evidence": "" },
  "dataFreshness": { "strengths": [], "gaps": [], "evidence": "" },
  "sourceDiversity": { "currentSources": [], "missingSources": [], "impact": "" },
  "rankingAccuracy": { "strengths": [], "gaps": [], "evidence": "" },
  "retention": { "currentMechanisms": [], "missingMechanisms": [] },
  "topOpportunities": ["opportunity1", "opportunity2", "opportunity3", "opportunity4", "opportunity5"]
}`
    },
    outputSchema: {
      type: 'object',
      required: ['topOpportunities'],
      properties: {
        signalQuality: { type: 'object' },
        contentQuality: { type: 'object' },
        userExperience: { type: 'object' },
        sourceDiversity: { type: 'object' },
        rankingAccuracy: { type: 'object' },
        retention: { type: 'object' },
        topOpportunities: { type: 'array', items: { type: 'string' } }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

// ────────────────────────────────────────────────────────────────────────────

const featureSynthesisTask = defineTask('feature-synthesis', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Synthesise top 3 enhancement proposals',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior product strategist',
      task: `Based on the following project analysis, select and articulate the top THREE enhancement features for Builder Radar.

Analysis input:
${JSON.stringify(args.analysis, null, 2)}

Selection criteria (rank features that score well across all three):
1. **Impact** — meaningful improvement to the core mission: "surface interesting new tools and turn them into build ideas"
2. **Feasibility** — can be implemented incrementally without breaking production; compatible with the existing Python/FastAPI/SQLite/Ollama stack on ARM64
3. **Leverage** — improves multiple dimensions at once (e.g., better signals AND better cards)

For each of the top 3 features, provide:
- A crisp feature name (5 words max)
- A one-sentence pitch (what it does + why it matters to the builder user)
- The core problem it solves (reference specific evidence from the analysis)
- Implementation sketch: key files to change, new components needed, estimated scope (S/M/L)
- The metric that would confirm success

Return exactly 3 features, ordered from highest to lowest priority.`,
      outputFormat: `{
  "topFeatures": [
    {
      "rank": 1,
      "name": "Feature Name",
      "pitch": "One-sentence pitch",
      "problemSolved": "Specific problem with evidence",
      "implementationSketch": {
        "keyChanges": ["file/component: what changes"],
        "newComponents": ["new thing needed"],
        "scope": "S|M|L",
        "estimatedFiles": 3
      },
      "successMetric": "How you'd know it worked"
    }
  ],
  "summary": "2-3 sentence narrative of the overall recommendation"
}`
    },
    outputSchema: {
      type: 'object',
      required: ['topFeatures', 'summary'],
      properties: {
        topFeatures: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: {
            type: 'object',
            required: ['rank', 'name', 'pitch', 'problemSolved', 'implementationSketch', 'successMetric']
          }
        },
        summary: { type: 'string' }
      }
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));
