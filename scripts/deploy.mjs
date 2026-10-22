import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEnvironment, readPublishingCredential, validateCredential } from './credentials.mjs';
import { maintenance, maintenanceTarget, waitForRebuild } from './maintenance.mjs';

export async function deploy(environment, options = {}) {
  checkEnvironment(environment);
  const origin = maintenanceTarget(environment, options.origin);
  if (new URL(origin).hostname === 'localhost') throw new Error('Deployment rebuilds must target the deployed Worker, not localhost; unset SITE_URL or select the remote environment URL');
  // Validate the credential's format before deployment; authentication follows it.
  const secret = validateCredential(options.secret ?? readPublishingCredential(environment));
  const result = (options.run ?? spawnSync)('npx', ['wrangler', 'deploy', '--env', environment === 'preview' ? 'preview' : ''], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Worker deployment failed; no rebuild was requested');
  const job = await maintenance('start', environment, undefined, { origin, secret, request: options.request });
  return job;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const environment = process.argv[2];
    const queued = await deploy(environment);
    console.log(`Deployment complete; waiting for rebuild ${queued.id}.`);
    const job = await waitForRebuild(queued, environment, { onProgress: job => console.log(`Rebuild ${job.id}: ${job.status}, ${job.phase}, ${job.processed} processed`) });
    console.log(`Deployment complete; rebuild ${job.id} completed.`);
    console.log(`Check: npm run rebuild:status -- ${environment} ${job.id}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
