import { env } from 'cloudflare:workers';
import { reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import * as publishing from '../src/publishing';
import { fingerprint } from '../src/primitives';
import { batchRecord, indexPost } from '../src/history-index';
import { localDate } from '../src/feed';
import { HttpError } from '../src/errors';
import type { Digest, Env, OperationContext, Publication, StoredPost } from '../src/types';

const bindings = env as unknown as Env;
const origin = 'https://lakearrowhead.town';
const secret = 'test-secret-at-least-thirty-two-characters-long';
const owner = fingerprint(secret);
const publisher = () => bindings.PUBLISHER.getByName('site');
const inPublisher = runInDurableObject as unknown as <T>(stub: unknown, callback: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
const digest = (name: string): Digest => ({ title: name, source: 'Community', items: [{ group: 'Group', group_url: origin,
  headline: name, body: 'Story body', category: '', post_url: `${origin}/source/${name}`, posted_at: new Date().toISOString() }] });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const operations = ['publish', 'append', 'retract', 'preview_digest', 'preview_append'] as const;
type Operation = typeof operations[number];
let events: any[];

async function seed(count = 8) {
  const now = Date.now();
  const posts: StoredPost[] = Array.from({ length: count }, (_, i) => {
    const received_at = new Date(now - i * 1000).toISOString();
    return { ...digest(`Source-${i}`), id: `source-${i}`, date: localDate(new Date(received_at)), received_at, publisher_fingerprint: owner };
  });
  const refs = posts.map(post => ({ id: post.id, key: `posts/${post.date}/${post.id}.json`, date: post.date, received_at: post.received_at }));
  const historyBody = JSON.stringify({ version: 1, posts: posts.map(indexPost), batches: posts.map(batchRecord) });
  const history_index = `history-index/${fingerprint(historyBody)}.json`;
  const publication: Publication = { version: 3, posts: refs, snapshot_date: posts[0].date, published_at: posts[0].received_at, history_index };
  for (let i = 0; i < posts.length; i++) await bindings.SITE_BUCKET.put(refs[i].key, JSON.stringify(posts[i]));
  await bindings.SITE_BUCKET.put(history_index, historyBody);
  await bindings.SITE_BUCKET.put('publications/fixture.json', JSON.stringify(publication));
  await bindings.SITE_BUCKET.put('pages/index.html', 'Original homepage', { customMetadata: { manifest: 'publications/fixture.json' } });
  await inPublisher(publisher(), async (_instance, state) => state.storage.put('migration', { complete: true, processed: count }));
  return publication;
}

function invoke(instance: any, operation: Operation, context: OperationContext, input = digest('Next')) {
  const update = { group: 'Group', body: 'Update', post_url: `${origin}/update`, posted_at: input.items[0].posted_at };
  switch (operation) {
    case 'publish': return instance.publishV2(input, origin, context);
    case 'append': return instance.appendUpdateV1('source-0', 0, update, origin, context);
    case 'retract': return instance.retractPostV1('source-0', owner, origin, context);
    case 'preview_digest': return instance.previewDigestV1(input, origin, context);
    case 'preview_append': return instance.previewAppendV1('source-0', 0, update, origin, context);
  }
}
const contextFor = (operation: string): OperationContext => ({ request_id: `followup-${operation}`, worker_version: 'test', environment: 'preview', operation });
beforeEach(async () => {
  vi.restoreAllMocks(); await reset(); events = [];
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(value => events.push(value));
});

it.each(operations)('loads retained sources in settled ordered batches through the %s RPC', async operation => {
  const publication = await seed();
  const before = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
  await inPublisher(publisher(), async instance => {
    const original = instance.env;
    const gates = new Map<string, ReturnType<typeof deferred>>(); const reads: string[] = []; const writes: string[] = [];
    let active = 0; let peak = 0; let released = false;
    instance.env = { ...original, SITE_BUCKET: {
      get: async (key: string) => {
        if (!key.startsWith('posts/')) return original.SITE_BUCKET.get(key);
        const gate = deferred(); gates.set(key, gate); reads.push(key); active++; peak = Math.max(peak, active);
        try { if (!released) await gate.promise; return await original.SITE_BUCKET.get(key); }
        finally { active--; }
      },
      head: (key: string) => original.SITE_BUCKET.head(key), list: (options: R2ListOptions) => original.SITE_BUCKET.list(options),
      put: (key: string, body: any, options: R2PutOptions) => { writes.push(key); return original.SITE_BUCKET.put(key, body, options); },
    } };
    const input = digest('Next'); input.items[0].category = ' Traffic ';
    input.items[0].posted_at = new Date(Date.now() + 86400000).toISOString();
    const pending = invoke(instance, operation, contextFor(operation), input);
    let reply: any;
    try {
      await vi.waitFor(() => expect(reads).toHaveLength(4));
      expect(active).toBe(4);
      for (const ref of publication.posts.slice(1, 4).reverse()) gates.get(ref.key)!.resolve();
      await vi.waitFor(() => expect(active).toBe(1));
      expect(reads).toHaveLength(4);
      gates.get(publication.posts[0].key)!.resolve();
      await vi.waitFor(() => expect(reads).toHaveLength(8));
      expect(active).toBe(4);
    } finally {
      released = true; for (const gate of gates.values()) gate.resolve();
      try { reply = await pending; } finally { instance.env = original; }
    }
    expect(reply.ok).toBe(true); expect(peak).toBe(4); expect(active).toBe(0);
    expect(reads).toEqual(publication.posts.map(ref => ref.key));
    const stages = events.filter(event => event.event === 'operation_stage' && event.request_id === `followup-${operation}`);
    for (const stage of ['committed_snapshot_loading', 'publication_loading', 'source_loading']) expect(stages.filter(event => event.stage === stage)).toHaveLength(1);
    expect(stages.some(event => event.stage === 'legacy_discovery')).toBe(false);
    if (operation !== 'retract') {
      expect(reply.result.warnings.map((warning: any) => warning.code)).toEqual(operation.includes('append') ? ['posted_at_in_future'] : ['unknown_category', 'posted_at_in_future']);
    }
    if (operation.startsWith('preview')) {
      expect(writes).toEqual([]);
      expect(reply.result).toMatchObject({ dry_run: true, committed: false });
      expect((await original.SITE_BUCKET.head('pages/index.html')).customMetadata).toEqual(before.customMetadata);
    }
  });
});

it.each(operations)('settles failures in source order and starts no later batch in the %s RPC', async operation => {
  const publication = await seed();
  await inPublisher(publisher(), async instance => {
    const original = instance.env; const gates = new Map<string, ReturnType<typeof deferred>>(); const reads: string[] = [];
    const put = vi.fn(original.SITE_BUCKET.put.bind(original.SITE_BUCKET)); let active = 0; let settled = false;
    instance.env = { ...original, SITE_BUCKET: {
      get: async (key: string) => {
        if (!key.startsWith('posts/')) return original.SITE_BUCKET.get(key);
        const gate = deferred(); gates.set(key, gate); reads.push(key); active++;
        try {
          await gate.promise;
          if (key === publication.posts[0].key || key === publication.posts[1].key) throw new HttpError(503, 'Private failure', {}, { code: key === publication.posts[0].key ? 'first_failure' : 'second_failure', retryable: true });
          return await original.SITE_BUCKET.get(key);
        } finally { active--; }
      },
      head: (key: string) => original.SITE_BUCKET.head(key), list: (options: R2ListOptions) => original.SITE_BUCKET.list(options), put,
    } };
    const pending = invoke(instance, operation, contextFor(operation)).finally(() => { settled = true; });
    let reply: any;
    try {
      await vi.waitFor(() => expect(reads).toHaveLength(4));
      gates.get(publication.posts[1].key)!.resolve();
      await vi.waitFor(() => expect(active).toBe(3));
      expect(settled).toBe(false);
    } finally {
      for (const gate of gates.values()) gate.resolve();
      try { reply = await pending; } finally { instance.env = original; }
    }
    expect(reply).toMatchObject({ ok: false, failure: { code: 'first_failure', stage: 'source_loading', retryable: true,
      publication_status: operation.startsWith('preview') ? 'not_attempted' : 'not_committed' } });
    expect(active).toBe(0); expect(reads).toEqual(publication.posts.slice(0, 4).map(ref => ref.key)); expect(put).not.toHaveBeenCalled();
  });
});

it.each(['publish', 'preview_digest'] as const)('preserves ordered damaged-source omissions and duplicate identities in %s', async operation => {
  const publication = await seed();
  await bindings.SITE_BUCKET.delete(publication.posts[1].key);
  await bindings.SITE_BUCKET.put(publication.posts[2].key, 'Invalid JSON');
  const input = digest('Next'); input.items[0].category = 'trafic';
  const duplicate = digest('Source-3').items[0]; input.items.unshift(duplicate);
  const reply = await invoke(publisher(), operation, contextFor(operation), input);
  expect(reply).toMatchObject({ ok: true, result: { counts: { submitted: 2, published: 1, duplicates: 1 },
    items: [{ index: 0, status: 'duplicate', post_id: 'source-3', item_index: 0 }, { index: 1, status: 'published', item_index: 0 }],
    warnings: [{ index: 1, code: 'unknown_category', value: 'trafic' }] } });
  expect(events.filter(event => event.event === 'source_omitted').map(event => event.post_id)).toEqual(['source-1', 'source-2']);
  const current = await publishing.currentPublication(bindings.SITE_BUCKET);
  if (operation === 'publish') {
    expect(current.omitted_posts?.map(ref => ref.id)).toEqual(['source-1', 'source-2']);
    const source = await publishing.loadPost(bindings.SITE_BUCKET, current.posts[0]);
    expect(source.items[0].category).toBe('trafic');
  } else expect(current).toEqual(publication);
});

it.each([...operations, 'batch_lookup', 'rebuild'] as const)('attributes damaged manifests to publication_loading during %s', async operation => {
  await seed(1); await bindings.SITE_BUCKET.put('publications/fixture.json', 'Private broken JSON');
  const context = contextFor(operation);
  if (operation === 'rebuild') {
    const job = await publisher().enqueueRebuild(origin, context); await runDurableObjectAlarm(publisher());
    expect(await publisher().jobStatus(job.id)).toMatchObject({ status: 'failed', failed_stage: 'publication_loading', error_code: 'manifest_damaged' });
  } else {
    const reply = await (operation === 'batch_lookup' ? publisher().findBatchV1('missing', context) : invoke(publisher(), operation, context));
    expect(reply).toMatchObject({ ok: false, failure: { stage: 'publication_loading', code: 'manifest_damaged' } });
  }
  const stages = events.filter(event => event.event === 'operation_stage' && event.request_id === context.request_id);
  expect(stages.filter(event => event.stage === 'publication_loading')).toHaveLength(1);
  expect(stages.some(event => ['source_loading', 'legacy_discovery'].includes(event.stage))).toBe(false);
  expect(JSON.stringify(events)).not.toContain('Private broken JSON');
});

it.each(operations)('attributes legacy listing failures separately during %s', async operation => {
  await seed(1);
  await inPublisher(publisher(), async (instance, state) => {
    await state.storage.put('migration', { complete: false, processed: 0 });
    const spy = vi.spyOn(instance.env.SITE_BUCKET, 'list').mockRejectedValue(new Error('Private listing error'));
    try {
      expect(await invoke(instance, operation, contextFor(operation))).toMatchObject({ ok: false, failure: { stage: 'legacy_discovery', code: 'storage_error' } });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
  const stages = events.filter(event => event.event === 'operation_stage');
  expect(stages.filter(event => event.stage === 'publication_loading')).toHaveLength(1);
  expect(stages.filter(event => event.stage === 'legacy_discovery')).toHaveLength(1);
  expect(stages.some(event => event.stage === 'source_loading')).toBe(false);
});

it.each(['publish', 'append', 'retract'] as const)('preserves committed certainty and retryability through the %s publisher and HTTP boundaries', async operation => {
  await seed(1);
  for (const retryable of [true, false]) {
    const helper = operation === 'publish' ? 'publishDigest' : operation === 'append' ? 'appendUpdate' : 'retractPost';
    const spy = vi.spyOn(publishing, helper).mockRejectedValueOnce(new publishing.PublicationError('committed', 'after_commit',
      new HttpError(500, 'Private failure', {}, { code: 'storage_error', retryable })));
    let reply: any;
    try { reply = await invoke(publisher(), operation, contextFor(operation)); } finally { spy.mockRestore(); }
    expect(reply).toMatchObject({ ok: false, failure: { publication_status: 'committed', retryable, stage: 'after_commit', code: 'storage_error' } });
    const path = operation === 'publish' ? '/api/digests' : operation === 'append' ? '/api/posts/source-0/items/0/updates' : '/api/posts/source-0/retract';
    const rpc = operation === 'publish' ? 'publishV2' : operation === 'append' ? 'appendUpdateV1' : 'retractPostV1';
    const body = operation === 'append' ? { group: 'Group', body: 'Update', post_url: `${origin}/update`, posted_at: new Date().toISOString() } : digest('Next');
    const response = await worker.fetch(new Request(origin + path, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), {
      ...bindings, PUBLISHER: { getByName: () => ({ [rpc]: async () => reply }) } as unknown as Env['PUBLISHER'],
    });
    const result = await response.json<any>();
    expect(result).toMatchObject({ publication_status: 'committed', retryable, message: reply.failure.error });
    expect(result.suggestion.message).toContain('confirmed committed');
    if (retryable) {
      expect(result.message).toContain('Reconcile'); expect(result.suggestion.message).toContain('Reconcile');
      expect(result.message).toContain(operation === 'retract' ? 'while its record is retained' : 'original 30 Los Angeles receipt-date history window');
    } else expect(result.suggestion.action).toBe('contact_operator');
    if (operation === 'retract') { expect(result.message).not.toContain('24 hours'); expect(result.suggestion.message).not.toContain('24 hours'); }
  }
});

it('keeps a supported mutation queued between the rebuild final check and index replacement', async () => {
  await seed(1);
  await inPublisher(publisher(), async instance => {
    const job = await instance.enqueueRebuild(origin, contextFor('rebuild'));
    const original = instance.env; const reached = deferred(); const release = deferred();
    let heads = 0; let finalChecked = false; let blocked = false; let published = false;
    instance.env = { ...original, SITE_BUCKET: {
      get: (key: string) => original.SITE_BUCKET.get(key), list: (options: R2ListOptions) => original.SITE_BUCKET.list(options),
      head: async (key: string) => {
        const result = await original.SITE_BUCKET.head(key);
        if (key === 'pages/index.html' && ++heads === 2) finalChecked = true;
        return result;
      },
      put: async (key: string, body: any, options: R2PutOptions) => {
        if (finalChecked && !blocked && /^publications\/.*\.json$/.test(key)) { blocked = true; reached.resolve(); await release.promise; }
        return original.SITE_BUCKET.put(key, body, options);
      },
    } };
    const rebuilding = instance.alarm();
    let mutation: Promise<any> | undefined;
    try {
      await reached.promise;
      mutation = instance.publishV2(digest('Queued-next'), origin, contextFor('publish')).then((reply: any) => { published = true; return reply; });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(published).toBe(false); expect(heads).toBe(2);
    } finally {
      release.resolve();
      try { await rebuilding; if (mutation) expect((await mutation).ok).toBe(true); }
      finally { instance.env = original; }
    }
    expect(await instance.jobStatus(job.id)).toMatchObject({ status: 'completed' });
    expect((await publishing.currentPublication(bindings.SITE_BUCKET)).posts).toHaveLength(2);
    const html = await (await bindings.SITE_BUCKET.get('pages/index.html'))!.text();
    expect(html).toContain('Source-0'); expect(html).toContain('Queued-next');
  });
});
