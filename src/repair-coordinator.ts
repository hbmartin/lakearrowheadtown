import { asHttpError, boundary, HttpError } from './errors';
import { emit, OperationTrace, safeError } from './diagnostics';
import { fingerprint, record as object } from './primitives';
import { prepareWrites } from './prepared-writes';
import { PublicationConflict } from './publication-conflict';
import { validateIndexMetadata } from './index-metadata';
import { indexNotFound, publicationHead, validateRepair, validateRepairTargets, type PublicationHead, type RepairInput, type RepairResult, type RecoverySummary } from './publication-repair';
import type { ContentBucket, OperationContext, PublicationStatus, RebuildJob, RebuildBlocker } from './types';

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
export const isPaused = (job: RebuildJob | null | undefined): boolean => !!job && (job.manual_resume === true || job.scheduling === 'manual');
export const pauseReason = (job: RebuildJob): NonNullable<RebuildJob['pause_reason']> => job.pause_reason
  ?? (job.recovery?.code === 'rebuild_checkpoint_damaged' ? 'rebuild_checkpoint_damaged' : 'manual_resume');

export function restartRebuild(job: RebuildJob): RebuildJob {
  const next = { ...job, status: 'queued' as const, scheduling: 'automatic' as const };
  for (const key of ['error', 'error_code', 'failed_stage', 'finished_at', 'conflict_count', 'next_retry_at', 'manual_resume', 'pause_reason', 'blocked', 'blocked_by'] as const) delete next[key];
  if (next.recovery && !['unknown', 'committed'].includes(next.recovery.publication_status)) delete next.recovery;
  return next;
}
export function newRebuild(id: string, origin: string, migration: { complete: boolean; processed: number }, context?: OperationContext): RebuildJob {
  const jobContext = context ? { ...context, job_id: id } : undefined;
  if (jobContext) delete jobContext.candidate_job_id;
  return { id, origin, status: 'queued', scheduling: 'automatic', phase: migration.complete ? 'render' : 'migration', processed: migration.processed,
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
function repairMetadata(index: R2Object, record: Pick<RepairRecord, 'id' | 'input'>): Record<string, string> {
  const metadata: Record<string, string> = { ...index.customMetadata, manifest: record.input.manifest, rss: record.input.rss, [REPAIR_MARKER]: record.id };
  if (record.input.archives === null) delete (metadata as Record<string, string>).archives; else metadata.archives = record.input.archives;
  validateIndexMetadata(metadata, true);
  return metadata;
}
function valid(value: unknown): value is RepairRecord {
  if (!object(value) || typeof value.id !== 'string' || typeof value.key !== 'string' || !/^repair-request:[a-f0-9]{64}$/.test(value.key)
    || !object(value.job) || typeof value.job.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.job.id) || value.job.status !== 'queued' || !['migration', 'render'].includes(String(value.job.phase)) || !Number.isSafeInteger(value.job.processed) || typeof value.etag !== 'string' || !['pending', 'committed', 'conflict'].includes(String(value.state))
    || !Number.isSafeInteger(value.attempts) || Number(value.attempts) < 0) return false;
  try { const input = validateRepair(value.input); return value.key === `repair-request:${fingerprint(JSON.stringify([input.expected_version, input.manifest, input.rss, input.archives]))}` && (value.phase === undefined || ['prepared', 'writing', 'activation'].includes(String(value.phase))); } catch { return false; }
}
export class RepairCoordinator {
  constructor(private bucket: ContentBucket, private storage: DurableObjectStorage,
    private reserve: (origin: string, trace: OperationTrace, context?: OperationContext) => Promise<RebuildJob>,
    private alarmDelivered: () => boolean = () => false) {}

  private async active() {
    const key = await boundary('storage', () => this.storage.get<unknown>(ACTIVE));
    const raw = typeof key === 'string' && key.startsWith('repair-request:') ? await boundary('storage', () => this.storage.get<unknown>(key)) : undefined;
    return { key, raw, record: valid(raw) && raw.key === key && raw.state === 'pending' ? raw : undefined };
  }

  async blocker(): Promise<RebuildBlocker | undefined> {
    const active = await this.active();
    if (active.key === undefined) return;
    const saved = active.record;
    return { reason: !saved ? 'repair_damaged' : saved.stalled ? 'repair_stalled' : 'repair_pending',
      ...(saved ? { repair_id: saved.id, job_id: saved.job.id, ...(saved.next_retry_at && !saved.stalled ? { retry_at: saved.next_retry_at } : {}) } : {}) };
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
      if (job.status === 'failed' || isPaused(job)) await storage.deleteAlarm();
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
  private async reconcile(record: RepairRecord, index: R2Object | null, trace: OperationTrace, uncertain: boolean): Promise<boolean> {
    if (index?.customMetadata?.[REPAIR_MARKER] === record.id && matches(index, record.input)) {
      trace.publication_status = 'committed'; record.phase = 'activation'; record.publication = publicationHead(index);
      await trace.run('repair_activation', () => this.activate(record, index, trace.context)); return true;
    }
    if (!index || index.etag !== record.etag || !uncertain && index.version !== record.input.expected_version) {
      await trace.run('repair_cancellation', () => this.cancel(record, uncertain ? 'unknown' : 'not_committed')); return true;
    }
    // R2's condition tests bytes, not version or metadata. A metadata-only
    // replacement cannot fence an earlier write whose acknowledgement was lost.
    if (index.version !== record.input.expected_version) throw pending(record);
    return false;
  }
  private async attempt(record: RepairRecord, trace: OperationTrace) {
    const uncertain = certainty(record) !== 'not_committed';
    let body: R2ObjectBody | null = null;
    try {
      const head = await trace.run('repair_index_loading', () => boundary('storage', () => this.bucket.head('pages/index.html')));
      if (await this.reconcile(record, head, trace, uncertain)) return;
      const index = await boundary('storage', () => this.bucket.get('pages/index.html'));
      body = index;
      if (await this.reconcile(record, index, trace, uncertain)) return;
      if (!index) return;
      const metadata = repairMetadata(index, record);
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
          if (!uncertain) { await trace.run('repair_cancellation', () => this.cancel(record, 'not_committed')); return; }
          const latest = await boundary('storage', () => this.bucket.head('pages/index.html'));
          if (await this.reconcile(record, latest, trace, true)) return;
          throw pending(record);
        }
      } finally { prepared.close(); }
      record.phase = 'activation'; record.publication = publicationHead(committed);
      await trace.run('repair_activation', () => this.activate(record, committed, trace.context));
    } catch (error) {
      const failure = asHttpError(error);
      if (!uncertain && record.phase === 'prepared' && failure.status < 500 && !failure.retryable) {
        await this.cancel(record, 'not_committed'); throw error;
      }
      record.attempts++;
      record.last_error = { code: failure.code, stage: trace.failed_stage ?? 'repair_recovery', retryable: failure.retryable };
      record.stalled = record.attempts >= MAX_ATTEMPTS || failure.status < 500 && !failure.retryable;
      record.next_retry_at = new Date(Date.now() + Math.min(300, 5 * 2 ** Math.min(record.attempts - 1, 6)) * 1000).toISOString();
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
    } finally { if (body && !body.bodyUsed) await body.body.cancel().catch(() => {}); }
  }
  async recover(trace: OperationTrace, respectDeadline = true): Promise<boolean> {
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
    const trace = new OperationTrace(context);
    try { await this.recover(trace, true); }
    catch (error) {
      const failure = asHttpError(error);
      if (!['repair_pending', 'repair_stalled', 'repair_journal_damaged'].includes(failure.code)) throw error;
      throw new HttpError(503, 'A different publication repair blocks index replacement. Inspect its recovery state before retrying this operation.', {}, {
        code: 'repair_blocked', stage: trace.failed_stage ?? failure.stage ?? 'repair_recovery', retryable: failure.retryable, retry_at: failure.retry_at,
        publication_status: 'not_committed', details: { blocking_repair: failure.details } });
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
      const id = crypto.randomUUID();
      repairMetadata(index, { id, input });
      const job = await this.reserve(origin, trace, context);
      const migration = await boundary('storage', () => this.storage.get<{ complete: boolean }>('migration'));
      await trace.run('repair_validation', () => validateRepairTargets(this.bucket, input, migration?.complete ?? false));
      record = { id, key, input, etag: index.etag, job, state: 'pending', phase: 'prepared', attempts: 0 };
      const saved = record;
      try {
        await trace.run('repair_preparation', () => boundary('storage', () => this.storage.transaction(async storage => {
          const alarm = await storage.getAlarm(); const ids = await storage.get<string[]>('jobs') ?? [];
          if (alarm === null && !this.alarmDelivered()) for (const id of ids) {
            const existing = await storage.get<RebuildJob>(`job:${id}`);
            if (!existing || existing.status === 'completed') continue;
            // Preserve genuinely unscheduled work, including automatic jobs
            // whose platform redeliveries were exhausted. A consumed delivery
            // waiting in our queue is distinguished by alarmDelivered().
            if (existing.status !== 'failed' && existing.scheduling !== 'manual') await storage.put(`job:${id}`, { ...existing, manual_resume: true, scheduling: 'manual', pause_reason: isPaused(existing) ? pauseReason(existing) : 'manual_resume' });
            break;
          }
          await storage.put(key, saved); await storage.put(ACTIVE, key);
          await storage.setAlarm(Math.min(alarm ?? Infinity, Date.now() + 1000));
        })));
      } catch (error) {
        emit('repair_preparation_failed', context, { ...safeError(error), error_code: asHttpError(error).code }, 'error');
        throw pending(saved);
      }
      await this.attempt(record, trace); worked = true;
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
