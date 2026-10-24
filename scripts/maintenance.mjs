import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkEnvironment, readPublishingCredential, validateCredential } from './credentials.mjs';
import { terminalValidation, TransportError, ValidationError } from './validation-errors.mjs';

const defaults = { preview: 'https://lakearrowheadtown-preview.harold-martin.workers.dev', production: 'https://lakearrowhead.town' };
const retryDeadline = Symbol('monotonic retry deadline');
const permanentApplicationError = Symbol('validated permanent application error');
const responseFailure = Symbol('maintenance response failure');
const monotonic = options => (options.now ?? (() => performance.now()))();
function withTiming(value, response, retryAt, options) {
  const server = Date.parse(response.headers.get('Date'));
  const header = response.headers.get('Retry-After');
  let delay = header !== null && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000
    : Number.isFinite(server) ? Date.parse(header) - server : NaN;
  if (!Number.isFinite(delay) && Number.isFinite(server)) delay = Date.parse(retryAt) - server;
  if (Number.isFinite(delay)) Object.defineProperty(value, retryDeadline, { value: monotonic(options) + Math.max(0, delay) });
  return value;
}
function retryDelay(value, attempts, options) {
  const delay = value?.[retryDeadline] !== undefined ? value[retryDeadline] - monotonic(options)
    : Date.parse(value?.retryAt ?? value?.blocked?.retry_at ?? value?.next_retry_at) - Date.now();
  return Math.max(1000, delay > 0 ? value?.[retryDeadline] !== undefined ? delay : Math.min(30000, delay)
    : Math.min(30000, 2 ** Math.min(attempts, 5) * 1000));
}
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
    if (terminalValidation(cause) || cause instanceof TransportError) throw cause;
    throw new TransportError('Maintenance request transport failed', cause);
  }
  let result;
  try { result = await response.json(); }
  catch {
    const failure = new Error(response.ok ? `Invalid maintenance response (${response.status}): expected JSON` : `Maintenance request failed (${response.status}): non-JSON response`);
    failure[responseFailure] = true;
    failure.status = response.status;
    failure.retryable = response.ok || response.status >= 500;
    throw withTiming(failure, response, undefined, options);
  }
  if (!response.ok) {
    const failure = new Error(`Maintenance request failed (${response.status}${typeof result?.code === 'string' ? ` ${result.code}` : ''}): ${typeof result?.error === 'string' ? result.error : 'Unknown error'}`);
    failure[responseFailure] = true;
    failure.code = result?.code;
    failure.retryAt = result?.retry_at;
    failure.retryable = result?.retryable === true;
    failure[permanentApplicationError] = result !== null && typeof result === 'object' && !Array.isArray(result)
      && typeof result.code === 'string' && result.code.length > 0 && typeof result.error === 'string' && result.error.length > 0
      && result.retryable === false;
    failure.publicationStatus = result?.publication_status;
    failure.details = result?.details;
    failure.status = response.status;
    throw withTiming(failure, response, failure.retryAt, options);
  }
  const malformed = message => Object.assign(new Error(`Invalid maintenance response (${response.status}): ${message}`), { [responseFailure]: true, status: response.status, retryable: true });
  if (repairing) {
    const head = result?.publication;
    if (!head || typeof head.version !== 'string' || !head.version || !['manifest', 'rss', 'archives'].every(key => head[key] === null || typeof head[key] === 'string')) throw malformed('expected a publication snapshot');
    if (result.regeneration_status !== undefined && (result.regeneration_status !== 'awaiting_resume' || !result.job
      || !/^[a-f0-9-]{36}$/.test(result.job.id ?? '') || !['queued', 'running'].includes(result.job.status)
      || !(result.job.manual_resume === true || result.job.scheduling === 'manual') || result.job.blocked_by
      || result.job.blocked && result.job.blocked.reason !== 'manual_resume')) throw malformed('invalid regeneration status');
    if (result.job) withTiming(result.job, response, result.job.blocked?.retry_at ?? result.job.next_retry_at, options);
    return result;
  }
  if (typeof result?.job?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(result.job.id) || !['queued', 'running', 'completed', 'failed'].includes(result.job.status)) throw malformed('expected a rebuild job');
  return withTiming(result.job, response, result.job.blocked?.retry_at ?? result.job.next_retry_at, options);
}
const blocked = job => job.blocked?.reason ? job.blocked.reason !== 'repair_pending' : Boolean(job.manual_resume || job.blocked_by);
const blockedAdvice = job => {
  const reason = job.blocked?.reason ?? (job.manual_resume ? 'manual_resume' : 'failed_rebuild');
  const target = job.blocked?.job_id ?? job.blocked_by ?? job.id;
  if (reason === 'rebuild_checkpoint_damaged') return job.blocked?.repair_id
    ? `Restore rebuild ${target}'s finalization checkpoint from a verified backup, then inspect publication repair ${job.blocked.repair_id} and explicitly resume repair recovery.`
    : `Restore rebuild ${target}'s finalization checkpoint from a verified backup, then explicitly resume it.`;
  const recovery = job.recovery ? ` Last recovery failure: ${job.recovery.code} at ${job.recovery.stage}; publication ${job.recovery.publication_status}.` : '';
  return reason.startsWith('repair_')
    ? `Inspect publication repair${job.blocked?.repair_id ? ` ${job.blocked.repair_id}` : ''}; restore damaged records or explicitly resume stalled recovery.`
    : `Inspect rebuild ${target} and explicitly resume it after correcting the cause.${recovery}`;
};

const terminal = job => ['completed', 'failed'].includes(job.status) || blocked(job);
function waitDeadline(options) {
  const timeout = options.timeoutMs ?? 1800000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('timeout-ms must be a positive integer');
  return monotonic(options) + timeout;
}
async function pauseUntilRetry(value, attempts, deadline, options, submission = false) {
  const delay = retryDelay(value, attempts, options);
  const until = Math.min(deadline, monotonic(options) + (submission ? delay : Math.min(30000, delay)));
  while (monotonic(options) < until) {
    const before = monotonic(options);
    await (options.sleep ?? sleep)(Math.min(30000, until - before));
    if (options.now && options.sleep && !(monotonic(options) > before)) throw new Error('Injected maintenance sleep must advance the injected monotonic clock');
  }
}
function completedJob(job) {
  if (job.status !== 'completed') throw new ValidationError('rebuild_incomplete', `Rebuild ${job.id} failed or is blocked (${job.blocked?.reason ?? job.status}). ${blockedAdvice(job)}`, {
    safeMessage: 'Rebuild failed or remains blocked; inspect the recorded rebuild identity and status.',
  });
  return job;
}
function waitTimeout(job, cause) {
  return new ValidationError('rebuild_timeout', `Rebuild ${job.id} exceeded the wait deadline; completion remains unconfirmed (last status: ${job.blocked?.reason ?? job.status}). Inspect its status; no resume was issued.`, {
    cause, safeMessage: 'Rebuild exceeded the wait deadline; completion remains unconfirmed. Inspect its status.',
  });
}
function statusFailure(job, cause) {
  return repairFollowFailure(`Rebuild ${job.id} status check failed (last status: ${job.blocked?.reason ?? job.status}). ${cause.message}`, cause);
}
async function finalStatus(job, environment, deadline, options, awaitingActivation = false) {
  const remaining = Math.ceil(deadline + 30000 - monotonic(options));
  if (remaining <= 0) throw waitTimeout(job);
  // One read-only check, never retried, with a fixed grace deadline.
  try {
    job = await maintenance('status', environment, job.id, { ...options, requestTimeoutMs: remaining });
    if (monotonic(options) > deadline + 30000) throw waitTimeout(job);
    options.onProgress?.(job);
  } catch (error) {
    if (terminalValidation(error)) throw error;
    if (monotonic(options) <= deadline + 30000 && error[permanentApplicationError]
      && !(awaitingActivation && error.status === 404 && error.code === 'job_not_found')) {
      throw statusFailure(job, error);
    }
    throw waitTimeout(job, error);
  }
  if (terminal(job)) return completedJob(job);
  throw waitTimeout(job);
}
async function followJob(job, environment, deadline, options) {
  let attempts = 0; let retry;
  while (!terminal(job)) {
    if (monotonic(options) >= deadline) return finalStatus(job, environment, deadline, options);
    await pauseUntilRetry(retry ?? job, attempts, deadline, options);
    if (monotonic(options) >= deadline) return finalStatus(job, environment, deadline, options);
    try {
      job = await maintenance('status', environment, job.id, { ...options, requestTimeoutMs: Math.max(1, Math.ceil(deadline - monotonic(options))) });
      attempts = 0; retry = undefined; options.onProgress?.(job);
    } catch (error) {
      if (terminalValidation(error)) throw error;
      if (error[permanentApplicationError] || !error.transport && !error[responseFailure]) throw statusFailure(job, error);
      attempts++; retry = error; options.onRetry?.(error, job);
    }
  }
  return completedJob(job);
}
export async function waitForRebuild(job, environment, options = {}) {
  return followJob(job, environment, waitDeadline(options), options);
}

function repairFollowFailure(message, cause) {
  return Object.assign(new Error(message, { cause }), { status: cause.status, code: cause.code, retryable: cause.retryable });
}

export async function repairAndFollow(environment, file, options = {}) {
  const payload = options.payload ?? JSON.parse(await readFile(file, 'utf8'));
  const deadline = waitDeadline(options);
  let result; let jobId; let attempts = 0;
  const context = () => jobId ? `Repair committed; rebuild ${jobId} is ${result?.job?.status ?? 'awaiting activation'}.` : 'Repair outcome may be unknown; retry the identical repair file to reconcile it.';
  while (!result) {
    if (monotonic(options) >= deadline) {
      let final;
      if (jobId) {
        try { final = await finalStatus({ id: jobId, status: 'awaiting activation' }, environment, deadline, { ...options, onProgress: job => options.onProgress?.({ job, publication_status: 'committed' }) }, true); }
        catch (error) { throw repairFollowFailure(`${context()} Overall repair timeout exceeded. ${error.message}`, error); }
      }
      throw new Error(`${context()} Overall repair timeout exceeded; repair result remains unconfirmed.${final ? ` Final rebuild status: ${final.status}.` : ''} Inspect the snapshot and rebuild status.`);
    }
    try {
      result = await maintenance('repair', environment, undefined, { ...options, payload, requestTimeoutMs: Math.max(1, Math.ceil(deadline - monotonic(options))) });
    } catch (error) {
      if (error.publicationStatus === 'committed' && typeof error.details?.job_id === 'string') {
        jobId = error.details.job_id;
        options.onProgress?.({ publication_status: 'committed', repair_id: error.details.repair_id, job_id: jobId });
      }
      if (!error.transport && !error.retryable) throw repairFollowFailure(`${jobId ? context() + ' ' : ''}${error.message}`, error);
      await pauseUntilRetry(error, attempts++, deadline, options, true);
    }
  }
  jobId = result.job?.id;
  options.onProgress?.(result);
  if (result.regeneration_status === 'awaiting_resume') return result;
  if (result.job) {
    try {
      result.job = await followJob(result.job, environment, deadline, { ...options,
        onProgress: job => { result.job = job; options.onProgress?.(result); },
        onRetry: error => options.onProgress?.({ job_id: jobId, publication_status: 'committed', warning: error.message }),
      });
    } catch (error) { throw repairFollowFailure(`${context()} ${error.message}`, error); }
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, environment, id] = process.argv.slice(2);
  try {
    if (operation === 'repair') {
      const extra = process.argv.slice(5);
      if (extra.length && (extra.length !== 2 || extra[0] !== '--timeout-ms' || !/^[1-9][0-9]*$/.test(extra[1]))) throw new Error('Use --timeout-ms <positive integer>');
      const result = await repairAndFollow(environment, id, { ...(extra.length ? { timeoutMs: Number(extra[1]) } : {}), onProgress: value => console.log(JSON.stringify(value, null, 2)) });
      if (result.regeneration_status === 'awaiting_resume') console.log(`Repair committed; rebuild ${result.job.id} awaits explicit resume. Regeneration is not complete; resume it after review and verify completion.`);
    }
    else {
      const result = await maintenance(operation, environment, id);
      console.log(JSON.stringify(result, null, 2));
      if (result.status === 'failed' || blocked(result)) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
