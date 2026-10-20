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
}

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
  version: 1 | 2;
  posts: PostReference[];
  omitted_posts?: PostReference[];
  snapshot_date: string | null;
  published_at: string | null;
  archives?: string;
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
