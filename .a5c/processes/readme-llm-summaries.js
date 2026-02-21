/**
 * @process github-digest/readme-llm-summaries
 * @description Fetch README files from GitHub repos stored in the DB, generate
 *              LLM summaries using Llama 3 via Ollama (local), and store them
 *              in repo_summaries. Processes max 15 repos.
 * @inputs { maxRepos: number, ollamaModel: string }
 * @outputs { success: boolean, summarized: number, findings: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

export async function process(inputs, ctx) {
  const maxRepos = inputs.maxRepos ?? 15;
  const ollamaModel = inputs.ollamaModel ?? 'llama3.2';
  const projectDir = '/home/ubuntu/projects/github-digest';
  const dbPath = `${projectDir}/data/github_digest.db`;

  // ============================================================================
  // STEP 1: Ensure Ollama is running and the Llama3 model is available
  // ============================================================================

  const ollamaResult = await ctx.task(ensureOllamaTask, {
    ollamaModel,
  });

  // ============================================================================
  // STEP 2: Implement the README + LLM summarizer Python module
  // ============================================================================

  const implementResult = await ctx.task(implementLlmSummarizerTask, {
    projectDir,
    ollamaModel,
    ollamaBaseUrl: ollamaResult.baseUrl,
  });

  // ============================================================================
  // STEP 3: Run the LLM summarizer for up to maxRepos repos
  // ============================================================================

  const runResult = await ctx.task(runLlmSummarizerTask, {
    projectDir,
    dbPath,
    maxRepos,
    ollamaModel,
  });

  // ============================================================================
  // STEP 4: Verify summaries are in the DB and accessible via API
  // ============================================================================

  const verifyResult = await ctx.task(verifySummariesTask, {
    projectDir,
    dbPath,
  });

  return {
    success: verifyResult.success,
    summarized: runResult.summarized,
    findings: verifyResult.findings,
  };
}

// ============================================================================
// TASK 1: Ensure Ollama is running with Llama3 model
// ============================================================================

const ensureOllamaTask = defineTask('ensure-ollama', (args) => ({
  kind: 'agent',
  title: 'Ensure Ollama is running with Llama3 model',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Systems engineer',
      task: `Ensure Ollama is installed, running, and the ${args.ollamaModel} model is available locally.`,
      context: {
        ollamaModel: args.ollamaModel,
        ollamaDefaultPort: 11434,
      },
      instructions: [
        'Check if ollama is installed: which ollama',
        'If not installed, install it via: curl -fsSL https://ollama.com/install.sh | sh',
        'Check if ollama service is running: curl -s http://localhost:11434/api/tags or systemctl is-active ollama',
        'If ollama is not running, start it in background: ollama serve &> /tmp/ollama.log & sleep 3',
        `Check if model ${args.ollamaModel} is already pulled: ollama list | grep ${args.ollamaModel}`,
        `If the model is not available, pull it: ollama pull ${args.ollamaModel}`,
        'Verify ollama responds: curl -s http://localhost:11434/api/tags | head -c 200',
        `Test the model with a quick inference: curl -s http://localhost:11434/api/generate -d '{"model":"${args.ollamaModel}","prompt":"Say hello in 5 words","stream":false}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('response',''))"`,
        'Report the ollama base URL (http://localhost:11434), whether model is ready, and any issues',
      ],
      outputFormat: 'JSON object with: ollamaInstalled, modelAvailable, baseUrl, testResponse, findings',
    },
    outputSchema: {
      type: 'object',
      required: ['ollamaInstalled', 'modelAvailable', 'baseUrl'],
      properties: {
        ollamaInstalled: { type: 'boolean' },
        modelAvailable: { type: 'boolean' },
        baseUrl: { type: 'string' },
        testResponse: { type: 'string' },
        findings: { type: 'string' },
      },
    },
  },
  io: {
    inputJsonPath: `tasks/ensure-ollama/input.json`,
    outputJsonPath: `tasks/ensure-ollama/result.json`,
  },
}));

// ============================================================================
// TASK 2: Implement the LLM README summarizer Python module
// ============================================================================

const implementLlmSummarizerTask = defineTask('implement-llm-summarizer', (args) => ({
  kind: 'agent',
  title: 'Implement README-based LLM summarizer',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Python engineer',
      task: 'Add a README-based LLM summarizer to the github-digest project that uses Ollama/Llama3 to generate repo summaries from README content.',
      context: {
        projectDir: args.projectDir,
        ollamaModel: args.ollamaModel,
        ollamaBaseUrl: args.ollamaBaseUrl || 'http://localhost:11434',
        existingFiles: {
          summarizer: `${args.projectDir}/src/github_digest/services/summarizer.py`,
          githubClient: `${args.projectDir}/src/github_digest/services/github_client.py`,
          models: `${args.projectDir}/src/github_digest/db/models.py`,
          cli: `${args.projectDir}/src/github_digest/cli.py`,
          config: `${args.projectDir}/src/github_digest/config.py`,
        },
        existingSummarizer: 'summarizer.py has: summarize_repos(model_fn=...) which accepts a callable model_fn(repo: Repo) -> dict. The dict must have: summary (2-3 sentences, max 600 chars), why_interesting (1 sentence ending in period), tags (JSON string of 3-6 strings), model (str), source (str).',
        validationRules: {
          summary: '2-3 sentences, max 600 chars',
          why_interesting: 'exactly 1 sentence (one period at end)',
          tags: 'JSON string of list with 3-6 string items',
        },
      },
      instructions: [
        `Read the existing files first: ${args.projectDir}/src/github_digest/services/summarizer.py, ${args.projectDir}/src/github_digest/services/github_client.py, ${args.projectDir}/src/github_digest/cli.py`,
        `Create a new file: ${args.projectDir}/src/github_digest/services/llm_summarizer.py`,
        'This module should contain:',
        '  1. fetch_readme(full_name, github_token=None) -> str: fetches README from GitHub API (GET https://api.github.com/repos/{full_name}/readme), decodes base64 content, returns truncated text (max 4000 chars). Returns empty string if not found.',
        '  2. build_llm_prompt(repo, readme_content) -> str: builds a prompt asking the LLM to output a JSON with summary, why_interesting, tags fields from the repo name, description, topics, stars, and README content.',
        '  3. call_ollama(prompt, model, base_url) -> dict: calls POST http://localhost:11434/api/generate with {"model": model, "prompt": prompt, "stream": false}. Extracts the JSON from the response text using json extraction (look for first { ... } block). Returns the parsed dict.',
        '  4. make_llm_model_fn(github_token=None, ollama_model="llama3.2", ollama_base_url="http://localhost:11434") -> Callable: returns a model_fn(repo) -> dict that fetches README, builds prompt, calls ollama, and returns the payload with model/source fields set.',
        'The prompt should instruct the LLM to output ONLY a JSON object like: {"summary": "2-3 sentences about what this project is and does.", "why_interesting": "One sentence on why this is interesting.", "tags": ["tag1", "tag2", "tag3"]}',
        'The prompt should emphasize: summary must be 2-3 complete sentences (ending with periods), why_interesting must be exactly 1 sentence, tags must be 3-6 lowercase strings.',
        'In the model_fn, after getting the LLM response, set payload["model"] = ollama_model and payload["source"] = "readme-llm".',
        'Also add tags fallback: if LLM returns fewer than 3 tags, supplement with repo topics or language.',
        `Now add a CLI subcommand to ${args.projectDir}/src/github_digest/cli.py called "summarize-llm" that:`,
        '  - Accepts --limit (default 15), --model (default llama3.2), --ollama-url (default http://localhost:11434), --dry-run, --force flags',
        '  - Calls summarize_repos() with model_fn=make_llm_model_fn(github_token, ollama_model, ollama_base_url)',
        '  - Passes the --limit as the limit parameter',
        '  - Prints the result as JSON',
        'After creating the files, verify the Python syntax: cd to the project dir and run: source .venv/bin/activate && python3 -c "from github_digest.services.llm_summarizer import make_llm_model_fn; print(\'import ok\')"',
        'Also verify the CLI: source .venv/bin/activate && github-digest summarize-llm --help',
        'Fix any syntax errors found.',
        'Report: files created, functions implemented, any issues found, import test result',
      ],
      outputFormat: 'JSON object with: filesCreated, importOk, cliOk, findings',
    },
    outputSchema: {
      type: 'object',
      required: ['filesCreated', 'importOk', 'findings'],
      properties: {
        filesCreated: { type: 'array', items: { type: 'string' } },
        importOk: { type: 'boolean' },
        cliOk: { type: 'boolean' },
        findings: { type: 'string' },
      },
    },
  },
  io: {
    inputJsonPath: `tasks/implement-llm-summarizer/input.json`,
    outputJsonPath: `tasks/implement-llm-summarizer/result.json`,
  },
}));

// ============================================================================
// TASK 3: Run the LLM summarizer for up to maxRepos repos
// ============================================================================

const runLlmSummarizerTask = defineTask('run-llm-summarizer', (args) => ({
  kind: 'agent',
  title: `Run LLM summarizer for up to ${args.maxRepos} repos`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Engineer running the LLM summarization pipeline',
      task: `Execute the LLM summarizer for up to ${args.maxRepos} repos from the GitHub Digest database using Llama3 via Ollama.`,
      context: {
        projectDir: args.projectDir,
        dbPath: args.dbPath,
        maxRepos: args.maxRepos,
        ollamaModel: args.ollamaModel,
        venvPath: `${args.projectDir}/.venv`,
      },
      instructions: [
        `Activate the virtualenv: source ${args.projectDir}/.venv/bin/activate`,
        `Change to the project directory: cd ${args.projectDir}`,
        `First check how many repos are in the DB: python3 -c "import sqlite3; conn=sqlite3.connect('${args.dbPath}'); print('repos:', conn.execute('SELECT COUNT(*) FROM repos').fetchone()[0]); conn.close()"`,
        `Run the LLM summarizer with a limit of ${args.maxRepos}: github-digest summarize-llm --limit ${args.maxRepos} --model ${args.ollamaModel} --force 2>&1`,
        'Wait for it to complete (this may take several minutes as each repo calls the LLM)',
        `If it fails with an error about eligible repos being 0, try running with --force flag to bypass freshness checks: github-digest summarize-llm --limit ${args.maxRepos} --model ${args.ollamaModel} --force 2>&1`,
        'After completion, check the summaries in DB: python3 -c "import sqlite3; conn=sqlite3.connect(\'data/github_digest.db\'); rows=conn.execute(\'SELECT r.full_name, s.source, s.summary[:80] FROM repo_summaries s JOIN repos r ON r.id=s.repo_id\').fetchall(); [print(row) for row in rows]; conn.close()"',
        'Count how many summaries have source="readme-llm": python3 -c "import sqlite3; conn=sqlite3.connect(\'data/github_digest.db\'); n=conn.execute(\'SELECT COUNT(*) FROM repo_summaries WHERE source=\\\"readme-llm\\\"\').fetchone()[0]; print(\'llm summaries:\', n); conn.close()"',
        'Report: how many summaries were created, any errors during processing, sample of the summaries generated',
      ],
      outputFormat: 'JSON object with: summarized, errors, sampleSummaries, findings',
    },
    outputSchema: {
      type: 'object',
      required: ['summarized', 'findings'],
      properties: {
        summarized: { type: 'number' },
        errors: { type: 'array', items: { type: 'string' } },
        sampleSummaries: { type: 'array', items: { type: 'object' } },
        findings: { type: 'string' },
      },
    },
  },
  io: {
    inputJsonPath: `tasks/run-llm-summarizer/input.json`,
    outputJsonPath: `tasks/run-llm-summarizer/result.json`,
  },
}));

// ============================================================================
// TASK 4: Verify summaries are in DB and accessible via the API
// ============================================================================

const verifySummariesTask = defineTask('verify-summaries', (args) => ({
  kind: 'agent',
  title: 'Verify LLM summaries in DB and API',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer',
      task: 'Verify that README-based LLM summaries were correctly stored in the database and are accessible via the GitHub Digest API.',
      context: {
        projectDir: args.projectDir,
        dbPath: args.dbPath,
      },
      instructions: [
        `Check total summaries in DB: cd ${args.projectDir} && python3 -c "import sqlite3; conn=sqlite3.connect('${args.dbPath}'); rows=conn.execute('SELECT r.full_name, s.source, s.model, substr(s.summary,1,100) FROM repo_summaries s JOIN repos r ON r.id=s.repo_id ORDER BY s.updated_at DESC LIMIT 10').fetchall(); [print(r) for r in rows]; conn.close()"`,
        'Count summaries by source: python3 -c "import sqlite3; conn=sqlite3.connect(\'data/github_digest.db\'); rows=conn.execute(\'SELECT source, COUNT(*) FROM repo_summaries GROUP BY source\').fetchall(); [print(r) for r in rows]; conn.close()"',
        'Check if the board API is running on port 8000: curl -s http://localhost:8000/health',
        'If running, test that summaries appear: curl -s "http://localhost:8000/board/today?mode=new&limit=5" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(r.get(\'full_name\'), r.get(\'summary\')) for r in d.get(\'repos\',[])[:3]]" 2>/dev/null',
        'Verify a sample summary from the DB looks like a real LLM-generated summary (not the stub template): it should reference specific details from the README, not use generic phrases',
        'Check that the tags field is valid JSON with 3-6 items for llm summaries',
        'Report: total llm summaries count, sample summaries look correct, API shows summaries, any quality issues',
      ],
      outputFormat: 'JSON object with: success, llmSummaryCount, samplesSeemsCorrect, apiShowsSummaries, findings',
    },
    outputSchema: {
      type: 'object',
      required: ['success', 'llmSummaryCount', 'findings'],
      properties: {
        success: { type: 'boolean' },
        llmSummaryCount: { type: 'number' },
        samplesSeemsCorrect: { type: 'boolean' },
        apiShowsSummaries: { type: 'boolean' },
        findings: { type: 'string' },
      },
    },
  },
  io: {
    inputJsonPath: `tasks/verify-summaries/input.json`,
    outputJsonPath: `tasks/verify-summaries/result.json`,
  },
}));
