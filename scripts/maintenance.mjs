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
  let response;
  try { response = await (options.request ?? fetch)(origin + path, { method: ['status', 'snapshot'].includes(operation) ? 'GET' : 'POST', headers: { Authorization: `Bearer ${secret}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(Math.min(30000, options.requestTimeoutMs ?? 30000)) }); }
  catch (cause) {
    const error = new Error('Maintenance request transport failed', { cause });
    error.transport = true;
    throw error;
  }
  let result;
  try { result = await response.json(); }
  catch {
    const failure = new Error(response.ok ? `Invalid maintenance response (${response.status}): expected JSON` : `Maintenance request failed (${response.status}): non-JSON response`);
    failure.status = response.status;
    failure.retryable = response.ok || response.status >= 500;
    throw failure;
  }
  if (!response.ok) {
    const failure = new Error(`Maintenance request failed (${response.status}): ${typeof result?.error === 'string' ? result.error : 'Unknown error'}`);
    failure.code = result?.code;
    failure.retryAt = result?.retry_at;
    failure.retryable = result?.retryable === true;
    failure.publicationStatus = result?.publication_status;
    failure.details = result?.details;
    failure.status = response.status;
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
  const timeoutMs = options.timeoutMs ?? 1800000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeout-ms must be a positive integer');
  const now = options.now ?? (() => performance.now());
  const deadline = now() + timeoutMs;
  const wait = options.sleep ?? sleep;
  let result; let jobId; let attempts = 0; let statusRetryAt;
  const context = () => jobId ? `Repair committed; rebuild ${jobId} is ${result?.job?.status ?? 'awaiting activation'}.` : 'Repair outcome may be unknown; retry the identical repair file to reconcile it.';
  const remaining = () => {
    const left = Math.ceil(deadline - now());
    if (left <= 0) throw new Error(`${context()} Overall repair timeout exceeded. Inspect the snapshot and rebuild status.`);
    return left;
  };
  const pause = async retryAt => {
    const delay = Math.min(30000, Math.max(1000, (Date.parse(retryAt) > Date.now() ? Date.parse(retryAt) - Date.now() : Math.min(30000, 2 ** Math.min(attempts++, 5) * 1000))));
    await wait(Math.min(delay, remaining()));
    remaining();
  };
  const call = (operation, id) => maintenance(operation, environment, id, { ...options, payload, requestTimeoutMs: remaining() });
  const retryable = error => error.transport === true || error.retryable === true;
  while (!result) {
    try { result = await call('repair'); }
    catch (error) {
      if (error.publicationStatus === 'committed' && typeof error.details?.job_id === 'string') {
        jobId = error.details.job_id;
        options.onProgress?.({ publication_status: 'committed', repair_id: error.details.repair_id, job_id: jobId });
      }
      if (!retryable(error)) throw new Error(`${jobId ? context() + ' ' : ''}${error.message}`, { cause: error });
      await pause(error.retryAt);
    }
  }
  attempts = 0;
  jobId = result.job?.id;
  options.onProgress?.(result);
  while (result.job && !['completed', 'failed'].includes(result.job.status) && !result.job.blocked_by) {
    await pause(statusRetryAt ?? result.job.next_retry_at);
    try { result.job = await call('status', jobId); attempts = 0; statusRetryAt = undefined; }
    catch (error) {
      if (!retryable(error)) throw new Error(`${context()} ${error.message}`, { cause: error });
      statusRetryAt = error.retryAt;
      options.onProgress?.({ job_id: jobId, publication_status: 'committed', warning: error.message });
      continue;
    }
    options.onProgress?.(result);
  }
  if (result.job && (result.job.status === 'failed' || result.job.blocked_by)) throw new Error(`Repair committed; rebuild ${jobId} failed or is blocked. Inspect rebuild status.`);
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, environment, id] = process.argv.slice(2);
  try {
    if (operation === 'repair') {
      const extra = process.argv.slice(5);
      if (extra.length && (extra.length !== 2 || extra[0] !== '--timeout-ms' || !/^[1-9][0-9]*$/.test(extra[1]))) throw new Error('Use --timeout-ms <positive integer>');
      await repairAndFollow(environment, id, { ...(extra.length ? { timeoutMs: Number(extra[1]) } : {}), onProgress: value => console.log(JSON.stringify(value, null, 2)) });
    }
    else {
      const result = await maintenance(operation, environment, id);
      console.log(JSON.stringify(result, null, 2));
      if (result.status === 'failed' || result.blocked_by) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
