import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unstable_readConfig } from 'wrangler';
import { readPublishingCredential, validateCredential } from './credentials.mjs';
import { deploy } from './deploy.mjs';
import { maintenanceTarget, waitForRebuild } from './maintenance.mjs';
import { smoke } from './smoke-preview.mjs';
import { smokeThumbnails } from './smoke-thumbnails.mjs';
import { createSmokeContext, withCleanup } from './smoke-support.mjs';
import { reportFailure, safeFailure, ValidationError } from './validation-errors.mjs';

export function validateCandidate(candidate, expected) {
  assert.equal(candidate.state, 'OPEN', 'Candidate PR is no longer open');
  assert.equal(candidate.isCrossRepository, false, 'Import fork changes into a trusted repository branch');
  assert.equal(candidate.headRefOid, expected.head, 'Candidate was superseded by another push');
  assert.equal(candidate.baseRefOid, expected.base, 'Candidate base changed; update and retest');
}
export function versionForTag(versions, tag) {
  assert(Array.isArray(versions), 'Invalid Worker version inventory');
  const matches = versions.filter(version => version.annotations?.['workers/tag'] === tag);
  assert.equal(matches.length, 1, 'Expected one candidate Worker version');
  assert.match(matches[0].id, /^[a-f0-9-]{36}$/); return matches[0].id;
}
export async function previewCI(options = {}) {
  const variables = options.variables ?? process.env;
  const directory = options.artifactsDirectory ?? '.artifacts/preview';
  const result = { candidate_sha: null, pr: null, status: 'failed', stage: 'configuration' };
  const secrets = Object.entries(variables).filter(([key]) => /TOKEN|SECRET|KEY/.test(key)).map(([, value]) => value);
  return withCleanup(async () => {
    try {
      if (variables.GITHUB_ACTIONS === 'true') for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'PREVIEW_API_SECRET']) assert(variables[name], `Missing CI configuration: ${name}`);
      const origin = maintenanceTarget('preview', options.origin);
      let secret;
      try { secret = validateCredential((options.credential ?? readPublishingCredential)('preview')); }
      catch (cause) { throw new ValidationError('credential_invalid', 'Publishing credential is invalid or unavailable', { cause }); }
      secrets.push(secret);
      const execute = options.command ?? (args => execFileSync(args[0], args.slice(1), { encoding: 'utf8' }));
      const command = async args => {
        try { return await execute(args); }
        catch (cause) { throw new ValidationError('command_failed', `Command failed: ${args[0]} ${args[1]}`, { cause }); }
      };
      result.stage = 'candidate';
      const sha = options.sha?.trim() || variables.CANDIDATE_SHA?.trim() || String(await command(['git', 'rev-parse', 'HEAD'])).trim();
      assert.match(sha, /^[a-f0-9]{40}$/, 'Candidate SHA must be 40 lowercase hexadecimal characters');
      result.candidate_sha = sha;
      const pr = variables.CANDIDATE_PR;
      const inspect = async () => {
        assert.match(pr, /^\d+$/, 'Candidate PR must be numeric');
        result.pr = pr;
        const candidate = JSON.parse(await command(['gh', 'pr', 'view', pr, '--repo', 'hbmartin/lakearrowheadtown', '--json', 'state,isCrossRepository,headRefOid,baseRefOid']));
        validateCandidate(candidate, { head: variables.CANDIDATE_HEAD_SHA, base: variables.CANDIDATE_BASE_SHA });
      };
      if (pr) await inspect();
      const tag = `ci-${sha.slice(0, 12)}-${variables.GITHUB_RUN_ID ?? crypto.randomUUID()}-${variables.GITHUB_RUN_ATTEMPT ?? '1'}`;
      result.tag = tag; result.stage = 'deployment';
      const queued = await (options.deploy ?? deploy)('preview', { secret, origin, tag, message: `API validation ${sha}`, request: options.request });
      const versions = JSON.parse(await command(['npx', 'wrangler', 'versions', 'list', '--env', 'preview', '--json']));
      result.worker_version = versionForTag(versions, tag); result.rebuild_id = queued.id;
      const config = options.config ?? unstable_readConfig({ config: 'wrangler.jsonc', env: 'preview' });
      assert(['true', 'false'].includes(config.vars?.ALERT_CONFIRMATIONS_ENABLED), 'Preview confirmation mode must be explicit');
      const common = { ...options, credential: () => secret, expectedVersion: result.worker_version,
        expectedConfirmations: config.vars.ALERT_CONFIRMATIONS_ENABLED === 'true', candidateSha: sha, artifactsDirectory: directory };
      const context = createSmokeContext(origin, { ...common, artifactName: 'rebuild' });
      result.stage = 'rebuild';
      await context.run(() => (options.wait ?? waitForRebuild)(queued, 'preview', { ...common, secret, origin, request: context.request, timeoutMs: 300000 }));
      result.stage = 'smoke';
      await (options.smoke ?? smoke)([origin, '--verify-edge'], common);
      result.stage = 'thumbnails';
      await (options.thumbnails ?? smokeThumbnails)([origin], common);
      // A final version check catches deployment drift after the last fixture write.
      const finalContext = createSmokeContext(origin, { ...common, artifactName: 'final-version' });
      await finalContext.run(async () => { const response = await finalContext.request(origin + '/api/posts?fields=index', { headers: finalContext.headers }); assert.equal(response.status, 200); });
      result.stage = 'final_candidate';
      if (pr) await inspect();
      result.status = 'passed'; return result;
    } catch (error) { result.failure = safeFailure(error, secrets); throw error; }
  }, async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await previewCI())); }
  catch (error) { reportFailure('Preview API validation failed; inspect .artifacts/preview', error); process.exitCode = 1; }
}
