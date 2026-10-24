import { captureChanges, readChanges, type ChangesReply } from './changes';
import { DurableObject } from 'cloudflare:workers';
import { appendUpdate, currentPublication, initialMigration, migrateBatch, PublicationError, publishDigest, rebuildHomepage, retractPost } from './publishing';
import { findBatch, loadHistoryIndex } from './history-index';
import { emit, OperationTrace, safeError } from './diagnostics';
import { committedSnapshot, requireCommittedManifest, type CommittedSnapshot } from './committed';
import { asHttpError, boundary, HttpError, publicationFailure } from './errors';
import { alertRpcFailure, confirmAlerts, readAlerts, retractAlertEntry, submitAlert, type AlertInput, type HistoryMode, type AlertsReply } from './alerts';
import { readPosts, type PostsReply } from './posts';
import { publishEvents, readEvents, type EventDigest, type EventsReply } from './events';
import { validateRepair, type RepairReply } from './publication-repair';
import { RepairCoordinator, restartRebuild, newRebuild, isPaused, pauseReason } from './repair-coordinator';
import { composeHomepageConditions } from './homepage-conditions';
import { checkpointKey, checkpointDamaged, checkpointFor, completeMigration, generationKey, pauseKey, readPause, repairableCodes, readCheckpoint, readHandoff, receiptMatches, type GenerationHandoff } from './rebuild-evidence';
import { validateWeather, WEATHER_KEY, WEATHER_URL } from './weather';
import { readLimited } from './validation';
import type { AppendReply, BatchReply, Digest, Env, Migration, OperationContext, PublicationStatus, PublishFailure, PublishReply, RebuildJob, RebuildResumeReply, RetractReply, StoryUpdate } from './types';

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
  private alarmDeliveries = 0;

  private conditionsOrigin(): string {
    return this.env.SITE_ORIGIN || 'https://lakearrowheadtown-preview.harold-martin.workers.dev';
  }

  private async finishConditions(origin = this.conditionsOrigin(), context?: OperationContext): Promise<void> {
    let stage = 'conditions_intent_read';
    try {
      if (!await boundary('storage', () => this.ctx.storage.get('conditions:pending')) && (await boundary('storage', () => this.env.SITE_BUCKET.head('pages/index.html')))?.customMetadata?.conditions_status !== 'unavailable') return;
      stage = 'repair_recovery';
      await this.repairCoordinator().gate(context);
      stage = 'conditions_composition';
      const available = await composeHomepageConditions(this.env.SITE_BUCKET, origin, context);
      stage = 'conditions_intent_write';
      if (!available) { await boundary('storage', () => this.ctx.storage.put('conditions:pending', true)); emit('conditions_unavailable', context, {}, 'error'); return; }
      await boundary('storage', () => this.ctx.storage.delete('conditions:pending'));
      emit('conditions_composed', context, {});
    } catch (error) {
      // Sources may already be committed. Retain the complete previous page and
      // durable intent; retry on another source event/manual rebuild, never a timer.
      emit('conditions_composition_failed', context, { error_code: asHttpError(error).code, stage: asHttpError(error).stage ?? stage, ...safeError(error) }, 'error');
    }
  }

  async pullWeatherV1(origin = this.conditionsOrigin()): Promise<void> {
    const context: OperationContext = { request_id: crypto.randomUUID(), operation: 'weather_pull', worker_version: this.env.CF_VERSION_METADATA?.id ?? 'local', environment: this.env.ENVIRONMENT ?? 'local' };
    const parse = (body: string | null) => { try { return body ? validateWeather(JSON.parse(body)) : null; } catch { return null; } };
    const read = async () => { const object = await boundary('storage', () => this.env.SITE_BUCKET.get(WEATHER_KEY)); return object ? boundary('storage', () => object.text()) : null; };
    let candidate: { body: string; weather: ReturnType<typeof validateWeather>; etag: string | null } | undefined;
    let response: Response | undefined;
    let stage = 'weather_storage_read';
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const prior = parse(await read());
      stage = 'weather_etag_read';
      const etag = prior ? await boundary('storage', () => this.ctx.storage.get<string>('weather:etag')) : undefined;
      stage = 'weather_fetch';
      response = await fetch(WEATHER_URL, { headers: etag ? { 'If-None-Match': etag } : {}, signal: controller.signal });
      if (response.status !== 304) {
        if (!response.ok) throw new HttpError(503, 'Upstream weather request failed', {}, { code: 'weather_upstream_failed', retryable: true });
        const length = response.headers.get('Content-Length');
        const headers = length ? { 'Content-Length': length } : undefined;
        stage = 'weather_body_read';
        const bytes = await readLimited(new Request(WEATHER_URL, { method: 'POST', body: response.body, headers }), 128 * 1024);
        stage = 'weather_validation';
        const weather = validateWeather(JSON.parse(new TextDecoder().decode(bytes)));
        if (Date.parse(weather.published_at) > Date.now() + 300_000) throw new Error('Weather publication is ahead of the clock');
        candidate = { body: JSON.stringify(weather), weather, etag: response.headers.get('etag') };
      }
    } catch (error) { emit('weather_pull_failed', context, { error_code: asHttpError(error).code, stage, ...(response ? { upstream_status: response.status } : {}), ...safeError(error) }, 'error'); }
    finally {
      try { if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {}); }
      finally { clearTimeout(timer); }
    }
    await this.serialize(async () => {
      try {
        if (candidate) {
          stage = 'weather_storage_read';
          const priorBody = await read(); const prior = parse(priorBody);
          if (prior && Date.parse(prior.published_at) > Date.parse(candidate.weather.published_at)) {
            emit('weather_pull', context, { changed: false, discarded_stale: true });
          } else {
            if (priorBody !== candidate.body) {
              stage = 'weather_storage_write';
              await boundary('storage', () => this.ctx.storage.put('conditions:pending', true));
              await boundary('storage', () => this.env.SITE_BUCKET.put(WEATHER_KEY, candidate!.body, { httpMetadata: { contentType: 'application/json' } }));
            }
            stage = 'weather_etag_write';
            if (candidate.etag) await boundary('storage', () => this.ctx.storage.put('weather:etag', candidate!.etag!));
            else await boundary('storage', () => this.ctx.storage.delete('weather:etag'));
            emit('weather_pull', context, { changed: priorBody !== candidate.body, published_at: candidate.weather.published_at });
          }
        }
      } catch (error) { emit('weather_pull_failed', context, { error_code: asHttpError(error).code, stage, ...safeError(error) }, 'error'); }
      await this.finishConditions(origin, context);
    }, context);
  }

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
      const trace = new OperationTrace(context);
      try {
        if (operation !== 'preview') await trace.run('repair_recovery', () => this.repairCoordinator().gate(context));
        const migration = await trace.run('migration_state', () => boundary('storage', () => this.ctx.storage.get<Migration>('migration')));
        let snapshot: CommittedSnapshot | undefined;
        // Internal publishing helpers may bootstrap a new bucket; only persisted
        // completion establishes that losing its manifest requires operator repair.
        if (migration?.complete) {
          try {
            await trace.run('committed_snapshot_loading', async () => {
              snapshot = await committedSnapshot(this.env.SITE_BUCKET);
              requireCommittedManifest(snapshot);
            });
          } catch (error) { throw new PublicationError('not_committed', 'committed_snapshot_loading', error); }
        }
        return { ok: true, result: await action(migration?.complete, context, snapshot) };
      } catch (error) {
        const classified = asHttpError(error);
        const stage = error instanceof PublicationError ? error.stage : classified.stage ?? trace.failed_stage ?? 'migration_state';
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

  async submitAlertV1(input: AlertInput, owner: string, context?: OperationContext, dryRun = false, history: HistoryMode = 'full'): Promise<AlertsReply> {
    context = this.executingContext(context);
    return this.serialize(async () => {
      try {
        const result = await submitAlert(this.env.SITE_BUCKET, input, owner, new Date(), context, dryRun,
          () => this.ctx.storage.put('conditions:pending', true), history);
        if (!dryRun) await this.finishConditions(undefined, context);
        return { ok: true, result };
      }
      catch (error) { return alertRpcFailure(error, context); }
    }, context);
  }

  async retractAlertEntryV1(alertId: string, entryId: string, owner: string, context?: OperationContext, dryRun = false, history: HistoryMode = 'full'): Promise<AlertsReply> {
    context = this.executingContext(context);
    return this.serialize(async () => {
      try {
        const result = await retractAlertEntry(this.env.SITE_BUCKET, alertId, entryId, owner, new Date(), context,
          () => this.ctx.storage.put('conditions:pending', true), dryRun, history);
        if (!dryRun) await this.finishConditions(undefined, context);
        return { ok: true, result };
      }
      catch (error) { return alertRpcFailure(error, context); }
    }, context);
  }

  async confirmAlertsV1(inputs: unknown[], context?: OperationContext, dryRun = false): Promise<AlertsReply> {
    context = this.executingContext(context);
    if (!dryRun && this.env.ALERT_CONFIRMATIONS_ENABLED !== 'true') return alertRpcFailure(new HttpError(503,
      'Batch confirmation writes are disabled in this environment; no publication was attempted. Dry-run batches and ordinary alert updates remain available.', {},
      { code: 'confirmations_not_enabled', retryable: false, publication_status: 'not_attempted' }), context);
    return this.serialize(async () => {
      try {
        const result = await confirmAlerts(this.env.SITE_BUCKET, inputs, new Date(), context, dryRun,
          () => this.ctx.storage.put('conditions:pending', true));
        if (!dryRun) await this.finishConditions(undefined, context);
        return { ok: true, result };
      } catch (error) { return alertRpcFailure(error, context); }
    }, context);
  }

  async readAlertsV1(query: string, context?: OperationContext, alertId?: string): Promise<AlertsReply> {
    context = this.executingContext(context);
    try {
      return { ok: true, result: await readAlerts(this.env.SITE_BUCKET, new URLSearchParams(query), await this.getCursorKey(), new Date(), alertId) };
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
    return new RepairCoordinator(this.env.SITE_BUCKET, this.ctx.storage, async (origin, trace, context, index, repairId) => {
      const head = await this.rebuildHead(trace, context, 'repair');
      const prior = head.job;
      const unscheduled = prior && prior.status !== 'failed' && !isPaused(prior)
        && await trace.run('repair_alarm_read', () => boundary('storage', () => this.ctx.storage.getAlarm())) === null && !this.alarmDeliveries;
      if (prior && (prior.status === 'failed' || isPaused(prior) || unscheduled)) {
        const previousHandoff = prior.generation_id ? await trace.run('repair_generation_read', async () => readHandoff(
          await boundary('storage', () => this.ctx.storage.get(generationKey(prior.id, prior.generation_id!))), prior, 'repair_generation_read')) : undefined;
        const provenance = await trace.run('repair_pause_read', async () => readPause(
          await boundary('storage', () => this.ctx.storage.get(pauseKey(prior.id))), prior, previousHandoff));
        const code = prior.status === 'failed' ? prior.error_code : unscheduled ? 'unscheduled' : prior.recovery?.code ?? provenance?.code;
        if (!(repairableCodes.includes(code ?? '') || code === 'unscheduled') || isPaused(prior) && pauseReason(prior) === 'rebuild_checkpoint_damaged') {
          throw new HttpError(409, 'An unrelated or damaged rebuild blocks regeneration. Inspect its recovery evidence before resuming.', {}, { code: 'rebuild_blocked', details: { job_id: prior.id } });
        }
        const checkpoint = await trace.run('repair_rebuild_evidence', async () => readCheckpoint(
          await boundary('storage', () => this.ctx.storage.get(checkpointKey(prior.id))), prior, 'repair_rebuild_evidence'));
        const committed = receiptMatches(index, prior) || prior.recovery?.publication_status === 'committed';
        const migration = await boundary('storage', () => this.ctx.storage.get<Migration>('migration'));
        if (committed && !checkpoint?.migration && !completeMigration(migration)) throw checkpointDamaged(
          'Committed migration bookkeeping is missing. Restore the finalization checkpoint before repairing this job.', 'repair_rebuild_evidence');
        const job = { ...restartRebuild(prior), generation_id: crypto.randomUUID() };
        // Repairing content never revokes an operator pause. The new generation
        // has not dispatched; the old summary is retained in the handoff below.
        if (isPaused(prior) || unscheduled) { job.manual_resume = true; job.scheduling = 'manual'; job.pause_reason = isPaused(prior) ? pauseReason(prior) : 'manual_resume'; }
        delete job.recovery;
        const handoff: GenerationHandoff = { version: 1, job_id: job.id, generation_id: job.generation_id, repair_id: repairId,
          prior_job: prior, prior_checkpoint: checkpoint ?? null,
          prior_archive_checkpoint: await boundary('storage', () => this.ctx.storage.get<string>(`rebuild:${prior.id}`)) ?? null,
          prior_committed: committed, repairable_code: code! };
        return { job, handoff };
      }
      const migration = await boundary('storage', () => this.ctx.storage.get<Migration>('migration')) ?? initialMigration();
      return { job: newRebuild(crypto.randomUUID(), origin, migration, context) };
    }, () => this.alarmDeliveries > 0);
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
        emit('repair_failed', context, { stage: failure.stage ?? trace.failed_stage ?? 'repair_validation', error_code: failure.code,
          publication_status, ...safeError(error) }, failure.status >= 500 ? 'error' : 'warn');
        return { ok: false, failure: { status: failure.status, code: failure.code, error: failure.message,
          retryable: failure.retryable, publication_status, stage: failure.stage ?? trace.failed_stage ?? 'repair_validation',
          details: failure.details, details_truncated: failure.details_truncated, ...(failure.retry_at ? { retry_at: failure.retry_at } : {}) } };
      }
    };
    // Inspection pins its own R2 HEAD and must not wait for rendering or writes.
    return input === undefined ? action() : this.serialize(action, context);
  }

  async publicationRepairControlV1(action: 'resume' | 'cancel', input: unknown, context?: OperationContext): Promise<RepairReply> {
    context = this.executingContext(context);
    return this.serialize(async () => {
      const trace = new OperationTrace(context);
      try { return { ok: true, result: await this.repairCoordinator().control(action, input, trace) }; }
      catch (error) { const failure = asHttpError(error); return { ok: false, failure: { status: failure.status, code: failure.code, error: failure.message, details: failure.details, retryable: failure.retryable, stage: trace.failed_stage ?? 'repair_recovery', publication_status: failure.publication_status ?? 'not_attempted' } }; }
    }, context);
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

  async readChangesV1(query: string, context?: OperationContext): Promise<ChangesReply> {
    context = this.executingContext(context);
    const trace = new OperationTrace(context);
    try {
      const key = await trace.run('cursor_key', () => this.getCursorKey());
      return { ok: true, result: await trace.run('changes_read', () => readChanges(this.env.SITE_BUCKET, new URLSearchParams(query), key,
        () => this.serialize(async () => {
          const migration = await boundary('storage', () => this.ctx.storage.get<Migration>('migration'));
          return captureChanges(this.env.SITE_BUCKET, new Date(), migration?.complete ?? false);
        }, context), new Date(), context)) };
    } catch (error) {
      const failure = asHttpError(error); const stage = trace.failed_stage ?? 'changes_read';
      emit('changes_read_failed', context, { stage, error_code: failure.code, ...safeError(error) }, 'error');
      return { ok: false, failure: { status: failure.status, code: failure.code, error: failure.message, retryable: failure.retryable, stage, publication_status: 'not_attempted' } };
    }
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
        const failure = asHttpError(error);
        emit('rebuild_request_failed', context, { stage: failure.stage ?? trace.failed_stage ?? 'rebuild_request', error_code: failure.code,
          publication_status: 'not_attempted', ...safeError(error) }, 'error');
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
    const job = newRebuild(id, origin, migration, context);
    const jobContext = job.context;
    await trace.run('rebuild_enqueue', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
      const ids = await storage.get<string[]>('jobs') ?? [];
      const head = await queueHead(ids, id => storage.get<RebuildJob>(`job:${id}`));
      await storage.put(`job:${job.id}`, job);
      await storage.put('jobs', [...ids, job.id]);
      if (head.job?.status !== 'failed' && !isPaused(head.job)) await storage.setAlarm(Date.now() + 1000);
    })));
    emit('rebuild_queued', jobContext, { job_id: job.id, generation_id: job.generation_id });
    return job;
  }

  async jobStatus(id: string, context?: OperationContext): Promise<RebuildJob | null> {
    context = this.executingContext(context);
    if (context) context = { ...context, job_id: id };
    const trace = new OperationTrace(context);
    try { return await trace.run('rebuild_status_read', async () => {
      const job = await boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${id}`));
      if (!job) return null;
      const ids = await boundary('storage', () => this.ctx.storage.get<string[]>('jobs')) ?? [];
      const head = await queueHead(ids, id => boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${id}`)));
      const result = { ...job }; delete result.blocked; delete result.blocked_by;
      if (job.status === 'completed' || job.status === 'failed') return result;
      const repair = await this.repairCoordinator().blocker();
      if (repair) result.blocked = repair;
      else if (head.job) {
        const reason = head.job.status === 'failed' ? 'failed_rebuild' : isPaused(head.job) ? pauseReason(head.job)
          : !this.alarmDeliveries && await boundary('storage', () => this.ctx.storage.getAlarm()) === null ? 'unscheduled' : undefined;
        if (reason) {
          result.blocked = { reason, job_id: head.job.id };
          if (head.job.id !== id) result.blocked_by = head.job.id;
        }
      }
      return result;
    }); } catch (error) {
      emit('rebuild_request_failed', context, { stage: trace.failed_stage ?? 'rebuild_status_read', error_code: asHttpError(error).code, ...safeError(error) }, 'error');
      throw error;
    }
  }

  async resumeRebuild(id: string, context?: OperationContext): Promise<RebuildJob | 'conflict' | null> {
    return this.rebuildRequest(context, { job_id: id }, async (trace, context) => {
      await trace.run('repair_recovery', () => this.repairCoordinator().gate(context));
      const saved = await trace.run('rebuild_resume_read', () => boundary('storage', () => this.ctx.storage.get<RebuildJob>(`job:${id}`)));
      if (!saved) return null;
      const job = restartRebuild(saved);
      const head = await this.rebuildHead(trace, context, 'rebuild_resume');
      if (head.job?.id !== id || !['failed', 'queued', 'running'].includes(saved.status)) return 'conflict';
      if (saved.status !== 'failed' && !isPaused(saved) && (this.alarmDeliveries || await trace.run('rebuild_resume_alarm_read', () => boundary('storage', () => this.ctx.storage.getAlarm())) !== null)) return 'conflict';
      if (context) job.context = context;
      // The repair timing encloses this write; failures retain the inner write stage.
      const write = () => trace.run('rebuild_resume_write', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
        if (head.skipped) await storage.put('jobs', head.ids);
        await storage.put(`job:${id}`, job);
        await storage.delete(pauseKey(id));
        await storage.setAlarm(Date.now() + 1000);
      })));
      if (head.skipped) await trace.run('rebuild_resume_queue_repair', write);
      else await write();
      return job;
    });
  }

  // Preserve typed blocker information across RPC without changing legacy callers
  // or converting unrelated management transport failures into application errors.
  async resumeRebuildV1(id: string, context?: OperationContext): Promise<RebuildResumeReply> {
    try { return { ok: true, result: await this.resumeRebuild(id, context) }; }
    catch (error) {
      const failure = asHttpError(error);
      if (failure.code !== 'repair_blocked') throw error;
      return { ok: false, failure: { status: failure.status, code: failure.code, error: failure.message, stage: failure.stage!,
        retryable: failure.retryable, publication_status: 'not_committed', details: failure.details,
        details_truncated: failure.details_truncated, ...(failure.retry_at ? { retry_at: failure.retry_at } : {}) } };
    }
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

  private async finalizeRebuild(job: RebuildJob, ids: string[], migration: Migration | undefined, conditionsAvailable: boolean | undefined, trace: OperationTrace) {
    const completed: RebuildJob = { ...job, status: 'completed', finished_at: new Date().toISOString() };
    delete completed.next_retry_at; delete completed.conflict_count;
    delete completed.recovery;
    await trace.run('rebuild_finalize', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
      if (migration) await storage.put('migration', migration);
      // A recovered receipt may predate a newer source's uncomposed intent.
      if (conditionsAvailable === true) await storage.delete('conditions:pending'); else await storage.put('conditions:pending', true);
      await storage.delete(`rebuild:${job.id}`);
      await storage.delete(checkpointKey(job.id));
      await storage.put(`job:${job.id}`, completed);
      await storage.put('jobs', ids.slice(1));
      const next = await queueHead(ids.slice(1), id => storage.get<RebuildJob>(`job:${id}`));
      if (next.job && next.job.status !== 'failed' && !isPaused(next.job)) await storage.setAlarm(Date.now() + 1000);
      else await storage.deleteAlarm();
    })));
    emit('rebuild_completed', trace.context, { generation_id: job.generation_id, processed: job.processed, publication_status: 'committed' });
  }

  private async recordRebuildRecovery(job: RebuildJob, error: unknown, trace: OperationTrace, damaged: boolean, publication_status: PublicationStatus) {
    const failure = asHttpError(error);
    const paused = damaged || !failure.retryable;
    const saved: RebuildJob = { ...job, recovery: { code: failure.code, stage: trace.failed_stage ?? failure.stage ?? 'rebuild_finalization', retryable: !paused,
      publication_status, failed_at: new Date().toISOString() },
      ...(paused ? { manual_resume: true, scheduling: 'manual' as const, pause_reason: damaged ? 'rebuild_checkpoint_damaged' as const : 'manual_resume' as const } : {}) };
    const { code, ...recovery } = saved.recovery!;
    emit(damaged ? 'rebuild_checkpoint_damaged' : paused ? 'rebuild_paused' : 'rebuild_finalization_pending', trace.context,
      { error_code: code, generation_id: job.generation_id, ...recovery, ...(paused ? { pause_reason: saved.pause_reason } : {}), ...safeError(error) }, 'error');
    try {
      await boundary('storage', () => this.ctx.storage.transaction(async storage => {
        await storage.put(`job:${job.id}`, saved);
        if (paused) await storage.deleteAlarm();
      }));
    } catch (recordError) {
      emit('rebuild_recovery_record_failed', trace.context, { original_error_code: failure.code, original_failed_stage: saved.recovery!.stage, publication_status: saved.recovery!.publication_status, ...safeError(recordError) }, 'error');
      throw recordError;
    }
    return paused;
  }

  async alarm(): Promise<void> {
    // Register delivery synchronously: the handler may wait behind a repair
    // after the platform has already consumed its scheduled alarm.
    this.alarmDeliveries++;
    try {
      const bootstrapContext: OperationContext = { request_id: crypto.randomUUID(), worker_version: this.env.CF_VERSION_METADATA?.id ?? 'local', environment: this.env.ENVIRONMENT ?? 'local', operation: 'rebuild' };
      return await this.serialize(async () => {
        const bootstrap = new OperationTrace(bootstrapContext);
        try { await this.repairCoordinator().recover(bootstrap, true); }
        catch (error) { if (['repair_pending', 'repair_stalled'].includes(asHttpError(error).code)) return; throw error; }
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
        if (!job || job.status === 'failed' || isPaused(job)) return;
        if (job.next_retry_at && Date.parse(job.next_retry_at) > Date.now()) {
          await boundary('storage', () => this.ctx.storage.setAlarm(Date.parse(job!.next_retry_at!)));
          return;
        }
        const context: OperationContext = { request_id: job.context?.request_id ?? job.id, ...job.context, worker_version: this.env.CF_VERSION_METADATA?.id ?? 'local', environment: this.env.ENVIRONMENT ?? 'local', operation: 'rebuild', job_id: job.id };
        const trace = new OperationTrace(context);
        let phase: 'inspecting' | 'preparing' | 'finalizing' = 'inspecting';
        // Until checkpoint inspection completes, a fresh trace cannot rule out
        // an earlier dispatch. Legacy checkpoints deliberately remain uncertain.
        let inherited: PublicationStatus = job.recovery?.publication_status === 'committed' ? 'committed' : 'unknown';
        // Receipt reads/finalization fail through platform redelivery, never the
        // pre-commit failure path. The marker survives later index replacements.
        try {
          const keys = [checkpointKey(job.id), ...(job.generation_id ? [generationKey(job.id, job.generation_id)] : [])];
          const evidence = await trace.run('rebuild_finalization_read', () => boundary('storage', () => this.ctx.storage.get(keys)));
          if (job.generation_id) await trace.run('rebuild_generation_read', () => readHandoff(evidence.get(generationKey(job!.id, job!.generation_id!)), job!));
          let finalization = await trace.run('rebuild_finalization_validation', () => readCheckpoint(evidence.get(checkpointKey(job!.id)), job!));
          if (inherited !== 'committed' && (!finalization || finalization.version === 2 && finalization.phase === 'prepared')) inherited = 'not_committed';
          // A prepared checkpoint proves non-dispatch. Absence still needs a
          // receipt lookup for supported missing-checkpoint recovery, but a failed
          // lookup cannot undo the absence evidence already read successfully.
          if (!finalization || inherited !== 'not_committed') {
            const index = await trace.run('rebuild_receipt_read', () => boundary('storage', () => this.env.SITE_BUCKET.head('pages/index.html')));
            if (receiptMatches(index, job)) {
              trace.publication_status = 'committed';
              if (!finalization) {
                const migration = await trace.run('rebuild_migration_receipt', () => boundary('storage', () => this.ctx.storage.get('migration')));
                if (!completeMigration(migration)) throw checkpointDamaged('Committed migration bookkeeping is missing. Restore the finalization checkpoint from a verified backup before resuming.');
              }
              phase = 'finalizing';
              await this.finalizeRebuild(job, ids, finalization?.migration, undefined, trace); return;
            }
            if (inherited === 'committed') throw checkpointDamaged('A committed rebuild has no matching receipt. Restore its finalization evidence from a verified backup before resuming.');
          }
          phase = 'preparing';
          if (inherited === 'not_committed') delete job.recovery;
          delete job.next_retry_at;
          job.status = 'running';
          job.started_at ??= new Date().toISOString();
          await trace.run('rebuild_start', () => boundary('storage', () => this.ctx.storage.put(`job:${job!.id}`, job!)));
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
          const rebuilt = await rebuildHomepage(this.env.SITE_BUCKET, job.origin, trace, migration.complete, baseline, { jobId: job.id, generationId: job.generation_id, checkpoint,
            beforeCommit: async () => {
              if (inherited === 'unknown' || inherited === 'committed') return;
              const next = checkpointFor(job!, 'prepared', bootstrap ? migration : undefined, finalization);
              await trace.run('rebuild_finalization_checkpoint', () => boundary('storage', () => this.ctx.storage.put(checkpointKey(job!.id), next)));
              finalization = next;
            }, beforeIndexDispatch: async () => {
              const next = checkpointFor(job!, 'dispatching', bootstrap ? migration : undefined, finalization);
              await trace.run('rebuild_dispatch_checkpoint', () => boundary('storage', () => this.ctx.storage.put(checkpointKey(job!.id), next)));
              finalization = next;
            } });
          if (rebuilt.progress) job.archive_progress = rebuilt.progress;
          switch (rebuilt.kind) {
            case 'pending':
            case 'reconcile':
              await trace.run('rebuild_archive_progress', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
                if (inherited !== 'unknown' && inherited !== 'committed') await storage.delete(checkpointKey(job.id));
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
          phase = 'finalizing';
          await this.finalizeRebuild(job, ids, bootstrap ? migration : undefined, rebuilt.conditionsAvailable, trace);
        } catch (error) {
          const damaged = asHttpError(error).code === 'rebuild_checkpoint_damaged';
          const certainty = trace.publication_status === 'committed' || inherited === 'committed' ? 'committed'
            : trace.publication_status === 'unknown' || inherited === 'unknown' ? 'unknown' : trace.publication_status;
          if (damaged || phase === 'inspecting' || phase === 'finalizing' || certainty === 'committed' || certainty === 'unknown') {
            if (await this.recordRebuildRecovery(job, error, trace, damaged, certainty)) return;
            throw error;
          }
          const failedStage = trace.failed_stage ?? trace.stage ?? 'rebuild_processing';
          const failure = asHttpError(error);
          emit('rebuild_failed', context, { stage: failedStage, error_code: failure.code, publication_status: trace.publication_status, ...safeError(error) }, 'error');
          job.status = 'failed';
          job.finished_at = new Date().toISOString();
          job.error = 'Rebuild failed; inspect Worker logs, repair the cause, then resume this job';
          job.error_code = failure.code;
          job.failed_stage = failedStage;
          delete job.recovery;
          try {
            await trace.run('rebuild_failure_record', () => boundary('storage', () => this.ctx.storage.transaction(async storage => {
              await storage.delete(checkpointKey(job.id));
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
    } finally { this.alarmDeliveries--; }
  }
}
