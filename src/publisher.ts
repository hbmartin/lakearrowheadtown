import { DurableObject } from 'cloudflare:workers';
import { initialMigration, migrateBatch, PublicationError, publishDigest, rebuildHomepage } from './publishing';
import { emit, OperationTrace, safeError } from './diagnostics';
import { asHttpError, boundary, publicationFailure } from './errors';
import type { Digest, Env, Migration, OperationContext, PublishReply, RebuildJob } from './types';

// Inspection is read-only. Each caller decides whether and when to prune missing references.
async function queueHead(ids: string[], read: (id: string) => Promise<RebuildJob | undefined>) {
  let skipped = 0;
  let job: RebuildJob | undefined;
  while (skipped < ids.length) {
    job = await read(ids[skipped]);
    if (job) break;
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

  async publishV2(digest: Digest, origin: string, context?: OperationContext): Promise<PublishReply> {
    context = this.executingContext(context);
    return this.serialize(async () => {
      try {
        const migration = await new OperationTrace(context).run('migration_state', () => boundary('storage', () => this.ctx.storage.get<Migration>('migration')));
        return { ok: true, result: await publishDigest(this.env.SITE_BUCKET, digest, origin, new Date(), migration?.complete, context) };
      } catch (error) {
        const stage = error instanceof PublicationError ? error.stage : 'migration_state';
        const publication_status = error instanceof PublicationError ? error.publication_status : 'not_committed';
        const cause = error instanceof PublicationError ? error.cause : error;
        const failure = publicationFailure(cause, stage, publication_status);
        emit('publish_failed', context, { stage, publication_status, publication_outcome: 'failed', error_code: failure.code, ...safeError(cause) }, 'error');
        return { ok: false, failure };
      }
    }, context);
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
    });
  }

  async jobStatus(id: string, context?: OperationContext): Promise<RebuildJob | null> {
    return this.rebuildRequest(context, { job_id: id }, trace => trace.run('rebuild_status_read', async () => {
      const job = await boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${id}`));
      if (!job) return null;
      const ids = await boundary('storage', () => this.ctx.storage.get<string[]>('jobs')) ?? [];
      const head = await queueHead(ids, id => boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${id}`)));
      return { ...job, ...(job.status === 'queued' && head.job?.status === 'failed' && head.job.id !== id ? { blocked_by: head.job.id } : {}) };
    }));
  }

  async resumeRebuild(id: string, context?: OperationContext): Promise<RebuildJob | 'conflict' | null> {
    return this.rebuildRequest(context, { job_id: id }, async (trace, context) => {
      const job = await trace.run('rebuild_resume_read', () => boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${id}`)));
      if (!job) return null;
      const head = await this.rebuildHead(trace, context, 'rebuild_resume');
      if (head.job?.id !== id || !['failed', 'queued', 'running'].includes(job.status)) return 'conflict';
      if (job.status !== 'failed' && await trace.run('rebuild_resume_alarm_read', () => boundary('storage', () => this.ctx.storage.getAlarm())) !== null) return 'conflict';
      job.status = 'queued';
      delete job.error;
      delete job.finished_at;
      delete job.error_code;
      delete job.failed_stage;
      if (context) job.context = context;
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
      if (context && prefix === 'rebuild') context.job_id = id;
      const job = await trace.run(`${prefix}_${prefix === 'rebuild' ? 'job' : 'head'}_read`, () => boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${id}`)));
      if (!job) emit('rebuild_queue_entry_missing', context, { job_id: id, error_code: 'job_record_missing' }, 'error');
      return job;
    });
  }

  async alarm(): Promise<void> {
    const bootstrapContext: OperationContext = { request_id: crypto.randomUUID(), worker_version: this.env.CF_VERSION_METADATA?.id ?? 'local', environment: this.env.ENVIRONMENT ?? 'local', operation: 'rebuild' };
    return this.serialize(async () => {
      const bootstrap = new OperationTrace(bootstrapContext);
      let ids: string[];
      let job: RebuildJob | null | undefined;
      try {
        const head = await this.rebuildHead(bootstrap, bootstrapContext);
        ({ ids, job } = head);
        if (head.skipped) await bootstrap.run('rebuild_queue_repair', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
          await storage.put('jobs', ids);
        })));
      } catch (error) {
        emit('rebuild_alarm_failed', bootstrapContext, { stage: bootstrap.failed_stage, error_code: asHttpError(error).code, ...safeError(error) }, 'error');
        // Leave recovery to bounded platform redelivery, then manual resume.
        throw error;
      }
      if (!job || job.status === 'failed') return;
      const context: OperationContext = { request_id: job.context?.request_id ?? job.id, ...job.context, worker_version: this.env.CF_VERSION_METADATA?.id ?? 'local', environment: this.env.ENVIRONMENT ?? 'local', operation: 'rebuild', job_id: job.id };
      const trace = new OperationTrace(context);
      try {
        job.status = 'running';
        job.started_at ??= new Date().toISOString();
        await trace.run('rebuild_start', () => boundary('storage', () => this.ctx.storage.put(`job:${job.id}`, job)));
        const migration = await trace.run('migration', async () => migrateBatch(this.env.SITE_BUCKET, await boundary('storage', () => this.ctx.storage.get<Migration>('migration')) ?? initialMigration()));
        job.processed = migration.processed;
        job.phase = migration.complete ? 'render' : 'migration';
        await trace.run('rebuild_checkpoint', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
          await storage.put('migration', migration);
          await storage.put(`job:${job.id}`, job);
          if (!migration.complete) await storage.setAlarm(Date.now() + 1000);
        })));
        if (!migration.complete) return;
        await rebuildHomepage(this.env.SITE_BUCKET, job.origin, trace);
        job.status = 'completed';
        job.finished_at = new Date().toISOString();
        await trace.run('rebuild_finalize', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
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
