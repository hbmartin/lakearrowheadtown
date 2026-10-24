import { asHttpError, boundary, HttpError } from './errors';
import { emit, OperationTrace, safeError } from './diagnostics';
import { fingerprint, record as object } from './primitives';
import { prepareWrites } from './prepared-writes';
import { repairErrorState, repairFailure, type RepairFailureContext } from './repair-errors';
import { decodeIndex } from './index-fence';
import { PublicationConflict } from './publication-conflict';
import { validateIndexMetadata } from './index-metadata';
import { checkpointKey, completeMigration, generationKey, pauseKey, readPause, readCheckpoint, checkpointDamaged, repairableCodes, readHandoff, receiptMatches, type GenerationHandoff } from './rebuild-evidence';
import { indexNotFound, publicationHead, validateRepair, validateRepairTargets, type PublicationHead, type RepairInput, type RepairResult, type RecoverySummary } from './publication-repair';
import type { ContentBucket, OperationContext, PublicationStatus, RebuildJob, RebuildBlocker } from './types';

export const REPAIR_MARKER = 'lakearrowhead_repair_id';
const ACTIVE = 'publication_repair_pending';
const MAX_ATTEMPTS = 10;
export type RepairRecoveryOutcome = 'none' | 'activated' | 'cancelled' | { outcome: 'cancelled'; error: unknown };
interface RepairRecord {
  id: string; key: string; input: RepairInput; job: RebuildJob; etag: string;
  state: 'pending' | 'committed' | 'conflict'; publication?: PublicationHead;
  conflict_status?: PublicationStatus; attempts: number; next_retry_at?: string;
  phase?: 'prepared' | 'writing' | 'activation'; stalled?: boolean;
  last_error?: { code: string; stage: string; retryable: boolean };
  handoff?: GenerationHandoff;
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
  return { id, generation_id: crypto.randomUUID(), origin, status: 'queued', scheduling: 'automatic', phase: migration.complete ? 'render' : 'migration', processed: migration.processed,
    created_at: new Date().toISOString(), ...(jobContext ? { context: jobContext } : {}) };
}
export const publicationChanged = (status: PublicationStatus = 'not_committed') => new HttpError(409,
  'The index changed. Read and review the current publication snapshot before submitting another repair.', {},
  { code: 'publication_changed', publication_status: status });
const matches = (index: R2Object, input: RepairInput) => ['manifest', 'rss', 'archives'].every(key => (index.customMetadata?.[key] ?? null) === input[key as keyof RepairInput]);
const certainty = (record: RepairRecord): PublicationStatus => record.publication ? 'committed' : record.phase === 'prepared' ? 'not_committed' : 'unknown';
const evidenceContext = (record: RepairRecord): RepairFailureContext => ({ publication_status: certainty(record), repair_id: record.id, job_id: record.job.id });
function apiOutcome(outcome: RepairRecoveryOutcome) {
  if (typeof outcome === 'object') throw outcome.error;
  return outcome;
}
const checkpointBlocked = (record: RepairRecord) => record.stalled && record.last_error?.code === 'rebuild_checkpoint_damaged';
const recoveryCode = (record: RepairRecord) => checkpointBlocked(record) ? 'rebuild_checkpoint_damaged' : record.stalled ? 'repair_stalled' : 'repair_pending';
const checkpointFailure = (record: RepairRecord) => new HttpError(503,
  'Repair committed, but rebuild migration evidence is missing or damaged. Restore the matching finalization checkpoint from a verified backup, then explicitly resume repair recovery.', {},
  { code: 'rebuild_checkpoint_damaged', stage: 'repair_activation', retryable: false, publication_status: certainty(record),
    details: { repair_id: record.id, job_id: record.job.id, checkpoint_key: checkpointKey(record.job.id), generation_id: record.handoff?.prior_job.generation_id } });
const pending = (record: RepairRecord, status = certainty(record), cause?: unknown) => Object.defineProperty(checkpointBlocked(record) ? checkpointFailure(record) : new HttpError(503,
  record.stalled ? 'Repair recovery is stalled. Inspect the repair, correct the cause, then explicitly resume it.' : status === 'committed' ? 'Repair committed; regeneration activation is being recovered.' : 'Repair outcome is being reconciled. Retry the identical repair request.', {},
  { code: recoveryCode(record), retryable: !record.stalled, publication_status: status,
    ...(!record.stalled ? { retry_at: record.next_retry_at ?? new Date(Date.now() + 1000).toISOString() } : {}), details: { repair_id: record.id, job_id: record.job.id } }), 'cause', { value: cause, configurable: true });
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
  try { if (value.handoff !== undefined) readHandoff(value.handoff, value.job as unknown as RebuildJob); const input = validateRepair(value.input); return value.key === `repair-request:${fingerprint(JSON.stringify([input.expected_version, input.manifest, input.rss, input.archives]))}` && (value.phase === undefined || ['prepared', 'writing', 'activation'].includes(String(value.phase))); } catch { return false; }
}
export class RepairCoordinator {
  constructor(private bucket: ContentBucket, private storage: DurableObjectStorage,
    private reserve: (origin: string, trace: OperationTrace, context: OperationContext | undefined, index: R2Object, repairId: string) => Promise<{ job: RebuildJob; handoff?: GenerationHandoff }>,
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
    return { reason: repairErrorState(saved ? recoveryCode(saved) : 'repair_journal_damaged')!.reason,
      ...(saved ? { repair_id: saved.id, job_id: saved.job.id, ...(saved.next_retry_at && !saved.stalled ? { retry_at: saved.next_retry_at } : {}) } : {}) };
  }

  async snapshot(trace: OperationTrace): Promise<RepairResult> {
    const index = await trace.run('repair_index_loading', () => boundary('storage', () => this.bucket.head('pages/index.html')));
    if (!index) throw indexNotFound();
    const active = await this.active();
    let recovery: RecoverySummary | null = null;
    if (active.key !== undefined) {
      const saved = active.record;
      recovery = { state: !saved || checkpointBlocked(saved) ? 'damaged' : saved.stalled ? 'stalled' : 'pending',
        recovery_token: fingerprint(JSON.stringify([active.key, active.raw ?? null, index.version])),
        publication_status: saved ? certainty(saved) : 'unknown', attempts: saved?.attempts ?? 0,
        ...(saved ? { repair_id: saved.id, job_id: saved.job.id, ...(saved.next_retry_at ? { next_retry_at: saved.next_retry_at } : {}), ...(saved.last_error ? { last_error: saved.last_error } : {}) } : { last_error: { code: 'repair_journal_damaged', stage: 'repair_journal', retryable: false } }) };
    }
    return { publication: publicationHead(index), unchanged: true, recovery };
  }
  private async schedule(storage: DurableObjectTransaction, cancelled?: RepairRecord) {
    const ids = await storage.get<string[]>('jobs') ?? [];
    for (const id of ids) {
      const job = await storage.get<RebuildJob>(`job:${id}`);
      if (!job || job.status === 'completed') continue;
      const prior = cancelled?.handoff?.prior_job;
      const preservedUnscheduled = cancelled?.handoff?.repairable_code === 'unscheduled' && prior?.id === job.id
        && prior.generation_id === job.generation_id && !isPaused(prior);
      if (job.status === 'failed' || isPaused(job) || preservedUnscheduled) await storage.deleteAlarm();
      else await storage.setAlarm(Math.max(Date.now() + 1000, Date.parse(job.next_retry_at ?? '') || 0));
      return;
    }
    await storage.deleteAlarm();
  }
  private async cancel(record: RepairRecord, status: PublicationStatus) {
    await boundary('storage', () => this.storage.transaction(async storage => {
      await storage.put(record.key, { ...record, state: 'conflict', conflict_status: status });
      await storage.delete(ACTIVE); await this.schedule(storage, record);
    }));
  }
  private async activate(record: RepairRecord, index: R2Object, context?: OperationContext) {
    record.publication = publicationHead(index);
    await boundary('storage', () => this.storage.transaction(async storage => {
      const ids = await storage.get<string[]>('jobs') ?? [];
      if (record.handoff) {
        const handoff = { ...record.handoff, prior_committed: record.handoff.prior_committed || receiptMatches(index, record.handoff.prior_job) };
        // The committed repair changed the bytes, fencing all older conditional
        // writes. Keep their evidence, but start the repaired generation prepared.
        if (handoff.prior_committed && !completeMigration(await storage.get('migration'))) {
          const restored = handoff.prior_checkpoint?.migration ? handoff.prior_checkpoint
            : readCheckpoint(await storage.get(checkpointKey(record.job.id)), handoff.prior_job, 'repair_activation');
          if (!restored?.migration) throw checkpointDamaged('Committed migration bookkeeping is missing. Restore the matching finalization checkpoint before resuming repair recovery.', 'repair_activation');
          handoff.prior_checkpoint = restored;
          await storage.put('migration', restored.migration);
        }
        await storage.put(generationKey(record.job.id, record.job.generation_id!), handoff);
        if (isPaused(record.job)) await storage.put(pauseKey(record.job.id), { version: 1, generation_id: record.job.generation_id!, repair_id: record.id, code: handoff.repairable_code });
        await storage.put(checkpointKey(record.job.id), { version: 2, generation_id: record.job.generation_id!, phase: 'prepared' });
      }
      await storage.put(`job:${record.job.id}`, record.job);
      if (!ids.includes(record.job.id)) await storage.put('jobs', [...ids, record.job.id]);
      await storage.put(record.key, { ...record, state: 'committed' });
      await storage.put(`repair:${index.version}`, record.job.id);
      await storage.delete(ACTIVE); await this.schedule(storage);
    }));
    emit('rebuild_queued', record.job.context ?? context, { job_id: record.job.id, generation_id: record.job.generation_id, reused: !!record.handoff,
      scheduling: record.job.scheduling, manual_resume: isPaused(record.job), ...(isPaused(record.job) ? { pause_reason: pauseReason(record.job) } : {}) });
  }
  private async reconcile(record: RepairRecord, index: R2Object | null, trace: OperationTrace, uncertain: boolean): Promise<Exclude<RepairRecoveryOutcome, 'none'> | undefined> {
    if (index?.customMetadata?.[REPAIR_MARKER] === record.id && matches(index, record.input)) {
      trace.publication_status = 'committed'; record.phase = 'activation'; record.publication = publicationHead(index);
      await trace.run('repair_activation', () => this.activate(record, index, trace.context)); return 'activated';
    }
    if (!index || index.etag !== record.etag || !uncertain && index.version !== record.input.expected_version) {
      await trace.run('repair_cancellation', () => this.cancel(record, uncertain ? 'unknown' : 'not_committed')); return 'cancelled';
    }
    // R2's condition tests bytes, not version or metadata. A metadata-only
    // replacement cannot fence an earlier write whose acknowledgement was lost.
    if (index.version !== record.input.expected_version) throw pending(record);
    return undefined;
  }
  private async attempt(record: RepairRecord, trace: OperationTrace, validated?: { index: R2Object; bytes: ArrayBuffer }) {
    const uncertain = certainty(record) !== 'not_committed';
    let body: R2ObjectBody | null = null;
    try {
      const head = await trace.run('repair_index_loading', () => boundary('storage', () => this.bucket.head('pages/index.html')));
      const reconciledHead = await this.reconcile(record, head, trace, uncertain);
      if (reconciledHead) return reconciledHead;
      const cached = validated && head?.version === validated.index.version && head.etag === validated.index.etag ? validated : undefined;
      const index = (cached?.index ?? await boundary('storage', () => this.bucket.get('pages/index.html')))!;
      body = cached ? null : index as R2ObjectBody | null;
      const reconciledIndex = await this.reconcile(record, index, trace, uncertain);
      if (reconciledIndex) return reconciledIndex;
      const metadata = repairMetadata(index, record);
      const prepared = prepareWrites(this.bucket, trace, record.id);
      let committed: R2Object;
      try {
        const bytes = cached?.bytes ?? await trace.run('repair_body_loading', () => boundary('storage', () => (index as R2ObjectBody).arrayBuffer()));
        if (!cached) await trace.run('repair_representation_validation', () => decodeIndex(bytes, index.httpMetadata, true));
        await trace.run('index_write', () => prepared.bucket.put('pages/index.html', bytes, { httpMetadata: index.httpMetadata, customMetadata: metadata }));
        record.phase = 'writing';
        await trace.run('repair_dispatch', () => boundary('storage', () => this.storage.put(record.key, record)));
        try { committed = (await prepared.commit(index))!; }
        catch (error) {
          if (!(error instanceof PublicationConflict)) throw error;
          if (!uncertain) { await trace.run('repair_cancellation', () => this.cancel(record, 'not_committed')); return 'cancelled' as const; }
          const latest = await boundary('storage', () => this.bucket.head('pages/index.html'));
          const reconciledLatest = await this.reconcile(record, latest, trace, true);
          if (reconciledLatest) return reconciledLatest;
          throw pending(record);
        }
      } finally { prepared.close(); }
      record.phase = 'activation'; record.publication = publicationHead(committed);
      await trace.run('repair_activation', () => this.activate(record, committed, trace.context));
      return 'activated' as const;
    } catch (error) {
      const failure = asHttpError(error);
      if (!uncertain && record.phase === 'prepared' && failure.status < 500 && !failure.retryable) {
        await this.cancel(record, 'not_committed'); return { outcome: 'cancelled' as const, error };
      }
      record.attempts++;
      record.last_error = { code: failure.code, stage: trace.failed_stage ?? 'repair_recovery', retryable: failure.retryable };
      record.stalled = record.attempts >= MAX_ATTEMPTS || failure.code === 'rebuild_checkpoint_damaged' || failure.status < 500 && !failure.retryable;
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
      throw pending(record, trace.publication_status === 'committed' ? 'committed' : certainty(record), error);
    } finally { if (body && !body.bodyUsed) await body.body.cancel().catch(() => {}); }
  }
  async recover(trace: OperationTrace, respectDeadline = true): Promise<RepairRecoveryOutcome> {
    const active = await this.active();
    if (active.key === undefined) return 'none';
    const saved = active.record; if (!saved) throw damaged();
    if (saved.stalled) throw pending(saved);
    if (respectDeadline && saved.next_retry_at && Date.parse(saved.next_retry_at) > Date.now()) {
      await boundary('storage', () => this.storage.setAlarm(Date.parse(saved.next_retry_at!))); throw pending(saved);
    }
    return this.attempt(saved, trace);
  }
  async gate(context?: OperationContext): Promise<void> {
    const trace = new OperationTrace(context);
    try { apiOutcome(await this.recover(trace, true)); }
    catch (error) {
      const failure = asHttpError(error);
      if (!repairErrorState(failure.code)) throw error;
      throw new HttpError(503, 'A different publication repair blocks index replacement. Inspect its recovery state before retrying this operation.', {}, {
        code: 'repair_blocked', stage: trace.failed_stage ?? failure.stage ?? 'repair_recovery', retryable: failure.retryable, retry_at: failure.retry_at,
        publication_status: 'not_committed', details: { blocking_repair: failure.details } });
    }
  }
  async control(action: 'resume' | 'cancel', input: unknown, trace: OperationTrace): Promise<RepairResult> {
    if (!object(input) || Object.keys(input).some(key => !['expected_recovery_token', 'expected_version'].includes(key)) || typeof input.expected_recovery_token !== 'string' || typeof input.expected_version !== 'string') throw new HttpError(400, 'Supply expected_recovery_token and expected_version.');
    let saved: RepairRecord | undefined;
    let failureContext: RepairFailureContext = { publication_status: 'not_attempted' };
    let completing = false;
    try {
      const snapshot = await this.snapshot(trace);
      if (snapshot.recovery) failureContext = { publication_status: snapshot.recovery.publication_status,
        repair_id: snapshot.recovery.repair_id, job_id: snapshot.recovery.job_id };
      if (!snapshot.recovery || snapshot.recovery.recovery_token !== input.expected_recovery_token || snapshot.publication.version !== input.expected_version) throw new HttpError(409, 'Recovery state changed. Inspect it again.', {}, { code: 'repair_recovery_changed' });
      saved = (await this.active()).record;
      if (!saved) throw damaged();
      const record = saved;
      if (action === 'resume') {
        const resumed = { ...record, attempts: 0, stalled: false, next_retry_at: new Date(Date.now() + 1000).toISOString() };
        await boundary('storage', () => this.storage.transaction(async storage => {
          await storage.put(record.key, resumed);
          await storage.setAlarm(Date.parse(resumed.next_retry_at));
        }));
        saved = resumed;
      } else {
        const head = await boundary('storage', () => this.bucket.head('pages/index.html'));
        if (!head || head.version !== input.expected_version) throw publicationChanged(certainty(record));
        if (head.customMetadata?.[REPAIR_MARKER] === record.id && matches(head, record.input)) await this.activate(record, head, trace.context);
        else if (record.phase === 'prepared' || head.etag !== record.etag) await this.cancel(record, certainty(record));
        else throw new HttpError(409, 'Cannot cancel an unresolved conditional write. Reconcile or resume this repair.', {}, { code: 'unsafe_repair_cancellation', publication_status: certainty(record) });
      }
      completing = true;
      return await trace.run('repair_result_loading', () => this.snapshot(trace));
    } catch (error) {
      throw repairFailure(error, saved ? evidenceContext(saved) : failureContext, completing ? { retry_at: saved?.next_retry_at } : undefined);
    }
  }
  private async regenerationStatus(job: RebuildJob): Promise<{ regeneration_status?: 'awaiting_resume' }> {
    if (!['queued', 'running'].includes(job.status) || !isPaused(job) || pauseReason(job) === 'rebuild_checkpoint_damaged'
      || job.recovery && !repairableCodes.includes(job.recovery.code)) return {};
    const evidence = await boundary('storage', () => this.storage.get([pauseKey(job.id), generationKey(job.id, job.generation_id ?? '')]));
    const handoff = readHandoff(evidence.get(generationKey(job.id, job.generation_id ?? '')), job, 'repair_generation_read');
    const provenance = readPause(evidence.get(pauseKey(job.id)), job, handoff);
    return provenance ? { regeneration_status: 'awaiting_resume' } : {};
  }
  async submit(input: RepairInput, origin: string, trace: OperationTrace, context?: OperationContext): Promise<RepairResult> {
    let durable: RepairRecord | undefined;
    let receiptContext: RepairFailureContext | undefined;
    let completing = false;
    try {
      const key = `repair-request:${fingerprint(JSON.stringify([input.expected_version, input.manifest, input.rss, input.archives]))}`;
      const before = await boundary('storage', () => this.storage.get<RepairRecord>(key));
      if (before && valid(before)) durable = before;
      const active = await this.active();
      let worked = false;
      if (active.key !== undefined) {
        if (active.key === key) worked = apiOutcome(await this.recover(trace)) === 'activated';
        else await this.gate(context);
      }
      let record = await boundary('storage', () => this.storage.get<RepairRecord>(key));
      if (record && !valid(record)) throw damaged();
      if (record) durable = record;
      if (record?.state === 'conflict') throw publicationChanged(record.conflict_status);
      if (!record) {
        const index = await trace.run('repair_index_loading', () => boundary('storage', () => this.bucket.head('pages/index.html')));
        if (!index) throw indexNotFound();
        if (matches(index, input)) {
          const repairId = index.customMetadata?.[REPAIR_MARKER];
          receiptContext = { publication_status: repairId ? 'committed' : 'not_attempted', ...(repairId ? { repair_id: repairId } : {}) };
          completing = true;
          const receipt = await trace.run('repair_result_loading', () => boundary('storage', () => this.storage.get<string>(`repair:${index.version}`)));
          if (receipt) receiptContext = { ...receiptContext, publication_status: 'committed', job_id: receipt };
          const job = receipt ? await trace.run('repair_result_loading', () => boundary('storage', () => this.storage.get<RebuildJob>(`job:${receipt}`))) : undefined;
          return { publication: publicationHead(index), unchanged: true, ...(job ? { job, ...await trace.run('repair_regeneration_status', () => this.regenerationStatus(job)) } : {}) };
        }
        if (index.version !== input.expected_version) throw publicationChanged();
        const id = crypto.randomUUID();
        repairMetadata(index, { id, input });
        const { job, handoff } = await this.reserve(origin, trace, context, index, id);
        const validated = await trace.run('repair_representation_validation', async () => {
          const object = await boundary('storage', () => this.bucket.get('pages/index.html'));
          try {
            if (!object || object.version !== index.version || object.etag !== index.etag) throw publicationChanged();
            const bytes = await boundary('storage', () => object.arrayBuffer());
            decodeIndex(bytes, object.httpMetadata, true);
            return { index: object, bytes };
          } finally { if (object && !object.bodyUsed) await object.body.cancel().catch(() => {}); }
        });
        const migration = await boundary('storage', () => this.storage.get<{ complete: boolean; processed: number }>('migration'));
        await trace.run('repair_validation', () => validateRepairTargets(this.bucket, input, migration?.complete ?? false));
        record = { id, key, input, etag: index.etag, job, ...(handoff ? { handoff } : {}), state: 'pending', phase: 'prepared', attempts: 0 };
        const saved = record;
        try {
          await trace.run('repair_preparation', () => boundary('storage', () => this.storage.transaction(async storage => {
            const alarm = await storage.getAlarm();
            // A delivery can register while target validation is awaiting R2.
            // In that case preserve the working head and reserve a separate job.
            if (saved.handoff?.repairable_code === 'unscheduled' && !isPaused(saved.handoff.prior_job)
              && (alarm !== null || this.alarmDelivered())) {
              saved.job = newRebuild(crypto.randomUUID(), origin, migration ?? { complete: false, processed: 0 }, context);
              delete saved.handoff;
            }
            await storage.put(key, saved); await storage.put(ACTIVE, key);
            await storage.setAlarm(Math.min(alarm ?? Infinity, Date.now() + 1000));
          })));
        } catch (error) {
          emit('repair_preparation_failed', context, { ...safeError(error), error_code: asHttpError(error).code }, 'error');
          // A lost acknowledgement is not proof that the transaction rolled back.
          // Recover identifiers only from a successful, matching journal read.
          try {
            const readback = await boundary('storage', () => this.storage.get<RepairRecord>(key));
            if (valid(readback) && readback.id === saved.id) durable = readback;
          } catch { /* Preserve the preparation error and its unconfirmed identity. */ }
          if (durable) throw pending(durable, certainty(durable), error);
          throw error;
        }
        durable = record;
        apiOutcome(await this.attempt(record, trace, validated)); worked = true;
      }
      completing = true;
      const saved = (await trace.run('repair_result_loading', () => boundary('storage', () => this.storage.get<RepairRecord>(key))))!;
      if (saved?.state === 'conflict') throw publicationChanged(saved.conflict_status);
      if (!saved || saved.state !== 'committed' || !saved.publication) throw pending(record);
      durable = saved;
      const job = await trace.run('repair_result_loading', () => boundary('storage', () => this.storage.get<RebuildJob>(`job:${saved.job.id}`))) ?? saved.job;
      return { publication: saved.publication, repair_id: saved.id, unchanged: !worked && before?.state === 'committed', job, ...await trace.run('repair_regeneration_status', () => this.regenerationStatus(job)) };
    } catch (error) {
      const failureContext = durable ? evidenceContext(durable) : receiptContext ?? { publication_status: 'not_committed' as const };
      throw repairFailure(error, { ...failureContext, publication_status: trace.publication_status === 'committed' ? 'committed' : failureContext.publication_status }, completing ? { retry_at: durable?.next_retry_at } : undefined);
    }
  }
}
