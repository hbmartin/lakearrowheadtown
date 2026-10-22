import { asHttpError, boundary, HttpError } from './errors';
import { emit, OperationTrace, safeError } from './diagnostics';
import { fingerprint, record as object } from './primitives';
import { prepareWrites } from './prepared-writes';
import { PublicationConflict } from './publication-conflict';
import { indexNotFound, publicationHead, validateRepair, validateRepairTargets, type PublicationHead, type RepairInput, type RepairResult, type RecoverySummary } from './publication-repair';
import type { ContentBucket, OperationContext, PublicationStatus, RebuildJob } from './types';

export const REPAIR_MARKER = 'lakearrowhead_repair_id';
const ACTIVE = 'publication_repair_pending';
const MAX_ATTEMPTS = 10;
interface RepairRecord {
  id: string; key: string; input: RepairInput; job: RebuildJob; etag: string;
  state: 'pending' | 'committed' | 'conflict'; publication?: PublicationHead;
  conflict_status?: PublicationStatus; attempts: number; next_retry_at?: string;
  phase?: 'prepared' | 'writing' | 'activation'; stalled?: boolean;
  last_error?: { code: string; stage: string; retryable: boolean };
}
export function restartRebuild(job: RebuildJob): RebuildJob {
  const next = { ...job, status: 'queued' as const };
  for (const key of ['error', 'error_code', 'failed_stage', 'finished_at', 'conflict_count', 'next_retry_at', 'manual_resume'] as const) delete next[key];
  return next;
}
export function newRebuild(id: string, origin: string, migration: { complete: boolean; processed: number }, context?: OperationContext): RebuildJob {
  const jobContext = context ? { ...context, job_id: id } : undefined;
  if (jobContext) delete jobContext.candidate_job_id;
  return { id, origin, status: 'queued', phase: migration.complete ? 'render' : 'migration', processed: migration.processed,
    created_at: new Date().toISOString(), ...(jobContext ? { context: jobContext } : {}) };
}
export const publicationChanged = (status: PublicationStatus = 'not_committed') => new HttpError(409,
  'The index changed. Read and review the current publication snapshot before submitting another repair.', {},
  { code: 'publication_changed', publication_status: status });
const matches = (index: R2Object, input: RepairInput) => ['manifest', 'rss', 'archives'].every(key => (index.customMetadata?.[key] ?? null) === input[key as keyof RepairInput]);
const certainty = (record: RepairRecord): PublicationStatus => record.publication ? 'committed' : record.phase === 'prepared' ? 'not_committed' : 'unknown';
const pending = (record: RepairRecord, status = certainty(record)) => new HttpError(503,
  record.stalled ? 'Repair recovery is stalled. Inspect the repair, correct the cause, then explicitly resume it.' : status === 'committed' ? 'Repair committed; regeneration activation is being recovered.' : 'Repair outcome is being reconciled. Retry the identical repair request.', {},
  { code: record.stalled ? 'repair_stalled' : 'repair_pending', retryable: !record.stalled, publication_status: status,
    ...(!record.stalled ? { retry_at: record.next_retry_at ?? new Date(Date.now() + 1000).toISOString() } : {}), details: { repair_id: record.id, job_id: record.job.id } });
const damaged = () => new HttpError(503, 'The repair journal is damaged. Restore the active journal and its referenced record from a verified backup before resuming. Do not force-clear an unknown write.', {}, { code: 'repair_journal_damaged', retryable: false });
function valid(value: unknown): value is RepairRecord {
  if (!object(value) || typeof value.id !== 'string' || typeof value.key !== 'string' || !/^repair-request:[a-f0-9]{64}$/.test(value.key)
    || !object(value.job) || typeof value.job.id !== 'string' || typeof value.etag !== 'string' || !['pending', 'committed', 'conflict'].includes(String(value.state))
    || !Number.isSafeInteger(value.attempts) || Number(value.attempts) < 0) return false;
  try { validateRepair(value.input); return true; } catch { return false; }
}
export class RepairCoordinator {
  constructor(private bucket: ContentBucket, private storage: DurableObjectStorage,
    private reserve: (origin: string, trace: OperationTrace, context?: OperationContext) => Promise<RebuildJob>) {}

  private async active() {
    const key = await boundary('storage', () => this.storage.get<unknown>(ACTIVE));
    const raw = typeof key === 'string' && key.startsWith('repair-request:') ? await boundary('storage', () => this.storage.get<unknown>(key)) : undefined;
    return { key, raw, record: valid(raw) && raw.key === key && raw.state === 'pending' ? raw : undefined };
  }

  async snapshot(trace: OperationTrace): Promise<RepairResult> {
    const index = await trace.run('repair_index_loading', () => boundary('storage', () => this.bucket.head('pages/index.html')));
    if (!index) throw indexNotFound();
    const active = await this.active();
    let recovery: RecoverySummary | null = null;
    if (active.key !== undefined) {
      const saved = active.record;
      recovery = { state: !saved ? 'damaged' : saved.stalled ? 'stalled' : 'pending',
        recovery_token: fingerprint(JSON.stringify([active.key, active.raw ?? null, index.version])),
        publication_status: saved ? certainty(saved) : 'unknown', attempts: saved?.attempts ?? 0,
        ...(saved ? { repair_id: saved.id, job_id: saved.job.id, ...(saved.next_retry_at ? { next_retry_at: saved.next_retry_at } : {}), ...(saved.last_error ? { last_error: saved.last_error } : {}) } : { last_error: { code: 'repair_journal_damaged', stage: 'repair_journal', retryable: false } }) };
    }
    return { publication: publicationHead(index), unchanged: true, recovery };
  }
  private async schedule(storage: DurableObjectTransaction) {
    const ids = await storage.get<string[]>('jobs') ?? [];
    for (const id of ids) {
      const job = await storage.get<RebuildJob>(`job:${id}`);
      if (!job || job.status === 'completed') continue;
      if (job.status === 'failed' || job.manual_resume) await storage.deleteAlarm();
      else await storage.setAlarm(Math.max(Date.now() + 1000, Date.parse(job.next_retry_at ?? '') || 0));
      return;
    }
    await storage.deleteAlarm();
  }
  private async cancel(record: RepairRecord, status: PublicationStatus) {
    await boundary('storage', () => this.storage.transaction(async storage => {
      await storage.put(record.key, { ...record, state: 'conflict', conflict_status: status });
      await storage.delete(ACTIVE); await this.schedule(storage);
    }));
  }
  private async activate(record: RepairRecord, index: R2Object, context?: OperationContext) {
    record.publication = publicationHead(index);
    await boundary('storage', () => this.storage.transaction(async storage => {
      const ids = await storage.get<string[]>('jobs') ?? [];
      await storage.put(`job:${record.job.id}`, record.job);
      if (!ids.includes(record.job.id)) await storage.put('jobs', [...ids, record.job.id]);
      await storage.put(record.key, { ...record, state: 'committed' });
      await storage.put(`repair:${index.version}`, record.job.id);
      await storage.delete(ACTIVE); await this.schedule(storage);
    }));
    emit('rebuild_queued', record.job.context ?? context, { job_id: record.job.id });
  }
  private async attempt(record: RepairRecord, trace: OperationTrace, firstAttempt = false) {
    try {
      const head = await trace.run('repair_index_loading', () => boundary('storage', () => this.bucket.head('pages/index.html')));
      if (head?.customMetadata?.[REPAIR_MARKER] === record.id && matches(head, record.input)) {
        trace.publication_status = 'committed'; record.phase = 'activation'; record.publication = publicationHead(head);
        await trace.run('repair_activation', () => this.activate(record, head, trace.context)); return;
      }
      if (!head || head.version !== record.input.expected_version || head.etag !== record.etag) {
        await trace.run('repair_cancellation', () => this.cancel(record, firstAttempt ? 'not_committed' : 'unknown')); return;
      }
      const index = await boundary('storage', () => this.bucket.get('pages/index.html'));
      if (!index || index.version !== head.version) { await this.cancel(record, 'not_committed'); return; }
      const metadata: Record<string, string> = { ...index.customMetadata, manifest: record.input.manifest, rss: record.input.rss, [REPAIR_MARKER]: record.id };
      if (record.input.archives === null) delete metadata.archives; else metadata.archives = record.input.archives;
      if (Object.entries(metadata).reduce((size, [key, value]) => size + new TextEncoder().encode(key + value).length, 0) > 8192) throw new HttpError(400, 'Repair metadata exceeds the R2 object metadata limit.', {}, { code: 'invalid_repair_target' });
      const prepared = prepareWrites(this.bucket, trace);
      let committed: R2Object;
      try {
        const body = await trace.run('repair_body_loading', () => boundary('storage', () => index.arrayBuffer()));
        await trace.run('index_write', () => prepared.bucket.put('pages/index.html', body, { httpMetadata: index.httpMetadata, customMetadata: metadata }));
        record.phase = 'writing';
        await trace.run('repair_dispatch', () => boundary('storage', () => this.storage.put(record.key, record)));
        try { committed = (await prepared.commit(index))!; }
        catch (error) {
          if (!(error instanceof PublicationConflict)) throw error;
          await trace.run('repair_cancellation', () => this.cancel(record, 'not_committed')); return;
        }
      } finally { prepared.close(); }
      record.phase = 'activation'; record.publication = publicationHead(committed);
      await trace.run('repair_activation', () => this.activate(record, committed, trace.context));
    } catch (error) {
      record.attempts++;
      const failure = asHttpError(error);
      record.last_error = { code: failure.code, stage: trace.failed_stage ?? 'repair_recovery', retryable: failure.retryable };
      record.stalled = record.attempts >= MAX_ATTEMPTS || failure.status < 500 && !failure.retryable;
      record.next_retry_at = new Date(Date.now() + Math.min(30, 2 ** Math.min(record.attempts - 1, 5)) * 1000).toISOString();
      emit('repair_recovery_failed', trace.context, { repair_id: record.id, job_id: record.job.id, attempts: record.attempts, stalled: record.stalled,
        stage: trace.failed_stage, error_code: failure.code, ...safeError(error) }, 'error');
      // Never acknowledge an alarm when persisting its next wake-up failed.
      await boundary('storage', () => this.storage.transaction(async storage => {
        const saved = await storage.get<RepairRecord>(record.key);
        if (saved?.state !== 'pending') return;
        await storage.put(record.key, record);
        if (record.stalled) await storage.deleteAlarm(); else await storage.setAlarm(Date.parse(record.next_retry_at!));
      }));
      throw pending(record, trace.publication_status === 'committed' ? 'committed' : certainty(record));
    }
  }
  async recover(trace: OperationTrace, respectDeadline = false): Promise<boolean> {
    const active = await this.active();
    if (active.key === undefined) return false;
    const saved = active.record; if (!saved) throw damaged();
    if (saved.stalled) throw pending(saved);
    if (respectDeadline && saved.next_retry_at && Date.parse(saved.next_retry_at) > Date.now()) {
      await boundary('storage', () => this.storage.setAlarm(Date.parse(saved.next_retry_at!))); throw pending(saved);
    }
    await this.attempt(saved, trace); return true;
  }
  async gate(context?: OperationContext): Promise<void> {
    try { await this.recover(new OperationTrace(context), true); }
    catch (error) {
      const failure = asHttpError(error);
      if (!['repair_pending', 'repair_stalled', 'repair_journal_damaged'].includes(failure.code)) throw error;
      throw new HttpError(503, 'A different publication repair blocks index replacement. Inspect its recovery state before retrying this operation.', {}, {
        code: 'repair_blocked', retryable: failure.retryable, retry_at: failure.retry_at, publication_status: 'not_committed', details: { blocking_repair: failure.details } });
    }
  }
  async control(action: 'resume' | 'cancel', input: unknown, trace: OperationTrace): Promise<RepairResult> {
    if (!object(input) || Object.keys(input).some(key => !['expected_recovery_token', 'expected_version'].includes(key)) || typeof input.expected_recovery_token !== 'string' || typeof input.expected_version !== 'string') throw new HttpError(400, 'Supply expected_recovery_token and expected_version.');
    const snapshot = await this.snapshot(trace);
    if (!snapshot.recovery || snapshot.recovery.recovery_token !== input.expected_recovery_token || snapshot.publication.version !== input.expected_version) throw new HttpError(409, 'Recovery state changed. Inspect it again.', {}, { code: 'repair_recovery_changed' });
    const saved = (await this.active()).record; if (!saved) throw damaged();
    if (action === 'resume') {
      await boundary('storage', () => this.storage.transaction(async storage => {
        await storage.put(saved.key, { ...saved, attempts: 0, stalled: false, next_retry_at: new Date(Date.now() + 1000).toISOString() });
        await storage.setAlarm(Date.now() + 1000);
      }));
    } else {
      const head = await boundary('storage', () => this.bucket.head('pages/index.html'));
      if (!head || head.version !== input.expected_version) throw publicationChanged();
      if (head.customMetadata?.[REPAIR_MARKER] === saved.id && matches(head, saved.input)) await this.activate(saved, head, trace.context);
      else if (saved.phase === 'prepared' || head.etag !== saved.etag) await this.cancel(saved, certainty(saved));
      else throw new HttpError(409, 'Cannot cancel an unresolved conditional write. Reconcile or resume this repair.', {}, { code: 'unsafe_repair_cancellation', publication_status: certainty(saved) });
    }
    return this.snapshot(trace);
  }
  async submit(input: RepairInput, origin: string, trace: OperationTrace, context?: OperationContext): Promise<RepairResult> {
    const key = `repair-request:${fingerprint(JSON.stringify([input.expected_version, input.manifest, input.rss, input.archives]))}`;
    const before = await boundary('storage', () => this.storage.get<RepairRecord>(key));
    const active = await this.active();
    let worked = false;
    if (active.key !== undefined) {
      if (active.key === key) worked = await this.recover(trace);
      else await this.gate(context);
    }
    let record = await boundary('storage', () => this.storage.get<RepairRecord>(key));
    if (record && !valid(record)) throw damaged();
    if (record?.state === 'conflict') throw publicationChanged(record.conflict_status);
    if (!record) {
      const index = await trace.run('repair_index_loading', () => boundary('storage', () => this.bucket.head('pages/index.html')));
      if (!index) throw indexNotFound();
      if (matches(index, input)) {
        const receipt = await boundary('storage', () => this.storage.get<string>(`repair:${index.version}`));
        const job = receipt ? await boundary('storage', () => this.storage.get<RebuildJob>(`job:${receipt}`)) : undefined;
        return { publication: publicationHead(index), unchanged: true, ...(job ? { job } : {}) };
      }
      if (index.version !== input.expected_version) throw publicationChanged();
      const job = await this.reserve(origin, trace, context);
      const migration = await boundary('storage', () => this.storage.get<{ complete: boolean }>('migration'));
      await trace.run('repair_validation', () => validateRepairTargets(this.bucket, input, migration?.complete ?? false));
      record = { id: crypto.randomUUID(), key, input, etag: index.etag, job, state: 'pending', phase: 'prepared', attempts: 0 };
      const saved = record;
      try {
        await trace.run('repair_preparation', () => boundary('storage', () => this.storage.transaction(async storage => {
          const alarm = await storage.getAlarm(); const ids = await storage.get<string[]>('jobs') ?? [];
          if (alarm === null) for (const id of ids) {
            const existing = await storage.get<RebuildJob>(`job:${id}`);
            if (!existing || existing.status === 'completed') continue;
            if (existing.status !== 'failed') await storage.put(`job:${id}`, { ...existing, manual_resume: true });
            break;
          }
          await storage.put(key, saved); await storage.put(ACTIVE, key);
          await storage.setAlarm(Math.min(alarm ?? Infinity, Date.now() + 1000));
        })));
      } catch (error) {
        emit('repair_preparation_failed', context, { ...safeError(error), error_code: asHttpError(error).code }, 'error');
        throw pending(saved);
      }
      await this.attempt(record, trace, true); worked = true;
    }
    try {
    const saved = (await boundary('storage', () => this.storage.get<RepairRecord>(key)))!;
    if (saved?.state === 'conflict') throw publicationChanged(saved.conflict_status);
    if (!saved || saved.state !== 'committed' || !saved.publication) throw pending(record);
    const job = await boundary('storage', () => this.storage.get<RebuildJob>(`job:${saved.job.id}`)) ?? saved.job;
    return { publication: saved.publication, repair_id: saved.id, unchanged: !worked && before?.state === 'committed', job };
    } catch (error) { if (error instanceof HttpError) throw error; throw pending(record, trace.publication_status === 'committed' ? 'committed' : certainty(record)); }
  }
}
