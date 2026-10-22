import { boundary, DamagedManifest, DamagedSource, HttpError, isPublishReply } from './errors';
import { loadPublication, validArchiveKey, validRssKey } from './committed';
import { loadCatalog } from './archives';
import { loadHistoryIndex } from './history-index';
import { loadPost, rebuildReference } from './publishing';
import { settledInOrder } from './batches';
import { record } from './primitives';
import type { ContentBucket, PublishFailure, RebuildJob } from './types';

export interface RepairPointers { manifest: string; rss: string; archives: string | null }
export interface RepairInput extends RepairPointers { expected_version: string }
export interface PublicationHead { version: string; manifest: string | null; rss: string | null; archives: string | null }
export interface RecoverySummary { state: 'pending' | 'stalled' | 'damaged'; recovery_token: string; publication_status: import('./types').PublicationStatus; attempts: number; repair_id?: string; job_id?: string; next_retry_at?: string; last_error?: { code: string; stage: string; retryable: boolean } }
export interface RepairResult { recovery?: RecoverySummary | null; publication: PublicationHead; unchanged: boolean; repair_id?: string; job?: RebuildJob }
export type RepairReply = { ok: true; result: RepairResult } | { ok: false; failure: PublishFailure };

export function publicationHead(index: R2Object): PublicationHead {
  return { version: index.version, manifest: index.customMetadata?.manifest ?? null,
    rss: index.customMetadata?.rss ?? null, archives: index.customMetadata?.archives ?? null };
}

export const indexNotFound = () => new HttpError(404, 'No stored index exists to repair.', {}, { code: 'index_not_found' });

export function validateRepair(input: unknown): RepairInput {
  if (!record(input) || Object.keys(input).some(key => !['expected_version', 'manifest', 'rss', 'archives'].includes(key))
    || typeof input.expected_version !== 'string' || !input.expected_version || input.expected_version.length > 256
    || typeof input.manifest !== 'string' || !/^publications\/[a-f0-9-]{36}\.json$/.test(input.manifest)
    || !validRssKey(input.rss)
    || input.archives !== null && !validArchiveKey(input.archives)) {
    throw new HttpError(400, 'Supply expected_version and existing manifest, rss, and archives pointers. archives must be a catalogue key or null.');
  }
  return input as unknown as RepairInput;
}

export async function validateRepairTargets(bucket: ContentBucket, input: RepairInput, migrationComplete = true): Promise<void> {
  try {
    const publication = await loadPublication(bucket, input.manifest);
    if ((publication.archives ?? null) !== input.archives) throw new HttpError(400, 'The archive pointer must match the selected manifest.');
    for await (const { result } of settledInOrder(publication.posts, async ref => { const canonical = rebuildReference(ref); if (!migrationComplete && canonical.key !== ref.key && !await boundary('storage', () => bucket.head(canonical.key))) return loadPost(bucket, ref); return loadPost(bucket, canonical); })) {
      if (result.status === 'rejected') throw result.reason;
    }
    await loadHistoryIndex(bucket, publication);
    await loadCatalog(bucket, input.archives ?? undefined);
    if (!await boundary('storage', () => bucket.head(input.rss))) throw new HttpError(400, 'The selected RSS object does not exist.', {}, { code: 'invalid_repair_target', details: { key: input.rss, reason: 'missing' } });
  } catch (error) {
    if (error instanceof DamagedManifest || error instanceof DamagedSource || error instanceof HttpError && error.code === 'archive_damaged') {
      throw new HttpError(400, 'The selected repair content is missing or invalid.', {}, { code: 'invalid_repair_target', details: {
        key: error instanceof DamagedManifest ? error.manifest_key : error instanceof DamagedSource ? error.source_key : input.archives,
        reason: error instanceof DamagedManifest || error instanceof DamagedSource ? error.reason : 'invalid_catalogue',
      } });
    }
    throw error;
  }
}

export function isRepairReply(value: unknown): value is RepairReply {
  if (!record(value)) return false;
  if (value.ok === false) return isPublishReply(value);
  const result = value.result;
  if (value.ok !== true || !record(result) || typeof result.unchanged !== 'boolean' || !record(result.publication)) return false;
  const head = result.publication;
  return (result.repair_id === undefined || typeof result.repair_id === 'string' && /^[a-f0-9-]{36}$/.test(result.repair_id))
    && typeof head.version === 'string' && !!head.version && ['manifest', 'rss', 'archives'].every(key => head[key] === null || typeof head[key] === 'string')
    && (result.job === undefined || record(result.job) && typeof result.job.id === 'string' && /^[a-f0-9-]{36}$/.test(result.job.id)
      && ['queued', 'running', 'completed', 'failed'].includes(String(result.job.status)));
}
