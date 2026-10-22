import type { ValidationIssue } from './errors';
import type { DigestPublisher } from './publisher';

export interface DigestItem {
  group: string;
  group_url: string;
  headline: string;
  body: string;
  post_url: string;
  category: string;
  posted_at: string;
}

export interface Digest {
  title: string;
  source: string;
  items: DigestItem[];
  client_ref?: string;
}

export interface StoryUpdate {
  post_url: string;
  group: string;
  group_url?: string;
  body: string;
  posted_at: string;
}

export interface StoredItem extends DigestItem {
  updates?: (StoryUpdate & { received_at: string })[];
}

export interface StoredPost extends Digest {
  items: StoredItem[];
  id: string;
  date: string;
  received_at: string;
  publisher_fingerprint?: string;
  retracted_at?: string;
}

export interface StoryIdentity {
  post_id: string;
  item_index: number;
  update_index?: number;
}

export interface Suggestion {
  action: string;
  message: string;
  method?: string;
  path?: string;
}

export interface PublicationWarning {
  index?: number;
  field: string;
  code: 'unknown_category' | 'posted_at_in_future' | 'posted_at_stale' | 'possible_duplicate_alert';
  message: string;
  value: string;
  server_time?: string;
  matches?: { alert_id: string; reason: 'source_event_id' | 'location' }[];
  matches_truncated?: boolean;
}

export interface AppendResult extends StoryIdentity {
  status: 'appended' | 'duplicate';
  message: string;
  suggestion?: Suggestion;
  warnings?: PublicationWarning[];
  dry_run?: true;
  committed?: false;
  checked_at?: string;
}

export interface PublishOptions { dryRun?: boolean; publisherFingerprint?: string }
export interface RetractResult { post_id: string; status: 'retracted' | 'already_retracted'; retracted_at: string }
export type RetractReply = { ok: true; result: RetractResult } | { ok: false; failure: PublishFailure };
export interface BatchRecord {
  id: string;
  date: string;
  received_at: string;
  client_ref?: string;
  publisher_fingerprint?: string;
  retracted_at?: string;
}
export interface IndexItem {
  item_index: number;
  post_url: string;
  posted_at: string;
  last_received_at: string;
  latest_activity_at: string;
  updates: { update_index: number; post_url: string; posted_at: string; received_at: string }[];
}
export interface IndexPost {
  post_id: string;
  date: string;
  received_at: string;
  client_ref?: string;
  items: IndexItem[];
}
export interface HistoryIndex { version: 1; posts: IndexPost[]; batches: BatchRecord[] }
export interface BatchResult { client_ref: string; post: Pick<StoredPost, 'id' | 'date' | 'received_at'>; status: 'published' | 'retracted'; retracted_at?: string }
export type BatchReply = { ok: true; result: BatchResult } | { ok: false; failure: PublishFailure };

export type AppendReply = { ok: true; result: AppendResult } | { ok: false; failure: PublishFailure };

export type PublicationStatus = 'not_attempted' | 'not_committed' | 'committed' | 'unknown';

export interface OperationContext {
  request_id: string;
  worker_version: string;
  environment: string;
  operation: string;
  cf_ray?: string;
  job_id?: string;
  candidate_job_id?: string;
}

export interface PublishResult {
  post: Pick<StoredPost, 'id' | 'date' | 'received_at'> | null;
  duplicate: boolean;
  counts: { submitted: number; published: number; duplicates: number };
  items: (StoryIdentity & { index: number; status: 'published' | 'duplicate'; message?: string; suggestion?: Suggestion })[];
  client_ref?: string;
  warnings?: PublicationWarning[];
  dry_run?: true;
  committed?: false;
  checked_at?: string;
}

export interface PublishFailure {
  details?: ValidationIssue[] | Record<string, unknown>;
  details_truncated?: boolean;
  retry_at?: string;
  status: number;
  code: string;
  error: string;
  stage: string;
  publication_status: PublicationStatus;
  retryable: boolean;
}

export type PublishReply = { ok: true; result: PublishResult } | { ok: false; failure: PublishFailure };

export interface PostReference {
  id: string;
  key: string;
  date: string;
  received_at: string;
  last_received_at?: string;
}

export interface Publication {
  version: 1 | 2 | 3;
  posts: PostReference[];
  omitted_posts?: PostReference[];
  snapshot_date: string | null;
  published_at: string | null;
  archives?: string;
  legacy_receipts?: Record<string, string>;
  history_index?: string;
  sync_index?: string;
}

export interface Migration {
  cursor?: string;
  processed: number;
  complete: boolean;
}

export interface ArchiveProgress { completed_days: number; total_days: number }

export interface RebuildBlocker {
  reason: 'manual_resume' | 'unscheduled' | 'failed_rebuild' | 'repair_pending' | 'repair_stalled' | 'repair_damaged';
  job_id?: string;
  repair_id?: string;
  retry_at?: string;
}

export interface RebuildJob {
  manual_resume?: boolean;
  scheduling?: 'automatic' | 'manual';
  id: string;
  origin: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  phase: 'migration' | 'render';
  processed: number;
  archive_progress?: ArchiveProgress;
  conflict_count?: number;
  next_retry_at?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  blocked_by?: string;
  blocked?: RebuildBlocker;
  context?: OperationContext;
  error_code?: string;
  failed_stage?: string;
}

export interface Env {
  IMAGES?: ImagesBinding;
  API_SECRET?: string;
  SITE_ORIGIN: string;
  SITE_BUCKET: R2Bucket;
  PUBLISHER: DurableObjectNamespace<DigestPublisher>;
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
  ENVIRONMENT?: string;
  ALERT_CONFIRMATIONS_ENABLED?: string;
}

// A narrow storage interface also allows failure injection in publishing tests.
export interface ContentBucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  put(key: string, value: string | ArrayBuffer | ArrayBufferView, options?: R2PutOptions): Promise<R2Object | null>;
  list(options?: R2ListOptions): Promise<R2Objects>;
}
