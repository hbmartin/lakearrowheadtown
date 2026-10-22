import { DurableObject } from 'cloudflare:workers';
import { appendUpdate, currentPublication, initialMigration, migrateBatch, PublicationError, publishDigest, rebuildHomepage, retractPost } from './publishing';
import { findBatch, loadHistoryIndex } from './history-index';
import { emit, OperationTrace, safeError } from './diagnostics';
import { committedSnapshot, requireCommittedManifest, type CommittedSnapshot } from './committed';
import { asHttpError, boundary, HttpError, publicationFailure } from './errors';
import { alertRpcFailure, readAlerts, retractAlertEntry, submitAlert, type AlertInput, type AlertsReply } from './alerts';
import { readPosts, type PostsReply } from './posts';
import { publishEvents, readEvents, type EventDigest, type EventsReply } from './events';
import { validateRepair, type RepairReply } from './publication-repair';
import { RepairCoordinator, restartRebuild } from './repair-coordinator';
import type { AppendReply, BatchReply, Digest, Env, Migration, OperationContext, PublishFailure, PublishReply, RebuildJob, RetractReply, StoryUpdate } from './types';

// Inspection is read-only. Callers choose when to prune missing/completed references.
async function queueHead(ids: string[], read: (id: string) => Promise<RebuildJob | undefined>) {
  let skipped = 0;
  let job: RebuildJob | undefined;
  while (skipped < ids.length) {
    job = await read(ids[skipped]);
    if (job && job.status !== 'completed') break;
    job = undefined;
    skipped++;
  }
  return { ids: ids.slice(skipped), job, skipped };
}

export class DigestPublisher extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();

  private executingContext(context?: OperationContext): OperationContext | undefined {
    return context ? { ...context, worker_version: this.env.CF_VERSION_METADATA?.id ?? context.worker_version, environment: this.env.ENVIRONMENT ?? context.environment } : undefined;
  }

  private serialize<T>(action: () => Promise<T>, context?: OperationContext): Promise<T> {
    const queued = performance.now();
    const result = this.queue.then(() => {
      emit('operation_stage', context, { stage: 'queue_wait', outcome: 'ok', duration_ms: performance.now() - queued });
      return action();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async publish(digest: Digest, origin: string, context?: OperationContext): Promise<PublishReply> {
    // Pre-v2 Workers ignore success values but rely on rejected RPCs for failure.
    // The already-deployed preview Worker also understands this success shape.
    const reply = await this.publishV2(digest, origin, context);
    if (!reply.ok) throw new Error(reply.failure.error);
    return reply;
  }

  private mutation<T>(operation: 'publish' | 'append' | 'retract' | 'preview', context: OperationContext | undefined,
    action: (complete: boolean | undefined, context: OperationContext | undefined, snapshot?: CommittedSnapshot) => Promise<T>): Promise<{ ok: true; result: T } | { ok: false; failure: PublishFailure }> {
    context = this.executingContext(context);
    return this.serialize(async () => {
      try {
        await this.repairCoordinator().recover(new OperationTrace(context));
        const migration = await new OperationTrace(context).run('migration_state', () => boundary('storage', () => this.ctx.storage.get<Migration>('migration')));
        let snapshot: CommittedSnapshot | undefined;
        // Internal publishing helpers may bootstrap a new bucket; only persisted
        // completion establishes that losing its manifest requires operator repair.
        if (migration?.complete) {
          try {
            await new OperationTrace(context).run('committed_snapshot_loading', async () => {
              snapshot = await committedSnapshot(this.env.SITE_BUCKET);
              requireCommittedManifest(snapshot);
            });
          } catch (error) { throw new PublicationError('not_committed', 'committed_snapshot_loading', error); }
        }
        return { ok: true, result: await action(migration?.complete, context, snapshot) };
      } catch (error) {
        const stage = error instanceof PublicationError ? error.stage : 'migration_state';
        const publication_status = operation === 'preview' ? 'not_attempted' : error instanceof PublicationError ? error.publication_status : 'not_committed';
        const cause = error instanceof PublicationError ? error.cause : error;
        const failure = operation === 'preview' ? { ...publicationFailure(cause, stage, publication_status), error: asHttpError(cause).message } : publicationFailure(cause, stage, publication_status, operation);
        emit(`${operation}_failed`, context, { stage, publication_status, publication_outcome: 'failed', error_code: failure.code, ...safeError(cause) }, 'error');
        return { ok: false, failure };
      }
    }, context);
  }

  async publishV2(digest: Digest, origin: string, context?: OperationContext, publisherFingerprint?: string): Promise<PublishReply> {
    return this.mutation('publish', context, (complete, executing, snapshot) => publishDigest(this.env.SITE_BUCKET, digest, origin, new Date(), complete, executing, { publisherFingerprint, snapshot }));
  }

  async publishEventsV1(digest: EventDigest, context?: OperationContext, dryRun = false): Promise<PublishReply> {
    context = this.executingContext(context);
    return this.serialize(() => publishEvents(this.env.SITE_BUCKET, digest, new Date(), context, dryRun), context);
  }

  async readEventsV1(query: string, context?: OperationContext): Promise<EventsReply> {
    context = this.executingContext(context);
    const trace = new OperationTrace(context);
    try {
      return { ok: true, result: await trace.run('events_read', () => readEvents(this.env.SITE_BUCKET, new URLSearchParams(query))) };
    } catch (error) {
      const failure = asHttpError(error);
      const stage = trace.failed_stage ?? 'events_read';
      emit('events_read_failed', context, { stage, error_code: failure.code, ...safeError(error) }, 'error');
      return { ok: false, failure: { status: failure.status, code: failure.code, error: failure.message, retryable: failure.retryable, stage, publication_status: 'not_attempted' } };
    }
  }

  async submitAlertV1(input: AlertInput, owner: string, context?: OperationContext, dryRun = false): Promise<AlertsReply> {
    context = this.executingContext(context);
    return this.serialize(async () => {
      try { return { ok: true, result: await submitAlert(this.env.SITE_BUCKET, input, owner, new Date(), context, dryRun) }; }
      catch (error) { return alertRpcFailure(error, context); }
    }, context);
  }

  async retractAlertEntryV1(alertId: string, entryId: string, owner: string, context?: OperationContext): Promise<AlertsReply> {
    context = this.executingContext(context);
    return this.serialize(async () => {
      try { return { ok: true, result: await retractAlertEntry(this.env.SITE_BUCKET, alertId, entryId, owner, new Date(), context) }; }
      catch (error) { return alertRpcFailure(error, context); }
    }, context);
  }

  async readAlertsV1(query: string, context?: OperationContext): Promise<AlertsReply> {
    context = this.executingContext(context);
    try {
      return { ok: true, result: await readAlerts(this.env.SITE_BUCKET, new URLSearchParams(query), await this.getCursorKey()) };
    } catch (error) { return alertRpcFailure(error, context); }
  }

  async previewDigestV1(digest: Digest, origin: string, context?: OperationContext): Promise<PublishReply> {
    return this.mutation('preview', context, (complete, executing, snapshot) => publishDigest(this.env.SITE_BUCKET, digest, origin, new Date(), complete, executing, { dryRun: true, snapshot }));
  }

  async previewAppendV1(postId: string, itemIndex: number, update: StoryUpdate, origin: string, context?: OperationContext): Promise<AppendReply> {
    return this.mutation('preview', context, (complete, executing, snapshot) => appendUpdate(this.env.SITE_BUCKET, postId, itemIndex, update, origin, new Date(), complete, executing, { dryRun: true, snapshot }));
  }

  async retractPostV1(postId: string, publisherFingerprint: string, origin: string, context?: OperationContext): Promise<RetractReply> {
    return this.mutation('retract', context, (complete, executing, snapshot) => retractPost(this.env.SITE_BUCKET, postId, publisherFingerprint, origin, new Date(), complete, executing, snapshot));
  }

  async findBatchV1(clientRef: string, context?: OperationContext): Promise<BatchReply> {
    context = this.executingContext(context);
    const trace = new OperationTrace(context);
    try {
      const publication = await trace.run('publication_loading', async () => (await committedSnapshot(this.env.SITE_BUCKET)).publication({ archives: false }));
      const index = await trace.run('history_index_loading', () => publication ? loadHistoryIndex(this.env.SITE_BUCKET, publication) : { version: 1 as const, posts: [], batches: [] });
      return { ok: true, result: findBatch(index, clientRef, new Date()) };
    } catch (error) {
      const failure = asHttpError(error);
      if (failure.code !== 'batch_not_found') emit('batch_lookup_failed', context, { stage: trace.failed_stage ?? 'batch_lookup', error_code: failure.code, ...safeError(error) }, 'error');
      return { ok: false, failure: { status: failure.status, code: failure.code, error: failure.message, retryable: failure.retryable,
        stage: trace.failed_stage ?? 'batch_lookup', publication_status: 'not_attempted' } };
    }
  }

  async appendUpdateV1(postId: string, itemIndex: number, update: StoryUpdate, origin: string, context?: OperationContext): Promise<AppendReply> {
    return this.mutation('append', context, (complete, executing, snapshot) => appendUpdate(this.env.SITE_BUCKET, postId, itemIndex, update, origin, new Date(), complete, executing, { snapshot }));
  }

  private repairCoordinator(): RepairCoordinator {
    return new RepairCoordinator(this.env.SITE_BUCKET, this.ctx.storage, async (origin, trace, context) => {
      const head = await this.rebuildHead(trace, context, 'repair');
      if (head.job?.status === 'failed') {
        if (!['manifest_damaged', 'legacy_recovery_required', 'source_damaged', 'archive_damaged'].includes(head.job.error_code ?? '')) {
          throw new HttpError(409, 'An unrelated failed rebuild blocks regeneration.', {}, { code: 'rebuild_blocked' });
        }
        return restartRebuild(head.job);
      }
      const migration = await boundary('storage', () => this.ctx.storage.get<Migration>('migration')) ?? initialMigration();
      const id = crypto.randomUUID();
      return { id, origin, status: 'queued', phase: migration.complete ? 'render' : 'migration', processed: migration.processed,
        created_at: new Date().toISOString(), ...(context ? { context: { ...context, job_id: id } } : {}) };
    });
  }

  async publicationRepairV1(input: unknown, origin: string, context?: OperationContext): Promise<RepairReply> {
    context = this.executingContext(context);
    const action = async (): Promise<RepairReply> => {
      const trace = new OperationTrace(context);
      try {
        const repairs = this.repairCoordinator();
        const result = input === undefined ? await repairs.snapshot(trace) : await repairs.submit(validateRepair(input), origin, trace, context);
        emit('repair_result', context, { repair_id: result.repair_id, job_id: result.job?.id,
          publication_status: result.unchanged ? 'not_attempted' : 'committed', publication_outcome: result.unchanged ? 'unchanged' : 'repaired' });
        return { ok: true, result };
      } catch (error) {
        const failure = asHttpError(error);
        const publication_status = input === undefined ? 'not_attempted' : failure.publication_status ?? trace.publication_status;
        emit('repair_failed', context, { stage: trace.failed_stage ?? 'repair_validation', error_code: failure.code,
          publication_status, ...safeError(error) }, failure.status >= 500 ? 'error' : 'warn');
        return { ok: false, failure: { status: failure.status, code: failure.code, error: failure.message,
          retryable: failure.retryable, publication_status, stage: trace.failed_stage ?? 'repair_validation',
          details: failure.details, details_truncated: failure.details_truncated, ...(failure.retry_at ? { retry_at: failure.retry_at } : {}) } };
      }
    };
    // Inspection pins its own R2 HEAD and must not wait for rendering or writes.
    return input === undefined ? action() : this.serialize(action, context);
  }

  private cursorKey?: Promise<string>;
  private getCursorKey(): Promise<string> {
    // The caller credential cannot sign trusted cursors. A transaction also
    // protects first initialization while reads bypass the publication queue.
    this.cursorKey ??= boundary('storage', () => this.ctx.storage.transaction(async storage => {
      let key = await storage.get<string>('posts_cursor_key');
      if (!key) {
        key = `${crypto.randomUUID()}${crypto.randomUUID()}`;
        await storage.put('posts_cursor_key', key);
      }
      return key;
    })).catch(error => { this.cursorKey = undefined; throw error; });
    return this.cursorKey;
  }

  async readPostsV1(query: string, context?: OperationContext): Promise<PostsReply> {
    context = this.executingContext(context);
    const trace = new OperationTrace(context);
    try {
      const key = await trace.run('cursor_key', () => this.getCursorKey());
      return { ok: true, result: await trace.run('posts_read', () => readPosts(this.env.SITE_BUCKET, new URLSearchParams(query), key)) };
    } catch (error) {
      const failure = asHttpError(error);
      const stage = trace.failed_stage ?? 'posts_read';
      emit('posts_read_failed', context, { stage, error_code: failure.code, ...safeError(error) }, 'error');
      return { ok: false, failure: { status: failure.status, code: failure.code, error: failure.message, retryable: failure.retryable, stage, publication_status: 'not_attempted' } };
    }
  }

  private rebuildRequest<T>(context: OperationContext | undefined, identity: { job_id: string } | { candidate_job_id: string }, action: (trace: OperationTrace, context?: OperationContext) => Promise<T>): Promise<T> {
    context = this.executingContext(context);
    if (context) context = { ...context, ...identity };
    return this.serialize(async () => {
      const trace = new OperationTrace(context);
      try { return await action(trace, context); }
      catch (error) {
        emit('rebuild_request_failed', context, { stage: trace.failed_stage ?? 'rebuild_request', error_code: asHttpError(error).code, ...safeError(error) }, 'error');
        throw error;
      }
    }, context);
  }

  async enqueueRebuild(origin: string, context?: OperationContext): Promise<RebuildJob> {
    const id = crypto.randomUUID();
    return this.rebuildRequest(context, { candidate_job_id: id }, async (trace, context) => {
      return this.enqueueRebuildUnlocked(id, origin, trace, context);
    });
  }

  private async enqueueRebuildUnlocked(id: string, origin: string, trace: OperationTrace, context?: OperationContext): Promise<RebuildJob> {
    const migration = await trace.run('rebuild_enqueue_state', () => boundary('storage', () => this.ctx.storage.get<Migration>('migration'))) ?? initialMigration();
    const jobContext = context ? { ...context, job_id: id } : undefined;
    if (jobContext) delete jobContext.candidate_job_id;
    const job: RebuildJob = { id, origin, status: 'queued', phase: migration.complete ? 'render' : 'migration', processed: migration.processed, created_at: new Date().toISOString(), ...(jobContext ? { context: jobContext } : {}) };
    await trace.run('rebuild_enqueue', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
      const ids = await storage.get<string[]>('jobs') ?? [];
      const head = await queueHead(ids, id => storage.get<RebuildJob>(`job:${id}`));
      await storage.put(`job:${job.id}`, job);
      await storage.put('jobs', [...ids, job.id]);
      if (head.job?.status !== 'failed') await storage.setAlarm(Date.now() + 1000);
    })));
    emit('rebuild_queued', jobContext, { job_id: job.id });
    return job;
  }

  async jobStatus(id: string, context?: OperationContext): Promise<RebuildJob | null> {
    return this.rebuildRequest(context, { job_id: id }, trace => trace.run('rebuild_status_read', async () => {
      await this.repairCoordinator().recover(trace);
      const job = await boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${id}`));
      if (!job) return null;
      const ids = await boundary('storage', () => this.ctx.storage.get<string[]>('jobs')) ?? [];
      const head = await queueHead(ids, id => boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${id}`)));
      return { ...job, ...(job.status === 'queued' && head.job?.status === 'failed' && head.job.id !== id ? { blocked_by: head.job.id } : {}) };
    }));
  }

  async resumeRebuild(id: string, context?: OperationContext): Promise<RebuildJob | 'conflict' | null> {
    return this.rebuildRequest(context, { job_id: id }, async (trace, context) => {
      await this.repairCoordinator().recover(trace);
      const saved = await trace.run('rebuild_resume_read', () => boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${id}`)));
      if (!saved) return null;
      const job = restartRebuild(saved);
      const head = await this.rebuildHead(trace, context, 'rebuild_resume');
      if (head.job?.id !== id || !['failed', 'queued', 'running'].includes(saved.status)) return 'conflict';
      if (saved.status !== 'failed' && await trace.run('rebuild_resume_alarm_read', () => boundary('storage', () => this.ctx.storage.getAlarm())) !== null) return 'conflict';
      if (context) job.context = context;
      // The repair timing encloses this write; failures retain the inner write stage.
      const write = () => trace.run('rebuild_resume_write', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
        if (head.skipped) await storage.put('jobs', head.ids);
        await storage.put(`job:${id}`, job);
        await storage.setAlarm(Date.now() + 1000);
      })));
      if (head.skipped) await trace.run('rebuild_resume_queue_repair', write);
      else await write();
      return job;
    });
  }

  private async rebuildHead(trace: OperationTrace, context?: OperationContext, prefix = 'rebuild') {
    const ids = await trace.run(`${prefix}_queue_read`, () => boundary('storage', () => this.ctx.storage.get<string[]>('jobs'))) ?? [];
    return queueHead(ids, async id => {
      const job = await trace.run(`${prefix}_${prefix === 'rebuild' ? 'job' : 'head'}_read`, () => boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${id}`)), { queue_entry_id: id });
      if (!job) emit('rebuild_queue_entry_missing', context, { job_id: id, error_code: 'job_record_missing' }, 'error');
      else if (job.status === 'completed') emit('rebuild_queue_entry_completed', context, { job_id: id });
      return job;
    });
  }

  async alarm(): Promise<void> {
    const bootstrapContext: OperationContext = { request_id: crypto.randomUUID(), worker_version: this.env.CF_VERSION_METADATA?.id ?? 'local', environment: this.env.ENVIRONMENT ?? 'local', operation: 'rebuild' };
    return this.serialize(async () => {
      const bootstrap = new OperationTrace(bootstrapContext);
      try { await this.repairCoordinator().recover(bootstrap, true); }
      catch (error) { if (asHttpError(error).code === 'repair_pending') return; throw error; }
      let ids: string[];
      let job: RebuildJob | null | undefined;
      try {
        const head = await this.rebuildHead(bootstrap, bootstrapContext);
        ({ ids, job } = head);
        if (job) bootstrapContext.job_id = job.id;
        if (head.skipped) await bootstrap.run('rebuild_queue_repair', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
          await storage.put('jobs', ids);
        })));
      } catch (error) {
        emit('rebuild_alarm_failed', bootstrapContext, { stage: bootstrap.failed_stage, error_code: asHttpError(error).code, ...safeError(error) }, 'error');
        // Leave recovery to bounded platform redelivery, then manual resume.
        throw error;
      }
      if (!job || job.status === 'failed') return;
      if (job.next_retry_at && Date.parse(job.next_retry_at) > Date.now()) {
        await boundary('storage', () => this.ctx.storage.setAlarm(Date.parse(job!.next_retry_at!)));
        return;
      }
      const context: OperationContext = { request_id: job.context?.request_id ?? job.id, ...job.context, worker_version: this.env.CF_VERSION_METADATA?.id ?? 'local', environment: this.env.ENVIRONMENT ?? 'local', operation: 'rebuild', job_id: job.id };
      const trace = new OperationTrace(context);
      try {
        delete job.next_retry_at;
        job.status = 'running';
        job.started_at ??= new Date().toISOString();
        await trace.run('rebuild_start', () => boundary('storage', () => this.ctx.storage.put(`job:${job.id}`, job)));
        let migrationBefore = initialMigration();
        const migration = await trace.run('migration', async () => {
          migrationBefore = await boundary('storage', () => this.ctx.storage.get<Migration>('migration')) ?? initialMigration();
          return migrateBatch(this.env.SITE_BUCKET, migrationBefore);
        });
        // Capture any legacy bootstrap selection before confirming migration
        // completion; later operations must not discover raw sources again.
        let bootstrap = false;
        const baseline = migration.complete ? await trace.run('publication_loading', async () => {
          const snapshot = await committedSnapshot(this.env.SITE_BUCKET);
          bootstrap = !snapshot.index?.customMetadata?.manifest;
          return { snapshot, publication: await currentPublication(this.env.SITE_BUCKET, migrationBefore.complete ? async () => [] : undefined, snapshot, migrationBefore.complete, trace) };
        }) : undefined;
        job.processed = migration.processed;
        job.phase = migration.complete ? 'render' : 'migration';
        await trace.run('rebuild_checkpoint', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
          // Without a committed manifest a failed initial render must be able
          // to repeat discovery. Replaying the final import batch is idempotent.
          await storage.put('migration', bootstrap ? migrationBefore : migration);
          await storage.put(`job:${job.id}`, job);
          if (!migration.complete) await storage.setAlarm(Date.now() + 1000);
        })));
        if (!migration.complete) return;
        const checkpoint = await trace.run('rebuild_archive_state', () => boundary('storage', () => this.ctx.storage.get<string>(`rebuild:${job.id}`)));
        const rebuilt = await rebuildHomepage(this.env.SITE_BUCKET, job.origin, trace, migration.complete, baseline, { jobId: job.id, checkpoint });
        if (rebuilt.progress) job.archive_progress = rebuilt.progress;
        switch (rebuilt.kind) {
          case 'pending':
          case 'reconcile':
            await trace.run('rebuild_archive_progress', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
              if (rebuilt.kind === 'pending') await storage.put(`rebuild:${job.id}`, rebuilt.checkpoint);
              const delay = rebuilt.kind === 'reconcile' ? Math.min(30, 2 ** Math.min(job.conflict_count ?? 0, 5)) : 1;
              if (rebuilt.kind === 'reconcile') {
                job.conflict_count = (job.conflict_count ?? 0) + 1;
                job.next_retry_at = new Date(Date.now() + delay * 1000).toISOString();
              }
              await storage.put(`job:${job.id}`, job);
              await storage.setAlarm(Date.now() + delay * 1000);
            })));
            return;
          case 'committed': break;
          default: {
            const unexpected: never = rebuilt;
            throw new Error(`Unexpected rebuild result kind: ${String((unexpected as { kind?: unknown })?.kind)}`);
          }
        }
        delete job.next_retry_at; delete job.conflict_count;
        job.status = 'completed';
        job.finished_at = new Date().toISOString();
        await trace.run('rebuild_finalize', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
          if (bootstrap) await storage.put('migration', migration);
          await storage.delete(`rebuild:${job.id}`);
          await storage.put(`job:${job.id}`, job);
          await storage.put('jobs', ids.slice(1));
          if (ids.length > 1) await storage.setAlarm(Date.now() + 1000);
        })));
        emit('rebuild_completed', context, { processed: job.processed });
      } catch (error) {
        const failedStage = trace.failed_stage ?? trace.stage ?? 'rebuild_processing';
        const failure = asHttpError(error);
        emit('rebuild_failed', context, { stage: failedStage, error_code: failure.code, publication_status: trace.publication_status, ...safeError(error) }, 'error');
        job.status = 'failed';
        job.finished_at = new Date().toISOString();
        job.error = 'Rebuild failed; inspect Worker logs, repair the cause, then resume this job';
        job.error_code = failure.code;
        job.failed_stage = failedStage;
        try {
          await trace.run('rebuild_failure_record', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
            await storage.put(`job:${job.id}`, job);
            await storage.deleteAlarm();
          })));
        } catch (recordError) {
          emit('rebuild_failure_record_failed', context, { stage: 'rebuild_failure_record', error_code: asHttpError(recordError).code,
            original_failed_stage: failedStage, original_error_code: failure.code, publication_status: trace.publication_status, ...safeError(recordError) }, 'error');
          throw recordError;
        }
        // Handled failures stop here. Platform redelivery sees the persisted failed state.
      }
    }, bootstrapContext);
  }
}
