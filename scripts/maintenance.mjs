import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEnvironment, readCredential } from './credentials.mjs';

const defaults = { preview: 'https://lakearrowheadtown-preview.harold-martin.workers.dev', production: 'https://lakearrowhead.town' };
export function maintenanceTarget(environment, value = process.env.SITE_URL || defaults[environment]) {
  checkEnvironment(environment);
  const url = new URL(value);
  const allowed = environment === 'preview' ? ['lakearrowheadtown-preview.harold-martin.workers.dev'] : ['lakearrowhead.town', 'lakearrowheadtown.harold-martin.workers.dev'];
  const local = environment === 'preview' && url.protocol === 'http:' && url.hostname === 'localhost';
  if (!(local || (url.protocol === 'https:' && allowed.includes(url.hostname) && !url.port)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Refusing to send a publishing credential to an unexpected target; update the maintenance allowlist when changing domains');
  return url.origin;
}
export async function maintenance(operation, environment, id, options = {}) {
  checkEnvironment(environment);
  if (!['start', 'status', 'resume'].includes(operation)) throw new Error('Choose start, status, or resume');
  if (operation !== 'start' && !/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('Provide the rebuild job UUID');
  const origin = maintenanceTarget(environment, options.origin);
  const secret = options.secret ?? readCredential(environment);
  const path = `/api/rebuild${operation === 'start' ? '' : `/${id}${operation === 'resume' ? '/resume' : ''}`}`;
  const response = await (options.request ?? fetch)(origin + path, { method: operation === 'status' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(30000) });
  let result;
  try { result = await response.json(); }
  catch { throw new Error(response.ok ? `Invalid maintenance response (${response.status}): expected JSON` : `Maintenance request failed (${response.status}): non-JSON response`); }
  if (!response.ok) throw new Error(`Maintenance request failed (${response.status}): ${typeof result?.error === 'string' ? result.error : 'Unknown error'}`);
  if (typeof result?.job?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(result.job.id) || !['queued', 'running', 'completed', 'failed'].includes(result.job.status)) throw new Error(`Invalid maintenance response (${response.status}): expected a rebuild job`);
  return result.job;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, environment, id] = process.argv.slice(2);
  try {
    const job = await maintenance(operation, environment, id);
    console.log(JSON.stringify(job, null, 2));
    if (job.status === 'failed' || job.blocked_by) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
