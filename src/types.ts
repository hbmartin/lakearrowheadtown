import type { DigestPublisher } from './worker';

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
  date: string;
  title: string;
  source: string;
  items: DigestItem[];
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
  put(key: string, value: string, options?: R2PutOptions): Promise<R2Object | null>;
}
