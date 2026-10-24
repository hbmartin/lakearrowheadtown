import type { ContentBucket, Digest, DigestItem } from '../../src/types';
export const origin = 'https://lakearrowhead.town';
export const secret = 'test-secret-at-least-thirty-two-characters-long';
export const at = new Date('2026-10-24T18:00:00Z');
export function item(patch: Partial<DigestItem> = {}): DigestItem {
  return { group: 'Test community', group_url: 'https://example.com/group', headline: 'Test story', body: 'Verified fixture', category: 'announcement', post_url: `https://example.com/${crypto.randomUUID()}`, posted_at: at.toISOString(), ...patch };
}
export function digest(patch: Partial<Digest> = {}): Digest {
  return { title: 'Test digest', source: 'test', client_ref: crypto.randomUUID(), items: [item()], ...patch };
}
export function bucketWith(bucket: R2Bucket, overrides: Partial<ContentBucket> = {}): ContentBucket {
  return { get: key => bucket.get(key), head: key => bucket.head(key), put: (key, body, options) => bucket.put(key, body, options), list: options => bucket.list(options), ...overrides };
}
