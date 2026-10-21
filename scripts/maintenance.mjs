import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkEnvironment, readPublishingCredential, validateCredential } from './credentials.mjs';

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
  if (!['start', 'status', 'resume', 'snapshot', 'repair'].includes(operation)) throw new Error('Choose start, status, resume, snapshot, or repair');
  if (['status', 'resume'].includes(operation) && !/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('Provide the rebuild job UUID');
  const origin = maintenanceTarget(environment, options.origin);
  const secret = validateCredential(options.secret ?? readPublishingCredential(environment));
  const repairing = operation === 'repair' || operation === 'snapshot';
  const payload = operation === 'repair' ? options.payload ?? JSON.parse(await readFile(id, 'utf8')) : undefined;
  if (operation === 'repair' && (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || typeof payload.expected_version !== 'string' || !payload.expected_version
    || typeof payload.manifest !== 'string' || !/^publications\/[a-f0-9-]{36}\.json$/.test(payload.manifest)
    || typeof payload.rss !== 'string' || !/^publications\/[a-f0-9-]{36}\.rss\.xml$/.test(payload.rss)
    || payload.archives !== null && (typeof payload.archives !== 'string' || !/^archive-catalogs\/[a-f0-9]{64}\.json$/.test(payload.archives)))) throw new Error('Invalid repair payload');
  const path = repairing ? '/api/publication/repair' : `/api/rebuild${operation === 'start' ? '' : `/${id}${operation === 'resume' ? '/resume' : ''}`}`;
  const response = await (options.request ?? fetch)(origin + path, { method: ['status', 'snapshot'].includes(operation) ? 'GET' : 'POST', headers: { Authorization: `Bearer ${secret}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(30000) });
  let result;
  try { result = await response.json(); }
  catch { throw new Error(response.ok ? `Invalid maintenance response (${response.status}): expected JSON` : `Maintenance request failed (${response.status}): non-JSON response`); }
  if (!response.ok) {
    const failure = new Error(`Maintenance request failed (${response.status}): ${typeof result?.error === 'string' ? result.error : 'Unknown error'}`);
    failure.code = result?.code;
    failure.retryAt = result?.retry_at;
    throw failure;
  }
  if (repairing) {
    const head = result?.publication;
    if (!head || typeof head.version !== 'string' || !head.version || !['manifest', 'rss', 'archives'].every(key => head[key] === null || typeof head[key] === 'string')) throw new Error(`Invalid maintenance response (${response.status}): expected a publication snapshot`);
    return result;
  }
  if (typeof result?.job?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(result.job.id) || !['queued', 'running', 'completed', 'failed'].includes(result.job.status)) throw new Error(`Invalid maintenance response (${response.status}): expected a rebuild job`);
  return result.job;
}
export async function repairAndFollow(environment, file, options = {}) {
  const payload = options.payload ?? JSON.parse(await readFile(file, 'utf8'));
  const started = Date.now();
  const wait = options.sleep ?? sleep;
  let result;
  while (true) {
    try { result = await maintenance('repair', environment, undefined, { ...options, payload }); break; }
    catch (error) {
      if (error.code !== 'publication_conflict' || Date.now() - started > 300000) throw error;
      await wait(Math.min(30000, Math.max(1000, Date.parse(error.retryAt) - Date.now() || 1000)));
    }
  }
  options.onProgress?.(result);
  if (result.job) {
    while (!['completed', 'failed'].includes(result.job.status) && !result.job.blocked_by) {
      await wait(Math.min(30000, Math.max(1000, Date.parse(result.job.next_retry_at) - Date.now() || 1000)));
      result.job = await maintenance('status', environment, result.job.id, options);
      options.onProgress?.(result);
    }
    if (result.job.status === 'failed' || result.job.blocked_by) throw new Error(`Repair committed; rebuild ${result.job.id} failed or is blocked. Inspect rebuild status.`);
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, environment, id] = process.argv.slice(2);
  try {
    if (operation === 'repair') await repairAndFollow(environment, id, { onProgress: value => console.log(JSON.stringify(value, null, 2)) });
    else {
      const result = await maintenance(operation, environment, id);
      console.log(JSON.stringify(result, null, 2));
      if (result.status === 'failed' || result.blocked_by) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
