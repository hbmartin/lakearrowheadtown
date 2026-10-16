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

export interface StoredPost extends Digest {
  id: string;
  date: string;
  received_at: string;
}

export interface PostReference {
  id: string;
  key: string;
  date: string;
  received_at: string;
}

export interface Publication {
  version: 1;
  posts: PostReference[];
  omitted_posts?: PostReference[];
  snapshot_date: string | null;
  published_at: string | null;
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
}

export interface Env {
  API_SECRET?: string;
  SITE_ORIGIN: string;
  SITE_BUCKET: R2Bucket;
  PUBLISHER: DurableObjectNamespace<DigestPublisher>;
}

// A narrow storage interface also allows failure injection in publishing tests.
export interface ContentBucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  put(key: string, value: string, options?: R2PutOptions): Promise<R2Object | null>;
  list(options?: R2ListOptions): Promise<R2Objects>;
}
