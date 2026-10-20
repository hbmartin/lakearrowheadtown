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

export interface AppendResult extends StoryIdentity {
  status: 'appended' | 'duplicate';
  message: string;
  suggestion?: Suggestion;
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
  dry_run?: true;
  committed?: false;
  checked_at?: string;
}

export interface PublishFailure {
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
}

export interface Migration {
  cursor?: string;
  processed: number;
  complete: boolean;
}

export interface RebuildJob {
  id: string;
  origin: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  phase: 'migration' | 'render';
  processed: number;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  blocked_by?: string;
  context?: OperationContext;
  error_code?: string;
  failed_stage?: string;
}

export interface Env {
  API_SECRET?: string;
  SITE_ORIGIN: string;
  SITE_BUCKET: R2Bucket;
  PUBLISHER: DurableObjectNamespace<DigestPublisher>;
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
  ENVIRONMENT?: string;
}

// A narrow storage interface also allows failure injection in publishing tests.
export interface ContentBucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  put(key: string, value: string | ArrayBuffer | ArrayBufferView, options?: R2PutOptions): Promise<R2Object | null>;
  list(options?: R2ListOptions): Promise<R2Objects>;
}
