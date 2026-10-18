import { DurableObject } from 'cloudflare:workers';
import { initialMigration, migrateBatch, PublicationError, publishDigest, rebuildHomepage } from './publishing';
import { emit, OperationTrace, safeError } from './diagnostics';
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
    context = this.executingContext(context);
    return this.serialize(async () => {
      try {
        const migration = await new OperationTrace(context).run('migration_state', () => this.ctx.storage.get<Migration>('migration'));
        return { ok: true, result: await publishDigest(this.env.SITE_BUCKET, digest, origin, new Date(), migration?.complete, context) };
      } catch (error) {
        const stage = error instanceof PublicationError ? error.stage : 'migration_state';
        const publication_status = error instanceof PublicationError ? error.publication_status : 'not_committed';
        const code = stage === 'rendering' ? 'render_failed' : 'storage_error';
        emit('publish_failed', context, { stage, publication_status, error_code: code, ...safeError(error instanceof PublicationError ? error.cause : error) }, 'error');
        return { ok: false, failure: { code, stage, publication_status, retryable: true, error: publication_status === 'unknown'
          ? 'Unable to publish digest; publication may have completed. Retry the unchanged payload within the seven-day deduplication window.'
          : 'Unable to publish digest before publication committed. Retry the unchanged payload.' } };
      }
    }, context);
  }

  async enqueueRebuild(origin: string, context?: OperationContext): Promise<RebuildJob> {
    context = this.executingContext(context);
    return this.serialize(async () => {
      const migration = await this.ctx.storage.get<Migration>('migration') ?? initialMigration();
      const job: RebuildJob = { id: crypto.randomUUID(), origin, status: 'queued', phase: migration.complete ? 'render' : 'migration', processed: migration.processed, created_at: new Date().toISOString(), ...(context ? { context } : {}) };
      await this.ctx.storage.transaction(async storage => {
        const ids = await storage.get<string[]>('jobs') ?? [];
        const head = ids.length ? await storage.get<RebuildJob>(`job:${ids[0]}`) : null;
        await storage.put(`job:${job.id}`, job);
        await storage.put('jobs', [...ids, job.id]);
        if (head?.status !== 'failed') await storage.setAlarm(Date.now() + 1000);
      });
      emit('rebuild_queued', context, { job_id: job.id });
      return job;
    }, context);
  }

  async jobStatus(id: string): Promise<RebuildJob | null> {
    return this.serialize(async () => {
      const job = await this.ctx.storage.get<RebuildJob>(`job:${id}`);
      if (!job) return null;
      const ids = await this.ctx.storage.get<string[]>('jobs') ?? [];
      const head = ids.length ? await this.ctx.storage.get<RebuildJob>(`job:${ids[0]}`) : null;
      return { ...job, ...(job.status === 'queued' && head?.status === 'failed' && head.id !== id ? { blocked_by: head.id } : {}) };
    });
  }

  async resumeRebuild(id: string, context?: OperationContext): Promise<RebuildJob | 'conflict' | null> {
    context = this.executingContext(context);
    return this.serialize(async () => {
      const job = await this.ctx.storage.get<RebuildJob>(`job:${id}`);
      if (!job) return null;
      if (job.status !== 'failed') return 'conflict';
      job.status = 'queued';
      delete job.error;
      delete job.finished_at;
      delete job.error_code;
      delete job.failed_stage;
      if (context) job.context = context;
      await this.ctx.storage.transaction(async storage => {
        await storage.put(`job:${id}`, job);
        await storage.setAlarm(Date.now() + 1000);
      });
      return job;
    }, context);
  }

  async alarm(): Promise<void> {
    return this.serialize(async () => {
      const ids = await this.ctx.storage.get<string[]>('jobs') ?? [];
      const job = ids.length ? await this.ctx.storage.get<RebuildJob>(`job:${ids[0]}`) : null;
      if (!job || job.status === 'failed') return;
      const context: OperationContext = { request_id: job.context?.request_id ?? job.id, ...job.context, worker_version: this.env.CF_VERSION_METADATA?.id ?? 'local', environment: this.env.ENVIRONMENT ?? 'local', operation: 'rebuild', job_id: job.id };
      const trace = new OperationTrace(context);
      try {
        job.status = 'running';
        job.started_at ??= new Date().toISOString();
        await this.ctx.storage.put(`job:${job.id}`, job);
        const migration = await trace.run('migration', async () => migrateBatch(this.env.SITE_BUCKET, await this.ctx.storage.get<Migration>('migration') ?? initialMigration()));
        job.processed = migration.processed;
        job.phase = migration.complete ? 'render' : 'migration';
        await this.ctx.storage.transaction(async storage => {
          await storage.put('migration', migration);
          await storage.put(`job:${job.id}`, job);
          if (!migration.complete) await storage.setAlarm(Date.now() + 1000);
        });
        if (!migration.complete) return;
        await rebuildHomepage(this.env.SITE_BUCKET, job.origin, trace);
        job.status = 'completed';
        job.finished_at = new Date().toISOString();
        await this.ctx.storage.transaction(async storage => {
          await storage.put(`job:${job.id}`, job);
          await storage.put('jobs', ids.slice(1));
          if (ids.length > 1) await storage.setAlarm(Date.now() + 1000);
        });
        emit('rebuild_completed', context, { processed: job.processed });
      } catch (error) {
        emit('rebuild_failed', context, { stage: trace.stage, error_code: 'rebuild_failed', ...safeError(error) }, 'error');
        job.status = 'failed';
        job.finished_at = new Date().toISOString();
        job.error = 'Rebuild failed; inspect Worker logs, repair the cause, then resume this job';
        job.error_code = 'rebuild_failed';
        job.failed_stage = trace.stage;
        await this.ctx.storage.transaction(async storage => {
          await storage.put(`job:${job.id}`, job);
          await storage.deleteAlarm();
        });
        // Handled failures stop here. Platform redelivery sees the persisted failed state.
      }
    });
  }
}
