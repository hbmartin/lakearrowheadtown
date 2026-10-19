import { DurableObject } from 'cloudflare:workers';
import { initialMigration, migrateBatch, PublicationError, publishDigest, rebuildHomepage } from './publishing';
import { emit, OperationTrace, safeError } from './diagnostics';
import { asHttpError, boundary, publicationFailure } from './errors';
import type { Digest, Env, Migration, OperationContext, PublishReply, RebuildJob } from './types';

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
        const head = ids.length ? await storage.get<RebuildJob>(`job:${ids[0]}`) : null;
        await storage.put(`job:${job.id}`, job);
        await storage.put('jobs', [...ids, job.id]);
        if (head?.status !== 'failed') await storage.setAlarm(Date.now() + 1000);
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
      const head = ids.length ? await boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${ids[0]}`)) : null;
      return { ...job, ...(job.status === 'queued' && head?.status === 'failed' && head.id !== id ? { blocked_by: head.id } : {}) };
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
      await trace.run('rebuild_resume_write', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
        await storage.put(`job:${id}`, job);
        await storage.setAlarm(Date.now() + 1000);
      })));
      return job;
    });
  }

  private async rebuildHead(trace: OperationTrace, context?: OperationContext, prefix = 'rebuild'): Promise<{ ids: string[]; job: RebuildJob | undefined }> {
    const ids = await trace.run(`${prefix}_queue_read`, () => boundary('storage', () => this.ctx.storage.get<string[]>('jobs'))) ?? [];
    let skipped = 0;
    let job: RebuildJob | undefined;
    while (skipped < ids.length) {
      if (context && prefix === 'rebuild') context.job_id = ids[skipped];
      job = await trace.run(`${prefix}_${prefix === 'rebuild' ? 'job' : 'head'}_read`, () => boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${ids[skipped]}`)));
      if (job) break;
      emit('rebuild_queue_entry_missing', context, { job_id: ids[skipped], error_code: 'job_record_missing' }, 'error');
      skipped++;
    }
    const remaining = ids.slice(skipped);
    if (skipped) await trace.run(`${prefix}_queue_repair`, () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
      await storage.put('jobs', remaining);
    })));
    return { ids: remaining, job };
  }

  async alarm(): Promise<void> {
    const bootstrapContext: OperationContext = { request_id: crypto.randomUUID(), worker_version: this.env.CF_VERSION_METADATA?.id ?? 'local', environment: this.env.ENVIRONMENT ?? 'local', operation: 'rebuild' };
    return this.serialize(async () => {
      const bootstrap = new OperationTrace(bootstrapContext);
      let ids: string[];
      let job: RebuildJob | null | undefined;
      try {
        ({ ids, job } = await this.rebuildHead(bootstrap, bootstrapContext));
      } catch (error) {
        emit('rebuild_alarm_failed', bootstrapContext, { stage: bootstrap.failed_stage, error_code: asHttpError(error).code, ...safeError(error) }, 'error');
        // Without a loaded job, leave queue state untouched for platform redelivery.
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
        await trace.run('rebuild_failure_record', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
          await storage.put(`job:${job.id}`, job);
          await storage.deleteAlarm();
        })));
        // Handled failures stop here. Platform redelivery sees the persisted failed state.
      }
    }, bootstrapContext);
  }
}
