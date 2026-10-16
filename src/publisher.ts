import { DurableObject } from 'cloudflare:workers';
import { initialMigration, migrateBatch, publishDigest, rebuildHomepage } from './publishing';
import type { Digest, Env, Migration, RebuildJob } from './types';

export class DigestPublisher extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  async publish(digest: Digest, origin: string): Promise<void> {
    return this.serialize(async () => {
      const migration = await this.ctx.storage.get<Migration>('migration');
      await publishDigest(this.env.SITE_BUCKET, digest, origin, new Date(), migration?.complete);
    });
  }

  async enqueueRebuild(origin: string): Promise<RebuildJob> {
    return this.serialize(async () => {
      const migration = await this.ctx.storage.get<Migration>('migration') ?? initialMigration();
      const job: RebuildJob = { id: crypto.randomUUID(), origin, status: 'queued', phase: migration.complete ? 'render' : 'migration', processed: migration.processed, created_at: new Date().toISOString() };
      await this.ctx.storage.transaction(async storage => {
        const ids = await storage.get<string[]>('jobs') ?? [];
        const head = ids.length ? await storage.get<RebuildJob>(`job:${ids[0]}`) : null;
        await storage.put(`job:${job.id}`, job);
        await storage.put('jobs', [...ids, job.id]);
        if (head?.status !== 'failed') await storage.setAlarm(Date.now() + 1000);
      });
      return job;
    });
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

  async resumeRebuild(id: string): Promise<RebuildJob | 'conflict' | null> {
    return this.serialize(async () => {
      const job = await this.ctx.storage.get<RebuildJob>(`job:${id}`);
      if (!job) return null;
      if (job.status !== 'failed') return 'conflict';
      job.status = 'queued';
      delete job.error;
      delete job.finished_at;
      await this.ctx.storage.transaction(async storage => {
        await storage.put(`job:${id}`, job);
        await storage.setAlarm(Date.now() + 1000);
      });
      return job;
    });
  }

  async alarm(): Promise<void> {
    return this.serialize(async () => {
      const ids = await this.ctx.storage.get<string[]>('jobs') ?? [];
      const job = ids.length ? await this.ctx.storage.get<RebuildJob>(`job:${ids[0]}`) : null;
      if (!job || job.status === 'failed') return;
      try {
        job.status = 'running';
        job.started_at ??= new Date().toISOString();
        await this.ctx.storage.put(`job:${job.id}`, job);
        const migration = await migrateBatch(this.env.SITE_BUCKET, await this.ctx.storage.get<Migration>('migration') ?? initialMigration());
        job.processed = migration.processed;
        job.phase = migration.complete ? 'render' : 'migration';
        await this.ctx.storage.transaction(async storage => {
          await storage.put('migration', migration);
          await storage.put(`job:${job.id}`, job);
          if (!migration.complete) await storage.setAlarm(Date.now() + 1000);
        });
        if (!migration.complete) return;
        await rebuildHomepage(this.env.SITE_BUCKET, job.origin);
        job.status = 'completed';
        job.finished_at = new Date().toISOString();
        await this.ctx.storage.transaction(async storage => {
          await storage.put(`job:${job.id}`, job);
          await storage.put('jobs', ids.slice(1));
          if (ids.length > 1) await storage.setAlarm(Date.now() + 1000);
        });
      } catch (error) {
        console.error('Rebuild failed', error instanceof Error ? error.name : 'Unknown error');
        job.status = 'failed';
        job.finished_at = new Date().toISOString();
        job.error = 'Rebuild failed; inspect Worker logs, repair the cause, then resume this job';
        await this.ctx.storage.transaction(async storage => {
          await storage.put(`job:${job.id}`, job);
          await storage.deleteAlarm();
        });
        // Handled failures stop here. Platform redelivery sees the persisted failed state.
      }
    });
  }
}
