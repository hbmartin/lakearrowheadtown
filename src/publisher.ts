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

  private rebuildRequest<T>(context: OperationContext | undefined, job_id: string, action: (trace: OperationTrace, context?: OperationContext) => Promise<T>): Promise<T> {
    context = this.executingContext(context);
    if (context) context = { ...context, job_id };
    return this.serialize(async () => {
      const trace = new OperationTrace(context);
      try { return await action(trace, context); }
      catch (error) {
        emit('rebuild_failed', context, { stage: trace.failed_stage ?? 'rebuild_request', error_code: asHttpError(error).code, publication_status: trace.publication_status, ...safeError(error) }, 'error');
        throw error;
      }
    }, context);
  }

  async enqueueRebuild(origin: string, context?: OperationContext): Promise<RebuildJob> {
    const id = crypto.randomUUID();
    return this.rebuildRequest(context, id, async (trace, context) => {
      const migration = await trace.run('rebuild_enqueue_state', () => boundary('storage', () => this.ctx.storage.get<Migration>('migration'))) ?? initialMigration();
      const job: RebuildJob = { id, origin, status: 'queued', phase: migration.complete ? 'render' : 'migration', processed: migration.processed, created_at: new Date().toISOString(), ...(context ? { context } : {}) };
      await trace.run('rebuild_enqueue', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
        const ids = await storage.get<string[]>('jobs') ?? [];
        const head = ids.length ? await storage.get<RebuildJob>(`job:${ids[0]}`) : null;
        await storage.put(`job:${job.id}`, job);
        await storage.put('jobs', [...ids, job.id]);
        if (head?.status !== 'failed') await storage.setAlarm(Date.now() + 1000);
      })));
      emit('rebuild_queued', context, { job_id: job.id });
      return job;
    });
  }

  async jobStatus(id: string, context?: OperationContext): Promise<RebuildJob | null> {
    return this.rebuildRequest(context, id, trace => trace.run('rebuild_status_read', async () => {
      const job = await boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${id}`));
      if (!job) return null;
      const ids = await boundary('storage', () => this.ctx.storage.get<string[]>('jobs')) ?? [];
      const head = ids.length ? await boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${ids[0]}`)) : null;
      return { ...job, ...(job.status === 'queued' && head?.status === 'failed' && head.id !== id ? { blocked_by: head.id } : {}) };
    }));
  }

  async resumeRebuild(id: string, context?: OperationContext): Promise<RebuildJob | 'conflict' | null> {
    return this.rebuildRequest(context, id, async (trace, context) => {
      const job = await trace.run('rebuild_resume_read', () => boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${id}`)));
      if (!job) return null;
      if (job.status !== 'failed') return 'conflict';
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

  async alarm(): Promise<void> {
    const bootstrapContext: OperationContext = { request_id: crypto.randomUUID(), worker_version: this.env.CF_VERSION_METADATA?.id ?? 'local', environment: this.env.ENVIRONMENT ?? 'local', operation: 'rebuild' };
    return this.serialize(async () => {
      const bootstrap = new OperationTrace(bootstrapContext);
      let ids: string[];
      let job: RebuildJob | null | undefined;
      try {
        ids = await bootstrap.run('rebuild_queue_read', () => boundary('storage', () => this.ctx.storage.get<string[]>('jobs'))) ?? [];
        if (ids.length) bootstrapContext.job_id = ids[0];
        job = ids.length ? await bootstrap.run('rebuild_job_read', () => boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${ids[0]}`))) : null;
      } catch (error) {
        emit('rebuild_failed', bootstrapContext, { stage: bootstrap.failed_stage, error_code: asHttpError(error).code, publication_status: bootstrap.publication_status, ...safeError(error) }, 'error');
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
