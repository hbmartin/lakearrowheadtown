import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEnvironment, readCredential } from './credentials.mjs';
import { maintenance, maintenanceTarget } from './maintenance.mjs';

export async function deploy(environment, options = {}) {
  checkEnvironment(environment);
  const origin = maintenanceTarget(environment, options.origin);
  if (new URL(origin).hostname === 'localhost') throw new Error('Deployment rebuilds must target the deployed Worker, not localhost; unset SITE_URL or select the remote environment URL');
  // Fail before deployment when the local credential/setup is missing.
  const secret = options.secret ?? readCredential(environment);
  const result = (options.run ?? spawnSync)('npx', ['wrangler', 'deploy', '--env', environment === 'preview' ? 'preview' : ''], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Worker deployment failed; no rebuild was requested');
  const job = await maintenance('start', environment, undefined, { origin, secret, request: options.request });
  return job;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const environment = process.argv[2];
    const job = await deploy(environment);
    console.log(`Deployment complete; rebuild ${job.id} durably queued (not yet completed).`);
    console.log(`Check: npm run rebuild:status -- ${environment} ${job.id}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
