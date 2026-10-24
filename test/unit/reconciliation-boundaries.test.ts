import { createHmac } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { captureChanges, readChanges, isChangesReply } from '../../src/changes';
import { publishDigest, currentPublication } from '../../src/publishing';
import { canonicalJson, fingerprint } from '../../src/primitives';
import { at, bucketWith, digest, origin, secret } from '../helpers/fixtures';
import type { Env } from '../../src/types';
const bucket = (env as unknown as Env).SITE_BUCKET;
const checkpoint = { as_of: at.toISOString(), posts: null, events: null, alerts: null };
function sign(value: unknown, raw = false) { const payload = Buffer.from(raw ? value as string : JSON.stringify(value)).toString('base64url'); return `${payload}.${createHmac('sha256', secret).update(`changes-v1:${payload}`).digest('base64url')}`; }
const read = (query: URLSearchParams) => readChanges(bucket, query, secret, async () => checkpoint, at);
beforeEach(async () => { vi.restoreAllMocks(); await reset(); for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {}); });
it.each([null, {}, { type: 'other', to: checkpoint }, { type: 'page', to: checkpoint, from: 1, offset: 0 }, { type: 'page', to: checkpoint, from: null, offset: -1 }, { type: 'sync', to: { ...checkpoint, posts: 'private/wrong' } }])('rejects signed but invalid cursor structure %j', async value => {
  await expect(read(new URLSearchParams({ since: sign(value) }))).rejects.toMatchObject({ code: 'invalid_cursor' });
});
it('rejects malformed signed JSON, token-mode mismatches, and offsets beyond the inventory', async () => {
  await expect(read(new URLSearchParams({ since: sign('{', true) }))).rejects.toMatchObject({ code: 'invalid_cursor' });
  await expect(read(new URLSearchParams({ since: sign({ type: 'page', to: checkpoint, from: null, offset: 0 }) }))).rejects.toMatchObject({ code: 'invalid_cursor' });
  await expect(read(new URLSearchParams({ cursor: sign({ type: 'page', to: checkpoint, from: null, offset: 1 }) }))).rejects.toMatchObject({ code: 'invalid_cursor' });
});
it('distinguishes legacy bootstrap requirements from transport failures', async () => {
  await bucket.put('digests/2026-10-24.json', '{}');
  await expect(captureChanges(bucket, at)).rejects.toMatchObject({ code: 'legacy_recovery_required' });
  await expect(captureChanges(bucketWith(bucket, { head: async () => { throw Error('transport'); } }), at)).rejects.toMatchObject({ kind: 'storage' });
  await bucket.delete('digests/2026-10-24.json');
  await bucket.put('pages/index.html', 'test', { customMetadata: { manifest: 'wrong' } });
  await expect(captureChanges(bucket, at)).rejects.toMatchObject({ code: 'manifest_damaged' });
});
it.each(['missing_item', 'revision'])('rejects an internally valid sync index with %s source mismatch', async damage => {
  await publishDigest(bucket, digest(), origin, at, true);
  const publication = await currentPublication(bucket);
  const index: any = await (await bucket.get(publication.sync_index!))!.json();
  if (damage === 'missing_item') index.rows[0].identity.item_index = 100; else index.rows[0].revision = 'a'.repeat(64);
  const body = canonicalJson(index); const key = `sync-index/story/${fingerprint(body)}.json`; await bucket.put(key, body);
  const manifest = `publications/${crypto.randomUUID()}.json`; await bucket.put(manifest, JSON.stringify({ ...publication, sync_index: key }));
  await expect(readChanges(bucket, new URLSearchParams(), secret, async () => ({ ...checkpoint, posts: manifest }), at)).rejects.toMatchObject({ code: 'source_damaged' });
});
it('does not accept malformed RPC envelopes', () => {
  for (const value of [null, {}, { ok: false }, { ok: true, result: {} }]) expect(isChangesReply(value)).toBe(false);
});
