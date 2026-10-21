import { boundary, DamagedManifest, HttpError } from './errors';
import { isDate, isTimestamp } from './validation';
import { record, text } from './primitives';
import type { ContentBucket, Publication } from './types';

export const archiveUnavailable = () => new HttpError(503, 'News archives are damaged. An operator must repair them before retrying.', {}, { code: 'archive_damaged', retryable: false });
export const legacyRecoveryRequired = () => new HttpError(503, 'Migration is complete but no committed manifest exists. An operator must restore or explicitly reconstruct the bootstrap manifest before retrying.', {}, { code: 'legacy_recovery_required', retryable: false });
export const validArchiveKey = (key: unknown): key is string => typeof key === 'string' && /^archive-catalogs\/[a-f0-9]{64}\.json$/.test(key);
export const isLegacyId = (id: string) => /^legacy-\d{4}-\d{2}-\d{2}$/.test(id) && isDate(id.slice(7));

function isPublication(value: unknown): value is Publication {
  const date = (value: unknown) => typeof value === 'string' && isDate(value);
  const refs = (value: unknown) => Array.isArray(value) && value.every(ref => record(ref)
    && text(ref.id) && text(ref.key) && date(ref.date) && isTimestamp(ref.received_at)
    && (ref.last_received_at === undefined || isTimestamp(ref.last_received_at)));
  return record(value) && (value.version === 1 || value.version === 2 || value.version === 3) && refs(value.posts)
    && (value.version === 3 ? typeof value.history_index === 'string' && /^history-index\/[a-f0-9]{64}\.json$/.test(value.history_index) : value.history_index === undefined)
    && (value.omitted_posts === undefined || refs(value.omitted_posts))
    && (value.archives === undefined || validArchiveKey(value.archives))
    && (value.legacy_receipts === undefined || (record(value.legacy_receipts)
      && Object.entries(value.legacy_receipts).every(([id, time]) => isLegacyId(id) && isTimestamp(time))))
    && (value.snapshot_date === null || date(value.snapshot_date))
    && (value.published_at === null || isTimestamp(value.published_at));
}

async function readManifest(bucket: ContentBucket, key: string): Promise<unknown> {
  const object = await boundary('storage', () => bucket.get(key));
  if (!object) throw new DamagedManifest(key, 'missing');
  const text = await boundary('storage', () => object.text());
  try { return JSON.parse(text); }
  catch (error) {
    if (error instanceof SyntaxError) throw new DamagedManifest(key, 'invalid_json');
    throw error;
  }
}

export async function loadPublication(bucket: ContentBucket, key: string): Promise<Publication> {
  const value = await readManifest(bucket, key);
  if (!isPublication(value)) throw new DamagedManifest(key, 'invalid_manifest');
  return value;
}

// Pin every lookup to one index replacement. Lazy reads keep direct archive
// requests independent of the manifest while sharing it when metadata needs it.
export async function committedSnapshot(bucket: ContentBucket) {
  const index = await boundary('storage', () => bucket.head('pages/index.html'));
  const key = index?.customMetadata?.manifest;
  const direct = index?.customMetadata?.archives;
  let pending: Promise<unknown> | undefined;
  const read = () => pending ??= readManifest(bucket, key!);
  const archives = async (): Promise<string | undefined> => {
    if (direct !== undefined && !validArchiveKey(direct)) throw archiveUnavailable();
    if (direct !== undefined || !key) return direct;
    try {
      const value = await read();
      // Archive discovery must not discard URLs merely because lastmod is bad.
      if (!record(value) || !isPublication({ ...value, published_at: null })) throw archiveUnavailable();
      return value.archives as string | undefined;
    } catch (error) {
      if (error instanceof DamagedManifest) throw archiveUnavailable();
      throw error;
    }
  };
  return {
    index,
    archives,
    async publication(options: { archives?: boolean } = {}): Promise<Publication | undefined> {
      if (options.archives !== false && direct !== undefined && !validArchiveKey(direct)) throw archiveUnavailable();
      if (!key) return;
      const value = await read();
      if (!isPublication(value)) throw new DamagedManifest(key, 'invalid_manifest');
      return direct === undefined || options.archives === false ? value : { ...value, archives: direct };
    },
    async metadata(): Promise<{ publishedAt?: string; archives?: string }> {
      const pointer = await archives();
      let time: unknown;
      if (key) {
        try { const value = await read(); time = record(value) ? value.published_at : undefined; }
        catch (error) { if (!(error instanceof DamagedManifest)) throw error; }
      }
      const date = typeof time === 'string' ? new Date(time) : undefined;
      const publishedAt = typeof time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time)
        && date && Number.isFinite(date.getTime()) && date.toISOString() === time ? time : undefined;
      return { archives: pointer, publishedAt };
    },
  };
}
