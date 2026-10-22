import { asHttpError, boundary, HttpError } from './errors';
import { emit, OperationTrace, safeError } from './diagnostics';
import { fingerprint } from './primitives';
import { prepareWrites } from './prepared-writes';
import { PublicationConflict } from './publication-conflict';
import { indexNotFound, publicationHead, validateRepairTargets, type PublicationHead, type RepairInput, type RepairResult } from './publication-repair';
import type { ContentBucket, OperationContext, PublicationStatus, RebuildJob } from './types';

export const REPAIR_MARKER = 'lakearrowhead_repair_id';
const ACTIVE = 'publication_repair_pending';
interface RepairRecord {
  id: string;
  key: string;
  input: RepairInput;
  job: RebuildJob;
  etag: string;
  state: 'pending' | 'committed' | 'conflict';
  publication?: PublicationHead;
  conflict_status?: PublicationStatus;
  attempts: number;
  next_retry_at?: string;
}
export function restartRebuild(job: RebuildJob): RebuildJob {
  const next = { ...job, status: 'queued' as const };
  for (const key of ['error', 'error_code', 'failed_stage', 'finished_at', 'conflict_count', 'next_retry_at'] as const) delete next[key];
  return next;
}
export const publicationChanged = (status: PublicationStatus = 'not_committed') => new HttpError(409,
  'The index changed. Read and review the current publication snapshot before submitting another repair.', {},
  { code: 'publication_changed', publication_status: status });
const matches = (index: R2Object, input: RepairInput) => ['manifest', 'rss', 'archives']
  .every(key => (index.customMetadata?.[key] ?? null) === input[key as keyof RepairInput]);
const pending = (record: RepairRecord, status: PublicationStatus = record.publication ? 'committed' : 'unknown') => new HttpError(503,
  status === 'committed' ? 'Repair committed; regeneration activation is being recovered.' : 'Repair outcome is being reconciled. Retry the identical repair request.', {},
  { code: 'repair_pending', retryable: true, publication_status: status,
    retry_at: record.next_retry_at ?? new Date(Date.now() + 1000).toISOString(), details: { repair_id: record.id, job_id: record.job.id } });

// The record is a durable outbox for one index replacement and one regeneration.
// Pending records gate index writers; they never revive a failed job speculatively.
export class RepairCoordinator {
  constructor(private bucket: ContentBucket, private storage: DurableObjectStorage,
    private reserve: (origin: string, trace: OperationTrace, context?: OperationContext) => Promise<RebuildJob>) {}

  async snapshot(trace: OperationTrace): Promise<RepairResult> {
    const index = await trace.run('repair_index_loading', () => boundary('storage', () => this.bucket.head('pages/index.html')));
    if (!index) throw indexNotFound();
    return { publication: publicationHead(index), unchanged: true };
  }

  private async schedule(storage: DurableObjectTransaction) {
    const ids = await storage.get<string[]>('jobs') ?? [];
    for (const id of ids) {
      const job = await storage.get<RebuildJob>(`job:${id}`);
      if (!job || job.status === 'completed') continue;
      if (job.status === 'failed') await storage.deleteAlarm();
      else await storage.setAlarm(Math.max(Date.now() + 1000, Date.parse(job.next_retry_at ?? '') || 0));
      return;
    }
    await storage.deleteAlarm();
  }

  private async cancel(record: RepairRecord, status: PublicationStatus) {
    await boundary('storage', () => this.storage.transaction(async storage => {
      await storage.put(record.key, { ...record, state: 'conflict', conflict_status: status });
      await storage.delete(ACTIVE);
      await this.schedule(storage);
    }));
  }

  private async activate(record: RepairRecord, index: R2Object) {
    record.publication = publicationHead(index);
    await boundary('storage', () => this.storage.transaction(async storage => {
      const ids = await storage.get<string[]>('jobs') ?? [];
      await storage.put(`job:${record.job.id}`, record.job);
      if (!ids.includes(record.job.id)) await storage.put('jobs', [...ids, record.job.id]);
      await storage.put(record.key, { ...record, state: 'committed' });
      await storage.put(`repair:${index.version}`, record.job.id);
      await storage.delete(ACTIVE);
      await this.schedule(storage);
    }));
  }

  private async attempt(record: RepairRecord, trace: OperationTrace, firstAttempt = false) {
    try {
      const index = await trace.run('repair_index_loading', () => boundary('storage', () => this.bucket.get('pages/index.html')));
      if (index?.customMetadata?.[REPAIR_MARKER] === record.id && matches(index, record.input)) {
        trace.publication_status = 'committed';
        await trace.run('repair_activation', () => this.activate(record, index));
        return;
      }
      if (!index || index.version !== record.input.expected_version || index.etag !== record.etag) {
        await trace.run('repair_cancellation', () => this.cancel(record, firstAttempt ? 'not_committed' : 'unknown'));
        return;
      }
      const metadata = { ...index.customMetadata, manifest: record.input.manifest, rss: record.input.rss, [REPAIR_MARKER]: record.id };
      if (record.input.archives === null) delete (metadata as Record<string, string>).archives;
      else (metadata as Record<string, string>).archives = record.input.archives;
      const prepared = prepareWrites(this.bucket, trace);
      let committed: R2Object;
      try {
        const body = await trace.run('repair_body_loading', () => boundary('storage', () => index.arrayBuffer()));
        await trace.run('index_write', () => prepared.bucket.put('pages/index.html', body, { httpMetadata: index.httpMetadata, customMetadata: metadata }));
        try { committed = (await prepared.commit(index))!; }
        catch (error) {
          if (!(error instanceof PublicationConflict)) throw error;
          await trace.run('repair_cancellation', () => this.cancel(record, 'not_committed'));
          return;
        }
      } finally { prepared.close(); }
      await trace.run('repair_activation', () => this.activate(record, committed));
    } catch (error) {
      record.attempts++;
      record.next_retry_at = new Date(Date.now() + Math.min(30, 2 ** Math.min(record.attempts - 1, 5)) * 1000).toISOString();
      emit('repair_recovery_failed', trace.context, { repair_id: record.id, job_id: record.job.id,
        stage: trace.failed_stage, error_code: asHttpError(error).code, ...safeError(error) }, 'error');
      // If activation's acknowledgement was lost, do not overwrite its committed
      // receipt or re-open its active slot. Its transaction also scheduled the job.
      try {
        await boundary('storage', () => this.storage.transaction(async storage => {
          const saved = await storage.get<RepairRecord>(record.key);
          if (saved?.state !== 'pending') return;
          await storage.put(record.key, record);
          await storage.setAlarm(Date.parse(record.next_retry_at!));
        }));
      } catch { /* The original durable alarm and platform redelivery remain available. */ }
      throw pending(record, trace.publication_status === 'committed' ? 'committed' : 'unknown');
    }
  }

  async recover(trace: OperationTrace, respectDeadline = false): Promise<void> {
    const key = await boundary('storage', () => this.storage.get<string>(ACTIVE));
    if (!key) return;
    const record = await boundary('storage', () => this.storage.get<RepairRecord>(key));
    if (!record || record.state !== 'pending') throw new Error('Invalid pending repair record');
    if (respectDeadline && record.next_retry_at && Date.parse(record.next_retry_at) > Date.now()) {
      await boundary('storage', () => this.storage.setAlarm(Date.parse(record.next_retry_at!)));
      throw pending(record);
    }
    await this.attempt(record, trace);
  }

  async submit(input: RepairInput, origin: string, trace: OperationTrace, context?: OperationContext): Promise<RepairResult> {
    const key = `repair-request:${fingerprint(JSON.stringify([input.expected_version, input.manifest, input.rss, input.archives]))}`;
    await this.recover(trace);
    let record = await boundary('storage', () => this.storage.get<RepairRecord>(key));
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
      await trace.run('repair_validation', () => validateRepairTargets(this.bucket, input));
      record = { id: crypto.randomUUID(), key, input, etag: index.etag, job, state: 'pending', attempts: 0 };
      const saved = record;
      try {
        await trace.run('repair_preparation', () => boundary('storage', () => this.storage.transaction(async storage => {
          await storage.put(key, saved);
          await storage.put(ACTIVE, key);
          const alarm = await storage.getAlarm();
          await storage.setAlarm(Math.min(alarm ?? Infinity, Date.now() + 1000));
        })));
      } catch { throw pending(saved); }
      await this.attempt(record, trace, true);
    }
    try {
      const saved = (await boundary('storage', () => this.storage.get<RepairRecord>(key)))!;
      if (saved.state === 'conflict') throw publicationChanged(saved.conflict_status);
      if (saved.state !== 'committed' || !saved.publication) throw pending(saved);
      const job = await boundary('storage', () => this.storage.get<RebuildJob>(`job:${saved.job.id}`)) ?? saved.job;
      return { publication: saved.publication, repair_id: saved.id, unchanged: record.state === 'committed', job };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw pending(record, trace.publication_status === 'committed' || record.publication ? 'committed' : 'unknown');
    }
  }
}
