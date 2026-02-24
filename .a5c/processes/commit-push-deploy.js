/**
 * @process github-digest/commit-push-deploy
 * @description Commit staged changes, push to remote, deploy to production at /opt/github-digest
 *
 * @inputs { commitMessage?: string, files?: string[] }
 * @outputs { committed: boolean, pushed: boolean, deployed: boolean, summary: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

export async function process(inputs, ctx) {
  const projectDir = inputs.projectDir || '/home/ubuntu/projects/github-digest';
  const prodDir = inputs.prodDir || '/opt/github-digest';
  const files = inputs.files || ['src/github_digest/db/migrations.py', 'src/github_digest/radar/card_generator.py'];
  const commitMessage = inputs.commitMessage || 'Fix migration idempotency and add missing os import';

  // ============================================================================
  // PHASE 1: Commit changes
  // ============================================================================
  const commit = await ctx.task(commitTask, { projectDir, files, commitMessage });

  // ============================================================================
  // PHASE 2: Push to remote
  // ============================================================================
  const push = await ctx.task(pushTask, { projectDir, commitResult: commit });

  // ============================================================================
  // PHASE 3: Deploy to production
  // ============================================================================
  const deploy = await ctx.task(deployTask, { prodDir, pushResult: push });

  // ============================================================================
  // PHASE 4: Verify production
  // ============================================================================
  const verify = await ctx.task(verifyTask, { prodDir, deployResult: deploy });

  return {
    committed: commit.success,
    pushed: push.success,
    deployed: deploy.success,
    summary: verify.summary
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const commitTask = defineTask('git-commit', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Commit changed files',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Git expert',
      task: `Commit the following files in the git repo at ${args.projectDir}:
Files to commit: ${JSON.stringify(args.files)}
Commit message: "${args.commitMessage}"

Steps:
1. Run: git -C ${args.projectDir} add ${args.files.join(' ')}
2. Run: git -C ${args.projectDir} commit -m "${args.commitMessage}\\n\\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
3. Verify the commit was created with: git -C ${args.projectDir} log --oneline -1
4. Return the result.

If there is nothing to commit (already committed), that is also a success.`,
      outputFormat: '{"success": true/false, "commitHash": "short hash or null", "message": "what happened"}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

const pushTask = defineTask('git-push', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Push to remote origin main',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Git expert',
      task: `Push the local main branch to remote origin in the git repo at ${args.projectDir}.

Steps:
1. Run: git -C ${args.projectDir} push origin main
2. Verify with: git -C ${args.projectDir} log --oneline origin/main -1
3. Return the result.`,
      outputFormat: '{"success": true/false, "message": "what happened"}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

const deployTask = defineTask('deploy-prod', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Deploy to production /opt/github-digest',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'DevOps engineer',
      task: `Deploy the latest changes to production at ${args.prodDir}.

The correct deploy sequence (from MEMORY.md) is:
1. sudo git -C ${args.prodDir} pull origin main
2. sudo -u github-digest ${args.prodDir}/.venv/bin/pip install -e ${args.prodDir}/ -q
3. sudo systemctl restart github-digest-api.service
4. sudo systemctl status github-digest-api.service --no-pager -l (verify it is running)

Run these commands in order. Return what happened.`,
      outputFormat: '{"success": true/false, "gitPullOutput": "...", "serviceStatus": "active/failed/...", "message": "what happened"}'
    },
    outputSchema: { type: 'object', required: ['success'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));

const verifyTask = defineTask('verify-prod', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Verify production is running correctly',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer',
      task: `Verify production deployment at ${args.prodDir} is healthy.

Steps:
1. Check git log in prod: sudo git -C ${args.prodDir} log --oneline -3
2. Check service health: sudo systemctl is-active github-digest-api.service
3. Check the API health endpoint: curl -s http://localhost:8000/health
4. Compare prod git HEAD with dev:
   - dev HEAD: git -C /home/ubuntu/projects/github-digest log --oneline -1
   - prod HEAD: sudo git -C ${args.prodDir} log --oneline -1
5. Confirm the commits match.

Return a comprehensive summary.`,
      outputFormat: '{"success": true/false, "prodCommit": "hash", "devCommit": "hash", "inSync": true/false, "serviceActive": true/false, "summary": "human-readable summary"}'
    },
    outputSchema: { type: 'object', required: ['summary'] }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/output.json`
  }
}));
